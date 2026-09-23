import { spawn } from 'node:child_process';

// A shell may exit before its descendants close their inherited output pipes.
// Keep signaling the process group even when the group leader has exited.
export function signalProcessTree(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true,
    });
    killer.once('error', () => { try { child.kill(signal); } catch {} });
    return;
  }
  try { process.kill(-child.pid, signal); } catch {
    if (child.exitCode == null && !child.signalCode) {
      try { child.kill(signal); } catch {}
    }
  }
}
