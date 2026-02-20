import { writeFileSync } from 'fs';
import { History } from './history.js';
import { Coder } from './coder.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { initModes } from './modes.js';
import { initBot } from '../utils/mcdata.js';
import { containsCommand, commandExists, executeCommand, truncCommandMessage, isAction, blacklistCommands } from './commands/index.js';
import { ActionManager } from './action_manager.js';
import { NPCContoller } from './npc/controller.js';
import { MemoryBank } from './memory_bank.js';
import { SelfPrompter } from './self_prompter.js';
import { Orchestrator } from './orchestrator.js';
import convoManager from './conversation.js';
import { handleTranslation, handleEnglishTranslation } from '../utils/translator.js';
import { addBrowserViewer } from './vision/browser_viewer.js';
import { serverProxy, sendOutputToServer } from './mindserver_proxy.js';
import { EventLogger } from './event_logger.js';
import * as world from './library/world.js';
import settings from './settings.js';
import { Task } from './tasks/tasks.js';
import { speak } from './speak.js';
import { log, validateNameFormat, handleDisconnection } from './connection_handler.js';

export class Agent {
    async start(load_mem=false, init_message=null, count_id=0) {
        this.last_sender = null;
        this.count_id = count_id;
        this._disconnectHandled = false;

        // Initialize components
        this.actions = new ActionManager(this);
        this.prompter = new Prompter(this, settings.profile);
        // Event logger initialized after name is set (below)
        this.name = (this.prompter.getName() || '').trim();
        this.event_logger = new EventLogger(this.name);
        console.log(`Initializing agent ${this.name}...`);
        
        // Validate Name Format
        // connection_handler now ensures the message has [LoginGuard] prefix
        const nameCheck = validateNameFormat(this.name);
        if (!nameCheck.success) {
            log(this.name, nameCheck.msg);
            process.exit(1);
            return;
        }
        
        this.history = new History(this);
        this.coder = new Coder(this);
        this.npc = new NPCContoller(this);
        this.memory_bank = new MemoryBank();
        this.self_prompter = new SelfPrompter(this);
        this.orchestrator = new Orchestrator(this);
        convoManager.initAgent(this);
        await this.prompter.initExamples();

        // load mem first before doing task
        let save_data = null;
        if (load_mem) {
            save_data = this.history.load();
        }
        let taskStart = null;
        if (save_data) {
            taskStart = save_data.taskStart;
            if (save_data.memory_bank)
                this.memory_bank.loadJson(save_data.memory_bank);
        } else {
            taskStart = Date.now();
        }
        this.task = new Task(this, settings.task, taskStart);
        this.blocked_actions = settings.blocked_actions.concat(this.task.blocked_actions || []);
        blacklistCommands(this.blocked_actions);

        console.log(this.name, 'logging into minecraft...');
        this.bot = initBot(this.name);
        
        // Connection Handler
        const onDisconnect = (event, reason) => {
            if (this._disconnectHandled) return;
            this._disconnectHandled = true;

            // Log and Analyze
            // handleDisconnection handles logging to console and server
            const { type } = handleDisconnection(this.name, reason);
     
            process.exit(1);
        };
        
        // Bind events
        this.bot.once('kicked', (reason) => onDisconnect('Kicked', reason));
        this.bot.once('end', (reason) => onDisconnect('Disconnected', reason));
        this.bot.on('error', (err) => {
            if (String(err).includes('Duplicate') || String(err).includes('ECONNREFUSED')) {
                 onDisconnect('Error', err);
            } else {
                 log(this.name, `[LoginGuard] Connection Error: ${String(err)}`);
            }
        });

        initModes(this);

        this.bot.on('login', () => {
            console.log(this.name, 'logged in!');
            serverProxy.login();
            
            // Set skin for profile, requires Fabric Tailor. (https://modrinth.com/mod/fabrictailor)
            if (this.prompter.profile.skin)
                this.bot.chat(`/skin set URL ${this.prompter.profile.skin.model} ${this.prompter.profile.skin.path}`);
            else
                this.bot.chat(`/skin clear`);
        });
		const spawnTimeoutDuration = settings.spawn_timeout;
        const spawnTimeout = setTimeout(() => {
            const msg = `Bot has not spawned after ${spawnTimeoutDuration} seconds. Exiting.`;
            log(this.name, msg);
            process.exit(1);
        }, spawnTimeoutDuration * 1000);
        this.bot.once('spawn', async () => {
            try {
                clearTimeout(spawnTimeout);
                addBrowserViewer(this.bot, count_id);
                console.log('Initializing vision intepreter...');
                this.vision_interpreter = new VisionInterpreter(this, settings.allow_vision);

                // wait for a bit so stats are not undefined
                await new Promise((resolve) => setTimeout(resolve, 1000));
                
                console.log(`${this.name} spawned.`);
                this.clearBotLogs();
              
                this._setupEventHandlers(save_data, init_message);
                this.startEvents();
              
                if (!load_mem) {
                    if (settings.task) {
                        this.task.initBotTask();
                        this.task.setAgentGoal();
                    }
                } else {
                    // set the goal without initializing the rest of the task
                    if (settings.task) {
                        this.task.setAgentGoal();
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, 10000));
                this.checkAllPlayersPresent();

            } catch (error) {
                console.error('Error in spawn event:', error);
                process.exit(0);
            }
        });
    }

