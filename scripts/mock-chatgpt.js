#!/usr/bin/env node
import process from 'node:process';
import { MockChatGptStateMachine } from './e2e/mock-chatgpt/state-machine.js';
import { startMockChatGptServer } from './e2e/mock-chatgpt/server.js';

const tabId = 1;
const state = new MockChatGptStateMachine({ tabId });
const tab = { state, publishObservation: async () => {}, publicLayoutUrl: () => '' };
const tabs = new Map([[tabId, tab]]);
const server = await startMockChatGptServer({ tabs, port: Number(process.env.MOCK_CHATGPT_PORT) || 0 });
tab.publicLayoutUrl = () => `${server.origin}/?tab=${tabId}`;
console.log(`Mock ChatGPT layout: ${server.origin}/?tab=${tabId}`);
console.log('Use the composer or POST actions to /api/tabs/1. Ctrl+C stops the server.');
const close = async () => { await server.close(); process.exit(0); };
process.on('SIGINT', close);
process.on('SIGTERM', close);
