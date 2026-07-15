function timeoutError(message, timeoutMs) {
  const error = new Error(`${message} after ${timeoutMs}ms`);
  error.code = 'E2E_PUBLIC_STREAM_TIMEOUT';
  return error;
}

function parseBlock(block = '') {
  let event = 'message';
  const data = [];
  for (const line of String(block).split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim() || 'message';
    else if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
  }
  if (!data.length) return null;
  const raw = data.join('\n');
  let value = raw;
  try { value = JSON.parse(raw); } catch {}
  return { event, data: value };
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutError(message, timeoutMs)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function openPublicTurnEventStream(options, turnId, { timeoutMs = 360_000, onRecord = null } = {}) {
  const controller = new AbortController();
  const records = [];
  let sequence = 0;
  let readyResolve;
  let readyReject;
  let doneResolve;
  let doneReject;
  const readyPromise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const donePromise = new Promise((resolve, reject) => { doneResolve = resolve; doneReject = reject; });

  const runPromise = (async () => {
    const headers = { Accept: 'text/event-stream' };
    if (options.apiToken) headers.Authorization = `Bearer ${options.apiToken}`;
    const url = `${options.baseUrl}/turns/${encodeURIComponent(turnId)}/events?stream=1&recent=0&wait=1`;
    const response = await fetch(url, { headers, signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`Public turn stream failed (${response.status}): ${await response.text()}`);
    if (!response.body) throw new Error('Public turn stream returned no response body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const separator = buffer.search(/\r?\n\r?\n/);
        if (separator < 0) break;
        const match = buffer.slice(separator).match(/^\r?\n\r?\n/);
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + (match?.[0]?.length || 2));
        const parsed = parseBlock(block);
        if (!parsed) continue;
        const record = {
          ...parsed,
          sequence: ++sequence,
          receivedAt: new Date().toISOString(),
          receivedAtMs: Date.now(),
        };
        records.push(record);
        if (typeof onRecord === 'function') {
          try { onRecord(record); } catch {}
        }
        if (record.event === 'ready') readyResolve(record);
        if (record.event === 'error') {
          const error = new Error(record.data?.error || 'Public turn stream reported an error');
          readyReject(error);
          doneReject(error);
        }
        if (record.event === 'done') doneResolve(record);
      }
    }
    doneResolve(records.at(-1) || null);
  })();

  runPromise.catch((error) => {
    if (error?.name === 'AbortError' && controller.signal.aborted) return;
    readyReject(error);
    doneReject(error);
  });

  return {
    turnId,
    records,
    waitReady: (waitMs = 15_000) => withTimeout(readyPromise, waitMs, `Timed out waiting for public turn stream readiness for ${turnId}`),
    waitDone: (waitMs = timeoutMs) => withTimeout(donePromise, waitMs, `Timed out waiting for public turn stream completion for ${turnId}`),
    close() { controller.abort(); },
  };
}
