import fs from 'node:fs/promises';
import path from 'node:path';

export async function writeFinalDiagnostics({ reportDir, report, timeline, consoleLogPath = '', writeZip }) {
  await fs.mkdir(reportDir, { recursive: true });
  const jsonPath = path.join(reportDir, 'report.json');
  const timelinePath = path.join(reportDir, 'timeline.ndjson');
  const summaryPath = path.join(reportDir, 'SUMMARY.md');
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(timelinePath, `${timeline.map((item) => JSON.stringify(item)).join('\n')}\n`);
  const rows = report.scenarios
    .map((item) => `| ${item.id || ''} | ${item.name} | ${item.status} | ${item.durationMs ?? ''} | ${String(item.error?.message || item.note || '').replaceAll('|', '\\|')} |`)
    .join('\n');
  await fs.writeFile(summaryPath, `# Real E2E report\n\n- Run: \`${report.runId}\`\n- Status: **${report.status}**\n- Started: ${report.startedAt}\n- Finished: ${report.finishedAt || ''}\n- Session: ${report.sessionUrl || '(not created)'}\n- Selected scenarios: ${(report.selectedScenarios || []).map((id) => `\`${id}\``).join(', ')}\n\n| ID | Scenario | Status | ms | Detail |\n|---|---|---:|---:|---|\n${rows}\n\n## Cleanup\n\n\`\`\`json\n${JSON.stringify(report.cleanup, null, 2)}\n\`\`\`\n`);

  const runningPath = path.join(reportDir, 'RUNNING.json');
  await fs.rm(runningPath, { force: true }).catch(() => {});
  const bundlePath = `${reportDir}.zip`;
  const entries = [];
  const collectEntries = async (dir, prefix = '') => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await collectEntries(absolute, name);
      else if (entry.isFile() && !['RUNNING.json', 'report.partial.json', 'timeline.partial.ndjson'].includes(name)) {
        entries.push({ name, path: absolute });
      }
    }
  };
  await collectEntries(reportDir);
  await writeZip(bundlePath, entries);

  const verified = {};
  for (const filePath of [jsonPath, timelinePath, summaryPath, bundlePath]) {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size <= 0) throw new Error(`Diagnostics output is empty or missing: ${filePath}`);
    verified[filePath] = stat.size;
  }
  return { jsonPath, timelinePath, summaryPath, bundlePath, consoleLogPath, verified };
}
