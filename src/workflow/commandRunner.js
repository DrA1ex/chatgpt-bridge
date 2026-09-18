import { spawn } from 'node:child_process';

function tail(text, maxChars = 120_000) {
  const value = String(text || '');
  return value.length > maxChars ? value.slice(value.length - maxChars) : value;
}

function shellInvocation(command) {
  if (process.platform === 'win32') {
    return {
      // Let Node perform the cmd.exe quoting for the complete command string.
      // Passing a command as the fourth argv item to cmd.exe breaks quoted
      // executable paths on Windows (for example, paths under Program Files).
      file: String(command || ''),
      args: [],
      options: { shell: true, windowsHide: true, detached: false },
    };
  }
  return {
    file: '/bin/sh',
    args: ['-lc', String(command || '')],
    options: { detached: true },
  };
}

function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', () => { try { child.kill(); } catch {} });
    killer.once('close', () => { try { if (!child.killed) child.kill(); } catch {} });
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
}

export async function runWorkflowCommand(command, { cwd, timeoutMs = 10 * 60_000, env = {}, onOutput = null } = {}) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  return await new Promise((resolve) => {
    const invocation = shellInvocation(command);
    const child = spawn(invocation.file, invocation.args, {
      cwd,
      env: { ...process.env, ...env },
      ...invocation.options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      setTimeout(() => {
        try { if (!child.killed) child.kill('SIGKILL'); } catch {}
      }, 2_000).unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { const text = chunk.toString(); stdout = tail(stdout + text); onOutput?.('stdout', text); });
    child.stderr.on('data', (chunk) => { const text = chunk.toString(); stderr = tail(stderr + text); onOutput?.('stderr', text); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ command, cwd, ok: false, code: null, signal: '', timedOut, stdout, stderr, error: error.message, startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - started });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ command, cwd, ok: code === 0 && !timedOut, code, signal: signal || '', timedOut, stdout, stderr, error: '', startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - started });
    });
  });
}

export async function runWorkflowCommands(commands, options = {}) {
  const results = [];
  for (const command of commands || []) {
    const result = await runWorkflowCommand(command, options);
    results.push(result);
    if (!result.ok) break;
  }
  return { ok: results.every((item) => item.ok), results };
}
