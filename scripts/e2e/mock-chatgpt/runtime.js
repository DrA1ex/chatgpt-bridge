import { startMockChatGptServer } from './server.js';
import { MockChatGptBrowser } from './extension-client.js';

export async function startMockChatGptRuntime({ enabled, bridgeUrl, bridgeToken = '', report = null, testLog = () => {} } = {}) {
  if (!enabled) return null;
  const browser = new MockChatGptBrowser({ bridgeUrl, bridgeToken });
  const server = await startMockChatGptServer({ tabs: browser.tabs });
  browser.pageOrigin = server.origin;
  try {
    await browser.openTab({ tabId: 1, requestedUrl: 'https://chatgpt.com/' });
  } catch (error) {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
    throw error;
  }
  if (report) report.mockChatGptOrigin = server.origin;
  testLog('ok', 'mock-chatgpt', 'Deterministic local ChatGPT runtime connected', { layoutUrl: server.origin });
  return Object.freeze({ browser, server, origin: server.origin });
}

export async function stopMockChatGptRuntime(runtime) {
  if (!runtime) return;
  await runtime.browser?.close?.().catch(() => {});
  await runtime.server?.close?.().catch(() => {});
}
