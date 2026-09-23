(() => {
  'use strict';

  // Internal bundle identity is intentionally separate from the user-facing
  // extension version. It changes whenever a bundled extension release must be
  // distinguishable from another unpacked directory with the same semver.
  globalThis.ChatGptBridgeBuildIdentity = Object.freeze({
    bundleId: '7c3f0df5a1bc4e889531cc1d9cc6bbd2',
  });
})();
