(() => {
  'use strict';

  // Internal bundle identity is intentionally separate from the user-facing
  // extension version. It changes whenever a bundled extension release must be
  // distinguishable from another unpacked directory with the same semver.
  globalThis.ChatGptBridgeBuildIdentity = Object.freeze({
    bundleId: '5d17e8b63a044ad8a09728cdf3e15547',
  });
})();
