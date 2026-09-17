# Zipflow dependency acquisition

Bridge 6.4.0 pins Zipflow to a public, immutable GitHub codeload archive:

    https://codeload.github.com/balajibj/zipflow/tar.gz/59a5906e5ae3151d274c8f208f1869e978725eb8

The pinned source is the merged owner fork commit 59a5906e5ae3151d274c8f208f1869e978725eb8.
It contains the reviewed Windows package-install verifier repair for Zipflow 1.9.0.
The package lock records the resolved archive and its SHA-512 integrity:

    sha512-75SuDXpMl4j3drelqs90E/UQew2PnOE69wtr8/J9T5IuxsGnAzb4gZDiiiB6RL1FDizVGr0juoYlEYxFWHG5FQ==

This source path is deliberate: the upstream repository did not accept the
reviewed source push, and publication to the npm registry is a separate owner
release action. The lockfile therefore remains reproducible without depending
on an unpublished registry version or an SSH Git transport.

For a clean consumer verification, run:

    npm ci --ignore-scripts --no-audit --no-fund
    node scripts/check-package.js

The package checker fails closed if package.json or the package-lock.json
Zipflow entry drifts from the reviewed source, version, or integrity.
It also rejects private registry URLs and package contents that cross the
existing release boundary. No npm publication is implied by this integration.
