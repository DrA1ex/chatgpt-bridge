import { spawn } from 'node:child_process';

function tail(text, maxChars = 120_000) {
  const value = String(text || '');
  return value.length > maxChars ? value.slice(value.length - maxChars) : value;
}

export async function runWorkflowCommand(command, { cwd, timeoutMs = 10 * 60_000, env = {}, onOutput = null } = {}) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  return await new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-lc', command], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref?.();
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
