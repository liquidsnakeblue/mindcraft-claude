export class MemoryBank {
	constructor() {
		this.memory = {};
		this.facts = {};     // key -> { value, tags[], timestamp }
		this.players = {};   // playerName -> { lastSeen, lastPosition, interactions[], notes }
	}

	// === Place Memory (original API preserved) ===

	rememberPlace(name, x, y, z) {
		this.memory[name] = [x, y, z];
	}

	recallPlace(name) {
		return this.memory[name];
	}

	getKeys() {
		return Object.keys(this.memory).join(', ')
	}

	// === Fact Memory ===

	rememberFact(key, value, tags = []) {
		this.facts[key] = {
			value,
			tags: Array.isArray(tags) ? tags : [tags],
			timestamp: Date.now()
		};
	}

	recallFact(key) {
		const fact = this.facts[key];
		return fact ? fact.value : null;
	}

	searchFacts(query) {
		const results = [];
		const queryLower = query.toLowerCase();
		for (const [key, fact] of Object.entries(this.facts)) {
			if (key.toLowerCase().includes(queryLower) ||
				fact.value.toLowerCase().includes(queryLower) ||
				fact.tags.some(t => t.toLowerCase().includes(queryLower))) {
				results.push({ key, ...fact });
			}
		}
		return results;
	}

	forgetFact(key) {
		delete this.facts[key];
	}

	getFactKeys() {
		return Object.keys(this.facts).join(', ');
	}

	// === Player Memory ===

	updatePlayer(playerName, data = {}) {
		if (!this.players[playerName]) {
			this.players[playerName] = {
				firstSeen: Date.now(),
				lastSeen: Date.now(),
				lastPosition: null,
				interactions: [],
				notes: []
			};
		}
		const p = this.players[playerName];
		p.lastSeen = Date.now();
		if (data.position) p.lastPosition = data.position;
		if (data.interaction) {
			p.interactions.push({
				type: data.interaction,
				timestamp: Date.now(),
				detail: data.detail || null
			});
			// Keep only last 20 interactions per player
			if (p.interactions.length > 20) {
				p.interactions = p.interactions.slice(-20);
			}
		}
		if (data.note) {
			p.notes.push(data.note);
			if (p.notes.length > 10) {
				p.notes = p.notes.slice(-10);
			}
		}
	}

	getPlayer(playerName) {
		return this.players[playerName] || null;
	}

	getPlayerSummary(playerName) {
		const p = this.players[playerName];
		if (!p) return `No memory of player ${playerName}.`;
		const timeSince = Math.floor((Date.now() - p.lastSeen) / 60000);
		const interactions = p.interactions.length;
		const notes = p.notes.length > 0 ? ` Notes: ${p.notes.join('; ')}` : '';
		return `${playerName}: last seen ${timeSince}min ago, ${interactions} interactions.${notes}`;
	}

	getAllPlayerNames() {
		return Object.keys(this.players);
	}

	// === Serialization (backward-compatible) ===

	getJson() {
		return {
			places: this.memory,
			facts: this.facts,
			players: this.players
		};
	}

	loadJson(json) {
		if (!json) return;
		// Backward compatibility: if json is a flat object of places (old format)
		if (json.places === undefined && json.facts === undefined) {
			this.memory = json;
		} else {
			this.memory = json.places || {};
			this.facts = json.facts || {};
			this.players = json.players || {};
		}
	}
}
