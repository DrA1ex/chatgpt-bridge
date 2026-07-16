function failedStepSummary(validation) {
  return (validation.failed || []).map((result) => (
    `- ${result.name || result.id || result.command}: ${result.command} (exit=${result.code ?? 'none'}, signal=${result.signal || 'none'}, timeout=${result.timedOut ? 'yes' : 'no'})`
  )).join('\n');
}

function attachmentContext(config) {
  const values = [];
  if (config.onFailure.attachProject) values.push('the attached current project snapshot');
  else values.push('the project context already available in this conversation');
  if (config.onFailure.attachDiagnostics) values.push('the attached compressed diagnostics with complete command logs');
  else values.push('the failure summary below');
  return values.join(' and ');
}

function outputInstruction(config) {
  const expected = String(config.onFailure.output.expected || 'zip').toLowerCase();
  if (expected === 'zip') {
    return [
      'Return exactly one complete project ZIP with project files at the archive root. Do not return only a patch.',
      'Do not include node_modules, .git, .bridge-data, logs, databases, caches, build output, secrets, CHANGELOG.md, or nested project archives.',
      'Preserve public registry URLs in package-lock.json.',
    ];
  }
  return [`Return the requested ${expected || 'text'} result without unrelated artifacts.`];
}

export function buildAutomationPrompt({ workflow, validation, cycle }) {
  const config = workflow.automation;
  const custom = String(config.onFailure.prompt || '').trim();
  const commit = workflow.commit || {};
  const commitInstruction = commit.mode === 'block'
    ? `Include a concise commit message between these exact markers:\n${commit.beginMarker}\n<commit message>\n${commit.endMarker}`
    : '';
  const base = [
    `Automated workflow validation cycle ${cycle} failed. Use ${attachmentContext(config)}.`,
    '',
    'Failed steps:',
    failedStepSummary(validation) || '- Validation failed without a named failed step.',
    '',
    'Read AGENT.MD and the other project Markdown files before changing code. Determine the root cause, implement the fix, add regression coverage for every corrected bug, and run the relevant tests.',
    ...outputInstruction(config),
    commitInstruction,
  ].filter(Boolean).join('\n');
  return custom ? `${custom}\n\n${base}` : base;
}
