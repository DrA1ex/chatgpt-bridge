import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTION_CONFIRMATIONS,
  ACTION_RISKS,
  ERROR_CODES,
  SECTION_KINDS,
  SURFACE_KINDS,
  assertProtocolValue,
  getConformanceFixtureBundle,
} from 'zipflow/protocol';
import { renderWorkflowSurface } from '../src/interactive/workflowSurfaces/index.js';
import {
  normalizeZipflowClientError,
  validateZipflowHello,
} from '../src/workflow/server/zipflowWorkflowClient.js';

test('Bridge consumes the canonical Zipflow protocol fixtures without schema or renderer drift', () => {
  const bundle = getConformanceFixtureBundle();
  assertProtocolValue('conformance', bundle);
  assert.equal(validateZipflowHello(bundle.hello).serverEpoch, bundle.hello.serverEpoch);

  const rendered = bundle.surfaces.map((surface) => {
    assertProtocolValue('surface', surface);
    return renderWorkflowSurface(surface);
  });
  assert.deepEqual(new Set(rendered.map((surface) => surface.kind)), new Set(SURFACE_KINDS));
  assert.deepEqual(
    new Set(rendered.flatMap((surface) => surface.sections.map((section) => section.kind))),
    new Set(SECTION_KINDS),
  );
  assert.deepEqual(
    new Set(rendered.flatMap((surface) => surface.actions.map((action) => action.risk))),
    new Set(ACTION_RISKS),
  );
  assert.deepEqual(
    new Set(rendered.flatMap((surface) => surface.actions.map((action) => action.confirmation))),
    new Set(ACTION_CONFIRMATIONS),
  );
  for (const surface of rendered) {
    assert.ok(surface.id);
    assert.ok(surface.title);
    assert.ok(surface.lines.length);
    assert.ok(surface.actions.length);
    assert.doesNotMatch(JSON.stringify(surface), /zipflow/i);
  }

  const normalizedProblems = bundle.problems.map((problem) => {
    assertProtocolValue('problem', problem);
    return normalizeZipflowClientError({ problem });
  });
  assert.deepEqual(new Set(normalizedProblems.map((problem) => problem.code)), new Set(ERROR_CODES));
  assert.ok(normalizedProblems.every((problem) => problem.message));

  for (const event of [...bundle.sse.replay, bundle.sse.gap]) {
    assertProtocolValue('event', event);
    assert.equal(event.serverEpoch, bundle.hello.serverEpoch);
  }
  for (const scenario of Object.values(bundle.scenarios)) {
    assert.ok(scenario.runId);
    assert.ok(scenario.operationId);
    assert.ok(renderWorkflowSurface(scenario.surface).lines.length);
  }
});
