import { makeRequestId } from '../protocol.js';

export function nowIso() { return new Date().toISOString(); }
export function clean(value) { return typeof value === 'string' ? value.trim() : ''; }
export function compactId(prefix) { return `${prefix}_${makeRequestId().replace(/[^a-zA-Z0-9_-]/g, '')}`; }

export function normalizeAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === 'string' ? item : item?.id || item?.fileId || '')).filter(Boolean);
}

export function normalizeInputParts(input) {
  if (typeof input === 'string') return [{ type: 'text', text: input }];
  if (Array.isArray(input)) return input;
  if (input && typeof input === 'object') return [input];
  return [];
}

export function textFromInput(input) {
  const parts = normalizeInputParts(input);
  return parts.map((part) => {
    if (typeof part === 'string') return part;
    if (part?.type === 'text') return part.text || '';
    if (typeof part?.text === 'string') return part.text;
    if (typeof part?.content === 'string') return part.content;
    return '';
  }).filter(Boolean).join('\n').trim();
}

export function publicThread(thread) { return thread ? { ...thread } : null; }
export function publicTurn(turn) { return turn ? { ...turn } : null; }

export function trackAsync(list, task) {
  if (!task || typeof task.then !== 'function') return task;
  const tracked = Promise.resolve(task);
  list.push(tracked);
  return tracked;
}

export async function drainTrackedAsync(list) {
  while (list.length) {
    const batch = list.splice(0, list.length);
    await Promise.all(batch);
  }
}

export function createAgentMessageWriter({ metadataStore, threadId, turnId, record, resumed = false }) {
  let itemId = '';
  let tail = Promise.resolve();
  const enqueue = (operation) => {
    const task = tail.then(operation);
    tail = task.catch(() => {});
    return task;
  };
  const ensure = async () => {
    if (itemId) return itemId;
    const item = await metadataStore.createItem({
      id: compactId('item'),
      threadId,
      turnId,
      type: 'agent_message',
      status: 'in_progress',
      content: { text: '' },
    });
    itemId = item.id;
    await record('item/started', { item, ...(resumed ? { resumed: true } : {}) });
    return itemId;
  };
  return {
    update(text) {
      return enqueue(async () => {
        const id = await ensure();
        await metadataStore.updateItem(id, { status: 'in_progress', content: { text } });
        await record('item/agentMessage/delta', { itemId: id, text, chars: text.length, ...(resumed ? { resumed: true } : {}) });
      });
    },
    finish(response = {}) {
      return enqueue(async () => {
        if (!response.answer && !itemId) return '';
        const id = await ensure();
        await metadataStore.updateItem(id, {
          status: 'completed',
          content: {
            text: response.answer || '',
            blocks: response.responseBlocks || [],
            codeBlocks: response.codeBlocks || [],
            codeBlockDiagnostics: response.codeBlockDiagnostics || [],
            parserAudit: response.parserAudit || null,
            format: response.format || '',
          },
        });
        await record('item/agentMessage/completed', { itemId: id, chars: String(response.answer || '').length, ...(resumed ? { resumed: true } : {}) });
        return id;
      });
    },
  };
}
