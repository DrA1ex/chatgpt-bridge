import { compactTabLabel, deriveInteractiveRuntimeStatus, truncate } from './inkView.js';
import { workflowDashboard, workflowStage } from '../workflow/ux/workflowView.js';

export function createStatusPanels({ React, Box, Text, Panel } = {}) {
  function Badge({ label, color = 'white' }) {
    return React.createElement(Text, { color }, ` ${label} `);
  }

  function StatusHeader({ health, state, busy, phase, tick, spinnerFrames }) {
    const activeClient = health.activeClient || health.clients?.[0] || null;
    const status = health.ok ? 'connected' : health.needsSelection ? 'select tab' : 'offline';
    const statusColor = health.ok ? 'green' : health.needsSelection ? 'yellow' : 'red';
    const runtime = deriveInteractiveRuntimeStatus(health, busy, phase);
    const spinner = runtime.active ? `${spinnerFrames[tick % spinnerFrames.length]} ${runtime.label}` : runtime.label;
    const projectName = state.projectRoot ? state.projectRoot.split(/[\\/]/).filter(Boolean).slice(-1)[0] : 'none';
    return React.createElement(Panel, { title: 'ChatGPT Bridge', borderColor: statusColor },
      React.createElement(Box, { justifyContent: 'space-between' },
        React.createElement(Box, null,
          React.createElement(Badge, { label: status, color: statusColor }),
          React.createElement(Text, null, ` ${compactTabLabel(activeClient)} · tabs ${health.clients?.length || 0}`)
        ),
        React.createElement(Text, { color: runtime.color }, spinner)
      ),
      React.createElement(Box, { flexDirection: 'column' },
        React.createElement(Text, null,
          React.createElement(Text, { dimColor: true }, 'Project '), projectName,
          React.createElement(Text, { dimColor: true }, '  Session '), state.sessionId || 'current tab',
          React.createElement(Text, { dimColor: true }, '  Model '), state.model || 'default',
          React.createElement(Text, { dimColor: true }, '  Effort '), state.effort || 'default',
          React.createElement(Text, { dimColor: true }, '  Files '), String(state.pendingAttachments.length)
        ),
        runtime.requestId ? React.createElement(Text, { color: runtime.color }, `Request ${runtime.requestId} · ${runtime.phase}`) : null
      )
    );
  }

  function WorkflowPanel({ workflow, currentSessionId }) {
    if (!workflow) return null;
    const view = workflowDashboard(workflow, { currentSessionId });
    const cycle = view.cycle || view.maxCycles ? `${view.cycle || 0}/${view.maxCycles || '?'}` : '';
    const session = view.boundSessionId || view.nextSession;
    return React.createElement(Panel, { title: `Workflow · ${view.id}`, borderColor: view.stage.tone, marginTop: 1 },
      React.createElement(Box, { justifyContent: 'space-between' },
        React.createElement(Text, { color: view.stage.tone, bold: true }, view.stage.label),
        view.runId ? React.createElement(Text, { dimColor: true }, view.runId) : null
      ),
      React.createElement(Text, null,
        cycle ? React.createElement(React.Fragment, null, React.createElement(Text, { dimColor: true }, 'Cycle '), cycle, '  ') : null,
        React.createElement(Text, { dimColor: true }, view.active ? 'Session ' : 'Next session '), session
      ),
      view.error ? React.createElement(Text, { color: 'red' }, truncate(view.error, 180)) : null,
      React.createElement(Text, { dimColor: true }, view.actions.join('  ·  '))
    );
  }

  function WorkflowExitPrompt({ workflow }) {
    const stage = workflowStage(workflow);
    return React.createElement(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 1, marginTop: 1 },
      React.createElement(Text, { color: 'yellow', bold: true }, 'Workflow action is active'),
      React.createElement(Text, null, `${workflow.id} · ${stage.label}`),
      React.createElement(Text, null, 'Press y to stop the run and exit, n/Esc to continue. Press Ctrl+C again to force exit.')
    );
  }

  return { StatusHeader, WorkflowPanel, WorkflowExitPrompt };
}
