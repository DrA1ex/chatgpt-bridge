import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePromptRoute } from '../src/interactive/view.js';

const guided = { id: 'legacy-guided', preset: 'guided-task' };
const workflowManager = { get: (id) => id === guided.id ? guided : null };

test('server-backed interactive prompts ignore stale legacy guided focus and use project chat', () => {
  const route = resolvePromptRoute(
    { projectRoot: '/tmp/project', focusedWorkflowId: guided.id },
    { projectService: {}, turnManager: {}, workflowManager, zipflowWorkflowRuntime: {} },
    'inspect this project',
  );
  assert.equal(route.kind, 'project-chat');
  assert.equal(route.workflow, null);
});

test('legacy guided focus remains available when the server workflow runtime is absent', () => {
  const route = resolvePromptRoute(
    { projectRoot: '/tmp/project', focusedWorkflowId: guided.id },
    { projectService: {}, turnManager: {}, workflowManager },
    'continue legacy workflow',
  );
  assert.equal(route.kind, 'legacy-guided');
  assert.equal(route.workflow, guided);
});

test('plain prompt falls back to direct chat when no project turn runtime is available', () => {
  const route = resolvePromptRoute(
    { projectRoot: '/tmp/project', focusedWorkflowId: '' },
    { projectService: null, turnManager: null, zipflowWorkflowRuntime: {} },
    'hello',
  );
  assert.equal(route.kind, 'chat');
});

import { parseInteractiveRequestCommand } from '../src/interactive/commands.js';

test('interactive request commands keep direct chat and strict project task semantics explicit', () => {
  assert.deepEqual(parseInteractiveRequestCommand('/chat explain this'), {
    kind: 'chat', prompt: 'explain this', normalized: '/chat explain this',
  });
  assert.deepEqual(parseInteractiveRequestCommand('/task fix the tests'), {
    kind: 'task', prompt: 'fix the tests', normalized: '/task fix the tests',
  });
  assert.deepEqual(parseInteractiveRequestCommand('/task'), {
    kind: 'task', prompt: '', normalized: '/task',
  });
  assert.equal(parseInteractiveRequestCommand('/workflow'), null);
});
