import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';

const NOFOLLOW = fsConstants.O_NOFOLLOW || 0;

export function runtimeSecurityError(code, message, details = {}, cause = null) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code,
    details,
  });
}

export function createZipflowRuntimeSecurity({
  platform = process.platform,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
} = {}) {
  if (platform === 'win32') return createWindowsZipflowRuntimeSecurity();
  return createPosixZipflowRuntimeSecurity({ uid });
}

export function createPosixZipflowRuntimeSecurity({ uid } = {}) {
  if (!Number.isInteger(uid) || uid < 0) {
    throw runtimeSecurityError(
      'ZIPFLOW_RUNTIME_INVALID',
      'Workflow runtime validation requires the current numeric user ID.',
    );
  }
  return Object.freeze({
    kind: 'posix',
    uid,
    assertPrivateDirectory: (target, mode = 0o700) => assertPrivateNode(target, {
      uid,
      mode,
      kind: 'directory',
    }),
    assertPrivateSocket: (target, mode = 0o600, { optional = false } = {}) => assertPrivateNode(target, {
      uid,
      mode,
      kind: 'socket',
      optional,
    }),
    assertPrivateFile: (target, mode = 0o600, { optional = false } = {}) => assertPrivateNode(target, {
      uid,
      mode,
      kind: 'file',
      optional,
    }),
    readPrivateFile: (target, mode = 0o600) => readPrivateFile(target, { uid, mode }),
    inspectRuntime: (paths) => inspectPosixRuntime(paths, { uid }),
  });
}

export function createWindowsZipflowRuntimeSecurity() {
  const unavailable = () => {
    throw runtimeSecurityError(
      'ZIPFLOW_WINDOWS_SECURITY_UNAVAILABLE',
      'Workflow named-pipe discovery requires a Windows owner, DACL, and reparse-point security adapter.',
    );
  };
  return Object.freeze({
    kind: 'windows-placeholder',
    assertPrivateDirectory: unavailable,
    assertPrivateSocket: unavailable,
    assertPrivateFile: unavailable,
    readPrivateFile: unavailable,
    inspectRuntime: unavailable,
  });
}

async function readPrivateFile(target, { uid, mode }) {
  const listed = await assertPrivateNode(target, { uid, mode, kind: 'file' });
  const handle = await fs.open(target, fsConstants.O_RDONLY | NOFOLLOW).catch((error) => {
    if (error?.code === 'ELOOP') {
      throw runtimeSecurityError(
        'ZIPFLOW_RUNTIME_INVALID',
        `Workflow runtime file is a symbolic link: ${target}`,
      );
    }
    throw error;
  });
  try {
    const opened = await handle.stat();
    assertPrivateStat(opened, target, { uid, mode, kind: 'file' });
    if (!sameNode(listed, opened)) {
      throw runtimeSecurityError(
        'ZIPFLOW_RUNTIME_INVALID',
        `Workflow runtime file changed while opening: ${target}`,
      );
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function inspectPosixRuntime(paths, { uid }) {
  const root = await assertPrivateNode(paths.runtimeRoot, {
    uid,
    mode: 0o700,
    kind: 'directory',
    optional: true,
  });
  if (!root) return { state: 'absent', present: [] };
  const present = [];
  for (const target of [paths.discoveryPath, paths.tokenPath, paths.lockPath]) {
    const details = await assertPrivateNode(target, {
      uid,
      mode: 0o600,
      kind: 'file',
      optional: true,
    });
    if (details) present.push(target);
  }
  return {
    state: present.length === 0 ? 'absent' : present.length === 3 ? 'complete' : 'partial',
    present,
  };
}

async function assertPrivateNode(target, {
  uid,
  mode,
  kind,
  optional = false,
}) {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    throw error;
  }
  assertPrivateStat(stat, target, { uid, mode, kind });
  return stat;
}

function assertPrivateStat(stat, target, { uid, mode, kind }) {
  if (stat.isSymbolicLink() || !matchesKind(stat, kind)) {
    throw runtimeSecurityError(
      'ZIPFLOW_RUNTIME_INVALID',
      `Workflow runtime path has an unsafe type: ${target}`,
    );
  }
  if (stat.uid !== uid || (stat.mode & 0o777) !== mode) {
    throw runtimeSecurityError(
      'ZIPFLOW_RUNTIME_INVALID',
      `Workflow runtime path ownership or permissions are unsafe: ${target}`,
    );
  }
}

function matchesKind(stat, kind) {
  if (kind === 'directory') return stat.isDirectory();
  if (kind === 'file') return stat.isFile();
  if (kind === 'socket') return stat.isSocket();
  return false;
}

function sameNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
