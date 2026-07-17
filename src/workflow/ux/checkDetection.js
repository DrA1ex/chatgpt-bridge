import fs from 'node:fs/promises';
import path from 'node:path';

async function exists(filePath) {
  return Boolean(await fs.stat(filePath).catch(() => null));
}

async function readJson(filePath) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); } catch { return null; }
}

function add(result, seen, label, command, source, selected = false) {
  if (!command || seen.has(command)) return;
  seen.add(command);
  result.push({ id: command.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, ''), label, command, source, selected });
}

export async function detectProjectChecks(projectRoot) {
  const root = path.resolve(projectRoot || process.cwd());
  const result = [];
  const seen = new Set();
  const pkg = await readJson(path.join(root, 'package.json'));
  if (pkg?.scripts && typeof pkg.scripts === 'object') {
    const scripts = pkg.scripts;
    add(result, seen, 'Run all tests', scripts.test ? 'npm test' : '', 'package.json', true);
    add(result, seen, 'Check code quality', scripts.check ? 'npm run check' : scripts.lint ? 'npm run lint' : '', 'package.json', Boolean(scripts.check || scripts.lint));
    add(result, seen, 'Build the project', scripts.build ? 'npm run build' : '', 'package.json', false);
    add(result, seen, 'Run type checks', scripts.typecheck ? 'npm run typecheck' : scripts['type-check'] ? 'npm run type-check' : '', 'package.json', false);
  }
  if (await exists(path.join(root, 'pyproject.toml')) || await exists(path.join(root, 'pytest.ini'))) {
    add(result, seen, 'Run Python tests', 'python -m pytest', 'Python project', result.length === 0);
  }
  if (await exists(path.join(root, 'Cargo.toml'))) {
    add(result, seen, 'Run Rust tests', 'cargo test', 'Cargo.toml', result.length === 0);
    add(result, seen, 'Check Rust code', 'cargo check', 'Cargo.toml', false);
  }
  if (await exists(path.join(root, 'go.mod'))) {
    add(result, seen, 'Run Go tests', 'go test ./...', 'go.mod', result.length === 0);
  }
  if (await exists(path.join(root, 'composer.json'))) {
    const composer = await readJson(path.join(root, 'composer.json'));
    if (composer?.scripts?.test) add(result, seen, 'Run PHP tests', 'composer test', 'composer.json', result.length === 0);
  }
  if (await exists(path.join(root, 'Makefile'))) {
    const makefile = await fs.readFile(path.join(root, 'Makefile'), 'utf8').catch(() => '');
    if (/^test\s*:/m.test(makefile)) add(result, seen, 'Run Make tests', 'make test', 'Makefile', result.length === 0);
    if (/^check\s*:/m.test(makefile)) add(result, seen, 'Run Make checks', 'make check', 'Makefile', false);
    if (/^build\s*:/m.test(makefile)) add(result, seen, 'Build with Make', 'make build', 'Makefile', false);
  }
  for (const workspace of ['pnpm-workspace.yaml', 'nx.json', 'turbo.json', 'lerna.json']) {
    if (await exists(path.join(root, workspace)) && pkg?.scripts?.test) {
      add(result, seen, 'Run workspace tests', 'npm test', workspace, true);
    }
  }
  const legacy = await readJson(path.join(root, 'bridge.workflow.json'));
  for (const step of legacy?.automation?.steps || []) {
    const command = typeof step === 'string' ? step : step?.command;
    add(result, seen, step?.name || 'Run saved workflow check', command, 'bridge.workflow.json', true);
  }
  return result;
}
