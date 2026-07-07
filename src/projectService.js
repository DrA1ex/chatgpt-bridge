import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { writeZip } from './zipWriter.js';

function nowIso() { return new Date().toISOString(); }
function sha256Buffer(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function sha256Text(text) { return sha256Buffer(Buffer.from(String(text || ''), 'utf8')); }
function projectIdForRoot(root) { return `project_${sha256Text(path.resolve(root)).slice(0, 20)}`; }
function posixPath(filePath) { return filePath.split(path.sep).join('/'); }
function cleanName(name) { return String(name || 'project').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'project'; }
function bytes(value) { return Number(value) || 0; }
function bool(value, fallback = false) { return value == null ? fallback : Boolean(value); }

const DEFAULT_EXCLUDED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'vendor',
  'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.svelte-kit',
  '.cache', '.turbo', '.parcel-cache', '.vite', '.gradle', '.idea', '.vs',
  'bin', 'obj', 'target', 'venv', '.venv', '__pycache__', '.pytest_cache',
  '.mypy_cache', '.ruff_cache', '.tox', '.eggs', '.terraform', '.serverless',
]);

const DEFAULT_EXCLUDED_FILES = [
  '.DS_Store', 'Thumbs.db', '*.log', '*.tmp', '*.temp', '*.swp', '*.swo',
  '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.sqlite', '*.sqlite3',
  '*.db', '*.dump', '*.bak', '*.zip', '*.tar', '*.tgz', '*.gz', '*.7z', '*.rar',
];

const TEXT_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml',
  '.py', '.go', '.rs', '.php', '.rb', '.java', '.kt', '.kts', '.swift', '.c', '.h',
  '.cpp', '.hpp', '.cs', '.css', '.scss', '.html', '.vue', '.svelte', '.sh', '.zsh',
  '.bash', '.ps1', '.sql', '.toml', '.ini', '.env', '.txt', '.xml', '.gradle',
]);

