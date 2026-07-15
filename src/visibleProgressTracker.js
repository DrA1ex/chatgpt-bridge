function text(value) { return typeof value === 'string' ? value : ''; }
function iso(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}
function logicalId(item, index) {
  return String(item?.id || item?.key || `${item?.kind || 'progress'}:${item?.structuralHint || index}`);
}
function itemType(kind) { return kind === 'thinking' ? 'reasoning' : 'progress'; }
function itemStatus(item) { return item?.state === 'completed' || item?.active === false ? 'completed' : 'in_progress'; }

function publicProgressEvent(content = {}, extras = {}) {
  return {
    logicalId: String(content.logicalId || ''),
    kind: String(content.kind || 'progress'),
    text: text(content.text),
    state: String(content.state || ''),
    active: Boolean(content.active),
    visible: Boolean(content.visible),
    revision: Number(content.revision || 0),
    ...extras,
  };
}

function normalizedContent(item, previous = null, extras = {}) {
  const nextText = text(item?.text);
  const preservedText = nextText || text(previous?.text);
  return {
    ...(previous || {}),
    logicalId: extras.logicalId || previous?.logicalId || '',
    kind: item?.kind || previous?.kind || 'progress',
    text: preservedText,
    state: item?.state || previous?.state || (item?.active === false ? 'completed' : 'active'),
    active: typeof item?.active === 'boolean' ? item.active : previous?.active ?? true,
    visible: typeof item?.visible === 'boolean' ? item.visible : previous?.visible ?? true,
    revision: Math.max(Number(previous?.revision || 0), Number(item?.revision || 0)),
    firstSeenAt: iso(item?.firstSeenAt) || previous?.firstSeenAt || extras.now,
    lastSeenAt: iso(item?.lastSeenAt) || extras.now || previous?.lastSeenAt || '',
    structuralHint: item?.structuralHint || previous?.structuralHint || '',
    source: item?.source || previous?.source || extras.source || '',
    testIds: Array.isArray(item?.testIds) ? item.testIds : previous?.testIds || [],
    nodeToken: item?.nodeToken || previous?.nodeToken || '',
    recovered: Boolean(extras.recovered || previous?.recovered),
    resumed: Boolean(extras.resumed || previous?.resumed),
  };
}

export class VisibleProgressTracker {
  constructor({ metadataStore, threadId, turnId, createId, record, resumed = false, recovered = false }) {
    this.metadataStore = metadataStore;
    this.threadId = threadId;
    this.turnId = turnId;
    this.createId = createId;
    this.record = record;
    this.resumed = resumed;
    this.recovered = recovered;
    this.items = new Map();
    this.fallback = null;
    this.structuredSeen = false;
    this.queue = Promise.resolve();
  }

