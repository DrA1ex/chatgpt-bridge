import test from 'node:test';
import assert from 'node:assert/strict';
import { isFsyncCompatibilityError, syncDirectoryBestEffort, syncHandleBestEffort } from '../src/workflow/safeDirectorySync.js';

test('directory fsync compatibility errors are limited to Windows', () => {
  assert.equal(isFsyncCompatibilityError({ code: 'EPERM' }, 'win32'), true);
  assert.equal(isFsyncCompatibilityError({ code: 'EINVAL' }, 'win32'), true);
  assert.equal(isFsyncCompatibilityError({ code: 'ENOTSUP' }, 'win32'), true);
  assert.equal(isFsyncCompatibilityError({ code: 'EACCES' }, 'win32'), false);
  assert.equal(isFsyncCompatibilityError({ code: 'EPERM' }, 'linux'), false);
});

test('unsupported Windows file fsync does not reject snapshot completion', async () => {
  let synced = 0;
  assert.equal(await syncHandleBestEffort({
    sync: async () => { synced += 1; throw Object.assign(new Error('file sync unavailable'), { code: 'EPERM' }); },
  }, 'win32'), false);
  assert.equal(synced, 1);
});

test('unsupported Windows directory fsync does not reject snapshot completion', async () => {
  let closed = false;
  const fakeFs = {
    open: async () => ({
      sync: async () => { throw Object.assign(new Error('directory sync unavailable'), { code: 'EPERM' }); },
      close: async () => { closed = true; },
    }),
  };
  assert.equal(await syncDirectoryBestEffort(fakeFs, 'ignored', 'win32'), false);
  assert.equal(closed, true);
});

test('ordinary directory fsync errors still fail closed', async () => {
  const fakeFs = {
    open: async () => ({
      sync: async () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); },
      close: async () => {},
    }),
  };
  await assert.rejects(syncDirectoryBestEffort(fakeFs, 'ignored', 'win32'), { code: 'EACCES' });
});
