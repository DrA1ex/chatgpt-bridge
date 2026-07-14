import { spawn } from 'node:child_process';
import { safeChatGptUrl } from '../browserLaunch.js';

export function openExternalBrowserUrl(value) {
  const url = safeChatGptUrl(value);
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['explorer.exe', [url]]
      : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Failed to open the system browser with ${command}: ${err.message || String(err)}`));
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve({ command, url });
    });
  });
}
