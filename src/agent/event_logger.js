import { appendFileSync, mkdirSync } from 'fs';

export class EventLogger {
    constructor(agentName) {
        this.agentName = agentName;
        this.logDir = `./bots/${agentName}`;
        mkdirSync(this.logDir, { recursive: true });
        this.logFile = `${this.logDir}/events.jsonl`;
        this.startTime = Date.now();
        this.actionCount = 0;
        this.errorCount = 0;
        this.deathCount = 0;
    }

    log(eventType, data = {}) {
        const event = {
            timestamp: new Date().toISOString(),
            uptimeMs: Date.now() - this.startTime,
            agent: this.agentName,
            type: eventType,
            ...data
        };

        try {
            appendFileSync(this.logFile, JSON.stringify(event) + '\n');
        } catch (err) {
            console.error('EventLogger write failed:', err.message);
        }

        // Track counters
        if (eventType === 'action') this.actionCount++;
        if (eventType === 'error') this.errorCount++;
        if (eventType === 'death') this.deathCount++;
    }

    logAction(actionName, result) {
        this.log('action', {
            action: actionName,
            success: result?.success ?? true,
            message: result?.message?.substring(0, 200) ?? ''
        });
    }

    logError(context, error) {
        this.log('error', {
            context,
            error: error?.message || String(error)
        });
    }

    logDeath(message, position) {
        this.log('death', { message, position });
    }

    logGoalChange(oldGoal, newGoal) {
        this.log('goal_change', { oldGoal, newGoal });
    }

    logPlayerInteraction(playerName, type, detail) {
        this.log('player_interaction', { player: playerName, interactionType: type, detail });
    }

    logTimeEvent(timeEvent) {
        this.log('time_event', { event: timeEvent });
    }

    getStats() {
        return {
            uptime: Date.now() - this.startTime,
            actions: this.actionCount,
            errors: this.errorCount,
            deaths: this.deathCount
        };
    }
}
