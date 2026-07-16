import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { exampleWorkflowConfig } from '../workflow/config.js';
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
  recoverLatestResponse,
  resolveClientSelector,
  resolveFromList,
  resolveModelToken,
  resolveWorkflowId,
  runDirectPrompt,
  runProjectTask,
  runResume,
} from './controller.js';
import { bytes, shellSplit } from './format.js';
import {
  EFFORTS,
  EVENT_LEVELS,
  INTERACTIVE_STATE_FILE,
  makeDefaultState,
  selectResultForApply,
  switchSessionScope,
} from './state.js';

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
  console.log('');
  console.log('Passive artifact workflows:');
  console.log('  /workflow init [path] [--force] Create an example workflow JSON');
  console.log('  /workflow load <path>         Load and start a workflow');
  console.log('  /workflow list               Show loaded workflows and approvals');
  console.log('  /workflow start|stop <id>    Start or stop watching');
  console.log('  /workflow run <id> [--verbose] [--reset-thread] [--max-cycles n] Start automation');
  console.log('  /workflow run-stop <id>      Stop the active automation loop');
  console.log('  /workflow unload <id>        Remove a workflow from the daemon');
  console.log('  /workflow approvals          List pending artifact approvals');
  console.log('  /workflow approve <id>       Apply an approved artifact');
  console.log('  /workflow reject <id> [why]  Reject a pending artifact');
  console.log('  /workflow events <id> [n]    Show recent workflow events');
  console.log('  /workflow verify <id> <artifactId|fileId> Verify an artifact without applying it');
  console.log('  /workflow extension <id>     Deploy/reload the unpacked extension');
  console.log('  /watch <configPath>          Shortcut for /workflow load');
  console.log('  /watch-status                Shortcut for /workflow list');
  console.log('  /unwatch [id]                Stop a loaded workflow');
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
    return true;
  }

  if (command === '/watch') {
    if (!workflowManager) throw new Error('Workflow manager is not available');
    if (!tokens.length) { console.log('Usage: /watch <configPath>'); return true; }
    const loaded = await workflowManager.load(tokens.join(' '), { start: true });
    console.log(`[workflow] watching ${loaded.id} · ${loaded.projectRoot} · mode=${loaded.mode}`);
    return true;
  }

  if (command === '/watch-status') {
    await printWorkflowStatus(workflowManager);
    return true;
  }

  if (command === '/unwatch') {
    if (!workflowManager) throw new Error('Workflow manager is not available');
    const workflowId = resolveWorkflowId(workflowManager, tokens[0]);
    const stopped = await workflowManager.stop(workflowId);
    console.log(`[workflow] stopped ${stopped.id}`);
    return true;
  }

  if (command === '/workflow') {
    if (!workflowManager) throw new Error('Workflow manager is not available');
    const sub = String(tokens[0] || 'list').toLowerCase();
    if (sub === 'list' || sub === 'status') {
      await printWorkflowStatus(workflowManager);
      return true;
    }
    if (sub === 'init') {
      const force = tokens.includes('--force');
      const explicit = tokens.slice(1).find((token) => token !== '--force') || '';
      const target = path.resolve(explicit || path.join(state.projectRoot || process.cwd(), 'bridge.workflow.json'));
      const existing = await fs.stat(target).catch(() => null);
      if (existing && !force) throw new Error(`Workflow config already exists: ${target}. Use --force to overwrite it.`);
      const configValue = exampleWorkflowConfig();
      configValue.id = `${path.basename(path.dirname(target)) || 'project'}-workflow`;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, `${JSON.stringify(configValue, null, 2)}
`, 'utf8');
      console.log(`[workflow] created ${target}`);
      return true;
    }
    if (sub === 'load') {
      const configPath = tokens.slice(1).join(' ').trim();
      if (!configPath) { console.log('Usage: /workflow load <configPath>'); return true; }
      const loaded = await workflowManager.load(configPath, { start: true });
      console.log(`[workflow] loaded ${loaded.id} · ${loaded.status} · mode=${loaded.mode}`);
      return true;
    }
    if (sub === 'start' || sub === 'stop' || sub === 'unload' || sub === 'extension') {
      const workflowId = resolveWorkflowId(workflowManager, tokens[1]);
      if (sub === 'start') console.log(`[workflow] started ${(await workflowManager.start(workflowId)).id}`);
      else if (sub === 'stop') console.log(`[workflow] stopped ${(await workflowManager.stop(workflowId)).id}`);
      else if (sub === 'unload') console.log((await workflowManager.unload(workflowId)) ? `[workflow] unloaded ${workflowId}` : `[workflow] not found ${workflowId}`);
      else console.log(JSON.stringify(await workflowManager.deployExtension(workflowId), null, 2));
      return true;
    }
    if (sub === 'run') {
      const workflowId = resolveWorkflowId(workflowManager, tokens[1]);
      const maxCyclesIndex = tokens.indexOf('--max-cycles');
      const maxCycles = maxCyclesIndex >= 0 ? Number(tokens[maxCyclesIndex + 1]) || undefined : undefined;
      const automation = await workflowManager.runAutomation(workflowId, {
        verbose: tokens.includes('--verbose'),
        resetThread: tokens.includes('--reset-thread'),
        maxCycles,
        trigger: 'interactive',
      });
      console.log(`[workflow] automation started ${automation.id} · cycle=${automation.cycle}/${automation.maxCycles}`);
      return true;
    }
    if (sub === 'run-stop') {
      const workflowId = resolveWorkflowId(workflowManager, tokens[1]);
      const automation = await workflowManager.stopAutomation(workflowId, tokens.slice(2).join(' ') || 'stopped from interactive UI');
      console.log(`[workflow] automation ${automation.status} ${automation.id || ''}`.trim());
      return true;
    }
    if (sub === 'verify') {
      const workflowId = resolveWorkflowId(workflowManager, tokens[1]);
      const artifactOrFileId = tokens[2];
      if (!artifactOrFileId) { console.log('Usage: /workflow verify <workflowId> <artifactId|fileId>'); return true; }
      let verification;
      try {
        verification = await workflowManager.verifyArtifact(workflowId, { artifactId: artifactOrFileId });
      } catch (artifactError) {
        verification = await workflowManager.verifyArtifact(workflowId, { fileId: artifactOrFileId }).catch(() => { throw artifactError; });
      }
      console.log(JSON.stringify({ ok: verification.ok, reasons: verification.reasons, zip: verification.zip, overlapScore: verification.overlapScore, commands: verification.commands }, null, 2));
      return true;
    }
    if (sub === 'approvals') {
      const approvals = await workflowManager.approvals();
      if (!approvals.length) console.log('No pending workflow approvals.');
      else for (const approval of approvals) console.log(`${approval.id} · workflow=${approval.workflowId} · pipeline=${approval.pipelineId}`);
      return true;
    }
    if (sub === 'approve') {
      const approvalId = tokens[1];
      if (!approvalId) { console.log('Usage: /workflow approve <approvalId>'); return true; }
      console.log(JSON.stringify(await workflowManager.approve(approvalId), null, 2));
      return true;
    }
    if (sub === 'reject') {
      const approvalId = tokens[1];
      if (!approvalId) { console.log('Usage: /workflow reject <approvalId> [reason]'); return true; }
      console.log(JSON.stringify(await workflowManager.reject(approvalId, tokens.slice(2).join(' ') || 'rejected by user'), null, 2));
      return true;
    }
    if (sub === 'events') {
      const workflowId = resolveWorkflowId(workflowManager, tokens[1]);
      const limit = Math.max(1, Number.parseInt(tokens[2] || '50', 10) || 50);
      for (const event of await workflowManager.events(workflowId, limit)) console.log(`${event.time} ${event.type} ${JSON.stringify(event.data || {})}`);
      return true;
    }
    console.log('Usage: /workflow [list|init|load|start|stop|run|run-stop|unload|verify|approvals|approve|reject|events|extension]');
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
    console.log(`New session: ${session?.title || session?.id || '(unknown)'}`);
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
      if (result.current?.label && !state.model) state.model = result.current.label;
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
    else { state.effort = effort === 'auto' ? '' : effort; console.log(`Effort set: ${state.effort || 'auto'}`); }
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
