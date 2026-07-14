export const REAL_E2E_SCENARIOS = Object.freeze([
  {
    id: 'conversation',
    name: 'deterministic conversation and completion',
    description: 'Exact answers and continuity inside one concrete ChatGPT conversation.',
  },
  {
    id: 'response-markdown',
    name: 'response Markdown parsing',
    description: 'Lossless terminal blocks, code-widget languages, exact text, unknown-node audit, and full ownership coverage.',
  },
  {
    id: 'reasoning-lifecycle',
    name: 'visible reasoning lifecycle',
    description: 'Visible reasoning phases, revisions, completion, ordering, and final-answer separation.',
  },
  {
    id: 'model-effort',
    name: 'model and effort selection with deterministic answer',
    description: 'Model/effort picker application followed by a short exact-answer turn.',
  },
  {
    id: 'reasoning-steer',
    name: 'visible reasoning items, finalization and steer',
    description: 'Active-turn steering, reasoning items, and exact final override.',
  },
  {
    id: 'multiple-files',
    name: 'multiple downloadable files',
    description: 'Several separately downloadable artifacts and exact byte validation.',
  },
  {
    id: 'zip-artifact',
    name: 'single deterministic ZIP artifact',
    description: 'One generated ZIP, exact entries, and archive-content validation.',
  },
  {
    id: 'passive-workflow',
    name: 'passive workflow auto apply',
    description: 'A prompt submitted outside the request pipeline is observed, verified by project identity, applied automatically, and validated.',
  },
  {
    id: 'workflow-approval',
    name: 'passive workflow approval',
    description: 'Ask mode verifies and stages an artifact, leaves the project unchanged, then applies it only after an explicit approval.',
  },
  {
    id: 'workflow-remediation',
    name: 'passive workflow rollback and remediation',
    description: 'A failing applied artifact is rolled back, validation output is sent to the same chat, and a corrected ZIP is applied.',
  },
  {
    id: 'project-context',
    name: 'project AGENT.md, skill, multi-turn edit and snapshot reuse',
    description: 'Project packaging, context/skill injection, second-turn modification, and snapshot reuse.',
  },
  {
    id: 'project-no-context',
    name: 'project without AGENT.md or skills remains functional',
    description: 'Project packaging fallback when optional context files and requested skills are absent.',
  },
]);

const IDS = REAL_E2E_SCENARIOS.map((scenario) => scenario.id);
const BY_ID = new Map(REAL_E2E_SCENARIOS.map((scenario) => [scenario.id, scenario]));

const ALIASES = Object.freeze({
  all: IDS,
  smoke: ['conversation', 'model-effort'],
  parser: ['response-markdown', 'reasoning-lifecycle'],
  response: ['response-markdown'],
  'response-parser': ['response-markdown', 'reasoning-lifecycle'],
  markdown: ['response-markdown'],
  reasoning: ['reasoning-lifecycle'],
  'reasoning-parser': ['reasoning-lifecycle'],
  model: ['model-effort'],
  selection: ['model-effort'],
  steer: ['reasoning-steer'],
  files: ['multiple-files'],
  zip: ['zip-artifact'],
  artifacts: ['multiple-files', 'zip-artifact'],
  workflow: ['passive-workflow'],
  workflows: ['passive-workflow', 'workflow-approval', 'workflow-remediation'],
  'passive-workflow': ['passive-workflow'],
  'workflow-auto': ['passive-workflow'],
  'workflow-approval': ['workflow-approval'],
  'workflow-remediation': ['workflow-remediation'],
  project: ['project-context', 'project-no-context'],
  projects: ['project-context', 'project-no-context'],
});

function normalizeSelector(value = '') {
  return String(value || '').trim().toLowerCase().replaceAll('_', '-');
}

export function scenarioDefinition(id) {
  return BY_ID.get(normalizeSelector(id)) || null;
}

export function expandScenarioSelectors(selectors = []) {
  const requested = Array.isArray(selectors) ? selectors : [selectors];
  const normalized = requested.flatMap((value) => String(value || '').split(',')).map(normalizeSelector).filter(Boolean);
  const tokens = normalized.length ? normalized : ['all'];
  const selected = new Set();
  for (const token of tokens) {
    const expansion = ALIASES[token] || (BY_ID.has(token) ? [token] : null);
    if (!expansion) {
      const known = [...IDS, ...Object.keys(ALIASES)].sort().join(', ');
      throw new Error(`Unknown E2E scenario: ${token}. Known scenarios/aliases: ${known}`);
    }
    for (const id of expansion) selected.add(id);
  }
  return IDS.filter((id) => selected.has(id));
}

export function formatScenarioList() {
  const lines = REAL_E2E_SCENARIOS.map((scenario) => `  ${scenario.id.padEnd(20)} ${scenario.description}`);
  return `Available real-browser E2E scenarios:\n${lines.join('\n')}\n\nAliases:\n  smoke, response-parser, parser, response, markdown, reasoning, model, steer, files, zip, artifacts, workflow, workflows, workflow-auto, passive-workflow, project, all`;
}
