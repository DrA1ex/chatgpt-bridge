import { AsyncMutex } from '../mutex.js';
import { publicThread } from './turnManagerSupport.js';

const concreteSession = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id) && id !== 'new';

export function importedHistoryItems(thread) {
  if (!thread?.metadata?.importedChat || !Array.isArray(thread.metadata.importedMessages)) return [];
  // Imported messages have no local execution time. Preserve source order
  // and do not manufacture completed local turns.
  return thread.metadata.importedMessages.map((message) => ({
    id: `${thread.id}:import:${message.id}`,
    threadId: thread.id,
    turnId: `${thread.id}:import:${message.id}`,
    type: message.role === 'user' ? 'user_message' : 'agent_message',
    status: 'completed',
    content: { text: message.text, imported: true },
  }));
}

// After local turns exist, prepend only history proven to precede the
// original prefix. Never reimport locally executed responses.
export function extendImportedPrefix(previous, next) {
  if (!previous.length) return previous;
  const nativeId = message => {
    const id = String(message.id).replace(/^(user|assistant):/, '');
    return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id) ? id : '';
  };
  const normalize = text => String(text).replace(/\s+/g, ' ').trim();
  const equal = (a, b) => {
    if (a.role !== b.role) return false;
    const left = nativeId(a);
    const right = nativeId(b);
    return left && right ? left === right : normalize(a.text) === normalize(b.text);
  };
  const matches = [];
  for (let index = 0; index < next.length; index++) {
    const count = Math.min(previous.length, next.length - index);
    if (!previous.slice(0, count).every((message, offset) => equal(message, next[index + offset]))) continue;
    // A partial window is sufficient only if it includes a native identity
    // or an adjacent user/assistant pair. Never align a repeated prompt alone.
    const strong = previous.slice(0, count).some((message, offset) =>
      nativeId(message) && nativeId(message) === nativeId(next[index + offset]));
    if (count < previous.length && !strong && !(count >= 2 && previous.slice(0, count).some(message => message.role === 'assistant'))) continue;
    matches.push(index);
  }
  if (matches.length !== 1) return null;
  const ids = new Set(previous.map(message => nativeId(message) || message.id));
  const prefix = next.slice(0, matches[0]);
  if (prefix.some(message => ids.has(nativeId(message) || message.id))) return null;
  return [...prefix, ...previous];
}

export class ExistingChatConnector {
  #mutex = new AsyncMutex();

  constructor({ bridge, turnManager, metadataStore }) {
    this.bridge = bridge;
    this.turnManager = turnManager;
    this.metadataStore = metadataStore;
  }

  #source(sourceClientId) {
    const clients = (this.bridge.health()?.clients || []).filter((client) =>
      client.compatible !== false && client.compatibility?.compatible !== false
      && !client.quarantined);
    const client = sourceClientId ? clients.find((candidate) => candidate.id === sourceClientId)
      : clients.length === 1 ? clients[0] : null;
    if (!client) throw new Error('Choose a compatible ChatGPT browser tab first');
    return client;
  }

  async list({ sourceClientId } = {}) {
    const client = this.#source(sourceClientId);
    const sessions = await this.bridge.listSessions({ sourceClientId: client.id });
    const chats = [...new Map(sessions.filter((session) => concreteSession(session.id))
      .map((session) => [session.id, { id: session.id, title: String(session.title || session.id) }])).values()];
    return { sourceClientId: client.id, chats };
  }

  async attach({ sourceClientId, sessionId, refreshHistory = false } = {}) {
    if (!concreteSession(sessionId)) throw new Error('A concrete ChatGPT sessionId is required');
    return await this.#mutex.runExclusive(async () => {
      const { sourceClientId: clientId, chats } = await this.list({ sourceClientId });
      const chat = chats.find((candidate) => candidate.id === sessionId);
      if (!chat) throw new Error('Chat is not available in the selected browser tab');
      const [existing] = await this.metadataStore.listThreads({ sessionId, limit: 1 });
      if (existing && (!refreshHistory || !existing.metadata?.importedChat)) {
        return { thread: publicThread(existing), reused: true };
      }

      // Prefer a same-origin record read: no navigation, including during
      // generation or a Bridge-owned lease. Only fall back to an idle tab.
      let history = await this.bridge.readConversationHistory(sessionId, { sourceClientId: clientId });
      if (history.status !== 'available') {
        const client = this.#source(clientId);
        if (client.session?.id !== sessionId && !history.sourceGenerating
          && !client.activeRequest?.requestId && !client.releasePending) {
          await this.bridge.selectSession(sessionId, { sourceClientId: clientId, onlyIfIdle: true });
          history = await this.bridge.readConversationHistory(sessionId, { sourceClientId: clientId });
        }
      }
      if (history.status !== 'available') {
        throw new Error(`ChatGPT history unavailable: ${history.reason || 'unknown'}.`
          + ' Open this conversation in a separate ChatGPT tab and try again.');
      }
      const ids = new Set();
      for (const message of history.messages) {
        if (typeof message?.id !== 'string' || !message.id || ids.has(message.id)
          || !['user', 'assistant'].includes(message.role) || typeof message.text !== 'string') {
          throw new Error('Invalid imported conversation history');
        }
        ids.add(message.id);
      }
      const metadata = {
        ...(existing?.metadata || {}),
        importedChat: true,
        importedMessages: history.messages,
        importedHistory: { source: history.source, partial: Boolean(history.partial), reason: history.reason || '' },
      };
      if (existing) {
        if ((await this.metadataStore.listTurns({ threadId: existing.id, limit: 1 })).length) {
          const prefix = extendImportedPrefix(existing.metadata.importedMessages || [], history.messages);
          if (!prefix) {
            const previousCount = existing.metadata.importedMessages?.length || 0;
            throw new Error(`Cannot safely align older history with the imported prefix (${previousCount} saved, ${history.messages.length} fetched, source: ${history.source}). Existing history was preserved. Scroll to the older messages in ChatGPT and refresh again.`);
          }
          metadata.importedMessages = prefix;
          metadata.importedHistory.partial = Boolean(history.partial || existing.metadata.importedHistory?.partial);
        }
        const updated = await this.metadataStore.updateThread(existing.id, { metadata });
        return { thread: publicThread(updated), reused: true, refreshed: true };
      }
      const thread = await this.turnManager.createThread({ title: chat.title, sessionId, metadata });
      return { thread, reused: false };
    });
  }
}
