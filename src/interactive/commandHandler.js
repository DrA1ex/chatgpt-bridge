import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { initWorkflowConfig } from '../cli/workflowConfigCommands.js';
import { buildHelpText, normalizeCommand } from './commands.js';
import { applyLastTurnResult, applyZipPathResult } from './apply.js';
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
  printWorkflowStatus,
  printWorkflowHistory,
  printWorkflowList,
  recoverLatestResponse,
  resolveClientSelector,
  resolveFromList,
  resolveModelToken,
  resolveWorkflowId,
  runDirectPrompt,
  runProjectTask,
  runResume,
} from './controller.js';
import * as workflowView from '../workflow/ux/workflowView.js';
const { workflowBoundSession, workflowRunActive, workflowWatcherActive } = workflowView;
import { bytes, shellSplit } from './format.js';
import {
  EFFORTS,
  EVENT_LEVELS,
  makeDefaultState,
  switchSessionScope,
} from './state.js';
import { INTERACTIVE_THEME_PROFILES, interactiveThemeProfile, isInteractiveThemeName } from './terlioThemes.js';
import {
  runServerWorkflowCommand,
  startServerArchiveWorkflow,
  migrateLegacyWorkflowCommand,
} from './serverWorkflowCommands.js';

function printHelp() {
  console.log(buildHelpText());
}

function optionValue(tokens, name) {
  const index = tokens.indexOf(name);
  return index >= 0 ? String(tokens[index + 1] || '') : '';
}

function positionalTokens(tokens = []) {
  const result = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = String(tokens[index] || '');
    if (token.startsWith('--')) {
      if (['--max-cycles', '--session', '--reason'].includes(token)) index += 1;
      continue;
    }
    result.push(token);
  }
  return result;
}

function workflowSessionOptions(tokens, state, workflow = {}) {
  const value = optionValue(tokens, '--session').trim();
  if (!value || value === 'current') {
    return { sessionPolicy: 'current', sessionId: state.sessionId || '' };
  }
  if (value === 'new') return { sessionPolicy: 'new', sessionId: '' };
  if (value === 'pinned') {
    return { sessionPolicy: 'pinned', sessionId: workflow.pinnedSessionId || '' };
  }
  return { sessionPolicy: 'pinned', sessionId: value };
}

function activeLegacyForProject(workflowManager, state) {
  return workflowManager?.list?.().find((workflow) => (
    workflowRunActive(workflow)
    && (!state.projectRoot
      || (workflow.projectRoot
        && path.resolve(workflow.projectRoot) === path.resolve(state.projectRoot)))
  )) || null;
}

