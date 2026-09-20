function normalizedText(value = '') {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function comparableText(value = '') {
  return normalizedText(value)
    .toLocaleLowerCase()
    .replace(/[\s.!?…·•:;,_-]+/gu, ' ')
    .trim();
}

function parsedTime(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

export function itemTimestamp(item = {}) {
  return parsedTime(item.createdAt || item.updatedAt);
}

export function mergeItemsById(baseItems = [], updates = []) {
  const ordered = [];
  const byId = new Map();

  const accept = (item, fallbackIndex) => {
    if (!item || typeof item !== 'object') return;
    const key = String(item.id || `${item.turnId || 'turn'}:${item.type || 'item'}:${fallbackIndex}`);
    const existing = byId.get(key);
    if (existing) {
      Object.assign(existing, item);
      return;
    }
    const copy = { ...item, _uiOrder: Number.isFinite(item._uiOrder) ? item._uiOrder : ordered.length };
    byId.set(key, copy);
    ordered.push(copy);
  };

  baseItems.forEach(accept);
  updates.forEach((item, index) => accept(item, baseItems.length + index));
  ordered.sort((left, right) => (
    itemTimestamp(left) - itemTimestamp(right)
    || Number(left._uiOrder || 0) - Number(right._uiOrder || 0)
  ));
  return ordered;
}

export function isUiActionText(value = '') {
  const text = comparableText(value);
  return /^(?:edit|edit message|edit response|copy|copy response|share|retry|regenerate|download|open|save|preview|full screen|редактировать|редактировать сообщение|редактировать ответ|копировать|скопировать|поделиться|повторить|скачать|открыть|сохранить|предпросмотр)$/iu.test(text);
}

function isReasoningNoise(value = '') {
  const text = normalizedText(value);
  if (!text || isUiActionText(text)) return true;
  if (/^(?:thinking|thoughts?|думаю)[\s.!?…·•:;-]*$/iu.test(text)) return true;
  if (/^#?\d+\s*[·•]\s*(?:active|completed|in_progress)(?:\s*[·•].*)?$/i.test(text)) return true;
  return false;
}

function reasoningBlocks(value = '') {
  const blocks = [];
  for (const paragraph of normalizedText(value).split(/\n{2,}/)) {
    for (const line of paragraph.split(/\n+/)) {
      const text = normalizedText(line);
      if (!isReasoningNoise(text)) blocks.push(text);
    }
  }
  return blocks;
}

function reasoningSortValue(entry) {
  const content = entry.item?.content || {};
  const sequence = Number(content.sequence || entry.item?.sequence || 0);
  return {
    hasSequence: sequence > 0,
    sequence,
    firstSeenAt: parsedTime(content.firstSeenAt),
    createdAt: itemTimestamp(entry.item),
    index: entry.index,
  };
}

export function historicalReasoningSteps(items = [], turnId = '') {
  const candidates = items
    .map((item, index) => ({ item, index, sort: null }))
    .filter(({ item }) => item?.type === 'reasoning' && (!turnId || item.turnId === turnId));

  for (const entry of candidates) entry.sort = reasoningSortValue(entry);
  candidates.sort((left, right) => {
    if (left.sort.hasSequence && right.sort.hasSequence && left.sort.sequence !== right.sort.sequence) {
      return left.sort.sequence - right.sort.sequence;
    }
    return left.sort.firstSeenAt - right.sort.firstSeenAt
      || left.sort.createdAt - right.sort.createdAt
      || left.sort.index - right.sort.index;
  });

  const result = [];
  const byText = new Map();
  for (const { item, sort } of candidates) {
    const content = item.content && typeof item.content === 'object' ? item.content : {};
    const blocks = reasoningBlocks(content.text || '');
    for (let index = 0; index < blocks.length; index += 1) {
      const text = blocks[index];
      const identity = comparableText(text);
      const existing = byText.get(identity);
      if (existing) {
        if (text.length > existing.text.length) existing.text = text;
        continue;
      }
      const step = {
        _uiId: `history:${item.id || content.logicalId || sort.index}:${index}`,
        sequence: sort.hasSequence ? sort.sequence + index : result.length + 1,
        text,
        state: item.status === 'completed' || content.active === false ? 'completed' : content.state || 'active',
        active: item.status !== 'completed' && content.active !== false,
        firstSeenAt: sort.firstSeenAt || sort.createdAt || sort.index,
        revision: Number(content.revision || 0),
        source: content.source || 'history',
      };
      byText.set(identity, step);
      result.push(step);
    }
  }

  result.sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0)
    || Number(left.firstSeenAt || 0) - Number(right.firstSeenAt || 0));
  return result.map((step, index) => ({ ...step, sequence: index + 1 }));
}

function artifactCandidate(value, fallbackId = '') {
  if (!value || typeof value !== 'object') return null;
  const id = String(value.id || value.artifactId || fallbackId || '').trim();
  return id ? { ...value, id } : null;
}

export function artifactsFromItem(item = {}) {
  const content = item.content && typeof item.content === 'object' ? item.content : {};
  const values = [];
  const accept = (value) => {
    const artifact = artifactCandidate(value, item.artifactId);
    if (artifact) values.push(artifact);
  };

  accept(content.artifact);
  accept(item.artifact);
  for (const value of content.artifacts || []) accept(value);
  for (const value of item.artifacts || []) accept(value);
  if (item.type === 'artifact' && (content.id || content.name || content.mime || content.kind || content.phase)) accept(content);
  if (!values.length && item.artifactId) accept({ ...content, id: item.artifactId, name: content.name || 'Artifact' });

  const byId = new Map();
  for (const artifact of values) {
    const previous = byId.get(artifact.id) || {};
    byId.set(artifact.id, { ...previous, ...artifact });
  }
  return [...byId.values()];
}
