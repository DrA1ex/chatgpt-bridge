import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

async function collectMarkdown(root, relative = '') {
  const directory = path.join(root, relative);
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', '.bridge-data'].includes(entry.name)) continue;
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await collectMarkdown(root, next));
    else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(next);
  }
  return files;
}

test('project Markdown documentation is written in English only', async () => {
  const root = process.cwd();
  const files = await collectMarkdown(root);
  const violations = [];
  for (const relative of files) {
    const content = await fs.readFile(path.join(root, relative), 'utf8');
    const match = content.match(/[\u0400-\u04FF]/u);
    if (match) violations.push(`${relative}: contains Cyrillic character ${JSON.stringify(match[0])}`);
  }
  assert.deepEqual(violations, []);
});
