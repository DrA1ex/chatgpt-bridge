import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderWorkflowDiff,
  renderWorkflowHistoryPage,
  renderWorkflowPlanPage,
  renderWorkflowSurface,
} from '../src/interactive/workflowSurfaces/index.js';

function visibleText(rendered) {
  return [
    rendered.title,
    rendered.summary,
    ...(rendered.lines || []),
    ...(rendered.actions || []).flatMap((action) => [
      action.label,
      action.description,
      action.disabledReason,
    ]),
  ].join('\n');
}

test('generic surface renderer consumes every protocol v1 section kind without implementation branding', () => {
  const rendered = renderWorkflowSurface({
    id: 'surface-all',
    kind: 'workflow_setup',
    revision: 4,
    title: 'Zipflow server workflow',
    summary: 'Configure the Zipflow server safely',
    stage: { id: 'setup', index: 1, count: 3 },
    sections: [
      { kind: 'text', text: '\u001b[31mZipflow is preparing this workflow.\u001b[0m' },
      { kind: 'summary_fields', fields: [{ label: 'Mode', value: 'snapshot' }] },
      { kind: 'progress', label: 'Inspecting', completed: 1, total: 2 },
      { kind: 'choice_list', choices: [{ id: 'one', label: 'Snapshot', selected: true }] },
      { kind: 'plan_summary', counts: { added: 1, changed: 2, removed: 0 } },
      { kind: 'file_groups', groups: [{ kind: 'changed', files: [{ path: 'src/index.js', status: 'changed' }] }] },
      { kind: 'file_details', path: 'src/index.js', status: 'changed', size: 12 },
      { kind: 'conflict', path: 'src/conflict.js', summary: 'Both sides changed' },
      { kind: 'check_results', checks: [{ id: 'test', name: 'Tests', status: 'passed', durationMs: 1200 }] },
      { kind: 'commit', message: 'Update workflow', status: 'ready' },
      { kind: 'deployment', name: 'Preview', status: 'pending' },
      { kind: 'history_rows', rows: [{ id: 'run-1', label: 'Run 1', status: 'completed' }] },
      { kind: 'warning_list', warnings: [{ code: 'LOCAL_CHANGE', message: 'Review the local file' }] },
      { kind: 'error', code: 'STALE_REVISION', message: 'Refresh the workflow' },
    ],
    actions: [{
      id: 'save',
      kind: 'save_workflow',
      label: 'Save Zipflow server workflow',
      description: 'Update Zipflow configuration',
      enabled: true,
      risk: 'project_write',
      confirmation: 'explicit',
      presentation: { role: 'primary' },
    }],
  });

  const visible = visibleText(rendered);
  for (const expected of ['Mode: snapshot', '50%', 'Added 1', 'src/index.js', 'Tests', 'Run 1', 'STALE_REVISION']) {
    assert.match(visible, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(visible, /zipflow/i);
  assert.doesNotMatch(visible, /\u001b/);
  assert.equal(rendered.actions[0].id, 'save');
  assert.equal(rendered.actions[0].risk, 'project_write');
});

test('specialized plan, diff, progress, and history renderers produce semantic plain text', () => {
  const plan = renderWorkflowPlanPage({
    counts: { added: 1, changed: 1, removed: 1 },
    groups: [{ title: 'Changed', files: [{ path: 'src/app.js', status: 'changed', summary: 'Updated' }] }],
    nextCursor: 'opaque-next',
  }).join('\n');
  assert.match(plan, /Added 1/);
  assert.match(plan, /src\/app\.js/);
  assert.match(plan, /More files are available/);

  const diff = {
    path: 'src/app.js',
    hunks: [{
      oldStart: 1,
      oldCount: 1,
      newStart: 1,
      newCount: 1,
      lines: [
        { kind: 'remove', oldLine: 1, text: 'old value' },
        { kind: 'add', newLine: 1, text: 'new value' },
      ],
    }],
  };
  assert.match(renderWorkflowDiff(diff, { mode: 'unified' }).join('\n'), /-old value/);
  const sideBySide = renderWorkflowDiff(diff, { mode: 'side-by-side', columnWidth: 20 }).join('\n');
  assert.match(sideBySide, /old value\s+│/);
  assert.match(sideBySide, /│ 1 new value/);

  const history = renderWorkflowHistoryPage({
    rows: [{ id: 'run-1', label: 'Archive run', status: 'completed', summary: 'Applied safely' }],
    nextCursor: 'next',
  }).join('\n');
  assert.match(history, /Archive run/);
  assert.match(history, /More history is available/);
  assert.doesNotMatch(`${plan}\n${sideBySide}\n${history}`, /\x1b\[/);
});

test('diff code and project paths preserve literal Zipflow text while stripping controls', () => {
  const diff = renderWorkflowDiff({
    path: 'packages/zipflow-client/src/zipflow.js',
    hunks: [{
      oldStart: 1,
      oldCount: 0,
      newStart: 1,
      newCount: 1,
      lines: [{
        kind: 'add',
        newLine: 1,
        text: '\u001b[32mconst zipflow = "zipflow/server";\u001b[0m',
      }],
    }],
  }).join('\n');

  assert.match(diff, /packages\/zipflow-client\/src\/zipflow\.js/);
  assert.match(diff, /\+const zipflow = "zipflow\/server";/);
  assert.doesNotMatch(diff, /\u001b/);
});