  #enqueue(operation) {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => {});
    return run;
  }

  async #create(type, status, content) {
    const item = await this.metadataStore.createItem({
      id: this.createId(),
      threadId: this.threadId,
      turnId: this.turnId,
      type,
      status,
      content,
    });
    await this.record('item/started', { item, resumed: this.resumed, recovered: this.recovered });
    return item;
  }

  updateThinking(value, metadata = {}) {
    return this.#enqueue(() => this.#updateThinking(value, metadata));
  }

  async #updateThinking(value, metadata = {}) {
    const nextText = text(value);
    if (this.structuredSeen) return;
    const now = new Date().toISOString();
    if (!this.fallback) {
      if (!nextText) return;
      const content = {
        logicalId: 'snapshot-thinking', kind: 'thinking', text: nextText,
        state: 'active', active: true, visible: true, revision: 1,
        firstSeenAt: now, lastSeenAt: now, source: metadata?.source || metadata?.type || 'thinking.snapshot',
        testIds: [], resumed: this.resumed, recovered: this.recovered,
      };
      const item = await this.#create('reasoning', 'in_progress', content);
      this.fallback = { itemId: item.id, content };
    } else if (nextText) {
      const content = { ...this.fallback.content, text: nextText, revision: Number(this.fallback.content.revision || 0) + 1, lastSeenAt: now, visible: true };
      await this.metadataStore.updateItem(this.fallback.itemId, { status: 'in_progress', content });
      this.fallback.content = content;
    } else {
      // A disappearing reasoning DOM node is a lifecycle signal, not permission
      // to erase the last non-empty text.
      const content = { ...this.fallback.content, visible: false, lastSeenAt: now };
      await this.metadataStore.updateItem(this.fallback.itemId, { status: 'in_progress', content });
      this.fallback.content = content;
    }
    await this.record('item/reasoning/snapshot', publicProgressEvent(this.fallback?.content, {
      itemId: this.fallback?.itemId || '',
      status: 'in_progress',
      chars: nextText.length,
      cleared: !nextText,
      preservedChars: this.fallback?.content?.text?.length || 0,
      resumed: this.resumed,
    }));
  }

  updateItems(value, metadata = {}) {
    return this.#enqueue(() => this.#updateItems(value, metadata));
  }

  async #updateItems(value, metadata = {}) {
    const incoming = Array.isArray(value) ? value : [];
    if (!incoming.length) return;
    this.structuredSeen = true;
    const now = new Date().toISOString();
    for (let index = 0; index < incoming.length; index += 1) {
      const sourceItem = incoming[index] || {};
      const id = logicalId(sourceItem, index);
      let tracked = this.items.get(id) || null;
      const type = itemType(sourceItem.kind);
      if (!tracked && type === 'reasoning' && this.fallback) {
        tracked = { itemId: this.fallback.itemId, content: this.fallback.content, status: 'in_progress', type };
        this.fallback = null;
      }
      const content = normalizedContent(sourceItem, tracked?.content, {
        logicalId: id,
        now,
        source: metadata?.source || metadata?.type || 'assistant.progress.snapshot',
        resumed: this.resumed,
        recovered: this.recovered,
      });
      const status = itemStatus(sourceItem);
      if (!tracked) {
        const created = await this.#create(type, status, content);
        tracked = { itemId: created.id, content, status, type };
      } else {
        const nextStatus = tracked.status === 'completed' ? 'completed' : status;
        await this.metadataStore.updateItem(tracked.itemId, { status: nextStatus, content });
        tracked = { ...tracked, content, status: nextStatus, type };
      }
      this.items.set(id, tracked);
      await this.record(type === 'reasoning' ? 'item/reasoning/snapshot' : 'item/progress/snapshot', publicProgressEvent(content, {
        itemId: tracked.itemId,
        status: tracked.status,
        chars: content.text.length,
        resumed: this.resumed,
        recovered: this.recovered,
      }));
    }
  }

  async finalize(response = {}) {
    await this.queue;
    const merged = [];
    const seen = new Map();
    for (const source of [response.progressItems, response.reasoningHistory]) {
      for (const item of Array.isArray(source) ? source : []) {
        const id = logicalId(item, merged.length);
        const previous = seen.get(id);
        if (!previous || Number(item?.revision || 0) >= Number(previous?.revision || 0) || (!previous?.text && item?.text)) seen.set(id, item);
      }
    }
    merged.push(...seen.values());
    if (merged.length) await this.#updateItems(merged, { source: 'response.done' });

    const now = new Date().toISOString();
    for (const [id, tracked] of this.items) {
      const content = { ...tracked.content, state: 'completed', active: false, visible: Boolean(tracked.content.visible), lastSeenAt: tracked.content.lastSeenAt || now };
      await this.metadataStore.updateItem(tracked.itemId, { status: 'completed', content });
      this.items.set(id, { ...tracked, status: 'completed', content });
      await this.record(tracked.type === 'reasoning' ? 'item/reasoning/completed' : 'item/progress/completed', publicProgressEvent(content, {
        itemId: tracked.itemId,
        status: 'completed',
        chars: content.text.length,
        resumed: this.resumed,
        recovered: this.recovered,
      }));
    }

    if (this.fallback) {
      const finalText = text(response.thinking) || text(this.fallback.content.text);
      const content = {
        ...this.fallback.content,
        text: finalText,
        state: 'completed', active: false, visible: false, lastSeenAt: now,
      };
      await this.metadataStore.updateItem(this.fallback.itemId, { status: 'completed', content });
      await this.record('item/reasoning/completed', publicProgressEvent(content, {
        itemId: this.fallback.itemId,
        status: 'completed',
        chars: finalText.length,
        preserved: !response.thinking,
        resumed: this.resumed,
        recovered: this.recovered,
      }));
      this.fallback.content = content;
    } else if (!this.items.size && text(response.thinking)) {
      await this.#updateThinking(response.thinking, { source: 'response.done' });
      const content = {
        ...this.fallback.content,
        state: 'completed', active: false, visible: false, lastSeenAt: now,
      };
      await this.metadataStore.updateItem(this.fallback.itemId, { status: 'completed', content });
      await this.record('item/reasoning/completed', publicProgressEvent(content, {
        itemId: this.fallback.itemId,
        status: 'completed',
        chars: content.text.length,
        resumed: this.resumed,
        recovered: this.recovered,
      }));
      this.fallback.content = content;
    }
  }
}
