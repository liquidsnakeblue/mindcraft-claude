// Stimulus tiers
export const TIER_IMMEDIATE = 1;  // Hardcoded safety — handled by modes with execute()
export const TIER_URGENT = 2;     // Interrupt current action, let LLM decide response
export const TIER_PASSIVE = 3;    // Queue for next self-prompt as awareness context

// Debounce cooldowns per stimulus type (ms)
const DEBOUNCE_MS = {
    combat_alert: 5000,
    health_critical: 10000,
    huntable_nearby: 30000,
    item_nearby: 10000,
    tool_low_durability: 60000,
    food_low: 60000,
    weather_change: 120000,
    needs_torch: 15000,
};

const STIMULUS_TTL = 60000;  // Stimuli expire after 60s
const MAX_PER_FLUSH = 8;     // Max stimuli reported per flush

export class Orchestrator {
    constructor(agent) {
        this.agent = agent;
        this._queue = [];
        this._debounceMap = {};  // type → last timestamp
    }

    /**
     * Add a stimulus to the queue. Called by sensor modes every 300ms tick.
     * Debounces per type. If URGENT, triggers immediate interrupt handling.
     */
    addStimulus(type, tier, data) {
        const now = Date.now();
        const cooldown = DEBOUNCE_MS[type] || 10000;

        if (this._debounceMap[type] && (now - this._debounceMap[type]) < cooldown) {
            return;
        }
        this._debounceMap[type] = now;

        const stimulus = { type, tier, data, timestamp: now };
        this._queue.push(stimulus);
        console.log(`[Orchestrator] +${type} (tier ${tier})`);

        if (tier === TIER_URGENT) {
            this._handleUrgentInterrupt(stimulus);
        }
    }

    /**
     * Flush pending PASSIVE stimuli. Called by self-prompter's _buildPromptMessage().
     * Returns formatted awareness text or empty string.
     */
    flush() {
        const now = Date.now();
        const valid = this._queue.filter(s =>
            s.tier === TIER_PASSIVE && (now - s.timestamp) < STIMULUS_TTL
        );
        this._queue = [];  // clear all (urgent already handled inline)

        if (valid.length === 0) return '';

        // Deduplicate by type, keeping the latest
        const byType = {};
        for (const s of valid) {
            byType[s.type] = s;
        }
        const unique = Object.values(byType).slice(-MAX_PER_FLUSH);
        const lines = unique.map(s => `- ${this._describeStimulus(s)}`);

        return `\n\n[AWARENESS]\n${lines.join('\n')}\n\nConsider these observations alongside your current goal.`;
    }

    /**
     * Handle urgent interrupt: stop current action, inject context into history.
     * Does NOT stop the self-prompter loop — Claude sees the interrupt on next iteration.
     */
    _handleUrgentInterrupt(stimulus) {
        // Don't interrupt if the bot is already in combat
        const currentAction = this.agent.actions.currentActionLabel || '';
        if (currentAction.includes('attack') || currentAction.includes('defendSelf')) {
            // Already fighting — just add context, don't interrupt
            console.log(`[Orchestrator] Skipping interrupt — already in combat (${currentAction})`);
        } else {
            // Stop current action (interrupt flags set synchronously)
            this.agent.actions.stop();
        }

        const bot = this.agent.bot;
        const health = Math.floor(bot.health);
        const held = bot.heldItem;
        const weapon = held ? held.name.replace(/_/g, ' ') : 'bare hands';

        // Armor check (slots 5-8: helmet, chestplate, leggings, boots)
        const armorSlots = [5, 6, 7, 8];
        const armor = armorSlots
            .map(i => bot.inventory.slots[i])
            .filter(Boolean)
            .map(s => s.name.replace(/_/g, ' '));
        const armorStr = armor.length > 0 ? armor.join(', ') : 'no armor';

        const goal = this.agent.self_prompter.prompt || 'none';

        const msg = `[URGENT] ${this._describeStimulus(stimulus)}\n` +
            `Health: ${health}/20. Weapon: ${weapon}. Armor: ${armorStr}.\n` +
            `Your goal was: '${goal}'.\n` +
            `Decide how to respond, then continue your goal.`;

        this.agent.history.add('system', msg);
        console.log(`[Orchestrator] URGENT injected: ${stimulus.type}`);
    }

    _describeStimulus(s) {
        const d = s.data || {};
        switch (s.type) {
            case 'combat_alert':
                return `A ${d.entityName || 'hostile mob'} is ${d.distance ?? '?'} blocks away${d.attacking ? ' and attacking you!' : '!'}`;
            case 'health_critical':
                return `Health critically low (${d.health ?? '?'}/20)! Took ${d.recentDamage ?? '?'} damage recently.`;
            case 'huntable_nearby':
                return `A ${d.entityName || 'animal'} is ${d.distance ?? '?'} blocks away.`;
            case 'item_nearby':
                return `A dropped item is ${d.distance ?? '?'} blocks away.${d.emptySlots != null ? ` (${d.emptySlots} empty inventory slots)` : ''}`;
            case 'tool_low_durability':
                return `Your ${d.toolName || 'tool'} is at ${d.durabilityPct ?? '?'}% durability!`;
            case 'food_low': {
                if (d.foodLevel <= 6 && d.foodItemCount === 0)
                    return `Very hungry (${d.foodLevel}/20) with NO food! Find food urgently.`;
                if (d.foodItemCount <= 3)
                    return `Food supply low: hunger ${d.foodLevel}/20, only ${d.foodItemCount} food items left.`;
                return `Hunger at ${d.foodLevel}/20 with ${d.foodItemCount} food items.`;
            }
            case 'weather_change':
                if (d.weather === 'thunder') return `A thunderstorm is starting! Seek shelter if exposed.`;
                if (d.weather === 'rain') return `It started raining.`;
                if (d.weather === 'clear') return `The weather is clearing up.`;
                return `Weather changed to ${d.weather}.`;
            case 'needs_torch':
                return d.hasTorches
                    ? `This area is very dark — place a torch.`
                    : `This area is very dark, but you have no torches.`;
            default:
                return `${s.type}: ${JSON.stringify(d)}`;
        }
    }
}
