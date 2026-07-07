import { config } from './config.js';

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

function formatEvent(event, raw = false) {
  if (raw) return JSON.stringify(event);
  const time = event.time || new Date().toISOString();
  const type = event.type || 'event';
  const requestId = event.requestId ? ` request=${event.requestId}` : '';
  const clientId = event.clientId ? ` client=${event.clientId}` : '';
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const details = [];
  for (const key of ['status', 'message', 'selector', 'count', 'name', 'fileId', 'artifactId', 'answerLength', 'thinkingLength']) {
    if (data[key] != null && data[key] !== '') details.push(`${key}=${JSON.stringify(data[key])}`);
  }
  return `${time} ${type}${requestId}${clientId}${details.length ? ` ${details.join(' ')}` : ''}`;
}

function parseSse(buffer, onEvent) {
  let rest = buffer;
  let index;
  while ((index = rest.indexOf('\n\n')) !== -1) {
    const block = rest.slice(0, index);
    rest = rest.slice(index + 2);
    const lines = block.split(/\r?\n/);
    let data = '';
    for (const line of lines) {
      if (line.startsWith('data:')) data += `${line.slice(5).trimStart()}\n`;
    }
    data = data.trim();
    if (!data) continue;
    try { onEvent(JSON.parse(data)); } catch { onEvent({ type: 'raw', data: { data } }); }
  }
  return rest;
}

export async function runDebugClient() {
  const raw = process.argv.includes('--raw');
  const channel = process.argv.includes('--events') ? 'events' : 'debug';
  const baseUrl = argValue('--url', `http://${config.host}:${config.port}`);
  const token = argValue('--token', config.apiToken);
  const url = `${baseUrl.replace(/\/$/, '')}/${channel === 'debug' ? 'debug/stream' : 'events/stream'}`;
  const headers = token ? { Authorization: `Bearer ${token}` } : {};

  console.log(`[${channel}] connecting to ${url}`);
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`Could not connect to ${url}: HTTP ${response.status} ${await response.text()}`);
  if (!response.body) throw new Error('SSE response has no body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = parseSse(buffer, (event) => console.log(formatEvent(event, raw)));
  }
}
