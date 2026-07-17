import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadGlobalWorkflowConfig } from '../ux/globalConfig.js';

const execFileAsync = promisify(execFile);

function now() { return Date.now(); }

export function desktopNotificationCommand(platform, { title, body }) {
  const safeTitle = String(title || 'ChatGPT Bridge').replace(/[\r\n]+/g, ' ').slice(0, 120);
  const safeBody = String(body || '').replace(/[\r\n]+/g, ' ').slice(0, 500);
  if (platform === 'darwin') {
    const escapeApple = (value) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return { command: 'osascript', args: ['-e', `display notification "${escapeApple(safeBody)}" with title "${escapeApple(safeTitle)}"`] };
  }
  if (platform === 'linux') return { command: 'notify-send', args: [safeTitle, safeBody] };
  if (platform === 'win32') {
    const escapePs = (value) => value.replace(/'/g, "''");
    const script = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
      '$template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02',
      '$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template)',
      `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${escapePs(safeTitle)}')) > $null`,
      `$xml.GetElementsByTagName('text')[1].AppendChild($xml.CreateTextNode('${escapePs(safeBody)}')) > $null`,
      "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('ChatGPT Bridge').Show($toast)",
    ].join('; ');
    return { command: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', script] };
  }
  return null;
}

export class WorkflowNotificationService {
  constructor({ dataDir = '', output = process.stderr, platform = process.platform, run = execFileAsync, clock = now } = {}) {
    this.dataDir = dataDir;
    this.output = output;
    this.platform = platform;
    this.run = run;
    this.clock = clock;
    this.notified = new Map();
    this.configPromise = null;
  }

  async config() {
    if (!this.configPromise) this.configPromise = loadGlobalWorkflowConfig({ dataDir: this.dataDir }).then((item) => item.config.defaults.notifications);
    return await this.configPromise;
  }

  invalidateConfig() {
    this.configPromise = null;
  }

  async notify({ key, title, body, force = false, config: override = null } = {}) {
    const globalConfig = await this.config();
    const config = override && typeof override === 'object'
      ? { ...globalConfig, ...override }
      : globalConfig;
    if (!config.enabled) return { notified: false, reason: 'disabled' };
    const stableKey = String(key || `${title}:${body}`);
    const previous = this.notified.get(stableKey) || 0;
    const reminder = Math.max(0, Number(config.reminderIntervalMs) || 0);
    const current = this.clock();
    if (!force && previous && (!reminder || current - previous < reminder)) {
      return { notified: false, reason: 'deduplicated', key: stableKey };
    }
    this.notified.set(stableKey, current);
    let bell = false;
    if (config.terminalBell && this.output?.isTTY) {
      this.output.write('\u0007');
      bell = true;
    }
    let desktop = false;
    let desktopError = '';
    if (config.desktop) {
      const command = desktopNotificationCommand(this.platform, { title, body });
      if (command) {
        try {
          await this.run(command.command, command.args, { windowsHide: true, timeout: 5_000 });
          desktop = true;
        } catch (error) {
          desktopError = error.message || String(error);
        }
      }
    }
    return { notified: bell || desktop, bell, desktop, desktopError, key: stableKey };
  }

  acknowledge(key) {
    if (key) this.notified.delete(String(key));
  }
}
