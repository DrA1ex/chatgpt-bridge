import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const pendingWrites = new Map();

// Serialize each destination and replace it atomically. Readers always see a
// complete snapshot, and a failed write leaves the previous snapshot intact.
export function writeJsonFile(filePath, value) {
  const target = path.resolve(filePath);
  const contents = JSON.stringify(value, null, 2);
  const previous = pendingWrites.get(target) || Promise.resolve();
  const writing = previous.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temporary, target);
    } finally {
      await fs.unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  });
  pendingWrites.set(target, writing);
  const cleanup = () => {
    if (pendingWrites.get(target) === writing) pendingWrites.delete(target);
  };
  writing.then(cleanup, cleanup);
  return writing;
}
