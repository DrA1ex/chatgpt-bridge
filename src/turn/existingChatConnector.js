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
      && !client.quarantined && !client.releasePending && !client.activeRequest?.requestId);
    const client = sourceClientId ? clients.find((candidate) => candidate.id === sourceClientId)
      : clients.length === 1 ? clients[0] : null;
    if (!client) throw new Error('Choose an idle, compatible ChatGPT browser tab first');
    return client;
  }

  async list({ sourceClientId } = {}) {
    const client = this.#source(sourceClientId);
    const sessions = await this.bridge.listSessions({ sourceClientId: client.id });
    const chats = [...new Map(sessions.filter((session) => concreteSession(session.id))
      .map((session) => [session.id, { id: session.id, title: String(session.title || session.id) }])).values()];
    return { sourceClientId: client.id, chats };
  }

  async attach({ sourceClientId, sessionId } = {}) {
    if (!concreteSession(sessionId)) throw new Error('A concrete ChatGPT sessionId is required');
    return await this.#mutex.runExclusive(async () => {
      const { sourceClientId: clientId, chats } = await this.list({ sourceClientId });
      const chat = chats.find((candidate) => candidate.id === sessionId);
      if (!chat) throw new Error('Chat is not available in the selected browser tab');
      const [existing] = await this.metadataStore.listThreads({ sessionId, limit: 1 });
      if (existing) return { thread: publicThread(existing), reused: true };

      const client = this.#source(clientId);
      if (client.session?.id !== sessionId) {
        await this.bridge.selectSession(sessionId, { sourceClientId: clientId });
      }
      const history = await this.bridge.readConversationHistory(sessionId, { sourceClientId: clientId });
      const ids = new Set();
      for (const message of history) {
        if (typeof message?.id !== 'string' || !message.id || ids.has(message.id)
          || !['user', 'assistant'].includes(message.role) || typeof message.text !== 'string') {
          throw new Error('Invalid imported conversation history');
        }
        ids.add(message.id);
      }
      const thread = await this.turnManager.createThread({
        title: chat.title,
        sessionId,
        metadata: { importedChat: true, importedMessages: history },
      });
      return { thread, reused: false };
    });
  }
}
