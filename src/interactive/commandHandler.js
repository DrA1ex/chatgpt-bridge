import { config } from '../config.js';
import { buildHelpText, normalizeCommand } from './commands.js';
import {
  downloadArtifact,
  listArtifacts,
  listFiles,
  openArtifact,
  openProject,
  printAgent,
  printAttachments,
  printClients,
  printCurrentClient,
  printDebugEvents,
  printEfforts,
  printHealth,
  printModels,
  printProjectStatus,
  printProjectThreads,
  printSessions,
  printSkills,
  recoverLatestResponse,
  resolveClientSelector,
  resolveFromList,
  resolveModelToken,
  runDirectPrompt,
  runProjectTask,
  runResume,
} from './controller.js';
import { bytes, shellSplit } from './format.js';
import {
  EFFORTS,
  EVENT_LEVELS,
  makeDefaultState,
  switchSessionScope,
} from './state.js';
import { INTERACTIVE_THEME_PROFILES, interactiveThemeProfile, isInteractiveThemeName } from './terlioThemes.js';
import { runServerWorkflowCommand, startServerArchiveWorkflow } from './serverWorkflowCommands.js';

function printHelp() {
  console.log(buildHelpText());
}

export async function handleCommand(message, context) {
  message = normalizeCommand(message);
  const { bridge, fileStore, state, projectService, turnManager } = context;
  const [command, ...tokens] = shellSplit(message);
  const rest = message.slice(command.length).trim();
  const serverCommand = (args) => runServerWorkflowCommand({
    ...context,
    requestProjectArtifact: (prompt) => runProjectTask(prompt, {
      ...context,
      autoHandoff: false,
    }),
  }, args);

  if (message === '/help') { printHelp(); return true; }

  if (message === '/connect') {
    console.log(`Setup page: ${config.publicBaseUrl}/setup`);
    console.log(`Server URL: ${config.publicBaseUrl}`);
    console.log(`Bridge token: ${config.bridgeToken}`);
    console.log('Open an actual ChatGPT chat, click the floating Bridge button, paste the token, and press Save & connect.');
    console.log(`Diagnostics: ${config.publicBaseUrl}/diagnostics`);
    return true;
  }
  if (message === '/status') { printHealth(bridge, state); return true; }

  if (command === '/workflow') {
    await serverCommand(tokens);
    return true;
  }

  if (command === '/tab') {
    const sub = tokens[0] || 'current';
    if (sub === 'list') { printClients(bridge); return true; }
    if (sub === 'current') { printCurrentClient(bridge); return true; }
    if (sub === 'auto') {
      bridge.clearSelectedClient();
      console.log('Client selection cleared. Auto-selection is used only when exactly one tab is connected.');
      return true;
    }
    if (sub === 'drop') {
      const selector = tokens.slice(1).join(' ').trim();
      if (!selector) { console.log('Usage: /tab drop <id|index>'); return true; }
      const target = resolveClientSelector(bridge, selector);
      const dropped = bridge.dropClient(target.id);
      console.log(`Dropped client locally: ${dropped.id}`);
      return true;
    }
    const selector = tokens.join(' ').trim();
    const target = resolveClientSelector(bridge, selector);
    const selected = bridge.selectClient(target.id);
    console.log(`Selected client: ${selected.id}`);
    if (selected.url) console.log(selected.url);
    return true;
  }

  if (message === '/stop') {
    const cancelled = bridge.cancelActive('Cancelled from interactive /stop');
    console.log(`Cancelled requests: ${cancelled}`);
    return true;
  }

  if (message === '/reset') {
    Object.assign(state, makeDefaultState());
    console.log('Interactive state reset. Active ChatGPT tab was not modified.');
    return true;
  }


  if (command === '/theme') {
    const name = String(tokens[0] || '').trim().toLowerCase();
    if (!name) {
      const profile = interactiveThemeProfile(state.themeName);
      console.log(`Theme: ${profile.id} · ${profile.description}`);
      console.log('Usage: /theme list | /theme <name>');
      return true;
    }
    if (name === 'list') {
      console.log('Themes:');
      for (const profile of INTERACTIVE_THEME_PROFILES) {
        const active = profile.id === state.themeName ? '*' : ' ';
        console.log(` ${active} ${profile.id.padEnd(8)} ${profile.description}`);
      }
      return true;
    }
    if (!isInteractiveThemeName(name)) {
      console.log(`Unknown theme: ${name}`);
      console.log(`Available themes: ${INTERACTIVE_THEME_PROFILES.map((profile) => profile.id).join(', ')}`);
      return true;
    }
    state.themeName = name;
    const profile = interactiveThemeProfile(name);
    console.log(`Theme changed: ${profile.id} · ${profile.description}`);
    return true;
  }

  if (command === '/events') {
    const level = tokens[0];
    if (!level) console.log(`Events: ${state.eventLevel}`);
    else if (!EVENT_LEVELS.has(level)) console.log('Usage: /events quiet|normal|verbose');
    else { state.eventLevel = level; console.log(`Events: ${level}`); }
    return true;
  }

  if (message === '/session list') {
    state.lastSessions = await bridge.listSessions({ timeoutMs: 10_000 });
    printSessions(state);
    return true;
  }

  if (message === '/session current') {
    console.log(`Session: ${state.sessionId || '(current tab)'}`);
    return true;
  }

  if (message === '/session new') {
    const result = await bridge.newSession();
    const session = result.session || result.current || null;
    if (session?.id) switchSessionScope(state, session.id);
    state.lastSessions = result.sessions || (session ? [session] : []);
    console.log('Created new interactive session');
    console.log(`Session: ${session?.id || session?.title || '(unknown)'}`);
    if (session?.url) console.log(session.url);
    return true;
  }

  if (command === '/session') {
    const sub = tokens[0];
    const target = sub === 'select' ? tokens.slice(1).join(' ') : tokens.join(' ');
    if (!target) { console.log('Usage: /session select <id|index>'); return true; }
    if (!state.lastSessions.length && /^\d+$/.test(target)) state.lastSessions = await bridge.listSessions({ timeoutMs: 10_000 });
    const session = resolveFromList(target, state.lastSessions, 'session');
    const result = await bridge.selectSession(session.id);
    const selected = result.session || session;
    switchSessionScope(state, selected.id || session.id);
    state.lastSessions = result.sessions || state.lastSessions;
    console.log(`Selected session: ${selected.title || selected.id}`);
    if (selected.url) console.log(selected.url);
    return true;
  }

  if (command === '/model') {
    if (tokens[0] === 'list') {
      const result = await bridge.listModels({ timeoutMs: 10_000 });
      state.lastModels = result.models || [];
      state.currentModel = String(result.current?.label || result.current?.value || result.current?.name || result.current?.id || '');
      printModels(state);
      return true;
    }
    if (tokens[0] === 'default' || tokens[0] === 'clear' || tokens[0] === 'auto') {
      state.model = '';
      console.log('Model reset to ChatGPT default');
      return true;
    }
    const modelName = resolveModelToken(tokens.join(' '), state.lastModels);
    if (!modelName) printModels(state);
    else { state.model = modelName; console.log(`Model set: ${state.model}`); }
    return true;
  }

  if (command === '/effort') {
    if (tokens[0] === 'list') {
      const result = await bridge.listEfforts({ timeoutMs: 10_000 });
      state.lastEfforts = result.efforts || [];
      state.currentEffort = String(result.current?.value || result.current?.id || result.current?.label || '').toLowerCase();
      printEfforts(state);
      return true;
    }
    if (tokens[0] === 'default' || tokens[0] === 'clear') {
      state.effort = '';
      console.log('Effort reset to ChatGPT default');
      return true;
    }
    const effort = resolveModelToken(tokens.join(' '), state.lastEfforts, { preferValue: true }).toLowerCase();
    if (!effort) printEfforts(state);
    else if (!EFFORTS.has(effort)) console.log('Usage: /effort auto|instant|low|medium|high|xhigh');
    else { state.effort = effort; console.log(`Effort set: ${state.effort}`); }
    return true;
  }


  if (command === '/project') {
    const sub = tokens[0] || '';
    if (!sub) { printProjectStatus(state); return true; }
    if (sub === 'open') {
      const projectPath = tokens.slice(1).join(' ');
      if (!projectPath) { console.log('Usage: /project open <path>'); return true; }
      const project = await openProject(projectService, turnManager, state, projectPath);
      console.log(`[project] opened ${project.name} · ${project.root}`);
      if (state.projectThreads.length) {
        console.log('Existing local threads:');
        printProjectThreads(state);
      } else {
        console.log('No local thread yet. Use /project session new.');
      }
      return true;
    }
    if (sub === 'scan') {
      if (!state.projectRoot) { console.log('No project opened.'); return true; }
      const scan = await projectService.scan(state.projectRoot, { skills: state.enabledSkills });
      state.lastProjectScan = scan;
      state.projectId = scan.project.id;
      console.log(`[project] snapshot ${scan.snapshotId}`);
      console.log(`[project] ${scan.files.length} files included · ${scan.ignored.length} ignored · ${bytes(scan.totalBytes)}`);
      console.log(scan.agent.path ? `[agent] ${scan.agent.path}` : '[agent] not found');
      if (scan.skills.length) console.log(`[skills] available: ${scan.skills.map((skill) => skill.name).join(', ')}`);
      return true;
    }
    if (sub === 'pack' || sub === 'sync') {
      if (!state.projectRoot) { console.log('No project opened.'); return true; }
      const pack = await projectService.pack(state.projectRoot, { threadId: state.projectThreadId, skills: state.enabledSkills, force: sub === 'sync', snapshotPolicy: sub === 'sync' ? 'always' : 'reuse-if-unchanged' });
      state.lastProjectPack = pack;
      state.lastProjectScan = pack.scan;
      state.projectId = pack.project.id;
      console.log(`[project] packed ${pack.file.name} · ${pack.file.id} · ${bytes(pack.file.size)}`);
      console.log(`[project] snapshot ${pack.snapshotId} · ${pack.shouldAttach ? 'will attach on next task' : 'already uploaded for this thread'}`);
      return true;
    }
    if (sub === 'session') {
      const action = tokens[1] || 'list';
      if (action === 'list') {
        if (!state.projectRoot) { console.log('No project opened.'); return true; }
        state.projectThreads = await projectService.listThreadsForProject(state.projectRoot, turnManager);
        printProjectThreads(state);
        return true;
      }
      if (action === 'new') {
        if (!state.projectRoot) { console.log('No project opened.'); return true; }
        const title = state.projectRoot.split(/[\/]/).filter(Boolean).pop() || 'Project';
        const thread = await turnManager.createThread({ title, cwd: state.projectRoot, metadata: { project: true, projectId: state.projectId } });
        state.projectThreadId = thread.id;
        await projectService.setCurrentThread(state.projectRoot, thread.id);
        state.projectThreads = await projectService.listThreadsForProject(state.projectRoot, turnManager);
        console.log(`[project] new thread: ${thread.title} · ${thread.id}`);
        return true;
      }
      if (action === 'use' || action === 'select') {
        if (!state.projectRoot) { console.log('No project opened.'); return true; }
        const target = tokens.slice(2).join(' ');
        if (!target) { console.log('Usage: /project session use <id|index>'); return true; }
        if (!state.projectThreads.length) state.projectThreads = await projectService.listThreadsForProject(state.projectRoot, turnManager);
        const thread = resolveFromList(target, state.projectThreads, 'thread');
        state.projectThreadId = thread.id;
        await projectService.setCurrentThread(state.projectRoot, thread.id);
        console.log(`[project] using thread: ${thread.title || thread.id} · ${thread.id}`);
        return true;
      }
      console.log('Usage: /project session [list|new|use <id|index>]');
      return true;
    }
    if (sub === 'skills') {
      const action = tokens[1] || 'list';
      if (action === 'list' || action === 'reload') { await printSkills(projectService, state); return true; }
      if (action === 'enable') {
        const names = tokens.slice(2);
        if (!names.length) { console.log('Usage: /project skills enable <name...>'); return true; }
        state.enabledSkills = Array.from(new Set([...(state.enabledSkills || []), ...names])).sort();
        if (state.projectRoot) await projectService.setEnabledSkills(state.projectRoot, state.enabledSkills);
        console.log(`[skills] enabled: ${state.enabledSkills.join(', ')}`);
        return true;
      }
      if (action === 'disable') {
        const names = new Set(tokens.slice(2));
        if (!names.size) { console.log('Usage: /project skills disable <name...>'); return true; }
        state.enabledSkills = (state.enabledSkills || []).filter((name) => !names.has(name));
        if (state.projectRoot) await projectService.setEnabledSkills(state.projectRoot, state.enabledSkills);
        console.log(`[skills] enabled: ${state.enabledSkills.length ? state.enabledSkills.join(', ') : '(none)'}`);
        return true;
      }
      console.log('Usage: /project skills [list|enable <name...>|disable <name...>]');
      return true;
    }
    if (sub === 'agent') {
      await printAgent(projectService, state);
      return true;
    }
    console.log('Usage: /project | /project open <path> | /project scan | /project pack | /project sync | /project session [list|new|use <id|index>] | /project skills [list|enable|disable] | /project agent');
    return true;
  }

  if (command === '/chat') {
    const prompt = rest;
    if (!prompt) { console.log('Usage: /chat <text>'); return true; }
    await runDirectPrompt(prompt, context);
    return true;
  }

  if (command === '/resume') {
    await runResume(context);
    return true;
  }

  if (command === '/task') {
    const prompt = rest;
    if (!prompt) { console.log('Usage: /task <prompt>'); return true; }
    await runProjectTask(prompt, context);
    return true;
  }

  if (command === '/apply') {
    const pathArg = tokens.find((token) => !token.startsWith('--')) || '';
    if (tokens.includes('--force')) {
      throw Object.assign(new Error(
        '`/apply --force` is unavailable; approve only actions advertised by Zipflow.',
      ), { code: 'WORKFLOW_FORCE_UNSUPPORTED' });
    }
    const unknownFlag = tokens.find((token) => token.startsWith('--')
      && !['--plan', '--interactive'].includes(token));
    if (unknownFlag) throw new Error(`Unsupported /apply option: ${unknownFlag}`);
    await startServerArchiveWorkflow(context, { explicitPath: pathArg });
    return true;
  }

  if (command === '/recover') {
    const indexToken = tokens.find((token) => /^\d+$/.test(token));
    await recoverLatestResponse(context, { force: tokens.includes('--force'), apply: tokens.includes('--apply'), list: tokens.includes('list') || tokens.includes('--list'), index: indexToken ? Number(indexToken) : 1 });
    return true;
  }

  if (command === '/file') {
    const sub = tokens[0] || 'list';
    if (sub === 'list') { printAttachments(state); return true; }
    if (sub === 'clear-ui') {
      const result = await bridge.clearComposerAttachments({ timeoutMs: 10_000 });
      console.log(`Composer attachments cleared: ${result.removed ?? 0}`);
      if (result.message) console.log(result.message);
      return true;
    }
    if (sub === 'clear') {
      state.pendingAttachments = [];
      console.log('Queued attachments cleared.');
      return true;
    }
    if (sub === 'remove') {
      const target = tokens[1];
      if (!target) { console.log('Usage: /file remove <index|fileId>'); return true; }
      const before = state.pendingAttachments.length;
      const index = Number.parseInt(target, 10);
      if (Number.isInteger(index) && String(index) === target && index >= 1 && index <= state.pendingAttachments.length) {
        const [removed] = state.pendingAttachments.splice(index - 1, 1);
        console.log(`Removed from queue: ${removed.name}`);
      } else {
        state.pendingAttachments = state.pendingAttachments.filter((file) => file.id !== target);
        console.log(before === state.pendingAttachments.length ? `No queued attachment matched: ${target}` : `Removed from queue: ${target}`);
      }
      return true;
    }
    if (sub === 'add') {
      const paths = tokens.slice(1);
      if (!paths.length) { console.log('Usage: /file <path> [path...]'); return true; }
      for (const filePath of paths) {
        const file = await fileStore.importLocalPath({ filePath });
        state.pendingAttachments.push(file);
        console.log(`[file] added and queued ${file.name} · ${file.id} · ${bytes(file.size)}`);
      }
      return true;
    }
    if (sub === 'stored') { await listFiles(fileStore); return true; }
    if (sub === 'delete') {
      const fileId = tokens[1];
      if (!fileId) { console.log('Usage: /file delete <fileId>'); return true; }
      const removed = await fileStore.remove(fileId);
      state.pendingAttachments = state.pendingAttachments.filter((file) => file.id !== fileId);
      console.log(removed ? `Removed: ${fileId}` : `Not found: ${fileId}`);
      console.log('If this file is still visible in the ChatGPT composer, use /file clear-ui.');
      return true;
    }
    console.log('Usage: /file [path...] | /file list | /file add <path...> | /file remove <index|fileId> | /file clear-ui | /file clear | /file stored | /file delete <fileId>');
    return true;
  }

  if (command === '/artifact') {
    const sub = tokens[0] || 'list';
    if (sub === 'list') { await listArtifacts(bridge, fileStore, state); return true; }
    if (sub === 'download') { await downloadArtifact(bridge, fileStore, state, tokens.slice(1)); return true; }
    if (sub === 'open') { await openArtifact(bridge, fileStore, state, tokens.slice(1)); return true; }
    console.log('Usage: /artifact [list|download <index|artifactId> [path]|open <index|artifactId>]');
    return true;
  }

  if (command === '/debug') {
    const limit = Number.parseInt(tokens[0] || '20', 10);
    printDebugEvents(bridge, Number.isFinite(limit) ? limit : 20);
    return true;
  }

  return false;
}