function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const source = escaped.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${source}$`);
}

function parseIgnoreFile(content = '') {
  const rules = [];
  for (const raw of String(content).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1).trim();
    }
    if (!line) continue;
    rules.push({ pattern: line.replace(/^\//, ''), negated, directoryOnly: line.endsWith('/') });
  }
  return rules;
}

function matchSimpleGlob(pattern, rel, isDir) {
  let source = pattern.replace(/\\/g, '/').replace(/\/$/, '');
  const target = rel.replace(/\\/g, '/');
  if (!source) return false;
  if (pattern.endsWith('/') && !isDir) return false;
  if (!/[/*?]/.test(source)) return target === source || target.split('/').includes(source);
  if (!source.includes('/')) return target.split('/').some((segment) => globToRegExp(source).test(segment));
  return globToRegExp(source).test(target);
}

function isDefaultIgnored(rel, isDir) {
  const target = rel.replace(/\\/g, '/');
  const segments = target.split('/').filter(Boolean);
  if (segments.some((segment) => DEFAULT_EXCLUDED_DIRS.has(segment))) return true;
  if (isDir && DEFAULT_EXCLUDED_DIRS.has(segments.at(-1))) return true;
  return DEFAULT_EXCLUDED_FILES.some((pattern) => matchSimpleGlob(pattern, target, isDir));
}

function isIgnoredByRules(rel, isDir, rules) {
  let ignored = false;
  for (const rule of rules) {
    if (rule.directoryOnly && !isDir) continue;
    if (matchSimpleGlob(rule.pattern, rel, isDir)) ignored = !rule.negated;
  }
  return ignored;
}

function isLikelyTextFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  const base = path.basename(file).toLowerCase();
  return ['dockerfile', 'makefile', 'gemfile', 'rakefile', 'license', 'readme', 'changelog'].includes(base);
}

async function readTextIfPossible(filePath, maxBytes) {
  const stat = await fs.stat(filePath);
  if (stat.size > maxBytes) return '';
  const buffer = await fs.readFile(filePath);
  if (buffer.includes(0)) return '';
  return buffer.toString('utf8');
}

function detectSymbols(rel, text) {
  const patterns = [
    /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
    /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?[^=]*?\)?\s*=>/,
    /^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /^export\s+default\s+(?:async\s+)?function\s*([A-Za-z_$][\w$]*)?/,
    /^def\s+([A-Za-z_][\w]*)\s*\(/,
    /^class\s+([A-Za-z_][\w]*)\s*[:(]/,
    /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/,
    /^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)\s*\(/,
    /^(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_][\w]*)/,
    /^(?:public|private|protected|static|final|abstract|\s)*\s*(?:class|interface|enum)\s+([A-Za-z_][\w]*)/,
    /^function\s+([A-Za-z_][\w]*)\s*\(/,
  ];
  const lines = String(text || '').split(/\r?\n/);
  const raw = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        raw.push({ file: rel, name: match[1] || 'default', lineStart: i + 1, signature: line.slice(0, 180) });
        break;
      }
    }
  }
  for (let i = 0; i < raw.length; i += 1) raw[i].lineEnd = raw[i + 1] ? Math.max(raw[i].lineStart, raw[i + 1].lineStart - 1) : lines.length;
  return raw;
}

function makeTree(paths, limit = 500) {
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

function formatSymbols(symbols, limit) {
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

function skillNameFromPath(filePath) { return path.basename(filePath).replace(/\.md$/i, ''); }

export class ProjectService {
  constructor({ fileStore, metadataStore = null, eventBus = null, rootDir = config.dataDir } = {}) {
    this.fileStore = fileStore;
    this.metadataStore = metadataStore;
    this.eventBus = eventBus;
    this.rootDir = path.join(rootDir, 'projects');
  }

  async open(cwd, { threadId = '', title = '' } = {}) {
    const root = path.resolve(cwd || '');
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new Error(`Project path is not a directory: ${root}`);
    const id = projectIdForRoot(root);
    const state = await this.#loadState(id, root);
    state.root = root;
    state.name = title || state.name || path.basename(root) || id;
    if (threadId) state.currentThreadId = threadId;
    state.updatedAt = nowIso();
    await this.#saveState(state);
    return this.#publicState(state);
  }

  async listThreadsForProject(root, turnManager) {
    const absolute = path.resolve(root || '');
    if (!turnManager) return [];
    return await turnManager.listThreads({ cwd: absolute, includeArchived: false, limit: 100 });
  }

  async scan(cwd, options = {}) {
    const root = path.resolve(cwd || '');
    const id = projectIdForRoot(root);
    const state = await this.#loadState(id, root);
    const gitignoreRules = await this.#loadIgnoreRules(root, options);
    const maxFiles = Number(options.maxFiles || config.projectMaxFiles);
    const maxSingleFileBytes = Number(options.maxSingleFileBytes || config.projectMaxSingleFileBytes);
    const symbolLimit = Number(options.symbolLimit || config.projectContextMaxSymbols);
    const included = [];
    const ignored = [];
    const symbols = [];
    let totalBytes = 0;

    const walk = async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const absolute = path.join(dir, entry.name);
        const rel = posixPath(path.relative(root, absolute));
        if (!rel) continue;
        const isDir = entry.isDirectory();
        const ignoredByDefault = isDefaultIgnored(rel, isDir);
        const ignoredByRules = options.useGitignore === false ? false : isIgnoredByRules(rel, isDir, gitignoreRules);
        if (ignoredByDefault || ignoredByRules) {
          ignored.push({ path: rel, reason: ignoredByDefault ? 'default-exclude' : 'gitignore' });
          continue;
        }
        if (isDir) {
          await walk(absolute);
          continue;
        }
        if (!entry.isFile()) {
          ignored.push({ path: rel, reason: 'not-regular-file' });
          continue;
        }
        const stat = await fs.stat(absolute).catch(() => null);
        if (!stat) continue;
        if (stat.size > maxSingleFileBytes) {
          ignored.push({ path: rel, reason: `large-file>${maxSingleFileBytes}` });
          continue;
        }
        if (included.length >= maxFiles) {
          ignored.push({ path: rel, reason: `max-files>${maxFiles}` });
          continue;
        }
        const buffer = await fs.readFile(absolute);
        const sha256 = sha256Buffer(buffer);
        included.push({ path: rel, absolutePath: absolute, size: stat.size, mtimeMs: Math.round(stat.mtimeMs), sha256 });
        totalBytes += stat.size;
        if (isLikelyTextFile(rel)) symbols.push(...detectSymbols(rel, buffer.toString('utf8')));
      }
    };

    await walk(root);
    included.sort((a, b) => a.path.localeCompare(b.path));
    symbols.sort((a, b) => a.file.localeCompare(b.file) || a.lineStart - b.lineStart);

    const agent = await this.readAgent(root);
    const skills = await this.listSkills(root);
    const context = this.buildProjectContext({ root, files: included, ignored, symbols, agent, skills, symbolLimit });
    const manifestPayload = {
      root,
      files: included.map(({ path: rel, size, mtimeMs, sha256 }) => ({ path: rel, size, mtimeMs, sha256 })),
      agentHash: sha256Text(agent.content || ''),
      skillsHash: sha256Text(JSON.stringify(skills.map((skill) => ({ name: skill.name, sha256: skill.sha256 })))),
      contextHash: sha256Text(context),
    };
    const snapshotId = sha256Text(JSON.stringify(manifestPayload));
    state.lastSnapshotId = snapshotId;
    state.updatedAt = nowIso();
    await this.#saveState(state);

    return {
      project: this.#publicState(state),
      snapshotId,
      root,
      name: state.name,
      files: included.map(({ absolutePath: _absolutePath, ...file }) => file),
      ignored,
      totalBytes,
      tree: makeTree(included.map((file) => file.path), Number(options.treeLimit || 500)),
      symbols: symbols.slice(0, symbolLimit),
      agent,
      skills,
      context,
      manifest: manifestPayload,
      limits: { maxFiles, maxSingleFileBytes, symbolLimit },
    };
  }

  async pack(cwd, options = {}) {
    const root = path.resolve(cwd || '');
    const scan = await this.scan(root, options);
    const state = await this.#loadState(scan.project.id, root);
    const threadId = String(options.threadId || state.currentThreadId || '');
    const selectedSkills = this.#selectSkills(scan.skills, options.skills || state.enabledSkills || []);
    const skillsText = selectedSkills.map((skill) => `# Skill: ${skill.name}\n\n${skill.content}`).join('\n\n---\n\n');
    const effectiveAgent = this.buildEffectiveAgent({ agent: scan.agent, skills: selectedSkills });
    const generatedManifest = {
      projectId: scan.project.id,
      projectName: scan.name,
      snapshotId: scan.snapshotId,
      generatedAt: nowIso(),
      root: scan.root,
      files: scan.manifest.files,
      ignoredCount: scan.ignored.length,
      selectedSkills: selectedSkills.map((skill) => skill.name),
    };

    state.snapshots = state.snapshots || {};
    let snapshot = state.snapshots[scan.snapshotId] || null;
    let file = snapshot?.fileId ? await this.fileStore.get(snapshot.fileId).catch(() => null) : null;

    if (!file || options.force) {
      const projectDir = this.#projectDir(scan.project.id);
      const snapshotsDir = path.join(projectDir, 'snapshots');
      await fs.mkdir(snapshotsDir, { recursive: true });
      const zipName = `${cleanName(scan.name)}-${scan.snapshotId.slice(0, 12)}.zip`;
      const zipPath = path.join(snapshotsDir, zipName);
      const entries = [];
      for (const item of scan.files) entries.push({ name: `project/${item.path}`, path: path.join(root, item.path) });
      entries.push({ name: '.bridge/PROJECT_CONTEXT.md', data: scan.context });
      entries.push({ name: '.bridge/AGENT_EFFECTIVE.md', data: effectiveAgent });
      entries.push({ name: '.bridge/SKILLS.md', data: skillsText || 'No skills enabled.\n' });
      entries.push({ name: '.bridge/MANIFEST.json', data: JSON.stringify(generatedManifest, null, 2) });
      const zip = await writeZip(zipPath, entries);
      if (zip.size > config.projectMaxZipBytes) {
        throw new Error(`Project ZIP exceeds PROJECT_MAX_ZIP_BYTES (${zip.size} > ${config.projectMaxZipBytes})`);
      }
      file = await this.fileStore.importLocalPath({ filePath: zip.path, name: zipName, mime: 'application/zip' });
      snapshot = { snapshotId: scan.snapshotId, zipPath, fileId: file.id, name: zipName, size: file.size, createdAt: nowIso(), manifest: generatedManifest };
      state.snapshots[scan.snapshotId] = snapshot;
      await this.#saveState(state);
    }

    const uploaded = threadId && state.uploads?.[threadId]?.[scan.snapshotId];
    const shouldAttach = !(threadId && uploaded && options.snapshotPolicy !== 'always');
    return {
      project: this.#publicState(state),
      scan,
      snapshotId: scan.snapshotId,
      file,
      zip: snapshot,
      threadId,
      selectedSkills,
      shouldAttach,
      alreadyUploaded: Boolean(uploaded),
      attachmentIds: shouldAttach && file?.id ? [file.id] : [],
    };
  }


  async getSnapshotManifest(cwd, snapshotId = '') {
    const root = path.resolve(cwd || '');
    const state = await this.#loadState(projectIdForRoot(root), root);
    const id = snapshotId || state.lastSnapshotId || '';
    if (!id) return null;
    return state.snapshots?.[id]?.manifest || null;
  }

  async getLatestSnapshotManifest(cwd) {
    return await this.getSnapshotManifest(cwd, '');
  }

  async markSnapshotUploaded({ cwd, projectId, threadId, snapshotId, fileId }) {
    const root = path.resolve(cwd || '');
    const id = projectId || projectIdForRoot(root);
    const state = await this.#loadState(id, root);
    state.uploads = state.uploads || {};
    state.uploads[threadId] = state.uploads[threadId] || {};
    state.uploads[threadId][snapshotId] = { fileId, uploadedAt: nowIso() };
    state.updatedAt = nowIso();
    await this.#saveState(state);
    return this.#publicState(state);
  }

  async setCurrentThread(cwd, threadId) {
    const root = path.resolve(cwd || '');
    const state = await this.#loadState(projectIdForRoot(root), root);
    state.currentThreadId = threadId || '';
    state.updatedAt = nowIso();
    await this.#saveState(state);
    return this.#publicState(state);
  }

  async setEnabledSkills(cwd, names = []) {
    const root = path.resolve(cwd || '');
    const state = await this.#loadState(projectIdForRoot(root), root);
    state.enabledSkills = Array.from(new Set(names.map(String).filter(Boolean))).sort();
    state.updatedAt = nowIso();
    await this.#saveState(state);
    return this.#publicState(state);
  }

  async readAgent(root) {
    const absoluteRoot = path.resolve(root || '');
    const names = ['AGENTS.md', 'AGENT.md', 'agent.md', path.join('.bridge', 'AGENT.md')];
    const found = [];
    for (const name of names) {
      const filePath = path.join(absoluteRoot, name);
      try {
        const content = await fs.readFile(filePath, 'utf8');
        found.push({ path: posixPath(path.relative(absoluteRoot, filePath)), absolutePath: filePath, content, sha256: sha256Text(content) });
      } catch {}
    }
    const first = found[0] || { path: '', absolutePath: '', content: '', sha256: '' };
    return { ...first, found: found.map(({ absolutePath: _absolutePath, ...item }) => item) };
  }

  async listSkills(root) {
    const absoluteRoot = path.resolve(root || '');
    const dirs = [path.join(absoluteRoot, '.bridge', 'skills'), path.join(os.homedir(), '.chatgpt-bridge', 'skills')];
    const skills = [];
    for (const dir of dirs) {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
        const filePath = path.join(dir, entry.name);
        const content = await fs.readFile(filePath, 'utf8').catch(() => '');
        skills.push({ name: skillNameFromPath(filePath), path: filePath, scope: dir.startsWith(absoluteRoot) ? 'project' : 'global', content, sha256: sha256Text(content) });
      }
    }
    const byName = new Map();
    for (const skill of skills) if (!byName.has(skill.name) || skill.scope === 'project') byName.set(skill.name, skill);
    return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name)).map((skill) => ({ ...skill, path: posixPath(skill.path) }));
  }

  buildProjectContext({ root, files, ignored, symbols, agent, skills, symbolLimit = config.projectContextMaxSymbols }) {
    const scripts = files.find((file) => file.path === 'package.json') ? 'Node.js package detected from package.json.' : '';
    return [
      `# Project Context`,
      ``,
      `Root: ${root}`,
      `Files included: ${files.length}`,
      `Files ignored/skipped: ${ignored.length}`,
      scripts ? `Detected stack: ${scripts}` : '',
      ``,
      `## File tree`,
      '```text',
      makeTree(files.map((file) => file.path)),
      '```',
      ``,
      `## Symbols`,
      symbols.length ? formatSymbols(symbols, symbolLimit) : 'No symbols detected by the lightweight scanner.',
      ``,
      `## Agent file`,
      agent?.path ? `Found: ${agent.path}` : 'No AGENT.md file found.',
      ``,
      `## Available skills`,
      skills.length ? skills.map((skill) => `- ${skill.name} (${skill.scope})`).join('\n') : 'No skills found.',
    ].filter((line) => line !== '').join('\n');
  }

  buildEffectiveAgent({ agent, skills = [] }) {
    const sections = [
      '# Bridge project-task instructions',
      '- Treat the attached ZIP as the project snapshot.',
      '- Work only inside the project tree.',
      '- Do not include .git, node_modules, dist, build, coverage, caches, or secrets in output archives.',
      '- Return a downloadable ZIP artifact with the full updated project when asked to modify files.',
      '- Also include a concise changelog in the chat response.',
    ];
    if (agent?.content) sections.push('\n# Project AGENT.md\n', agent.content.trim());
    for (const skill of skills) sections.push(`\n# Skill: ${skill.name}\n`, skill.content.trim());
    return sections.join('\n');
  }

  buildTaskMessage({ message, pack }) {
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
      '- Exclude .git, node_modules, dist, build, coverage, caches, temporary files, and secrets.',
      '- Include a short changelog in the chat answer.',
      '- If you cannot create a ZIP artifact, output changed files as fenced blocks using ```file:path/to/file.',
    ].join('\n');
  }

  async buildAskMessage(cwd, message, { skills = [] } = {}) {
    const root = path.resolve(cwd || '');
    const agent = await this.readAgent(root);
    const availableSkills = await this.listSkills(root);
    const selectedSkills = this.#selectSkills(availableSkills, skills);
    const effectiveAgent = this.buildEffectiveAgent({ agent, skills: selectedSkills });
    return [
      'Use the following project agent instructions as lightweight context. Do not assume full project files are attached.',
      '',
      '```markdown',
      effectiveAgent,
      '```',
      '',
      'Question:',
      message,
    ].join('\n');
  }

  async #loadIgnoreRules(root, options = {}) {
    if (options.useGitignore === false) return [];
    const files = ['.gitignore', '.ignore', '.bridgeignore'];
    const rules = [];
    for (const file of files) {
      try { rules.push(...parseIgnoreFile(await fs.readFile(path.join(root, file), 'utf8'))); } catch {}
    }
    return rules;
  }

  #selectSkills(skills, names = []) {
    const wanted = new Set((names || []).map(String).filter(Boolean));
    if (!wanted.size) return [];
    return skills.filter((skill) => wanted.has(skill.name));
  }

  #projectDir(id) { return path.join(this.rootDir, id); }
  #statePath(id) { return path.join(this.#projectDir(id), 'state.json'); }

  async #loadState(id, root) {
    try {
      const raw = await fs.readFile(this.#statePath(id), 'utf8');
      const parsed = JSON.parse(raw);
      return {
        id,
        root,
        name: parsed.name || path.basename(root),
        currentThreadId: parsed.currentThreadId || '',
        enabledSkills: Array.isArray(parsed.enabledSkills) ? parsed.enabledSkills : [],
        lastSnapshotId: parsed.lastSnapshotId || '',
        snapshots: parsed.snapshots && typeof parsed.snapshots === 'object' ? parsed.snapshots : {},
        uploads: parsed.uploads && typeof parsed.uploads === 'object' ? parsed.uploads : {},
        createdAt: parsed.createdAt || nowIso(),
        updatedAt: parsed.updatedAt || nowIso(),
      };
    } catch {
      return { id, root, name: path.basename(root) || id, currentThreadId: '', enabledSkills: [], lastSnapshotId: '', snapshots: {}, uploads: {}, createdAt: nowIso(), updatedAt: nowIso() };
    }
  }

  async #saveState(state) {
    await fs.mkdir(this.#projectDir(state.id), { recursive: true });
    await fs.writeFile(this.#statePath(state.id), JSON.stringify(state, null, 2), 'utf8');
  }

  #publicState(state) {
    return {
      id: state.id,
      root: state.root,
      name: state.name,
      currentThreadId: state.currentThreadId || '',
      enabledSkills: state.enabledSkills || [],
      lastSnapshotId: state.lastSnapshotId || '',
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    };
  }
}
