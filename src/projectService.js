import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { writeZip } from './zipWriter.js';
import { sha256File } from './zipUtils.js';
import { buildEffectiveAgent as buildEffectiveAgentText, buildProjectContext as buildProjectContextText, buildTaskMessage as buildTaskMessageText, makeTree } from './project/service/context.js';
import { isDefaultIgnored, isIgnoredByRules, parseIgnoreFile } from './project/service/ignoreRules.js';
import { cleanName, nowIso, posixPath, projectIdForRoot, sha256Buffer, sha256Text, skillNameFromPath } from './project/service/core.js';
import { detectSymbols, isLikelyTextFile } from './project/service/symbols.js';

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
      const sha256 = await sha256File(zip.path);
      snapshot = { snapshotId: scan.snapshotId, zipPath, fileId: file.id, name: zipName, size: file.size, sha256, createdAt: nowIso(), manifest: generatedManifest };
      state.snapshots[scan.snapshotId] = snapshot;
      await this.#saveState(state);
    }

    if (snapshot && !snapshot.sha256 && snapshot.zipPath) {
      snapshot.sha256 = await sha256File(snapshot.zipPath).catch(() => '');
      if (snapshot.sha256) await this.#saveState(state).catch(() => {});
    }

    const uploaded = threadId && state.uploads?.[threadId]?.[scan.snapshotId];
    const shouldAttach = !(threadId && uploaded && options.snapshotPolicy !== 'always');
    return {
      project: this.#publicState(state),
      scan,
      snapshotId: scan.snapshotId,
      file,
      zip: snapshot,
      sha256: snapshot?.sha256 || '',
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

  async markSnapshotUploaded({ cwd, projectId, threadId, snapshotId, fileId, sha256 = '', source = 'attached' }) {
    const root = path.resolve(cwd || '');
    const id = projectId || projectIdForRoot(root);
    const state = await this.#loadState(id, root);
    state.uploads = state.uploads || {};
    state.uploads[threadId] = state.uploads[threadId] || {};
    state.uploads[threadId][snapshotId] = { fileId, sha256, source, uploadedAt: nowIso() };
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
    return buildProjectContextText({ root, files, ignored, symbols, agent, skills, symbolLimit });
  }

  buildEffectiveAgent({ agent, skills = [] }) {
    return buildEffectiveAgentText({ agent, skills });
  }

  buildTaskMessage({ message, pack }) {
    return buildTaskMessageText({ message, pack });
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
