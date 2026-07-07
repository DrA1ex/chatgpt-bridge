#!/usr/bin/env node
import WebSocket from 'ws';

const port = process.env.PORT || '8080';
const token = process.env.API_TOKEN || '';
const url = `ws://127.0.0.1:${port}/codex/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`;
const ws = new WebSocket(url);
let nextId = 1;
function send(method, params = {}) {
  ws.send(JSON.stringify({ id: nextId++, method, params }));
}
ws.on('open', () => {
  send('initialize');
  send('thread/create', { title: 'demo thread', cwd: process.cwd() });
});
ws.on('message', (raw) => {
  console.log(String(raw));
  if (nextId > 3) ws.close();
});
