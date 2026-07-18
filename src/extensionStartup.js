import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

export const DEFAULT_EXTENSION_DIRECTORY = fileURLToPath(new URL('../tools/chrome-bridge-extension', import.meta.url));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function normalizeExtensionReloadPolicy(value = 'ask') {
  const normalized = String(value || 'ask').trim().toLowerCase();
  if (['always', 'yes', 'true', '1', 'reload'].includes(normalized)) return 'always';
  if (['never', 'no', 'false', '0', 'skip'].includes(normalized)) return 'never';
  return 'ask';
}

export async function readBundledExtensionInfo(extensionDir = DEFAULT_EXTENSION_DIRECTORY) {
  const resolvedDir = path.resolve(extensionDir);
  const manifestPath = path.join(resolvedDir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const version = String(manifest?.version || '').trim();
  if (!version) throw new Error(`Extension manifest has no version: ${manifestPath}`);
  const contentPath = path.join(resolvedDir, 'content.js');
  const contentSource = await fs.readFile(contentPath, 'utf8').catch(() => '');
  const contentVersion = String(contentSource.match(/\bCONTENT_SCRIPT_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1] || '').trim();
  return {
    extensionDir: resolvedDir,
    manifestPath,
    contentPath,
    version,
    contentVersion,
    name: String(manifest.name || 'ChatGPT Browser Bridge'),
  };
}

export function extensionClientMatchesBundle(client = {}, info = {}) {
  const extensionMatches = String(client.extensionVersion || '') === String(info.version || '');
  if (!extensionMatches) return false;
  if (!info.contentVersion) return true;
  return String(client.clientVersion || '') === String(info.contentVersion);
}

export async function confirmYesNo(question, {
  input = process.stdin,
  output = process.stdout,
  defaultValue = true,
} = {}) {
  if (!input?.isTTY || !output?.isTTY) return null;
  const rl = readline.createInterface({ input, output });
  try {
    const suffix = defaultValue ? ' [Y/n] ' : ' [y/N] ';
    const answer = String(await rl.question(`${question}${suffix}`)).trim().toLowerCase();
    if (!answer) return defaultValue;
    return ['y', 'yes', 'д', 'да'].includes(answer);
  } finally {
    rl.close();
  }
}

export function selectReloadableExtensionClient(health = {}, preferredClientId = '') {
  const clients = Array.isArray(health.clients) ? health.clients : [];
  const activeId = String(health.selectedClientId || health.activeClient?.id || '');
  // A connected extension may be version-incompatible precisely because it needs
  // to reload the unpacked files from disk. Startup reload is the one control
  // operation that is allowed for such a client.
  const usable = clients.filter((client) => client?.ready);
  const preferredId = String(preferredClientId || '');
  return usable.find((client) => client.id === preferredId)
    || usable.find((client) => client.id === activeId)
    || usable.find((client) => client.selected)
    || usable[0]
    || null;
}

export async function waitForReloadableExtension(getHealth, {
  timeoutMs = 15_000,
  intervalMs = 250,
  preferredClientId = '',
} = {}) {
  const startedAt = Date.now();
  let lastHealth = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastHealth = await getHealth();
    const client = selectReloadableExtensionClient(lastHealth, preferredClientId);
    if (client) return { client, health: lastHealth, waitedMs: Date.now() - startedAt };
    await sleep(intervalMs);
  }
  return { client: null, health: lastHealth, waitedMs: Date.now() - startedAt };
}