    async _setupEventHandlers(save_data, init_message) {
        const ignore_messages = [
            "Set own game mode to",
            "Set the time to",
            "Set the difficulty to",
            "Teleported ",
            "Set the weather to",
            "Gamerule "
        ];
        
        const respondFunc = async (username, message) => {
            if (message === "") return;
            if (username === this.name) return;
            if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
            try {
                if (ignore_messages.some((m) => message.startsWith(m))) return;

                this.shut_up = false;

                console.log(this.name, 'received message from', username, ':', message);

                // Track player interaction in memory
                if (username !== 'system') {
                    const player = this.bot.players[username];
                    this.memory_bank.updatePlayer(username, {
                        interaction: 'chat',
                        detail: message.substring(0, 100),
                        position: player?.entity ? [
                            Math.floor(player.entity.position.x),
                            Math.floor(player.entity.position.y),
                            Math.floor(player.entity.position.z)
                        ] : null
                    });
                }

                if (convoManager.isOtherAgent(username)) {
                    console.warn('received whisper from other bot??')
                }
                else {
                    let translation = await handleEnglishTranslation(message);
                    this.handleMessage(username, translation);
                }
            } catch (error) {
                console.error('Error handling message:', error);
            }
        }

		this.respondFunc = respondFunc;

        this.bot.on('whisper', respondFunc);
        
        this.bot.on('chat', (username, message) => {
            if (serverProxy.getNumOtherAgents() > 0) return;
            // only respond to open chat messages when there are no other agents
            respondFunc(username, message);
        });

        // Set up auto-eat
        this.bot.autoEat.options = {
            priority: 'foodPoints',
            startAt: 14,
            bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"]
        };

        if (save_data?.self_prompt) {
            if (init_message) {
                this.history.add('system', init_message);
            }
            await this.self_prompter.handleLoad(save_data.self_prompt, save_data.self_prompting_state);
        }
        if (save_data?.last_sender) {
            this.last_sender = save_data.last_sender;
            if (convoManager.otherAgentInGame(this.last_sender)) {
                const msg_package = {
                    message: `You have restarted and this message is auto-generated. Continue the conversation with me.`,
                    start: true
                };
                convoManager.receiveFromBot(this.last_sender, msg_package);
            }
        }
        else if (init_message) {
            // Inject last session context if available
            const lastSession = this.history.loadLastSessionContext();
            if (lastSession) {
                const sessionContext = `[Previous Session] Last played: ${lastSession.date}. ` +
                    `Duration: ${lastSession.durationMinutes}min. ` +
                    (lastSession.lastGoal ? `Last goal: "${lastSession.lastGoal}". ` : '') +
                    (lastSession.savedPlaces?.length > 0 ? `Known places: ${lastSession.savedPlaces.join(', ')}. ` : '') +
                    `Welcome back!`;
                this.history.add('system', sessionContext);
            }
            await this.handleMessage('system', init_message, 2);
        }
        else {
            this.openChat("Hello world! I am "+this.name);
        }
    }

    checkAllPlayersPresent() {
        if (!this.task || !this.task.agent_names) {
          return;
        }

        const missingPlayers = this.task.agent_names.filter(name => !this.bot.players[name]);
        if (missingPlayers.length > 0) {
            console.log(`Missing players/bots: ${missingPlayers.join(', ')}`);
            this.cleanKill('Not all required players/bots are present in the world. Exiting.', 4);
        }
    }

