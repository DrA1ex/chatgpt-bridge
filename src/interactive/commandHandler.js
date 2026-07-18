import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { initWorkflowConfig } from '../cli/workflowConfigCommands.js';
import { applyLastTurnResult, applyZipPathResult } from './apply.js';
import {
  downloadArtifact,
  downloadLastTurnResult,
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
  printResponseByIndex,
  printResponseList,
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
  INTERACTIVE_STATE_FILE,
  makeDefaultState,
  selectResultForApply,
  switchSessionScope,
} from './state.js';
import { INTERACTIVE_THEME_PROFILES, interactiveThemeProfile, isInteractiveThemeName } from './terlioThemes.js';

function printHelp() {
  console.log('Commands:');
  console.log('  /help                         Show this help');
  console.log('  /status                       Show bridge status');
  console.log('  /connect                      Show browser extension setup URL and token hint');
  console.log('  /tabs                         List connected ChatGPT tabs');
  console.log('  /tab [id|index|auto]          Show or select the active tab');
  console.log('  /tab drop <id|index>          Drop a stale/unused tab connection locally');
  console.log('  /stop                         Cancel the active request');
  console.log('  /reset                        Clear local interactive state');
  console.log(`  /state                        Show saved interactive state path`);
  console.log('  /events [quiet|normal|verbose] Show/set event rendering level');
  console.log('  /theme [name]                 Show or apply a Terlio theme preset');
  console.log('  /themes                       List available theme presets');
  console.log('');
  console.log('Workflows:');
  console.log('  /workflow                    Start, inspect, resume, pause, or stop workflows');
  console.log('');
  console.log('Sessions:');
  console.log('  /sessions                     List visible ChatGPT sessions');
  console.log('  /session new                  Open a new ChatGPT session');
  console.log('  /session current              Show selected session in CLI');
  console.log('  /session refresh              Refresh session list');
  console.log('  /session select <id|index>    Select session by id or list index');
  console.log('');
  console.log('Model / effort:');
  console.log('  /model                        Show current model setting');
  console.log('  /model list                   Read visible model options from ChatGPT UI');
  console.log('  /model <name|index>           Set model for next prompts');
  console.log('  /effort                       Show current effort setting');
  console.log('  /effort list                  Read visible effort options from ChatGPT UI');
  console.log('  /effort <auto|instant|low|medium|high|xhigh>');
  console.log('');
  console.log('Project mode:');
  console.log('  /project                      Show current project status');
  console.log('  /project open <path>          Open/switch project root');
  console.log('  /project scan                 Build tree/symbol context');
  console.log('  /project pack                 Create/reuse project snapshot zip');
  console.log('  /project sync                 Force-create current snapshot zip');
  console.log('  /project sessions             List local threads for this project');
  console.log('  /project session new          Create new thread for this project');
  console.log('  /project session use <id|n>   Use existing project thread');
  console.log('  /skills                       List available/enabled skills');
  console.log('  /skills enable <name...>      Enable skills for project tasks');
  console.log('  /skills disable <name...>     Disable skills');
  console.log('  /agent                        Show AGENT.md discovery status');
  console.log('  /task <prompt>                Run project task, expects ZIP result');
  console.log('  /chat <prompt>                Send a direct prompt without project ZIP context');
  console.log('  /resume                       Attach to a prompt already running in the selected ChatGPT tab');
  console.log('  /result                       Show last turn result');
  console.log('  /recover [list|n] [--apply|--force] Recover a recent ChatGPT answer into the last turn');
  console.log('  /responses [list|n]        List saved answers or show full answer text');
  console.log('  /result download [path]       Download last ZIP result');
  console.log('  /apply [zipPath] [--plan|--interactive|--force] Sync last/user ZIP into project');
  console.log('');
  console.log('Files and artifacts:');
  console.log('  /file [path...]               Upload and queue attachments for the next message');
  console.log('  /file list                    List queued attachments');
  console.log('  /file remove <index|fileId>   Remove a queued attachment');
  console.log('  /file clear-ui                Clear visible attachments in ChatGPT composer');
  console.log('  /file clear                   Clear all queued attachments');
  console.log('  /files                        List local uploaded files');
  console.log('  /files remove <fileId>        Remove a local file/artifact from the index');
  console.log('  /artifacts                    List known output artifacts');
  console.log('  /download <index|artifactId> [path] Download artifact to local path');
  console.log('  /open <index|artifactId>      Download artifact if needed and open it');
  console.log('  /debug [n]                    Show recent debug events snapshot');
  console.log('  /exit, /quit                  Stop interactive mode');
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

export async function handleCommand(message, context) {
  const { bridge, fileStore, state, projectService, turnManager, workflowManager, confirm } = context;
  const [command, ...tokens] = shellSplit(message);
  const rest = message.slice(command.length).trim();

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
  if (message === '/tabs') { printClients(bridge); return true; }
  if (message === '/state') {
    console.log(`Interactive state file: ${INTERACTIVE_STATE_FILE}`);
    console.log(`Session: ${state.sessionId || '(current tab)'}`);
    console.log(`Model: ${state.model || '(ChatGPT default)'}`);
    console.log(`Effort: ${state.effort || '(ChatGPT default)'}`);
    console.log(`Queued attachments: ${state.pendingAttachments.length}`);
    console.log(`Event level: ${state.eventLevel}`);
    console.log(`Theme: ${state.themeName}`);
    return true;
  }

  if (command === '/watch') {
    if (!workflowManager) throw new Error('Workflow manager is not available');
    if (!tokens.length) { console.log('Usage: /workflow load <configPath>'); return true; }
    const loaded = await workflowManager.load(tokens.join(' '), { start: true });
    console.log(`Loaded workflow ${loaded.id}. The observer is managed automatically.`);
    await printWorkflowStatus(workflowManager, { workflowId: loaded.id, currentSessionId: state.sessionId });
    return true;
  }

  if (command === '/watch-status') {
    console.log('`/watch-status` is a legacy alias. Use `/workflow`.');
    await printWorkflowStatus(workflowManager, { currentSessionId: state.sessionId });
    return true;
  }

  if (command === '/unwatch') {
    if (!workflowManager) throw new Error('Workflow manager is not available');
    const workflowId = resolveWorkflowId(workflowManager, tokens[0]);
    await workflowManager.stop(workflowId);
    console.log(`Automatic passive processing paused for ${workflowId}. Use /workflow debug to inspect observer state.`);
    return true;
  }

  if (command === '/workflow') {
    if (!workflowManager) throw new Error('Workflow manager is not available');
    if (!tokens.length && typeof context.openWorkflowWizard === 'function') {
      await context.openWorkflowWizard();
      return true;
    }
    const sub = String(tokens[0] || 'open').toLowerCase();
    const args = tokens.slice(1);

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
    console.log('Usage: /workflow [wizard|open|new|active|action|settings]');
    return true;
  }

  if (command === '/tab') {
    const sub = tokens[0] || 'current';
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


  if (message === '/themes') {
    console.log('Themes:');
    for (const profile of INTERACTIVE_THEME_PROFILES) {
      const active = profile.id === state.themeName ? '*' : ' ';
      console.log(` ${active} ${profile.id.padEnd(8)} ${profile.description}`);
    }
    console.log('Switch theme: /theme <name>');
    return true;
  }

  if (command === '/theme') {
    const name = String(tokens[0] || '').trim().toLowerCase();
    if (!name) {
      const profile = interactiveThemeProfile(state.themeName);
      console.log(`Theme: ${profile.id} · ${profile.description}`);
      console.log('Usage: /theme <name>. Use /themes to list presets.');
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

  if (message === '/sessions' || message === '/session refresh') {
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
    if (sub === 'sessions') {
      if (!state.projectRoot) { console.log('No project opened.'); return true; }
      state.projectThreads = await projectService.listThreadsForProject(state.projectRoot, turnManager);
      printProjectThreads(state);
      return true;
    }
    if (sub === 'session') {
      const action = tokens[1] || '';
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
      console.log('Usage: /project session new | /project session use <id|index>');
      return true;
    }
    console.log('Usage: /project | /project open <path> | /project scan | /project pack | /project sync | /project sessions | /project session new | /project session use <id|index>');
    return true;
  }

  if (command === '/skills') {
    const sub = tokens[0] || '';
    if (!sub || sub === 'list' || sub === 'reload') { await printSkills(projectService, state); return true; }
    if (sub === 'enable') {
      const names = tokens.slice(1);
      if (!names.length) { console.log('Usage: /skills enable <name...>'); return true; }
      state.enabledSkills = Array.from(new Set([...(state.enabledSkills || []), ...names])).sort();
      if (state.projectRoot) await projectService.setEnabledSkills(state.projectRoot, state.enabledSkills);
      console.log(`[skills] enabled: ${state.enabledSkills.join(', ')}`);
      return true;
    }
    if (sub === 'disable') {
      const names = new Set(tokens.slice(1));
      if (!names.size) { console.log('Usage: /skills disable <name...>'); return true; }
      state.enabledSkills = (state.enabledSkills || []).filter((name) => !names.has(name));
      if (state.projectRoot) await projectService.setEnabledSkills(state.projectRoot, state.enabledSkills);
      console.log(`[skills] enabled: ${state.enabledSkills.length ? state.enabledSkills.join(', ') : '(none)'}`);
      return true;
    }
    console.log('Usage: /skills | /skills enable <name...> | /skills disable <name...>');
    return true;
  }

  if (command === '/agent') {
    await printAgent(projectService, state);
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

  if (command === '/responses') {
    const indexToken = tokens.find((token) => /^\d+$/.test(token));
    if (indexToken) printResponseByIndex(state, Number(indexToken));
    else printResponseList(state);
    return true;
  }

  if (command === '/result') {
    const sub = tokens[0] || '';
    if (!sub) {
      if (!state.lastTurn && state.lastTurnId && turnManager) state.lastTurn = await turnManager.getTurn(state.lastTurnId);
      if (!state.lastTurn) { console.log('No last turn result.'); return true; }
      console.log(`Turn: ${state.lastTurn.id} · ${state.lastTurn.status}`);
      if (state.lastTurn.output) {
        if (state.lastTurn.output.type === 'zip' && state.lastTurn.output.fileId && !state.selectedResult) selectResultForApply(state, state.lastTurn, { source: 'result' });
        console.log(`Result: ${state.lastTurn.output.type || 'unknown'} · ${state.lastTurn.output.name || ''} · ${bytes(state.lastTurn.output.size)}`);
        if (state.lastTurn.output.fileId) console.log(`File: ${state.lastTurn.output.fileId}`);
        if (state.lastTurn.output.downloadUrl) console.log(`Download URL: ${state.lastTurn.output.downloadUrl}`);
      }
      if (state.lastTurn.error) console.log(`Error: ${state.lastTurn.error.message}`);
      return true;
    }
    if (sub === 'download') {
      if (!state.lastTurn && state.lastTurnId && turnManager) state.lastTurn = await turnManager.getTurn(state.lastTurnId);
      await downloadLastTurnResult(fileStore, state, tokens.slice(1).join(' '));
      return true;
    }
    console.log('Usage: /result | /result download [path]');
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
    console.log('Usage: /file [path...] | /file list | /file clear | /file clear-ui | /file remove <index|fileId>');
    return true;
  }

  if (command === '/files') {
    const sub = tokens[0] || 'list';
    if (sub === 'list') { await listFiles(fileStore); return true; }
    if (sub === 'remove') {
      const fileId = tokens[1];
      if (!fileId) { console.log('Usage: /files remove <fileId>'); return true; }
      const removed = await fileStore.remove(fileId);
      state.pendingAttachments = state.pendingAttachments.filter((file) => file.id !== fileId);
      console.log(removed ? `Removed: ${fileId}` : `Not found: ${fileId}`);
      console.log('If this file was already visible in the ChatGPT composer, use /file clear-ui to remove composer chips.');
      return true;
    }
    console.log('Usage: /files | /files remove <fileId>');
    return true;
  }

  if (message === '/artifacts') { await listArtifacts(bridge, fileStore, state); return true; }

  if (command === '/download') {
    await downloadArtifact(bridge, fileStore, state, tokens);
    return true;
  }

  if (command === '/open') {
    await openArtifact(bridge, fileStore, state, tokens);
    return true;
  }

  if (command === '/debug') {
    const limit = Number.parseInt(tokens[0] || '20', 10);
    printDebugEvents(bridge, Number.isFinite(limit) ? limit : 20);
    return true;
  }

  return false;
}
