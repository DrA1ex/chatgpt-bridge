import test from 'node:test';
import assert from 'node:assert/strict';
import { persistCurrentScope, hydrateCurrentScope, switchSessionScope } from '../src/interactiveLegacy.js';

function stateFor(projectRoot, sessionId = '') {
  return {
    projectRoot,
    projectId: projectRoot ? `id-${projectRoot}` : '',
    enabledSkills: [],
    sessionId,
    projectThreadId: '',
    lastTurnId: '',
    lastTurn: null,
    lastAppliedTurnId: '',
    lastAppliedFileId: '',
    lastArtifacts: [],
    lastSessions: [],
    responseHistory: [],
    scopes: {},
  };
}

test('interactive state scopes last result and responses by project and ChatGPT session', () => {
  const state = stateFor('/tmp/project-a', 'chat-a');
  state.projectThreadId = 'thread-a';
  state.lastTurnId = 'turn-a';
  state.lastAppliedTurnId = 'turn-a';
  state.lastAppliedFileId = 'file-a';
  state.responseHistory = [{ id: 'r-a', text: 'answer a' }];
  persistCurrentScope(state);

  switchSessionScope(state, 'chat-b');
  assert.equal(state.lastTurnId, '');
  assert.equal(state.lastAppliedTurnId, '');
  assert.deepEqual(state.responseHistory, []);
  state.lastTurnId = 'turn-b';
  state.lastAppliedFileId = 'file-b';
  state.responseHistory = [{ id: 'r-b', text: 'answer b' }];
  persistCurrentScope(state);

  switchSessionScope(state, 'chat-a');
  assert.equal(state.lastTurnId, 'turn-a');
  assert.equal(state.lastAppliedTurnId, 'turn-a');
  assert.equal(state.lastAppliedFileId, 'file-a');
  assert.equal(state.responseHistory[0].text, 'answer a');

  persistCurrentScope(state);
  state.projectRoot = '/tmp/project-b';
  state.projectId = 'id-b';
  state.sessionId = '';
  hydrateCurrentScope(state, { preserveProjectThread: false });
  assert.equal(state.lastTurnId, '');
  assert.equal(state.lastAppliedFileId, '');
  assert.deepEqual(state.responseHistory, []);
});
