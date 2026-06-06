import { db, uuidv4 } from "./storage.js";

export async function getChats() {
    if (!db) return [];
    return await db.chats.orderBy("updated_at").reverse().toArray();
}

export async function getChat(id) {
    if (!db) return null;
    return await db.chats.get(id);
}

export async function saveChat(chat) {
    if (!db) return;
    const now = Date.now();
    chat.updated_at = now;
    if (!chat.id) {
        chat.id = uuidv4();
        chat.created_at = now;
    }
    chat.deleted = false;
    await db.chats.put(chat);
    return chat;
}

export async function deleteChat(id) {
    if (!db) return;
    const chat = await db.chats.get(id);
    if (chat) {
        chat.deleted = true;
        chat.updated_at = Date.now();
        await db.chats.put(chat);
    }
}

export async function getMessages(chatId) {
    if (!db) return [];
    return await db.messages.where("chat_id").equals(chatId).sortBy("created_at");
}

export async function saveMessage(message) {
    if (!db) return;
    const now = Date.now();
    message.updated_at = now;
    if (!message.id) {
        message.id = uuidv4();
        message.created_at = now;
    }
    message.deleted = false;
    await db.messages.put(message);
    return message;
}

export async function deleteMessage(id) {
    if (!db) return;
    const msg = await db.messages.get(id);
    if (msg) {
        msg.deleted = true;
        msg.updated_at = Date.now();
        await db.messages.put(msg);
    }
}

export async function getArtifacts(messageId) {
    if (!db) return [];
    return await db.artifacts.where("message_id").equals(messageId).toArray();
}

export async function saveArtifact(artifact) {
    if (!db) return;
    const now = Date.now();
    artifact.updated_at = now;
    if (!artifact.id) {
        artifact.id = uuidv4();
        artifact.created_at = now;
    }
    artifact.deleted = false;
    await db.artifacts.put(artifact);
    return artifact;
}
