import { AsyncMutex } from '../mutex.js';
import { publicThread } from './turnManagerSupport.js';
import { annotateLocalDelivery, mergeConversationItems } from './conversationHistoryView.js';

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
    status: message.status === 'in_progress' ? 'in_progress' : 'completed',
    content: { text: message.text, imported: true, sourceMessageId: message.id },
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
  #live = new Map();

  constructor({ bridge, turnManager, metadataStore }) {
    this.bridge = bridge;
    this.turnManager = turnManager;
    this.metadataStore = metadataStore;
  }

  #source(sourceClientId, sessionId = '') {
    const clients = (this.bridge.health()?.clients || []).filter((client) =>
      client.compatible !== false && client.compatibility?.compatible !== false
      && !client.quarantined);
    const matching = clients.filter(client => client.session?.id === sessionId);
    const client = sourceClientId ? clients.find((candidate) => candidate.id === sourceClientId)
      : matching.length === 1 ? matching[0] : clients.length === 1 ? clients[0] : null;
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

  async refresh({ threadId, sourceClientId, background = false } = {}) {
    const thread = await this.metadataStore.getThread(threadId);
    if (!thread?.metadata?.importedChat || thread.archived) throw new Error('Choose an attached ChatGPT chat');
    return await this.attach({ sourceClientId, sessionId: thread.sessionId, refreshHistory: true, threadId, background });
  }

  async historyView(thread, localItems, turns = []) {
    if (!thread?.metadata?.importedChat) return { items: localItems };
    localItems = await annotateLocalDelivery(localItems, turns,
      turnId => this.metadataStore.listTurnEvents(turnId, { limit: 1000 }));
    const live = this.#live.get(thread.id) || null;
    const canonical = thread.metadata.importedHistory?.source === 'conversation-record';
    const imported = importedHistoryItems(thread);
    return {
      items: canonical ? mergeConversationItems(imported, localItems, live?.messages || [])
        : mergeConversationItems(imported, localItems, live?.messages || [], false),
      historyLive: live ? { generating: live.generating, observedAt: live.observedAt } : null,
    };
  }

  #rememberLive(threadId, history) {
    if (history.live?.generating) {
      this.#live.set(threadId, {
        generating: true, messages: history.live.messages || [], observedAt: Date.now(),
      });
      while (this.#live.size > 64) this.#live.delete(this.#live.keys().next().value);
    } else {
      this.#live.delete(threadId);
    }
  }

  async attach({ sourceClientId, sessionId, refreshHistory = false, threadId = '', background = false } = {}) {
    if (!concreteSession(sessionId)) throw new Error('A concrete ChatGPT sessionId is required');
    return await this.#mutex.runExclusive(async () => {
      const existing = threadId ? await this.metadataStore.getThread(threadId)
        : (await this.metadataStore.listThreads({ sessionId, limit: 1 }))[0];
      if (threadId && (!existing || existing.sessionId !== sessionId || existing.archived)) {
        throw new Error('Attached conversation changed');
      }
      if (existing && background) {
        const turns = await this.metadataStore.listTurns({ threadId: existing.id, limit: 1 });
        if (turns.some(turn => !['completed', 'completed_without_artifact', 'failed', 'cancelled', 'interrupted'].includes(turn.status))) {
          return { thread: publicThread(existing), reused: true, refreshed: false };
        }
      }
      const client = this.#source(sourceClientId, sessionId);
      if (existing && background && (client.activeRequest?.requestId || client.releasePending)) {
        return { thread: publicThread(existing), reused: true, refreshed: false };
      }
      const clientId = client.id;
      const chat = existing && refreshHistory ? { title: existing.title }
        : (await this.list({ sourceClientId: clientId })).chats.find(candidate => candidate.id === sessionId);
      if (!chat) throw new Error('Chat is not available in the selected browser tab');
      if (existing && (!refreshHistory || !existing.metadata?.importedChat)) {
        return { thread: publicThread(existing), reused: true };
      }

      // Prefer a same-origin record read: no navigation, including during
      // generation or a Bridge-owned lease. Only fall back to an idle tab.
      let history = await this.bridge.readConversationHistory(sessionId, { sourceClientId: clientId, background });
      if (history.status !== 'available' && !background) {
        const client = this.#source(clientId);
        if (client.session?.id !== sessionId && !history.sourceGenerating && !history.sourceRequestActive
          && !client.activeRequest?.requestId && !client.releasePending) {
          await this.bridge.selectSession(sessionId, { sourceClientId: clientId, onlyIfIdle: true });
          history = await this.bridge.readConversationHistory(sessionId, { sourceClientId: clientId });
        }
      }
      if (history.status !== 'available') {
        if (existing) this.#rememberLive(existing.id, history);
        if (existing && background) return { thread: publicThread(existing), reused: true, refreshed: false };
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
        this.#rememberLive(existing.id, history);
        // A validated complete branch replaces the provisional import, even
        // if earlier DOM snapshots contained commentary or different text.
        // Local execution records are not modified; the read view reconciles
        // them against this branch independently.
        if (history.source !== 'conversation-record' && existing.metadata.importedHistory?.source === 'conversation-record') {
          return { thread: publicThread(existing), reused: true, refreshed: false };
        }
        if (history.source !== 'conversation-record' && (await this.metadataStore.listTurns({ threadId: existing.id, limit: 1 })).length) {
          const prefix = extendImportedPrefix(existing.metadata.importedMessages || [], history.messages);
          if (!prefix) {
            if (background) return { thread: publicThread(existing), reused: true, refreshed: false };
            const previousCount = existing.metadata.importedMessages?.length || 0;
            throw new Error(`Cannot safely align older history with the imported prefix (${previousCount} saved, ${history.messages.length} fetched, source: ${history.source}). Existing history was preserved. Scroll to the older messages in ChatGPT and refresh again.`);
          }
          metadata.importedMessages = prefix;
          metadata.importedHistory.partial = Boolean(history.partial || existing.metadata.importedHistory?.partial);
        }
        if (JSON.stringify(metadata) === JSON.stringify(existing.metadata)) {
          return { thread: publicThread(existing), reused: true, refreshed: false };
        }
        const updated = await this.metadataStore.updateThread(existing.id, { metadata });
        return { thread: publicThread(updated), reused: true, refreshed: true };
      }
      const thread = await this.turnManager.createThread({ title: chat.title, sessionId, metadata });
      this.#rememberLive(thread.id, history);
      return { thread, reused: false };
    });
  }
}
