import Dexie from "dexie";
import "dexie-observable";

const DatabaseName = "whiskr";

export let db;

class StorageDB {
	#cache = new Map();
	#listeners = new Set();
	#scheduled = new Map();
	#writes = new Map();
	#lastWrite = new Map();

	async init() {
		db = new Dexie(DatabaseName);

		db.version(1).stores({
			kv: "&key",
		});

		db.version(2).stores({
			kv: "&key",
			chats: "id, updated_at",
			messages: "id, chat_id, updated_at, [chat_id+created_at]",
			artifacts: "id, message_id, updated_at",
			sync_log: "client_id",
			outbox: "id++, type, entity_id, action"
		}).upgrade(async tx => {
			const kvTable = tx.table("kv");
			const keys = await kvTable.toCollection().keys();
			for (const key of keys) {
				if (key.startsWith("chat-")) {
					const chatData = (await kvTable.get(key))?.value;
				}
			}
		});

		await db.open();
		await this.#loadKV();

		db.on("changes", changes => this.#handleChanges(changes));
		this.#startSyncLoop();
	}

	async #loadKV() {
		const rows = await db.table("kv").toArray();
		let total = 0;
		rows.forEach(row => {
			if (row.value !== "" && row.value !== null && row.value !== undefined) {
				this.#cache.set(row.key, row.value);
				total++;
			}
		});
		console.info(`Loaded ${total} items from Dexie KV`);
	}

	async store(key, value = false) {
		const isNull = value === "" || value === null || value === undefined;
		if (isNull) {
			this.#cache.delete(key);
		} else {
			this.#cache.set(key, value);
		}
		this.#lastWrite.set(key, Date.now());
		await this.#scheduleKV(key);
	}

	async #scheduleKV(key) {
		if (this.#scheduled.has(key)) return;
		this.#scheduled.set(key, true);
		await new Promise(resolve => setTimeout(resolve, 500));
		this.#scheduled.delete(key);

		if (this.#writes.has(key)) {
			await this.#scheduleKV(key);
			return;
		}

		this.#writes.set(key, true);
		try {
			const value = this.#cache.get(key);
			const isNull = value === "" || value === null || value === undefined;
			if (isNull) {
				await db.table("kv").delete(key);
			} else {
				await db.table("kv").put({ key: key, value: value, updatedAt: Date.now() });
			}
		} catch (error) {
			console.error(`Failed to write to Dexie KV: ${error}`);
		} finally {
			this.#writes.delete(key);
		}
	}

	load(key, fallback = false) {
		if (!this.#cache.has(key)) return fallback;
		return this.#cache.get(key);
	}

	onChange(listener) {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emitChange(change) {
		for (const listener of this.#listeners) {
			listener(change);
		}
	}

	#handleChanges(changes) {
		for (const change of changes) {
			if (change.table === "kv") {
				const key = change.key,
					value = change.obj?.value ?? null,
					updatedAt = change.obj?.updatedAt ?? null;

				let isLocal = false;
				if (key && this.#lastWrite.has(key)) {
					const age = Date.now() - this.#lastWrite.get(key);
					if (age < 1500) isLocal = true;
				}

				this.#emitChange({
					key: key,
					value: value,
					updatedAt: updatedAt,
					type: change.type,
					isLocal: isLocal,
				});
			} else if (["chats", "messages", "artifacts"].includes(change.table)) {
				if (!change.obj?._fromSync) {
					this.#queueSync(change.table, change.key, change.type);
				}
			}
		}
	}

	async #queueSync(table, id, type) {
		await db.table("outbox").put({
			type: table,
			entity_id: id,
			action: type
		});
	}

	async #startSyncLoop() {
		setInterval(() => this.sync(), 10000);
		setTimeout(() => this.sync(), 2000);
	}

	async sync() {
		if (!navigator.onLine) return;
		try {
			const outboxItems = await db.table("outbox").toArray();
			if (outboxItems.length > 0) {
				const payload = {
					client_id: this.#getClientId(),
					chats: [],
					messages: [],
					artifacts: []
				};

				for (const item of outboxItems) {
					if (item.action === 3) continue;
					const entity = await db.table(item.type).get(item.entity_id);
					if (entity) {
						const { _fromSync, ...cleanEntity } = entity;
						payload[item.type].push(cleanEntity);
					}
				}

				if (payload.chats.length > 0 || payload.messages.length > 0 || payload.artifacts.length > 0) {
					const response = await fetch("/-/sync", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(payload)
					});
					if (response.ok) {
						const ids = outboxItems.map(i => i.id);
						await db.table("outbox").bulkDelete(ids);
					}
				}
			}

			const syncLog = await db.table("sync_log").get("local") || { last_sync: 0 };
			const pullResponse = await fetch(`/-/sync?since=${syncLog.last_sync}`);
			if (pullResponse.ok) {
				const data = await pullResponse.json();
				await db.transaction("rw", db.chats, db.messages, db.artifacts, db.sync_log, async () => {
					if (data.chats.length > 0) await db.chats.bulkPut(data.chats.map(c => ({...c, _fromSync: true})));
					if (data.messages.length > 0) await db.messages.bulkPut(data.messages.map(m => ({...m, _fromSync: true})));
					if (data.artifacts.length > 0) await db.artifacts.bulkPut(data.artifacts.map(a => ({...a, _fromSync: true})));
					await db.sync_log.put({ client_id: "local", last_sync: data.timestamp });
				});
			}
		} catch (error) {
			console.error("Sync failed:", error);
		}
	}

	#getClientId() {
		let id = this.load("client_id");
		if (!id) {
			id = crypto.randomUUID();
			this.store("client_id", id);
		}
		return id;
	}
}

let storageDB;

export async function connectDB() {
	if (storageDB) return;
	storageDB = new StorageDB();
	await storageDB.init();
}

export function store(key, value = false) {
	if (!storageDB) return;
	storageDB.store(key, value);
}

export function load(key, fallback = false) {
	if (!storageDB) return fallback;
	return storageDB.load(key, fallback);
}

export function onChange(listener) {
	if (!storageDB) return () => {};
	return storageDB.onChange(listener);
}

export async function refresh(keys = []) {
	return new Map();
}

export function uuidv4() {
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}
