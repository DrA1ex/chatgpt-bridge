import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractZipFile } from '../src/zipUtils.js';
import { writeZip } from '../src/zipWriter.js';
import {
  validateServerWorkflowResultMetadata,
  validateWorkflowResultProtocol,
  ZIPFLOW_COMMIT_MESSAGE,
  ZIPFLOW_RESULT_MANIFEST,
} from '../src/workflow/result/resultProtocol.js';

function workflow(overrides = {}) {
  return {
    id: 'workflow-1',
    projectId: 'project-1',
    artifact: { maxEntries: 100, maxExtractedBytes: 1024 * 1024 },
    resultProtocol: {
      required: true,
      manifest: ZIPFLOW_RESULT_MANIFEST,
      requireCommitMessage: true,
      producer: {
        name: 'chatgpt-bridge',
        workflowId: 'workflow-1',
        requestId: 'request-1',
        projectId: 'project-1',
      },
      ...overrides,
    },
  };
}

function manifest(overrides = {}) {
  return {
    version: 1,
    status: 'changed',
    summary: 'Updated the project.',
    commitMessage: 'Manifest message',
    files: ['src/index.js'],
    producer: {
      name: 'chatgpt-bridge',
      workflowId: 'workflow-1',
      requestId: 'request-1',
      projectId: 'project-1',
    },
    ...overrides,
  };
}

test('Zipflow result metadata is protected, correlated, and uses the commit-message override', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-zipflow-result-'));
  try {
    const zipPath = path.join(root, 'result.zip');
    const stagingRoot = path.join(root, 'staging');
    await mkdir(stagingRoot);
    await writeZip(zipPath, [
      { name: ZIPFLOW_RESULT_MANIFEST, data: `${JSON.stringify(manifest())}\n` },
      { name: ZIPFLOW_COMMIT_MESSAGE, data: 'Override commit message\n' },
      { name: 'package.json', data: '{"name":"fixture"}\n' },
      { name: 'src/index.js', data: 'export const ok = true;\n' },
    ]);

    const result = await validateWorkflowResultProtocol({
      workflow: workflow(),
      zipPath,
      stagingRoot,
      outputFiles: ['package.json', 'src/index.js'],
    });
    assert.equal(result.ok, true);
    assert.equal(result.manifestPath, ZIPFLOW_RESULT_MANIFEST);
    assert.equal(result.manifest.commitMessage, 'Override commit message');
    assert.equal(result.commitMessageSource, ZIPFLOW_COMMIT_MESSAGE);

    const extracted = path.join(root, 'extracted');
    const extraction = await extractZipFile(zipPath, extracted);
    assert.deepEqual(extraction.written.map((item) => item.path), ['package.json', 'src/index.js']);
    assert.equal(await readFile(path.join(extracted, 'src/index.js'), 'utf8'), 'export const ok = true;\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Zipflow result metadata rejects producer correlation mismatches', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-zipflow-correlation-'));
  try {
    const zipPath = path.join(root, 'result.zip');
    const stagingRoot = path.join(root, 'staging');
    await mkdir(stagingRoot);
    await writeZip(zipPath, [
      {
        name: ZIPFLOW_RESULT_MANIFEST,
        data: JSON.stringify(manifest({
          producer: { ...manifest().producer, requestId: 'another-request' },
        })),
      },
      { name: 'src/index.js', data: 'export const ok = false;\n' },
    ]);
    const result = await validateWorkflowResultProtocol({
      workflow: workflow(),
      zipPath,
      stagingRoot,
      outputFiles: ['src/index.js'],
    });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((reason) => reason.includes('producer.requestId mismatch')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('server handoff validates correlated metadata without inspecting project mutations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-server-result-'));
  try {
    const zipPath = path.join(root, 'result.zip');
    await writeZip(zipPath, [
      { name: ZIPFLOW_RESULT_MANIFEST, data: JSON.stringify(manifest()) },
      { name: 'src/index.js', data: 'export const server = true;\n' },
    ]);
    const accepted = await validateServerWorkflowResultMetadata({
      zipPath,
      producer: manifest().producer,
    });
    assert.equal(accepted.ok, true);

    const rejected = await validateServerWorkflowResultMetadata({
      zipPath,
      producer: { ...manifest().producer, requestId: 'wrong-request' },
    });
    assert.equal(rejected.ok, false);
    assert.ok(rejected.reasons.some((reason) => reason.includes('producer.requestId mismatch')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('non-canonical result manifests are rejected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-noncanonical-result-'));
  try {
    const zipPath = path.join(root, 'result.zip');
    const stagingRoot = path.join(root, 'staging');
    await mkdir(stagingRoot);
    await writeFile(path.join(stagingRoot, 'package-lock.json'), '{}\n');
    await writeZip(zipPath, [
      {
        name: 'bridge-result.json',
        data: JSON.stringify({
          version: 1,
          status: 'changed',
          summary: 'Non-canonical result.',
          commitMessage: 'Non-canonical commit',
        }),
      },
      { name: 'src/index.js', data: 'export const result = true;\n' },
    ]);

    const rejected = await validateWorkflowResultProtocol({
      workflow: workflow(),
      zipPath,
      stagingRoot,
      outputFiles: ['src/index.js'],
    });
    assert.equal(rejected.ok, false);
    assert.ok(rejected.reasons.some((reason) => reason.includes(ZIPFLOW_RESULT_MANIFEST)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
