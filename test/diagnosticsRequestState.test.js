import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticsJsonFromRequest, sendDiagnosticsBundle } from '../src/http/diagnostics.js';

function createResponseCapture() {
  const headers = new Map();
  return {
    body: '',
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    send(body) { this.body = body; },
    header(name) { return headers.get(String(name).toLowerCase()); },
  };
}

test('diagnostics state and compact bundle include authoritative canonical request states', async () => {
  const canonicalRequestStates = [{
    requestId: 'request-1',
    state: { lifecycle: 'generating', revision: 4 },
    history: [],
  }];
  const bridge = {
    health() {
      return {
        transport: 'extension-websocket',
        clients: [],
        activeClient: null,
        selectedClientId: '',
        pendingRequests: 1,
        pendingCommands: 0,
        artifacts: 0,
      };
    },
    requestDiagnostics() { return []; },
    requestStateDiagnostics() { return canonicalRequestStates; },
    debugEvents() { return []; },
  };
  const eventBus = {
    recentRequestTimelines() { return []; },
    recentEvents() { return []; },
    recentDebugEvents() { return []; },
  };
  const req = { app: { locals: { bridge } } };

  const diagnostics = await diagnosticsJsonFromRequest(req, eventBus);
  assert.deepEqual(diagnostics.canonicalRequestStates, canonicalRequestStates);

  const res = createResponseCapture();
  sendDiagnosticsBundle(res, diagnostics, { compact: true });
  const bundle = JSON.parse(res.body);
  assert.deepEqual(bundle.diagnostics.canonicalRequestStates, canonicalRequestStates);
  assert.match(res.header('content-disposition'), /^attachment; filename="bridge-debug-compact-/);
});
