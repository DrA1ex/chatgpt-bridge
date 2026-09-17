import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePromptRoute, shouldRouteToProjectChat } from '../src/interactive/view.js';

test('project-aware prompt routing depends only on current project services', () => {
  const state = { projectRoot: '/tmp/project' };
  const options = { projectService: {}, turnManager: {} };
  assert.equal(shouldRouteToProjectChat(state, options, 'fix this'), true);
  assert.deepEqual(resolvePromptRoute(state, options, 'fix this'), { kind: 'project-chat' });
});

test('stale legacy-shaped state cannot change project prompt routing', () => {
  const state = { projectRoot: '/tmp/project', focusedWorkflowId: 'removed-workflow' };
  const options = { projectService: {}, turnManager: {}, workflowManager: { get: () => ({ preset: 'guided-task' }) } };
  assert.deepEqual(resolvePromptRoute(state, options, 'fix this'), { kind: 'project-chat' });
});

test('prompt routing falls back to direct chat without project context or project services', () => {
  assert.deepEqual(resolvePromptRoute({}, {}, 'hello'), { kind: 'chat' });
  assert.deepEqual(resolvePromptRoute({ projectRoot: '/tmp/project' }, {}, 'hello'), { kind: 'chat' });
  assert.deepEqual(resolvePromptRoute({ projectRoot: '/tmp/project' }, { projectService: {}, turnManager: {} }, ''), { kind: 'chat' });
});
