import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeInputAction, pastedTextFromInput, commandSuggestions, shouldCompleteSlashCommand, completeCommand, shouldRouteToProjectTask } from '../src/interactiveInk.js';
import { renderEvent } from '../src/interactiveLegacy.js';

test('decodeInputAction handles macOS delete/backspace distinction conservatively', () => {
  assert.equal(decodeInputAction('\u007f', { name: 'delete', delete: true }), 'backspace');
  assert.equal(decodeInputAction('\u001b[3~', { name: 'delete' }), 'delete');
  assert.equal(decodeInputAction('', { name: 'backspace', delete: true }), 'backspace');
  assert.equal(decodeInputAction('\u0008', { name: 'c-h' }), 'backspace');
});

test('decodeInputAction handles common readline control keys', () => {
  assert.equal(decodeInputAction('\u0001', {}), 'line-start');
  assert.equal(decodeInputAction('\u0005', {}), 'line-end');
  assert.equal(decodeInputAction('\u000b', {}), 'kill-line-right');
  assert.equal(decodeInputAction('\u0015', {}), 'kill-line-left');
  assert.equal(decodeInputAction('\u0017', {}), 'delete-word-left');
  assert.equal(decodeInputAction('\u0004', {}), 'delete-or-exit');
  assert.equal(decodeInputAction('\u000a', {}), 'submit');
  assert.equal(decodeInputAction('\u000d', {}), 'submit');
});

test('decodeInputAction handles macOS option/cmd arrow style escape sequences', () => {
  assert.equal(decodeInputAction('\u001bb', {}), 'word-left');
  assert.equal(decodeInputAction('\u001bf', {}), 'word-right');
  assert.equal(decodeInputAction('\u001b\u007f', {}), 'delete-word-left');
  assert.equal(decodeInputAction('\u001b[1;13D', {}), 'line-start');
  assert.equal(decodeInputAction('\u001b[1;13C', {}), 'line-end');
  assert.equal(decodeInputAction('', { meta: true, name: 'left' }), 'word-left');
  assert.equal(decodeInputAction('', { meta: true, name: 'right' }), 'word-right');
  assert.equal(decodeInputAction('\u0001', { meta: true, name: 'left' }), 'line-start');
  assert.equal(decodeInputAction('\u0005', { meta: true, name: 'right' }), 'line-end');
});

test('decodeInputAction treats bare Escape as editor escape and supports common meta modifiers', () => {
  assert.equal(decodeInputAction('\u001b', {}), 'escape');
  assert.equal(decodeInputAction('\u001b[1;3D', {}), 'word-left');
  assert.equal(decodeInputAction('\u001b[1;3C', {}), 'word-right');
  assert.equal(decodeInputAction('\u001b[1;9D', {}), 'word-left');
  assert.equal(decodeInputAction('\u001b[1;9C', {}), 'word-right');
  assert.equal(decodeInputAction('\u001b[1;13D', {}), 'line-start');
  assert.equal(decodeInputAction('\u001b[1;13C', {}), 'line-end');
});


test('decodeInputAction and pastedTextFromInput handle bracketed paste', () => {
  assert.equal(decodeInputAction('\u001b[200~', {}), 'paste-start');
  assert.equal(decodeInputAction('\u001b[201~', {}), 'paste-end');
  assert.equal(pastedTextFromInput('\u001b[200~hello\nworld\u001b[201~'), 'hello\nworld');
  assert.equal(pastedTextFromInput('plain pasted text'), 'plain pasted text');
  assert.equal(pastedTextFromInput('\u001b[D'), '');
});


test('slash completion keeps exact /tab command before /tabs until arguments start', () => {
  const bareSuggestions = commandSuggestions('/tab');
  assert.equal(bareSuggestions[0].cmd, '/tab');
  assert.ok(bareSuggestions.some((item) => item.cmd === '/tabs'));
  assert.deepEqual(commandSuggestions('/tab '), []);
  assert.deepEqual(commandSuggestions('/tab 2'), []);
  assert.equal(completeCommand('/tab 2'), '/tab 2');
});


test('renderEvent shows request progress phases without noisy dom polls in normal mode', () => {
  assert.equal(
    renderEvent({ type: 'request.progress', phase: 'generating', meaningful: true, thinkingLength: 120, progressLength: 24, answerLength: 0, artifactCount: 0, visibilityState: 'hidden', anchorConfidence: 'high' }),
    '[chat] generating · thinking 120 · progress 24 · tab hidden'
  );
  assert.equal(renderEvent({ type: 'request.progress', phase: 'generating', meaningful: false, reason: 'dom.poll' }), '');
  assert.equal(renderEvent({ type: 'request.phase', phase: 'waiting_for_assistant_turn' }), '[chat] phase: waiting_for_assistant_turn');
  assert.equal(renderEvent({ type: 'assistant_turn.captured', turnIndex: 42 }), '[chat] assistant turn captured #42');
  assert.equal(renderEvent({ type: 'assistant.progress.snapshot', text: 'Inspecting uploaded ZIP' }), '[progress] Inspecting uploaded ZIP');
});


test('Ink interactive routes plain prompts to project task when a project is open', () => {
  assert.equal(shouldRouteToProjectTask({ projectRoot: '/tmp/project' }, { projectService: {}, turnManager: {} }, 'fix bug'), true);
  assert.equal(shouldRouteToProjectTask({ projectRoot: '' }, { projectService: {}, turnManager: {} }, 'fix bug'), false);
  assert.equal(shouldRouteToProjectTask({ projectRoot: '/tmp/project' }, { projectService: null, turnManager: {} }, 'fix bug'), false);
  assert.equal(shouldRouteToProjectTask({ projectRoot: '/tmp/project' }, { projectService: {}, turnManager: {} }, ''), false);
});
