import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizedArtifactText, verifyArtifactContent } from '../scripts/e2e/artifact-content.js';

test('E2E artifact content accepts semantically correct JSON without a trailing newline', () => {
  const result = verifyArtifactContent(Buffer.from('{"marker":"VALUE"}'), { kind: 'json', value: { marker: 'VALUE' } });
  assert.equal(result.ok, true);
});

test('E2E artifact content normalizes line endings and optional final newline', () => {
  const result = verifyArtifactContent(Buffer.from('key,value\r\nmarker,VALUE\r\n'), { kind: 'csv', value: 'key,value\nmarker,VALUE' });
  assert.equal(result.ok, true);
});

test('E2E artifact content reports an actionable mismatch', () => {
  const result = verifyArtifactContent(Buffer.from('wrong\n'), { kind: 'text', value: 'expected' });
  assert.equal(result.ok, false);
  assert.match(result.message, /Expected "expected", got "wrong"/);
});


test('artifact text normalization ignores optional terminal newlines for workflow assertions', () => {
  assert.equal(normalizedArtifactText('export const value = "OK";\n'), 'export const value = "OK";');
  assert.equal(normalizedArtifactText('export const value = "OK";'), 'export const value = "OK";');
});