export async function maybeReloadExtensionAtStartup({
  policy = 'ask',
  mode = 'startup',
  extensionDir = DEFAULT_EXTENSION_DIRECTORY,
  getHealth,
  reload,
  confirm = confirmYesNo,
  input = process.stdin,
  output = process.stdout,
  waitTimeoutMs = 15_000,
  reloadTimeoutMs = 30_000,
  reloadTabs = true,
  preferredClientId = '',
  log = () => {},
} = {}) {
  if (typeof getHealth !== 'function') throw new TypeError('getHealth is required');
  if (typeof reload !== 'function') throw new TypeError('reload is required');
  const normalizedPolicy = normalizeExtensionReloadPolicy(policy);
  const info = await readBundledExtensionInfo(extensionDir);
  if (normalizedPolicy === 'never') return { status: 'skipped', reason: 'disabled', policy: normalizedPolicy, ...info };

  const connected = await waitForReloadableExtension(getHealth, { timeoutMs: waitTimeoutMs, preferredClientId });
  if (!connected.client) {
    log('warn', `No connected extension was available for ${mode} startup reload.`);
    return { status: 'skipped', reason: 'not-connected', policy: normalizedPolicy, waitedMs: connected.waitedMs, ...info };
  }

  if (Number(connected.client.extensionProtocolVersion) !== 4) {
    log('warn', 'The connected extension does not use protocol 4 and cannot receive a reload command. Update the unpacked extension manually or run the installer.');
    return {
      status: 'blocked',
      reason: 'protocol-incompatible',
      policy: normalizedPolicy,
      clientId: connected.client.id,
      compatibility: connected.client.compatibility || null,
      waitedMs: connected.waitedMs,
      ...info,
    };
  }

  if (normalizedPolicy === 'ask' && extensionClientMatchesBundle(connected.client, info)) {
    log('info', `Connected extension is already current (extension v${info.version}${info.contentVersion ? `, content v${info.contentVersion}` : ''}); startup reload is not required.`);
    return {
      status: 'skipped',
      reason: 'already-current',
      policy: normalizedPolicy,
      clientId: connected.client.id,
      connectedVersion: String(connected.client.extensionVersion || ''),
      connectedContentVersion: String(connected.client.clientVersion || ''),
      waitedMs: connected.waitedMs,
      ...info,
    };
  }

  let approved = normalizedPolicy === 'always';
  if (normalizedPolicy === 'ask') {
    const currentVersion = String(connected.client.extensionVersion || 'unknown');
    const currentContentVersion = String(connected.client.clientVersion || 'unknown');
    log('action', `Extension update confirmation required for ${mode}. Local: v${info.version}${info.contentVersion ? ` / content ${info.contentVersion}` : ''}; connected: v${currentVersion} / content ${currentContentVersion}.`);
    const answer = await confirm(
      `Reload the connected unpacked extension now? Local project bundle: ${info.extensionDir} (v${info.version}${info.contentVersion ? `, content v${info.contentVersion}` : ''}); connected version: ${currentVersion}, content v${currentContentVersion}.`,
      { input, output, defaultValue: true },
    );
    if (answer === null) {
      log('info', `Skipping ${mode} extension reload because no interactive terminal is available. Use --reload-extension to force it.`);
      return { status: 'skipped', reason: 'non-interactive', policy: normalizedPolicy, clientId: connected.client.id, ...info };
    }
    approved = answer;
  }
  if (!approved) return { status: 'skipped', reason: 'declined', policy: normalizedPolicy, clientId: connected.client.id, ...info };

  log('action', `Reloading unpacked extension from ${info.extensionDir}...`);
  const result = await reload({
    sourceClientId: connected.client.id,
    expectedVersion: info.version,
    reloadTabs,
    timeoutMs: reloadTimeoutMs,
  });
  const reconnectedVersion = String(result?.reconnected?.extensionVersion || result?.extensionVersion || '');
  const reconnectedContentVersion = String(result?.reconnected?.clientVersion || result?.clientVersion || '');
  if (reconnectedVersion && reconnectedVersion !== info.version) {
    throw new Error(`Extension reconnected as ${reconnectedVersion}, expected ${info.version} from ${info.extensionDir}`);
  }
  if (info.contentVersion && reconnectedContentVersion && reconnectedContentVersion !== info.contentVersion) {
    throw new Error(`Extension content runtime reconnected as ${reconnectedContentVersion}, expected ${info.contentVersion} from ${info.extensionDir}`);
  }
  if (result?.recovery?.used) {
    log('warn', `The original owned tab did not reconnect after extension reload; opened a replacement tab and closed the stale owned tab safely (${result.recovery.reason}).`);
  }
  log('ok', `Extension reloaded and reconnected as v${reconnectedVersion || info.version}.`);
  return {
    status: 'reloaded',
    policy: normalizedPolicy,
    clientId: connected.client.id,
    waitedMs: connected.waitedMs,
    reconnectedVersion: reconnectedVersion || info.version,
    reconnectedContentVersion: reconnectedContentVersion || info.contentVersion,
    result,
    ...info,
  };
}
