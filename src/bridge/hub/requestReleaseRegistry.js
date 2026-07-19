export class RequestReleaseRegistry {
  constructor({ recordDebugEvent, publishClientChanged } = {}) {
    this.recordDebugEvent = recordDebugEvent;
    this.publishClientChanged = publishClientChanged;
  }

  begin(client, requestId, commandId = '') {
    if (!client) return null;
    const id = String(requestId || '');
    if (!id) return null;
    const existing = client.releasePending;
    if (existing?.requestId === id && existing.status !== 'failed') {
      if (commandId) existing.commandId = String(commandId);
      return client;
    }
    if (existing?.requestId && existing.requestId !== id && existing.status === 'pending') {
      throw new Error(`Browser extension client ${client.id} is still releasing ${existing.requestId}`);
    }
    client.releasePending = {
      requestId: id,
      commandId: String(commandId || ''),
      startedAt: Date.now(),
      status: 'pending',
      error: '',
      waiters: new Set(),
    };
    this.recordDebugEvent(client.id, { type: 'request.release.pending', requestId: id, commandId: String(commandId || '') });
    this.publishClientChanged(client);
    return client;
  }

  fail(client, requestId = '', error = null) {
    if (!client?.releasePending) return false;
    const expectedRequestId = String(requestId || '');
    if (expectedRequestId && client.releasePending.requestId !== expectedRequestId) return false;
    this.settle(client, { requestId: client.releasePending.requestId, commandId: client.releasePending.commandId }, error instanceof Error ? error : new Error(String(error || `Browser release failed for ${client.releasePending.requestId}`)));
    return true;
  }

  wait(client, requestId = '', timeoutMs = 10_500) {
    if (!client) return Promise.reject(new Error('Browser extension client not found'));
    const pending = client.releasePending;
    const expectedRequestId = String(requestId || '');
    if (!pending || (expectedRequestId && pending.requestId !== expectedRequestId)) return Promise.resolve({ released: true, clientId: client.id, requestId: expectedRequestId });
    if (pending.status === 'failed') return Promise.reject(new Error(pending.error || `Browser release failed for ${pending.requestId}`));
    const limitMs = Math.max(100, Number(timeoutMs) || 10_500);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        pending.waiters.delete(waiter);
        reject(new Error(`Timed out waiting for browser release of ${pending.requestId} after ${limitMs}ms`));
      }, limitMs);
      waiter.timer.unref?.();
      pending.waiters.add(waiter);
    });
  }

  settle(client, payload = {}, error = null) {
    const pending = client?.releasePending;
    if (!pending) return;
    if (payload.commandId && pending.commandId && String(payload.commandId) !== pending.commandId) return;
    const waiters = Array.from(pending.waiters || []);
    pending.waiters?.clear?.();
    if (error) {
      pending.status = 'failed';
      pending.error = error.message || String(error);
      this.recordDebugEvent(client.id, { type: 'request.release.failed', requestId: pending.requestId, commandId: pending.commandId, message: pending.error });
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    } else {
      client.releasePending = null;
      this.recordDebugEvent(client.id, { type: 'request.release.settled', requestId: pending.requestId, commandId: pending.commandId });
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve({ released: true, clientId: client.id, requestId: pending.requestId });
      }
    }
    this.publishClientChanged(client);
  }
}
