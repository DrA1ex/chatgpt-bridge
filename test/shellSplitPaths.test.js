import test from 'node:test';
import assert from 'node:assert/strict';
import { shellSplit } from '../src/interactive/format.js';

test('shellSplit preserves Windows paths and quoted spaces', () => {
  assert.deepEqual(
    shellSplit('/apply C:\\Users\\balaj\\AppData\\Local\\Temp\\result.zip --plan'),
    ['/apply', 'C:\\Users\\balaj\\AppData\\Local\\Temp\\result.zip', '--plan'],
  );
  assert.deepEqual(
    shellSplit('/apply "C:\\Users\\balaj\\Project Files\\result.zip" --plan'),
    ['/apply', 'C:\\Users\\balaj\\Project Files\\result.zip', '--plan'],
  );
});

test('shellSplit preserves Unix paths and escaped or quoted spaces', () => {
  assert.deepEqual(
    shellSplit('/file add /opt/bridge/result.zip /tmp/plain.txt'),
    ['/file', 'add', '/opt/bridge/result.zip', '/tmp/plain.txt'],
  );
  assert.deepEqual(
    shellSplit('/apply /tmp/project\\ with\\ spaces/result.zip --plan'),
    ['/apply', '/tmp/project with spaces/result.zip', '--plan'],
  );
  assert.deepEqual(
    shellSplit('/apply "/tmp/project with spaces/result.zip" --plan'),
    ['/apply', '/tmp/project with spaces/result.zip', '--plan'],
  );
});
