import { appendOnlyDelta } from '../../protocol.js';
import { completedReasoningRecords, mergeProgressRecords } from '../requestState.js';

function progressSignature(items = []) {
  return JSON.stringify(items.map((item) => [
    item?.id || item?.key || '', item?.revision || 0, item?.kind || '', item?.text || '',
    item?.state || '', item?.active ? 'active' : '', item?.visible ? 'visible' : '',
  ]));
}

/**
 * Materializes output fields for public callbacks. It deliberately has no
 * terminal operation: only the canonical request coordinator can finish work.
 */
export class RequestResultAccumulator {
  thinkingDelta(state, value) {
    const delta = String(value || '');
    if (!delta) return null;
    state.thinking += delta;
    return { text: state.thinking, delta };
  }

  thinkingSnapshot(state, value) {
    const text = String(value || '');
    if (text === state.thinking) return null;
    const delta = appendOnlyDelta(state.thinking, text);
    state.thinking = text;
    return { text, delta };
  }

  answerDelta(state, value) {
    const delta = String(value || '');
    if (!delta) return null;
    state.answer += delta;
    return { text: state.answer, delta };
  }

  answerSnapshot(state, value) {
    const text = String(value || '');
    if (!text || text === state.answer) return null;
    const delta = appendOnlyDelta(state.answer, text);
    state.answer = text;
    return { text, delta };
  }

  progressSnapshot(state, payload = {}) {
    const text = String(payload.text || payload.progress || '');
    const incomingItems = Array.isArray(payload.items) ? payload.items : [];
    const previousById = new Map((Array.isArray(state.progressItems) ? state.progressItems : []).map((item, index) => [
      String(item?.id || item?.key || `${item?.kind || 'progress'}:${item?.structuralHint || index}`),
      item,
    ]));
    const items = incomingItems.map((item, index) => {
      const id = String(item?.id || item?.key || `${item?.kind || 'progress'}:${item?.structuralHint || index}`);
      const previous = previousById.get(id);
      const reasoning = item?.kind === 'thinking' || previous?.kind === 'thinking';
      return previous && reasoning ? mergeProgressRecords([previous], [item])[0] : item;
    });
    const signature = progressSignature(items);
    if (text === state.progressText && signature === state.progressItemsSignature) return null;
    const delta = appendOnlyDelta(state.progressText || '', text);
    state.progressText = text;
    state.progressItems = items;
    state.progressItemsSignature = signature;
    state.reasoningHistory = mergeProgressRecords(state.reasoningHistory, completedReasoningRecords(items));
    return { text, items, delta };
  }

  artifactSnapshot(state, artifacts, requestId, clientId) {
    const previous = Array.isArray(state.artifacts) ? state.artifacts : [];
    const byId = new Map();
    for (const artifact of previous) {
      const phase = String(artifact?.phase || artifact?.state || 'READY').toUpperCase();
      const durable = Boolean(artifact?.id)
        && !/GENERAT|PEND|LOAD|RUN|QUEU|FAIL|ERROR/.test(phase)
        && Boolean(artifact?.downloadable || artifact?.kind === 'image');
      if (durable) byId.set(artifact.id, artifact);
    }
    for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
      if (!artifact?.id) continue;
      const normalized = {
        ...(byId.get(artifact.id) || {}),
        ...artifact,
        requestId,
        sourceClientId: artifact.sourceClientId || clientId,
      };
      byId.set(artifact.id, normalized);
    }
    const normalized = [...byId.values()];
    state.artifacts = normalized;
    return normalized;
  }

  sessionSnapshot(state, session) {
    state.session = session || null;
    return state.session;
  }
}