    requestInterrupt() {
        this.bot.interrupt_code = true;
        this.bot.stopDigging();
        this.bot.collectBlock.cancelTask();
        this.bot.pathfinder.stop();
        this.bot.pvp.stop();
    }

    clearBotLogs() {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    shutUp() {
        this.shut_up = true;
        if (this.self_prompter.isActive()) {
            this.self_prompter.stop(false);
        }
        convoManager.endAllConversations();
    }

    async handleMessage(source, message, max_responses=null) {
        await this.checkTaskDone();
        if (!source || !message) {
            console.warn('Received empty message from', source);
            return false;
        }

        let used_command = false;
        if (max_responses === null) {
            max_responses = settings.max_commands === -1 ? Infinity : settings.max_commands;
        }
        if (max_responses === -1) {
            max_responses = Infinity;
        }

        const self_prompt = source === 'system' || source === this.name;
        const from_other_bot = convoManager.isOtherAgent(source);

        if (!self_prompt && !from_other_bot) { // from user, check for forced commands
            const user_command_name = containsCommand(message);
            if (user_command_name) {
                if (!commandExists(user_command_name)) {
                    this.routeResponse(source, `Command '${user_command_name}' does not exist.`);
                    return false;
                }
                this.routeResponse(source, `*${source} used ${user_command_name.substring(1)}*`);
                if (user_command_name === '!newAction') {
                    // all user-initiated commands are ignored by the bot except for this one
                    // add the preceding message to the history to give context for newAction
                    this.history.add(source, message);
                }
                let execute_res = await executeCommand(this, message);
                if (execute_res) 
                    this.routeResponse(source, execute_res);
                return true;
            }
        }

        if (from_other_bot)
            this.last_sender = source;

        // Now translate the message
        message = await handleEnglishTranslation(message);
        console.log('received message from', source, ':', message);

        const checkInterrupt = () => this.self_prompter.shouldInterrupt(self_prompt) || this.shut_up || convoManager.responseScheduledFor(source);
        
        let behavior_log = this.bot.modes.flushBehaviorLog().trim();
        if (behavior_log.length > 0) {
            const MAX_LOG = 500;
            if (behavior_log.length > MAX_LOG) {
                behavior_log = '...' + behavior_log.substring(behavior_log.length - MAX_LOG);
            }
            behavior_log = 'Recent behaviors log: \n' + behavior_log;
            await this.history.add('system', behavior_log);
        }

        // Handle other user messages
        await this.history.add(source, message);
        this.history.save();

        if (!self_prompt && this.self_prompter.isActive()) // message is from user during self-prompting
            max_responses = 1; // force only respond to this message, then let self-prompting take over
        for (let i=0; i<max_responses; i++) {
            if (checkInterrupt()) break;
            let history = this.history.getHistory();
            let res = await this.prompter.promptConvo(history, self_prompt);

            console.log(`${this.name} full response to ${source}: ""${res}""`);

            if (res.trim().length === 0) {
                console.warn('no response')
                break; // empty response ends loop
            }

            let command_name = containsCommand(res);

            if (command_name) { // contains query or command
                res = truncCommandMessage(res); // everything after the command is ignored
                this.history.add(this.name, res);
                
                if (!commandExists(command_name)) {
                    this.history.add('system', `Command ${command_name} does not exist.`);
                    console.warn('Agent hallucinated command:', command_name)
                    continue;
                }

                if (checkInterrupt()) break;
                this.self_prompter.handleUserPromptedCmd(self_prompt, isAction(command_name));

                if (settings.show_command_syntax === "full") {
                    this.routeResponse(source, res);
                }
                else if (settings.show_command_syntax === "shortened") {
                    // show only "used !commandname"
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    let chat_message = `*used ${command_name.substring(1)}*`;
                    if (pre_message.length > 0)
                        chat_message = `${pre_message}  ${chat_message}`;
                    this.routeResponse(source, chat_message);
                }
                else {
                    // no command at all
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    if (pre_message.trim().length > 0)
                        this.routeResponse(source, pre_message);
                }

                let execute_res = await executeCommand(this, res);

                console.log('Agent executed:', command_name, 'and got:', execute_res);
                used_command = true;

                if (execute_res)
                    this.history.add('system', execute_res);
                else
                    break;
            }
            else { // conversation response
                this.history.add(this.name, res);
                this.routeResponse(source, res);
                break;
            }
            
            this.history.save();
        }

        return used_command;
    }

    async routeResponse(to_player, message) {
        if (this.shut_up) return;
        let self_prompt = to_player === 'system' || to_player === this.name;
        if (self_prompt && this.last_sender) {
            // this is for when the agent is prompted by system while still in conversation
            // so it can respond to events like death but be routed back to the last sender
            to_player = this.last_sender;
        }

        if (convoManager.isOtherAgent(to_player) && convoManager.inConversation(to_player)) {
            // if we're in an ongoing conversation with the other bot, send the response to it
            convoManager.sendToBot(to_player, message);
        }
        else {
            // otherwise, use open chat
            this.openChat(message);
            // note that to_player could be another bot, but if we get here the conversation has ended
        }
    }

    async openChat(message) {
        let to_translate = message;
        let remaining = '';
        let command_name = containsCommand(message);
        let translate_up_to = command_name ? message.indexOf(command_name) : -1;
        if (translate_up_to != -1) { // don't translate the command
            to_translate = to_translate.substring(0, translate_up_to);
            remaining = message.substring(translate_up_to);
        }
        message = (await handleTranslation(to_translate)).trim() + " " + remaining;
        // newlines are interpreted as separate chats, which triggers spam filters. replace them with spaces
        message = message.replaceAll('\n', ' ');

        if (settings.only_chat_with.length > 0) {
            for (let username of settings.only_chat_with) {
                this.bot.whisper(username, message);
            }
        }
        else {
            if (settings.speak) {
                speak(to_translate, this.prompter.profile.speak_model);
            }
            if (settings.chat_ingame) {this.bot.chat(message);}
            sendOutputToServer(this.name, message);
        }
    }

    startEvents() {
        // Custom events
        this.bot.on('time', () => {
            if (this.bot.time.timeOfDay == 0)
            this.bot.emit('sunrise');
            else if (this.bot.time.timeOfDay == 6000)
            this.bot.emit('noon');
            else if (this.bot.time.timeOfDay == 12000)
            this.bot.emit('sunset');
            else if (this.bot.time.timeOfDay == 18000)
            this.bot.emit('midnight');
        });

        // Time-of-day awareness: inject context messages at key times
        // NOTE: These use history.add() instead of handleMessage() so they don't trigger
        // separate LLM responses. The bot will see them as context on its next self-prompt.
        this.bot.on('sunrise', () => {
            this.event_logger.logTimeEvent('sunrise');
            const pos = this.bot.entity.position;
            const biome = this.bot.blockAt(pos)?.biome?.name || 'unknown';
            this.history.add('system',
                `[Time: Sunrise] A new day begins. Hostile mobs will burn in sunlight. ` +
                `You are at (${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}) in ${biome}. ` +
                `Health: ${Math.floor(this.bot.health)}/20, Hunger: ${Math.floor(this.bot.food)}/20. ` +
                `Plan your day wisely.`
            );
        });
        this.bot.on('noon', () => {
            this.history.add('system',
                `[Time: Noon] Half the day has passed. Sunset is in about 5 minutes. ` +
                `Health: ${Math.floor(this.bot.health)}/20, Hunger: ${Math.floor(this.bot.food)}/20. ` +
                `Consider whether you should head back to base soon or continue your current task.`
            );
        });
        this.bot.on('sunset', () => {
            const hasHome = !!this.memory_bank.recallPlace('home');
            const hasBed = this.bot.inventory.items().some(i => i.name.includes('bed'));
            let advice = '';
            if (hasHome) {
                advice = 'You have a home saved — use !goHome to return to safety. ';
            } else if (hasBed) {
                advice = 'You have a bed — find a safe spot to place it and sleep. ';
            } else {
                advice = 'You have no home or bed. Consider building an emergency shelter (!buildShelter) or finding a cave. ';
            }
            this.history.add('system',
                `[Time: Sunset] Night is falling! Hostile mobs will begin spawning soon. ` +
                `Health: ${Math.floor(this.bot.health)}/20, Hunger: ${Math.floor(this.bot.food)}/20. ` +
                advice +
                `If you want to continue working through the night, make sure you are well-armed and well-lit.`
            );
        });
        this.bot.on('midnight', () => {
            this.history.add('system',
                `[Time: Midnight] The darkest hour. Mobs are at peak spawning. ` +
                `Health: ${Math.floor(this.bot.health)}/20. ` +
                `Stay alert and avoid open areas unless well-equipped.`
            );
        });

        // Player greeting: greet players when they join the server
        this.bot.on('playerJoined', (player) => {
            if (player.username === this.name) return;
            const known = this.memory_bank.getPlayer(player.username);
            if (known) {
                const timeSince = Math.floor((Date.now() - known.lastSeen) / 60000);
                if (timeSince > 5) { // only greet if they've been gone > 5 min
                    this.openChat(`Hey ${player.username}, welcome back!`);
                }
            } else {
                this.openChat(`Hello ${player.username}!`);
            }
            this.memory_bank.updatePlayer(player.username, { interaction: 'joined' });
        });

        // Player leaving
        this.bot.on('playerLeft', (player) => {
            if (player.username === this.name) return;
            this.memory_bank.updatePlayer(player.username, { interaction: 'left' });
        });

        // Emote system: occasional flavor text during idle
        this._emoteTimer = 0;
        this._emoteCooldown = 5 * 60 * 1000; // every 5 minutes max
        const emotes = [
            '/me looks around curiously',
            '/me stretches and yawns',
            '/me hums a tune',
            '/me checks their inventory',
            '/me scans the horizon',
            '/me takes a deep breath',
        ];
        const weatherEmotes = [
            '/me shivers in the rain',
            '/me looks up at the dark clouds',
        ];
        const nightEmotes = [
            '/me glances nervously into the darkness',
            '/me listens to the sounds of the night',
        ];

        // Store emotes on agent for use in update loop
        this._emotes = emotes;
        this._weatherEmotes = weatherEmotes;
        this._nightEmotes = nightEmotes;

        let prev_health = this.bot.health;
        this.bot.lastDamageTime = 0;
        this.bot.lastDamageTaken = 0;
        this.bot.on('health', () => {
            if (this.bot.health < prev_health) {
                this.bot.lastDamageTime = Date.now();
                this.bot.lastDamageTaken = prev_health - this.bot.health;
            }
            prev_health = this.bot.health;
        });
        // Logging callbacks
        this.bot.on('error' , (err) => {
            console.error('Error event!', err);
        });
        // Use connection handler for runtime disconnects
        this.bot.on('end', (reason) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('death', () => {
            this.actions.cancelResume();
            this.actions.stop();
        });
        this.bot.on('kicked', (reason) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('messagestr', async (message, _, jsonMsg) => {
            if (jsonMsg.translate && jsonMsg.translate.startsWith('death') && message.startsWith(this.name)) {
                console.log('Agent died: ', message);
                this.event_logger.logDeath(message, this.bot.entity.position);
                let death_pos = this.bot.entity.position;
                this.memory_bank.rememberPlace('last_death_position', death_pos.x, death_pos.y, death_pos.z);
                let death_pos_text = null;
                if (death_pos) {
                    death_pos_text = `x: ${death_pos.x.toFixed(2)}, y: ${death_pos.y.toFixed(2)}, z: ${death_pos.x.toFixed(2)}`;
                }
                let dimention = this.bot.game.dimension;
                this.handleMessage('system',
                    `You died at position ${death_pos_text || "unknown"} in the ${dimention} dimension ` +
                    `with the final message: '${message}'. Your place of death is saved as 'last_death_position' ` +
                    `if you want to return. Previous actions were stopped and you have respawned. ` +
                    `REFLECT: What caused your death? What could you have done differently? ` +
                    `Should you change your current strategy, equip better gear, or avoid certain areas?`
                );
            }
        });
        this.bot.on('idle', () => {
            this.bot.clearControlStates();
            this.bot.pathfinder.stop(); // clear any lingering pathfinder
            this.bot.modes.unPauseAll();
            setTimeout(() => {
                if (this.isIdle()) {
                    this.actions.resumeAction();
                }
            }, 1000);
        });

        // Init NPC controller
        this.npc.init();

        // Auto-save heartbeat: save memory every 5 minutes to prevent data loss on crash
        this._lastAutoSave = Date.now();

        // Context pulse: inject environment awareness every 3 minutes
        this._lastContextPulse = Date.now();
        this._contextPulseInterval = 3 * 60 * 1000; // 3 minutes

        // Player proximity tracking
        this._nearbyPlayers = new Set();
        this._proximityCheckInterval = 5000; // check every 5 seconds
        this._lastProximityCheck = Date.now();
        this._playerProximityRange = 32;

        // Idle creativity: generate own goal after extended idle
        this._idleCreativityTime = 0;
        this._idleCreativityThreshold = 60 * 1000; // 60 seconds of total idle before generating goal

        // This update loop ensures that each update() is called one at a time, even if it takes longer than the interval
        const INTERVAL = 300;
        let last = Date.now();
        setTimeout(async () => {
            while (true) {
                let start = Date.now();
                await this.update(start - last);
                let remaining = INTERVAL - (Date.now() - start);
                if (remaining > 0) {
                    await new Promise((resolve) => setTimeout(resolve, remaining));
                }
                last = start;
            }
        }, INTERVAL);

        this.bot.emit('idle');
    }

    async update(delta) {
        await this.bot.modes.update();
        this.self_prompter.update(delta);
        await this.checkTaskDone();

        const now = Date.now();

        // Auto-save heartbeat + health dashboard
        if (now - this._lastAutoSave >= 5 * 60 * 1000) {
            this._lastAutoSave = now;
            try {
                this.history.save();
                this._writeHealthDashboard();
                console.log('Auto-save heartbeat: memory saved.');
            } catch (err) {
                console.error('Auto-save failed:', err.message);
            }
        }

        // Context pulse: periodic environment awareness
        if (now - this._lastContextPulse >= this._contextPulseInterval) {
            this._lastContextPulse = now;
            this._injectContextPulse();
        }

        // Player proximity awareness
        if (now - this._lastProximityCheck >= this._proximityCheckInterval) {
            this._lastProximityCheck = now;
            this._checkPlayerProximity();
        }

        // Emote system: flavor text during idle
        this._emoteTimer += delta;
        if (this._emoteTimer >= this._emoteCooldown && this.isIdle() && Math.random() < 0.3) {
            this._emoteTimer = 0;
            let pool = this._emotes;
            if (this.bot.rainState > 0) pool = pool.concat(this._weatherEmotes);
            if (this.bot.time.timeOfDay >= 13000) pool = pool.concat(this._nightEmotes);
            const emote = pool[Math.floor(Math.random() * pool.length)];
            this.bot.chat(emote);
        }

        // Idle creativity: if no goal and idle too long, generate one
        if (this.isIdle() && this.self_prompter.isStopped()) {
            this._idleCreativityTime += delta;
            if (this._idleCreativityTime >= this._idleCreativityThreshold) {
                this._idleCreativityTime = 0;
                this._triggerIdleCreativity();
            }
        } else {
            this._idleCreativityTime = 0;
        }
    }

    _getEnvironmentSnapshot() {
        const bot = this.bot;
        const pos = bot.entity.position;
        const health = Math.floor(bot.health);
        const food = Math.floor(bot.food);
        const timeOfDay = bot.time.timeOfDay;
        const isRaining = bot.isRaining;

        let timePhase = 'day';
        if (timeOfDay >= 12000 && timeOfDay < 13000) timePhase = 'dusk';
        else if (timeOfDay >= 13000 || timeOfDay < 0) timePhase = 'night';
        else if (timeOfDay >= 0 && timeOfDay < 1000) timePhase = 'dawn';

        // Inventory summary
        const counts = world.getInventoryCounts(bot);
        const items = Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([name, count]) => `${name}:${count}`)
            .join(', ');

        // Nearby entities
        const nearbyEntities = world.getNearbyEntities(bot, 16);
        const hostiles = nearbyEntities.filter(e => e.type === 'hostile' || e.type === 'mob').slice(0, 5);
        const players = nearbyEntities.filter(e => e.type === 'player' && e.name !== this.name);

        let entitySummary = '';
        if (hostiles.length > 0)
            entitySummary += `Hostile mobs nearby: ${hostiles.map(e => e.name || e.displayName).join(', ')}. `;
        if (players.length > 0)
            entitySummary += `Players nearby: ${players.map(e => e.username || e.name).join(', ')}. `;
        if (!entitySummary) entitySummary = 'No notable entities nearby. ';

        // Equipment check
        const heldItem = bot.heldItem;
        let equipNote = '';
        if (heldItem && heldItem.maxDurability) {
            const durabilityLeft = heldItem.maxDurability - (heldItem.durabilityUsed || 0);
            const pct = Math.floor((durabilityLeft / heldItem.maxDurability) * 100);
            if (pct < 20) equipNote = `WARNING: ${heldItem.name} is at ${pct}% durability! `;
        }

        return {
            pos: `(${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)})`,
            health, food, timePhase, isRaining, items, entitySummary, equipNote
        };
    }

    _injectContextPulse() {
        if (!this.self_prompter.isActive()) return; // only pulse during autonomous behavior

        const env = this._getEnvironmentSnapshot();
        const weatherNote = env.isRaining ? 'It is currently raining. ' : '';

        const pulse = `[Context Pulse] Position: ${env.pos} | Health: ${env.health}/20 | ` +
            `Hunger: ${env.food}/20 | Time: ${env.timePhase} | ${weatherNote}` +
            `${env.equipNote}${env.entitySummary}` +
            `Top inventory: ${env.items || 'empty'}. ` +
            `Reflect briefly on your progress toward your current goal, then continue.`;

        // Context only — the self-prompter will see this on its next iteration
        this.history.add('system', pulse);
    }

    _writeHealthDashboard() {
        try {
            const bot = this.bot;
            const pos = bot.entity.position;
            const stats = this.event_logger.getStats();
            const dashboard = {
                agent: this.name,
                timestamp: new Date().toISOString(),
                uptime_minutes: Math.floor(stats.uptime / 60000),
                position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
                health: Math.floor(bot.health),
                hunger: Math.floor(bot.food),
                gamemode: bot.game.gameMode,
                dimension: bot.game.dimension,
                current_goal: this.self_prompter.isActive() ? this.self_prompter.prompt : null,
                is_idle: this.isIdle(),
                stats: {
                    actions: stats.actions,
                    errors: stats.errors,
                    deaths: stats.deaths
                },
                saved_places: Object.keys(this.memory_bank.memory),
                inventory_count: bot.inventory.items().length
            };
            writeFileSync(`./bots/${this.name}/dashboard.json`, JSON.stringify(dashboard, null, 2));
        } catch (err) {
            // Silently fail — dashboard is non-critical
        }
    }

    _triggerIdleCreativity() {
        const env = this._getEnvironmentSnapshot();
        this.handleMessage('system',
            `[Idle - No Active Goal] You have been idle with no goal for a while. ` +
            `Position: ${env.pos} | Health: ${env.health}/20 | Hunger: ${env.food}/20 | Time: ${env.timePhase}. ` +
            `Inventory: ${env.items || 'empty'}. ` +
            `Based on your situation, decide what to do next and set a goal with !goal("your new goal"). ` +
            `Consider: exploring, gathering resources, building, or preparing for challenges.`
        );
    }

    _checkPlayerProximity() {
        try {
            const nearbyPlayers = world.getNearbyPlayerNames(this.bot);
            const currentSet = new Set(nearbyPlayers.filter(n => n !== this.name));

            // Detect players who just arrived — context only, no LLM response triggered
            for (const name of currentSet) {
                if (!this._nearbyPlayers.has(name)) {
                    const player = this.bot.players[name];
                    if (player?.entity) {
                        const dist = Math.floor(this.bot.entity.position.distanceTo(player.entity.position));
                        this.history.add('system',
                            `[Proximity] ${name} is approaching! They are ${dist} blocks away.`
                        );
                    }
                }
            }

            // Detect players who left — context only
            for (const name of this._nearbyPlayers) {
                if (!currentSet.has(name)) {
                    this.history.add('system',
                        `[Proximity] ${name} has moved out of range.`
                    );
                }
            }

            this._nearbyPlayers = currentSet;
        } catch (err) {
            // Silently ignore proximity check errors
        }
    }

    isIdle() {
        return !this.actions.executing;
    }
    

    cleanKill(msg='Killing agent process...', code=1) {
        this.history.add('system', msg);
        this.bot.chat(code > 1 ? 'Restarting.': 'Exiting.');
        this.history.save();
        this.history.saveSessionJournal();
        process.exit(code);
    }
    async checkTaskDone() {
        if (this.task.data) {
            let res = this.task.isDone();
            if (res) {
                await this.history.add('system', `Task ended with score : ${res.score}`);
                await this.history.save();
                // await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 second for save to complete
                console.log('Task finished:', res.message);
                this.killAll();
            }
        }
    }

    killAll() {
        serverProxy.shutdown();
    }
}