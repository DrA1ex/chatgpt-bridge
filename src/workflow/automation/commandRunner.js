import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { finished } from 'node:stream/promises';

function nowIso() {
  return new Date().toISOString();
}

function safeName(index, step = {}) {
  const slug = String(step.id || step.name || step.command || 'step')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'step';
  return `${String(index + 1).padStart(2, '0')}-${slug}`;
}

function signalChild(child, signal) {
  if (!child || child.exitCode != null || child.signalCode) return;
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to signaling only the shell process.
    }
  }
  try { child.kill(signal); } catch { /* The process may already be gone. */ }
}

async function finishStreams(streams) {
  for (const stream of streams) stream.end();
  await Promise.allSettled(streams.map((stream) => finished(stream)));
}

async function runStep(step, options = {}) {
  const name = safeName(options.index, step);
  const stdoutPath = path.join(options.outputDir, `${name}.stdout.log`);
  const stderrPath = path.join(options.outputDir, `${name}.stderr.log`);
  const combinedPath = path.join(options.outputDir, `${name}.combined.log`);
  const stdout = createWriteStream(stdoutPath, { flags: 'w' });
  const stderr = createWriteStream(stderrPath, { flags: 'w' });
  const combined = createWriteStream(combinedPath, { flags: 'w' });
  const streams = [stdout, stderr, combined];
  const startedAt = nowIso();
  const started = Date.now();
  await options.publish?.('workflow.automation.step.started', {
    automationId: options.automationId,
    cycle: options.cycle,
    stepId: step.id,
    name: step.name,
    command: step.command,
    cwd: step.cwd,
    index: options.index,
  });

  return await new Promise((resolve) => {
    const child = spawn(step.command, {
      cwd: step.cwd || options.cwd,
      env: { ...options.env, ...step.env },
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timedOut = false;
    let aborted = false;
    let spawnError = null;
    let killTimer = null;
    const append = (streamName, chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (streamName === 'stdout') stdout.write(buffer);
      else stderr.write(buffer);
      combined.write(Buffer.from(`[${streamName}] `));
      combined.write(buffer);
      if (options.verbose) {
        const target = streamName === 'stdout' ? process.stdout : process.stderr;
        target.write(buffer);
      }
    };
    const terminate = () => {
      signalChild(child, 'SIGTERM');
      killTimer = setTimeout(() => signalChild(child, 'SIGKILL'), 5_000);
      killTimer.unref?.();
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    child.once('error', (error) => { spawnError = error; });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const timeoutMs = Math.max(1_000, Number(step.timeoutMs) || options.timeoutMs || 60_000);
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timer.unref?.();
    child.once('close', async (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      await finishStreams(streams);
      const result = {
        index: options.index,
        id: step.id,
        name: step.name,
        command: step.command,
        cwd: step.cwd || options.cwd,
        ok: !spawnError && !timedOut && !aborted && code === 0,
        code: Number.isInteger(code) ? code : null,
        signal: signal || '',
        timedOut,
        aborted,
        error: spawnError?.message || '',
        startedAt,
        finishedAt: nowIso(),
        durationMs: Date.now() - started,
        stdoutPath,
        stderrPath,
        combinedPath,
      };
      await options.publish?.('workflow.automation.step.completed', {
        automationId: options.automationId,
        cycle: options.cycle,
        stepId: step.id,
        name: step.name,
        command: step.command,
        index: options.index,
        ok: result.ok,
        code: result.code,
        signal: result.signal,
        timedOut: result.timedOut,
        aborted: result.aborted,
        durationMs: result.durationMs,
      });
      resolve(result);
    });
  });
}

export async function runAutomationSteps(steps, options = {}) {
  const values = Array.isArray(steps) ? steps.filter((step) => step?.command) : [];
  if (!values.length) throw new Error('automation.steps must contain at least one command');
  const outputDir = path.join(options.reportDir, 'steps');
  await fs.mkdir(outputDir, { recursive: true });
  const results = [];
  for (let index = 0; index < values.length; index += 1) {
    if (options.signal?.aborted) break;
    const step = values[index];
    const result = await runStep(step, { ...options, outputDir, index });
    results.push(result);
    if (result.aborted || (!result.ok && !step.continueOnFailure)) break;
  }
  await fs.writeFile(path.join(options.reportDir, 'steps.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  return {
    ok: results.length === values.length && results.every((result) => result.ok),
    aborted: Boolean(options.signal?.aborted || results.some((result) => result.aborted)),
    results,
    failed: results.filter((result) => !result.ok),
  };
}
