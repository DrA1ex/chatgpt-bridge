import path from 'node:path';

export function makeTree(paths, limit = 500) {
  const sorted = [...paths].sort();
  const shown = sorted.slice(0, limit);
  const output = [];
  for (const rel of shown) {
    const depth = rel.split('/').length - 1;
    output.push(`${'  '.repeat(depth)}- ${path.posix.basename(rel)}`);
  }
  if (sorted.length > shown.length) output.push(`... ${sorted.length - shown.length} more files`);
  return output.join('\n');
}

export function formatSymbols(symbols, limit) {
  const shown = symbols.slice(0, limit);
  const lines = [];
  let current = '';
  for (const symbol of shown) {
    if (symbol.file !== current) {
      current = symbol.file;
      lines.push(`\n${current}`);
    }
    lines.push(`  L${symbol.lineStart}-L${symbol.lineEnd} ${symbol.signature}`);
  }
  if (symbols.length > shown.length) lines.push(`\n... ${symbols.length - shown.length} more symbols`);
  return lines.join('\n').trim();
}

export function buildProjectContext({ root, files, ignored, symbols, agent, skills, symbolLimit }) {
  const scripts = files.find((file) => file.path === 'package.json') ? 'Node.js package detected from package.json.' : '';
  return [
    '# Project Context',
    '',
    `Root: ${root}`,
    `Files included: ${files.length}`,
    `Files ignored/skipped: ${ignored.length}`,
    scripts ? `Detected stack: ${scripts}` : '',
    '',
    '## File tree',
    '```text',
    makeTree(files.map((file) => file.path)),
    '```',
    '',
    '## Symbols',
    symbols.length ? formatSymbols(symbols, symbolLimit) : 'No symbols detected by the lightweight scanner.',
    '',
    '## Agent file',
    agent?.path ? `Found: ${agent.path}` : 'No AGENT.md file found.',
    '',
    '## Available skills',
    skills.length ? skills.map((skill) => `- ${skill.name} (${skill.scope})`).join('\n') : 'No skills found.',
  ].filter((line) => line !== '').join('\n');
}

export function buildEffectiveAgent({ agent, skills = [] }) {
  const sections = [
    '# Bridge project-task instructions',
    '- Treat the attached ZIP as the project snapshot.',
    '- Work only inside the project tree.',
    '- Do not include .git, node_modules, dist, build, coverage, caches, or secrets in output archives.',
    '- Return a downloadable ZIP artifact with the full updated project when asked to modify files.',
    '- In output ZIP artifacts, put project files at the archive root (for example package.json, src/app.js). Do not wrap them in a top-level project/ folder.',
    '- Also include a concise changelog in the chat response.',
  ];
  if (agent?.content) sections.push('\n# Project AGENT.md\n', agent.content.trim());
  for (const skill of skills) sections.push(`\n# Skill: ${skill.name}\n`, skill.content.trim());
  return sections.join('\n');
}

export function buildTaskMessage({ message, pack }) {
  const attachText = pack.shouldAttach
    ? `A project ZIP snapshot is attached: ${pack.file.name} (${pack.snapshotId}).`
    : `Use the previously attached project ZIP snapshot for this thread: ${pack.snapshotId}. Do not ask me to re-upload it unless the context is missing.`;
  return [
    'You are working on a small project through ChatGPT Browser Bridge.',
    attachText,
    '',
    'Inside the ZIP:',
    '- project/ contains the project files.',
    '- .bridge/PROJECT_CONTEXT.md contains the file tree and symbol index.',
    '- .bridge/AGENT_EFFECTIVE.md contains project/skill instructions.',
    '- .bridge/MANIFEST.json contains the snapshot manifest.',
    '',
    'Task:',
    message,
    '',
    'Output contract:',
    '- Return a downloadable ZIP artifact with the full updated project.',
    '- The returned ZIP must have the project files at the archive root, not inside a top-level project/ folder. Example: use package.json and src/index.js, not project/package.json and project/src/index.js.',
    '- Exclude .git, node_modules, dist, build, coverage, caches, temporary files, and secrets.',
    '- Include a short changelog in the chat answer.',
    '- If you cannot create a ZIP artifact, output changed files as fenced blocks using ```file:path/to/file.',
  ].join('\n');
}