export async function handleCommand(message, context) {
  message = normalizeCommand(message);
  const { bridge, fileStore, state, projectService, turnManager, workflowManager, confirm } = context;
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
    const sub = String(tokens[0] || 'open').toLowerCase();
    const args = tokens.slice(1);
    if (context.zipflowWorkflowRuntime) {
      if (!tokens.length) {
        await serverCommand([]);
        return true;
      }
      if (['server', 'service'].includes(sub)) {
        await serverCommand(args);
        return true;
      }
      if (['history', 'plan', 'diff', 'report', 'checks', 'preset', 'fix', 'run'].includes(sub)) {
        await serverCommand(tokens);
        return true;
      }
      if (['open', 'new'].includes(sub)) {
        await serverCommand(['open']);
        return true;
      }
      if (!['legacy', 'migrate'].includes(sub)) {
        console.log('Usage: /workflow [history|plan|diff <path>|report|checks|fix|preset <id>]');
        return true;
      }
    }
    if (!workflowManager) throw new Error('Legacy workflow manager is not available');
    const activeLegacy = activeLegacyForProject(workflowManager, state);
    const migrationCandidate = workflowManager.list().find((workflow) => (
      !workflowRunActive(workflow)
      && (!state.projectRoot || path.resolve(workflow.projectRoot) === path.resolve(state.projectRoot))
    )) || null;
    if (!tokens.length && activeLegacy && typeof context.openWorkflowWizard === 'function') {
      await context.openWorkflowWizard();
      return true;
    }
    if (sub === 'migrate') {
      const workflowId = positionalTokens(args)[0] || migrationCandidate?.id;
      if (!workflowId) throw new Error('Usage: /workflow migrate <legacy-workflow-id>');
      await migrateLegacyWorkflowCommand(context, workflowId);
      return true;
    }
    if (sub === 'legacy' && typeof context.openWorkflowWizard === 'function') {
      await context.openWorkflowWizard();
      return true;
    }
    if (['wizard', 'open', 'new', 'active', 'action', 'settings'].includes(sub) && typeof context.openWorkflowWizard === 'function') {
      const view = sub === 'open' || sub === 'wizard' ? '' : sub;
      await context.openWorkflowWizard({ view, pendingOnly: sub === 'action' });
      return true;
    }
    if (sub === 'dashboard' || sub === 'status') {
      await printWorkflowStatus(workflowManager, { workflowId: positionalTokens(args)[0] || '', currentSessionId: state.sessionId });
      return true;
    }
    if (sub === 'list') {
      await printWorkflowList(workflowManager);
      return true;
    }
    if (sub === 'init') {
      const force = args.includes('--force');
      const explicit = positionalTokens(args)[0] || '';
      const target = path.resolve(explicit || path.join(state.projectRoot || process.cwd(), 'bridge.workflow.json'));
      const existing = await fs.stat(target).catch(() => null);
      if (existing && !force) throw new Error(`Workflow config already exists: ${target}. Use --force to overwrite it.`);
      await initWorkflowConfig(target, { force });
      console.log(`Created workflow config: ${target}`);
      console.log('Validate it with `bridge workflow validate` before running.');
      return true;
    }
    if (sub === 'load') {
      const configPath = args.join(' ').trim();
      if (!configPath) { console.log('Usage: /workflow load <configPath>'); return true; }
      const loaded = await workflowManager.load(configPath, { start: true });
      console.log(`Loaded workflow ${loaded.id}.`);
      await printWorkflowStatus(workflowManager, { workflowId: loaded.id, currentSessionId: state.sessionId });
      return true;
    }
    if (sub === 'show') {
      const workflowId = resolveWorkflowId(workflowManager, positionalTokens(args)[0]);
      const workflow = workflowManager.get(workflowId);
      await printWorkflowStatus(workflowManager, { workflowId, currentSessionId: state.sessionId });
      console.log('');
      console.log(`Project:  ${workflow.projectRoot}`);
      console.log(`Config:   ${workflow.configPath}`);
      console.log(`Session policy: ${workflow.sessionPolicy}`);
      console.log(`Restart policy: ${workflow.restartPolicy}`);
      if (workflow.run?.references?.reportDir) console.log(`Reports:  ${workflow.run.references.reportDir}`);
      if (workflow.nextAction) console.log(`Action:   ${workflow.nextAction.id}`);
      return true;
    }
    if (sub === 'run' || sub === 'restart') {
      const positionals = positionalTokens(args);
      const workflowId = resolveWorkflowId(workflowManager, positionals[0]);
      const workflow = workflowManager.get(workflowId);
      if (workflow.preset === 'apply-changes') {
        const watching = workflowWatcherActive(workflow) ? workflow : await workflowManager.start(workflowId);
        console.log('Workflow is watching the selected ChatGPT tab.');
        console.log('Continue the conversation in that browser tab; Bridge will process new completed responses and valid result packages automatically.');
        console.log(`Chat: ${watching.sessionId || watching.boundSessionId || watching.pinnedSessionId || '(selected tab)'}`);
        await printWorkflowStatus(workflowManager, { workflowId, currentSessionId: state.sessionId });
        return true;
      }
      if (workflow.preset === 'guided-task') {
        if (!workflowWatcherActive(workflow)) await workflowManager.start(workflowId);
        state.focusedWorkflowId = workflowId;
        console.log('Guided workflow focused. Type the next prompt in Bridge.');
        await printWorkflowStatus(workflowManager, { workflowId, currentSessionId: state.sessionId });
        return true;
      }
      const maxCyclesValue = optionValue(args, '--max-cycles');
      const maxCycles = maxCyclesValue ? Number(maxCyclesValue) || undefined : undefined;
      const runOptions = {
        verbose: args.includes('--verbose'),
        maxCycles,
        trigger: 'interactive',
        model: state.model || '',
        effort: state.effort || '',
        ...workflowSessionOptions(args, state, workflow),
      };
      const automation = sub === 'restart'
        ? await workflowManager.restartAutomation(workflowId, runOptions)
        : await workflowManager.runAutomation(workflowId, runOptions);
      console.log(`Workflow run started: ${automation.id}`);
      await printWorkflowStatus(workflowManager, { workflowId, currentSessionId: state.sessionId });
      return true;
    }
    if (sub === 'stop' || sub === 'run-stop') {
      const workflowId = resolveWorkflowId(workflowManager, positionalTokens(args)[0]);
      const workflow = workflowManager.get(workflowId);
      if (workflow.preset === 'apply-changes' || workflow.preset === 'guided-task') {
        await workflowManager.stop(workflowId);
        if (state.focusedWorkflowId === workflowId) state.focusedWorkflowId = '';
        console.log(workflow.preset === 'apply-changes' ? 'ChatGPT tab watching paused.' : 'Guided workflow paused.');
      } else {
        const automation = await workflowManager.stopAutomation(workflowId, 'stopped from interactive UI');
        console.log(`Workflow lifecycle: ${workflowManager.get(workflowId)?.lifecycle || 'stopped'}.`);
      }
      await printWorkflowStatus(workflowManager, { workflowId, currentSessionId: state.sessionId });
      return true;
    }
    if (sub === 'resume') {
      const workflowId = resolveWorkflowId(workflowManager, positionalTokens(args)[0]);
      const workflow = workflowManager.get(workflowId);
      if (workflow.preset === 'apply-changes' || workflow.preset === 'guided-task') {
        await workflowManager.start(workflowId);
        if (workflow.preset === 'guided-task') state.focusedWorkflowId = workflowId;
        console.log(workflow.preset === 'apply-changes' ? 'ChatGPT tab watching resumed.' : 'Guided workflow resumed and focused.');
      } else {
        await workflowManager.resumeAutomation(workflowId);
        console.log('Workflow run resumed.');
      }
      await printWorkflowStatus(workflowManager, { workflowId, currentSessionId: state.sessionId });
      return true;
    }
    if (sub === 'discard') {
      const workflowId = resolveWorkflowId(workflowManager, positionalTokens(args)[0]);
      await workflowManager.discardAutomation(workflowId, 'discarded from interactive UI');
      console.log('Interrupted workflow run discarded.');
      await printWorkflowStatus(workflowManager, { workflowId, currentSessionId: state.sessionId });
      return true;
    }
    if (sub === 'history') {
      const positionals = positionalTokens(args);
      const workflowId = resolveWorkflowId(workflowManager, positionals[0]);
      const limit = Math.max(1, Number(optionValue(args, '--limit')) || 10);
      await printWorkflowHistory(workflowManager, workflowId, limit);
      return true;
    }
    if (sub === 'logs') {
      const workflowId = resolveWorkflowId(workflowManager, positionalTokens(args)[0]);
      const workflow = workflowManager.get(workflowId);
      if (!args.includes('--verbose')) {
        console.log(`Run reports: ${workflow.run?.references?.reportDir || '(no report yet)'}`);
        console.log('Use `/workflow logs --verbose` for raw workflow events.');
        return true;
      }
      for (const event of await workflowManager.events(workflowId, 100)) {
        console.log(`${event.time} ${event.type} ${JSON.stringify(event.data || {})}`);
      }
      return true;
    }
    if (sub === 'approve' || sub === 'reject') {
      const positionals = positionalTokens(args);
      const loadedIds = new Set(workflowManager.list().map((item) => item.id));
      const workflowToken = loadedIds.has(positionals[0]) ? positionals.shift() : '';
      const workflowId = resolveWorkflowId(workflowManager, workflowToken);
      const workflow = workflowManager.get(workflowId);
      if (!workflow?.nextAction) throw new Error('This workflow has no pending action.');
      const choice = sub === 'approve' ? 'approve' : 'reject';
      await workflowManager.command(workflowId, { type: 'act', actionId: workflow.nextAction.id, choice, reason: optionValue(args, '--reason') || positionals.join(' ') });
      console.log(sub === 'approve' ? 'Workflow action approved.' : 'Workflow action rejected.');
      await printWorkflowStatus(workflowManager, { workflowId, currentSessionId: state.sessionId });
      return true;
    }
    if (sub === 'debug' || sub === 'events') {
      const positionals = positionalTokens(args);
      const workflowId = resolveWorkflowId(workflowManager, positionals[0]);
      const workflow = workflowManager.get(workflowId);
      console.log(JSON.stringify(workflow, null, 2));
      const limit = Math.max(1, Number(positionals[1]) || 30);
      for (const event of await workflowManager.events(workflowId, limit)) console.log(`${event.time} ${event.type} ${JSON.stringify(event.data || {})}`);
      return true;
    }

    // Compatibility-only administrative operations. They are intentionally absent from normal help.
    if (sub === 'unload' || sub === 'extension' || sub === 'verify' || sub === 'start') {
      const workflowId = resolveWorkflowId(workflowManager, positionalTokens(args)[0]);
      if (sub === 'unload') console.log((await workflowManager.unload(workflowId)) ? `Unloaded ${workflowId}.` : `Workflow not found: ${workflowId}`);
      else if (sub === 'extension') console.log(JSON.stringify(await workflowManager.deployExtension(workflowId), null, 2));
      else if (sub === 'start') {
        const started = await workflowManager.start(workflowId);
        console.log(started.preset === 'apply-changes'
          ? 'Workflow is watching the selected ChatGPT tab. Continue chatting there; no additional run command is needed.'
          : `Workflow observer started: ${workflowId}`);
        await printWorkflowStatus(workflowManager, { workflowId, currentSessionId: state.sessionId });
      } else {
        const artifactOrFileId = positionalTokens(args)[1];
        if (!artifactOrFileId) { console.log('Usage: /workflow verify <workflowId> <artifactId|fileId>'); return true; }
        let verification;
        try {
          verification = await workflowManager.verifyArtifact(workflowId, { artifactId: artifactOrFileId });
        } catch (artifactError) {
          verification = await workflowManager.verifyArtifact(workflowId, { fileId: artifactOrFileId }).catch(() => { throw artifactError; });
        }
        console.log(JSON.stringify({ ok: verification.ok, reasons: verification.reasons, zip: verification.zip, overlapScore: verification.overlapScore, commands: verification.commands }, null, 2));
      }
      return true;
    }
    console.log(context.zipflowWorkflowRuntime
      ? 'Usage: /workflow [history|plan|diff <path>|report|checks|fix|preset <id>]'
      : 'Usage: /workflow [wizard|open|new|active|action|settings]');
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
    const activeWorkflow = workflowManager?.list?.().find(workflowRunActive) || null;
    if (activeWorkflow) {
      console.log('');
      console.log(`Active workflow run remains bound to: ${workflowBoundSession(activeWorkflow) || '(its original browser session)'}`);
      console.log(`The next workflow run will use: ${session?.id || '(new session)'}`);
    } else if (workflowManager?.list?.().length) {
      console.log('');
      console.log(`The next workflow started through /workflow will use: ${session?.id || '(new session)'}`);
    }
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
    if (context.zipflowWorkflowRuntime) {
      if (tokens.includes('--force')) {
        throw Object.assign(new Error(
          '`/apply --force` is unavailable for server-backed workflows; approve only actions advertised by Zipflow.',
        ), { code: 'WORKFLOW_FORCE_UNSUPPORTED' });
      }
      const unknownFlag = tokens.find((token) => token.startsWith('--')
        && !['--plan', '--interactive'].includes(token));
      if (unknownFlag) throw new Error(`Unsupported /apply option: ${unknownFlag}`);
      await startServerArchiveWorkflow(context, { explicitPath: pathArg });
      return true;
    }
    if (pathArg) {
      await applyZipPathResult(pathArg, state, { force: tokens.includes('--force'), planOnly: tokens.includes('--plan'), interactive: tokens.includes('--interactive'), confirm, projectService });
    } else {
      if (!state.lastTurn && state.lastTurnId && turnManager) state.lastTurn = await turnManager.getTurn(state.lastTurnId);
      await applyLastTurnResult(fileStore, state, { force: tokens.includes('--force'), planOnly: tokens.includes('--plan'), interactive: tokens.includes('--interactive'), confirm, projectService, turnManager });
    }
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
