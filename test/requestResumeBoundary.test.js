import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

async function resume(turns, projection) {
  const context = vm.createContext({ Date, setTimeout, location: { href: 'https://chatgpt.com/c/chat' }, document: { title: 'Chat' } });
  vm.runInContext(await fs.readFile('tools/chrome-bridge-extension/content/requestResumeCommands.js', 'utf8'), context);
  const request = { requestId: 'request', leaseId: 'lease', responseEpoch: 0, turnCaptureArmed: false,
    update(_event, patch) { Object.assign(this, patch); } };
  const sent = [];
  const commands = context.ChatGptRequestResumeCommands.createRequestResumeCommands({
    getActiveRequest: () => request, getTurnNodes: () => turns, turnRole: turn => turn.role,
    turnKey: turn => turn.key, getCurrentSession: () => ({ id: 'chat' }),
    publicRequestStatus: () => ({ requestId: request.requestId }),
    send: payload => sent.push(payload), diagnostic() {}, startDomMonitor() {}, collectAndEmit() {},
    resumeBoundaryTimeoutMs: 0,
  });
  await commands.handleRequestResume({ requestId: request.requestId, commandId: 'resume', projection });
  return { request, response: sent[0] };
}

test('resume arms request-scoped observation after restoring a user boundary', async () => {
  const projection = { submittedUserTurnKey: 'user', assistantTurnKey: 'answer', responseEpoch: 0 };
  const { request, response } = await resume([{ role: 'user', key: 'user' }, { role: 'assistant', key: 'answer' }], projection);
  assert.equal(response.boundaryStatus, 'matched');
  assert.equal(request.turnCaptureArmed, true);
  assert.equal(request.assistantTurnKey, 'answer');
});

test('resume recovers a known assistant after user virtualization without binding repeated prompt', async () => {
  const projection = { submittedUserTurnKey: '12345678-1234-1234-1234-123456789abc', assistantTurnKey: 'answer', submittedPromptText: 'Continue' };
  const { request, response } = await resume([{ role: 'user', key: 'old-user', textContent: 'Continue' }, { role: 'assistant', key: 'answer' }], projection);
  assert.equal(response.boundaryStatus, 'matched');
  assert.equal(request.turnCaptureArmed, true);
  assert.equal(request.submittedUserTurnKey, projection.submittedUserTurnKey);
  assert.equal(request.submittedUserTurnIndex, -1);
  const missing = await resume([{ role: 'user', key: 'old-user', textContent: 'Continue' }], projection);
  assert.equal(missing.response.boundaryStatus, 'missing');
  assert.equal(missing.request.turnCaptureArmed, false);
});
