import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

function slug(value = '') {
  return String(value || 'layout')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'layout';
}

export function createPageLayoutCapture({ enabled = false, reportDir, options, api, getClient, report, testLog } = {}) {
  const directory = path.join(reportDir, 'page-layout');
  const entries = [];
  const filesByHash = new Map();
  let sequence = 0;

  async function writeIndex() {
    if (!enabled) return;
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'index.json'), `${JSON.stringify({
      version: 1,
      sanitized: true,
      description: 'Structural ChatGPT page snapshots. Conversation text, chat titles, account labels, URLs with identifiers, input values, and media sources are redacted.',
      entries,
    }, null, 2)}\n`);
    report.pageLayoutCapture = {
      enabled: true,
      directory: 'page-layout',
      entries: entries.map(({ html, ...entry }) => entry),
    };
  }

  async function capture(label, details = {}) {
    if (!enabled) return null;
    const client = getClient?.();
    if (!client?.id) return null;
    const entry = {
      sequence: ++sequence,
      label: String(label || 'layout'),
      scenarioId: String(details.scenarioId || ''),
      phase: String(details.phase || ''),
      status: String(details.status || ''),
      capturedAt: new Date().toISOString(),
      sourceClientId: client.id,
      requestId: String(details.requestId || client.activeRequest?.requestId || ''),
      file: '',
      duplicateOf: '',
      error: '',
      metadata: null,
    };
    try {
      const response = await api(options, '/browser/layout/capture', {
        method: 'POST',
        timeoutMs: Math.max(5_000, Number(details.timeoutMs) || 20_000),
        body: {
          sourceClientId: client.id,
          requestId: entry.requestId,
          maxNodes: 15_000,
          maxBytes: 2_000_000,
          timeoutMs: Math.max(5_000, Number(details.timeoutMs) || 15_000),
        },
      });
      const html = String(response.html || '');
      if (!html) throw new Error('Layout capture returned no HTML');
      const sha256 = createHash('sha256').update(html).digest('hex');
      const existing = filesByHash.get(sha256);
      if (existing) {
        entry.file = existing;
        entry.duplicateOf = existing;
      } else {
        await fs.mkdir(directory, { recursive: true });
        const filename = `${String(entry.sequence).padStart(3, '0')}-${slug(entry.label)}-${sha256.slice(0, 10)}.html`;
        await fs.writeFile(path.join(directory, filename), `${html}\n`);
        filesByHash.set(sha256, filename);
        entry.file = filename;
      }
      entry.sha256 = sha256;
      entry.bytes = Buffer.byteLength(html);
      entry.metadata = response.metadata && typeof response.metadata === 'object' ? response.metadata : {};
      entries.push(entry);
      await writeIndex();
      testLog?.('info', details.scenarioId || 'layout', 'Captured sanitized page layout', {
        label: entry.label,
        file: `page-layout/${entry.file}`,
        duplicate: Boolean(entry.duplicateOf),
        bytes: entry.bytes,
      });
      return entry;
    } catch (error) {
      entry.error = error?.message || String(error);
      entries.push(entry);
      await writeIndex().catch(() => {});
      testLog?.('warn', details.scenarioId || 'layout', 'Could not capture sanitized page layout', {
        label: entry.label,
        error: entry.error,
      });
      return entry;
    }
  }

  report.pageLayoutCapture = enabled ? { enabled: true, directory: 'page-layout', entries: [] } : { enabled: false };
  return Object.freeze({ capture, entries, writeIndex });
}
