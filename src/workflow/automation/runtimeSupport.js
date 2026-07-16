export function nowIso() {
  return new Date().toISOString();
}

export function timestampKey() {
  return nowIso().replace(/[:.]/g, '-');
}

export function sleep(ms, signal) {
  if (signal?.aborted) {
    return Promise.reject(Object.assign(new Error('Workflow automation interrupted'), {
      code: 'WORKFLOW_AUTOMATION_INTERRUPTED',
    }));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      reject(Object.assign(new Error('Workflow automation interrupted'), {
        code: 'WORKFLOW_AUTOMATION_INTERRUPTED',
      }));
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

export function turnResult(snapshot = {}) {
  const turn = snapshot.turn || {};
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  const agentMessages = items.filter((item) => item?.type === 'agent_message');
  const answer = String(agentMessages.at(-1)?.content?.text || turn.output?.answer || turn.output?.text || '');
  const fileId = String(turn.output?.fileId || turn.output?.result?.fileId || '');
  const response = turn.output?.response || turn.output?.result?.response || {};
  return { turn, items, answer, fileId, response, status: String(turn.status || '') };
}
