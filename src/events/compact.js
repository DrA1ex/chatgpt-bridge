export function truncateValue(value, max = 800) {
  if (typeof value === 'string' && value.length > max) return `${value.slice(0, max)}…`;
  if (Array.isArray(value)) return value.map((item) => truncateValue(item, max));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, nested] of Object.entries(value)) {
      if (/contentBase64|base64|dataUrl|rawDom|html/i.test(key) && typeof nested === 'string') {
        result[key] = `<${nested.length} chars>`;
      } else {
        result[key] = truncateValue(nested, max);
      }
    }
    return result;
  }
  return value;
}

export function compactEventData(data = {}) {
  const result = {};
  for (const key of [
    'turnId', 'jobId', 'clientId', 'phase', 'previousPhase', 'reason', 'status', 'finishReason',
    'answerLength', 'thinkingLength', 'progressLength', 'artifactCount', 'artifactId', 'fileId',
    'text', 'delta', 'kind', 'itemCount', 'name', 'sourceClientId', 'sourceTurnKey', 'turnKey', 'assistantTurnKey', 'submittedUserTurnKey',
    'anchorConfidence', 'anchorReason', 'visibilityState', 'focused', 'message', 'expected', 'recovered',
    'meaningfulIdleMs', 'hardIdleMs', 'sourceAlive', 'generationActive', 'forcedSnapshotCount',
  ]) {
    if (data[key] !== undefined && data[key] !== null && data[key] !== '') result[key] = truncateValue(data[key], 220);
  }
  return result;
}

export function isNoisyRequestProgress(event = {}) {
  if (event.type !== 'request.progress') return false;
  const data = event.data || {};
  return data.meaningful === false || data.reason === 'dom.poll' || data.snapshotReason === 'dom.poll';
}
