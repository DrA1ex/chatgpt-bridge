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
    const items = Array.isArray(payload.items) ? payload.items : [];
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
    const normalized = (Array.isArray(artifacts) ? artifacts : [])
      .map((artifact) => ({ ...artifact, requestId, sourceClientId: artifact.sourceClientId || clientId }));
    state.artifacts = normalized;
    return normalized;
  }

  sessionSnapshot(state, session) {
    state.session = session || null;
    return state.session;
  }
}
