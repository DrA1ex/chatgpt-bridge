import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageInfo = require('../package.json');

export const BRIDGE_VERSION = String(packageInfo.version || '0.0.0');

export const EXTENSION_COMPATIBILITY = Object.freeze({
  protocolVersion: 4,
  minProtocolVersion: 4,
  maxProtocolVersion: 4,
  minExtensionVersion: '2.2.5',
  recommendedExtensionVersion: '2.2.5',
  minContentVersion: '4.2.5',
});

export function parseVersion(value = '') {
  const match = String(value || '').trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1] || 0), Number(match[2] || 0), Number(match[3] || 0)];
}

export function compareVersions(left = '', right = '') {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return 1;
    if (a[index] < b[index]) return -1;
  }
  return 0;
}

function result(status, message, details = {}) {
  return {
    compatible: status === 'compatible',
    status,
    message,
    bridgeVersion: BRIDGE_VERSION,
    ...EXTENSION_COMPATIBILITY,
    ...details,
  };
}

export function evaluateExtensionCompatibility(client = {}) {
  const runtime = String(client.runtime || client.transport || '').toLowerCase();
  if (runtime && runtime !== 'extension') {
    return result('compatible', 'Non-extension compatibility is not enforced by the extension version gate.', {
      enforcement: 'not_applicable',
    });
  }

  const protocolVersion = Number(client.extensionProtocolVersion ?? client.protocolVersion ?? 0) || 0;
  const extensionVersion = String(client.extensionVersion || '').trim();
  const contentVersion = String(client.clientVersion || client.contentVersion || '').trim();

  if (!protocolVersion) {
    return result(
      'extension_metadata_invalid',
      'The extension did not report protocol 4. Update the unpacked extension before connecting.',
      { protocolVersion, extensionVersion, contentVersion, enforcement: 'blocked' },
    );
  }

  if (protocolVersion > EXTENSION_COMPATIBILITY.maxProtocolVersion) {
    return result(
      'bridge_outdated',
      `The browser extension protocol is newer than this bridge supports. Update ChatGPT Browser Bridge ${BRIDGE_VERSION}.`,
      { protocolVersion, extensionVersion, contentVersion, enforcement: 'blocked' },
    );
  }

  if (protocolVersion && protocolVersion < EXTENSION_COMPATIBILITY.minProtocolVersion) {
    return result(
      'extension_outdated',
      `The browser extension protocol is too old. Reload extension ${EXTENSION_COMPATIBILITY.recommendedExtensionVersion} or newer.`,
      { protocolVersion, extensionVersion, contentVersion, enforcement: 'blocked' },
    );
  }

  if (extensionVersion) {
    const comparison = compareVersions(extensionVersion, EXTENSION_COMPATIBILITY.minExtensionVersion);
    if (comparison == null) {
      return result('extension_metadata_invalid', `The extension reported an invalid version: ${extensionVersion}. Reload the packaged extension.`, {
        protocolVersion,
        extensionVersion,
        contentVersion,
        enforcement: 'blocked',
      });
    }
    if (comparison < 0) {
      return result(
        'extension_outdated',
        `Extension ${extensionVersion} is outdated. Reload extension ${EXTENSION_COMPATIBILITY.recommendedExtensionVersion} or newer from this bridge package.`,
        { protocolVersion, extensionVersion, contentVersion, enforcement: 'blocked' },
      );
    }
  } else {
    return result(
      'extension_metadata_invalid',
      `The extension did not report its package version. Reload extension ${EXTENSION_COMPATIBILITY.recommendedExtensionVersion} from this bridge package.`,
      { protocolVersion, extensionVersion, contentVersion, enforcement: 'blocked' },
    );
  }

  const contentComparison = compareVersions(contentVersion, EXTENSION_COMPATIBILITY.minContentVersion);
  if (contentComparison == null || contentComparison < 0) {
    return result(
      'extension_outdated',
      `Content runtime ${contentVersion || 'unknown'} is outdated. Reload extension ${EXTENSION_COMPATIBILITY.recommendedExtensionVersion} or newer.`,
      { protocolVersion, extensionVersion, contentVersion, enforcement: 'blocked' },
    );
  }

  return result('compatible', `Extension ${extensionVersion || contentVersion} is compatible with bridge ${BRIDGE_VERSION}.`, {
    protocolVersion: protocolVersion || EXTENSION_COMPATIBILITY.protocolVersion,
    extensionVersion,
    contentVersion,
    enforcement: 'allowed',
  });
}

export function compatibilityStatusMessage(compatibility = {}) {
  if (compatibility.compatible) {
    return {
      type: 'extension.compatibility',
      compatible: true,
      status: 'compatible',
      detail: compatibility.message || 'Extension is compatible.',
      compatibility,
    };
  }
  const bridgeOutdated = compatibility.status === 'bridge_outdated';
  return {
    type: 'extension.status',
    compatible: false,
    status: bridgeOutdated ? 'bridge update required' : 'extension update required',
    detail: compatibility.message || 'Browser extension compatibility check failed.',
    compatibility,
  };
}
