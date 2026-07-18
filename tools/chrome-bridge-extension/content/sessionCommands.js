// Session and browser-tab UI commands for the extension content runtime.
// Loaded as a classic MV3 content script before content.js.
(() => {
  'use strict';

  function createSessionCommands(deps = {}) {
    const {
      CONFIG,
      CONTENT_SCRIPT_VERSION,
      DOM_PARSER,
      EXTENSION_VERSION,
      chatPageReadiness,
      delay,
      diagnostic,
      extensionRequest,
      isVisible,
      safeLaunchBridgeServerUrl,
      schedulePageStatus,
      stageTemporaryConnectionOverride,
      send,
      visibleText,
      waitForDocumentReady,
    } = deps;

const PAGE_RELOAD_CONTENT_SOURCE = 'chatgpt-browser-bridge-artifact-content-v1';
const PAGE_RELOAD_MAIN_SOURCE = 'chatgpt-browser-bridge-artifact-main-v1';

function armPageOwnedReload(delayMs = 900, timeoutMs = 1_500) {
  const reloadId = `page-reload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(result);
    };
    const onMessage = (event) => {
      if (event.source !== window) return;
      const message = event.data || {};
      if (message.source !== PAGE_RELOAD_MAIN_SOURCE || message.type !== 'page.reload.armed' || String(message.reloadId || '') !== reloadId) return;
      finish({ armed: true, reloadId, delayMs: Number(message.delayMs) || delayMs });
    };
    const timer = setTimeout(() => finish({ armed: false, reloadId, reason: 'main_world_ack_timeout' }), Math.max(250, Number(timeoutMs) || 1_500));
    window.addEventListener('message', onMessage);
    window.postMessage({
      source: PAGE_RELOAD_CONTENT_SOURCE,
      type: 'page.reload.arm',
      reloadId,
      delayMs: Math.max(300, Math.min(Number(delayMs) || 900, 5_000)),
    }, '*');
  });
}

function getCurrentSession() {
  const id = conversationIdFromUrl(location.href) || 'new';
  return { id, url: location.href, title: document.title || id, active: true };
}

function conversationIdFromUrl(url) {
  try {
    const parsed = new URL(url, location.href);
    return parsed.pathname.match(/\/c\/([^/?#]+)/)?.[1] || '';
  } catch { return ''; }
}

function collectSessions() {
  const currentId = conversationIdFromUrl(location.href) || 'new';
  const map = new Map();
  map.set(currentId, getCurrentSession());

  for (const a of Array.from(document.querySelectorAll('a[href*="/c/"]'))) {
    const href = a.href || a.getAttribute('href') || '';
    const id = conversationIdFromUrl(href);
    if (!id) continue;
    const title = visibleText(a) || a.getAttribute('aria-label') || id;
    map.set(id, { id, title, url: new URL(href, location.href).toString(), active: id === currentId });
  }

  return Array.from(map.values());
}

function handleSessionsList(payload) {
  send({ type: 'sessions.snapshot', commandId: payload.commandId, sessions: collectSessions(), current: getCurrentSession(), url: location.href, title: document.title });
}

async function handleSessionsNew(payload) {
  try {
    const session = await openNewSession();
    send({ type: 'session.new', commandId: payload.commandId, session, sessions: collectSessions() });
  } catch (err) {
    send({ type: 'command.error', commandId: payload.commandId, message: err.message || String(err) });
  }
}

async function handleSessionsSelect(payload) {
  try {
    const session = await selectSessionById(String(payload.sessionId || ''));
    send({ type: 'session.selected', commandId: payload.commandId, session, sessions: collectSessions() });
  } catch (err) {
    send({ type: 'command.error', commandId: payload.commandId, message: err.message || String(err) });
  }
}

async function handleSessionsDelete(payload) {
  try {
    const result = await deleteCurrentSessionSafely({
      expectedSessionId: String(payload.sessionId || payload.expectedSessionId || ''),
      expectedUrl: String(payload.expectedUrl || ''),
    });
    send({ type: 'session.deleted', commandId: payload.commandId, ...result, session: getCurrentSession(), url: location.href, title: document.title });
  } catch (err) {
    send({ type: 'command.error', commandId: payload.commandId, message: err.message || String(err) });
  }
}

async function handleBrowserTabOpen(payload) {
  try {
    const result = await extensionRequest('bridge.tab.open', {
      url: String(payload.url || 'https://chatgpt.com/'),
      active: payload.active !== false,
      launchToken: String(payload.launchToken || ''),
      bridgeServerUrl: safeLaunchBridgeServerUrl(payload.bridgeServerUrl || CONFIG.serverUrl),
    }, Number(payload.timeoutMs) || 15_000);
    send({ type: 'browser.tab.opened', commandId: payload.commandId, ...result });
  } catch (err) {
    send({ type: 'command.error', commandId: payload.commandId, message: err.message || String(err) });
  }
}

async function handleBrowserTabClose(payload) {
  try {
    const expectedUrl = String(payload.expectedUrl || '');
    if (expectedUrl) {
      const current = DOM_PARSER.canonicalConversationUrl(location.href) || new URL(location.href).origin + new URL(location.href).pathname;
      const expected = DOM_PARSER.canonicalConversationUrl(expectedUrl) || new URL(expectedUrl, location.href).origin + new URL(expectedUrl, location.href).pathname;
      if (current !== expected) throw new Error(`Refusing to close tab because URL changed: expected ${expected}, current ${current}`);
    }
    const result = await extensionRequest('bridge.tab.close', {
      expectedLaunchToken: String(payload.expectedLaunchToken || ''),
    }, Number(payload.timeoutMs) || 10_000);
    send({ type: 'browser.tab.closing', commandId: payload.commandId, ...result, url: location.href });
  } catch (err) {
    send({ type: 'command.error', commandId: payload.commandId, message: err.message || String(err) });
  }
}

async function handleBrowserOwnedTabClose(payload) {
  try {
    const result = await extensionRequest('bridge.tab.close-owned', {
      tabId: Number(payload.tabId),
      expectedLaunchToken: String(payload.expectedLaunchToken || ''),
    }, Number(payload.timeoutMs) || 10_000);
    send({ type: 'browser.tab.owned_closing', commandId: payload.commandId, ...result, url: location.href });
  } catch (err) {
    send({ type: 'command.error', commandId: payload.commandId, message: err.message || String(err) });
  }
}

function handleBrowserTabReload(payload) {
  send({
    type: 'browser.tab.reloading',
    commandId: payload.commandId,
    url: location.href,
  });
  diagnostic('browser.tab.reload.accepted', { commandId: payload.commandId, reason: String(payload.reason || '') });
  setTimeout(() => {
    extensionRequest('bridge.tab.reload', {
      reason: String(payload.reason || ''),
    }, 5_000).catch((err) => diagnostic('browser.tab.reload.failed', { commandId: payload.commandId, message: err.message || String(err) }));
  }, 120);
}

async function handleExtensionReload(payload) {
  const reloadTabs = payload.reloadTabs !== false;
  const temporaryConnection = reloadTabs && typeof stageTemporaryConnectionOverride === 'function'
    ? stageTemporaryConnectionOverride({
      serverUrl: safeLaunchBridgeServerUrl(payload.connection?.serverUrl || CONFIG.serverUrl) || CONFIG.serverUrl,
      token: CONFIG.token,
    })
    : { staged: false, reason: reloadTabs ? 'staging_unavailable' : 'tabs_not_reloaded' };
  const pageReload = reloadTabs
    ? await armPageOwnedReload(Number(payload.pageReloadDelayMs) || 900)
    : { armed: false, reason: 'tabs_not_reloaded' };
  send({
    type: 'extension.reload.accepted',
    commandId: payload.commandId,
    extensionVersion: EXTENSION_VERSION,
    contentVersion: CONTENT_SCRIPT_VERSION,
    temporaryConnection,
    pageReload,
    url: location.href,
  });
  diagnostic('extension.reload.accepted', {
    commandId: payload.commandId,
    reloadTabs,
    temporaryConnection: { ...temporaryConnection, tokenChanged: Boolean(temporaryConnection.tokenChanged) },
    pageReload,
  });
  setTimeout(() => {
    extensionRequest('bridge.extension.reload', {
      reloadTabs,
      expectedVersion: String(payload.expectedVersion || ''),
      sourceTabId: Number.isInteger(payload.sourceTabId) ? payload.sourceTabId : null,
      sourceLaunchToken: String(payload.sourceLaunchToken || ''),
      temporaryServerUrl: safeLaunchBridgeServerUrl(payload.temporaryServerUrl || payload.connection?.serverUrl || ''),
    }, 5_000).catch((err) => diagnostic('extension.reload.failed', { commandId: payload.commandId, message: err.message || String(err) }));
  }, 40);
}

function assertSessionDeletionTarget(expectedSessionId, expectedUrl) {
  const check = DOM_PARSER.verifySessionDeletionTarget({ currentUrl: location.href, expectedUrl, expectedSessionId });
  if (!check.ok) {
    throw new Error(`Refusing to delete ChatGPT session: ${check.reason}. Expected ${expectedSessionId || '(missing)'} at ${expectedUrl || '(missing)'}, current URL is ${location.href}.`);
  }
  return check;
}

function sessionRowForLink(link) {
  let current = link;
  for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
    const buttons = Array.from(current.querySelectorAll?.('button, [role="button"]') || []);
    if (buttons.length && current.querySelector?.('a[href*="/c/"]')) return current;
  }
  return link.parentElement || link;
}

function isStableConversationMenuTrigger(element) {
  if (!element || !isVisible(element)) return false;
  const testId = String(element.getAttribute?.('data-testid') || '').toLowerCase();
  if (/(?:conversation|chat).*(?:menu|options)|(?:menu|options).*(?:conversation|chat)/.test(testId)) return true;
  return element.getAttribute?.('aria-haspopup') === 'menu'
    || Boolean(element.getAttribute?.('aria-controls'));
}

function conversationMenuCandidateScore(element, source = '') {
  const testId = String(element?.getAttribute?.('data-testid') || '').toLowerCase();
  const rect = element?.getBoundingClientRect?.() || { left: 0, top: 0 };
  let score = 0;
  if (source === 'session-row') score += 500;
  if (source === 'explicit-testid') score += 400;
  if (source === 'top-menu-trigger') score += 200;
  if (/(?:conversation|chat).*(?:menu|options)|(?:menu|options).*(?:conversation|chat)/.test(testId)) score += 300;
  if (element?.getAttribute?.('aria-haspopup') === 'menu') score += 80;
  if (element?.getAttribute?.('aria-controls')) score += 60;
  if (element?.getAttribute?.('aria-expanded') === 'true') score += 20;
  score += Math.max(0, Math.min(50, Math.round((rect.left / Math.max(1, window.innerWidth)) * 50)));
  score -= Math.max(0, Math.min(30, Math.round(rect.top / 20)));
  return score;
}

function currentSessionMenuCandidates(sessionId) {
  const scored = [];
  const seen = new Set();
  const add = (element, source) => {
    if (!element || seen.has(element) || !isVisible(element)) return;
    seen.add(element);
    scored.push({ element, source, score: conversationMenuCandidateScore(element, source) });
  };

  const links = Array.from(document.querySelectorAll('a[href*="/c/"]'))
    .filter((link) => conversationIdFromUrl(link.href || link.getAttribute('href')) === sessionId);
  for (const link of links) {
    const row = sessionRowForLink(link);
    try {
      row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, view: window }));
      row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: window }));
    } catch {}
    const rowButtons = Array.from(row.querySelectorAll?.('button, [role="button"]') || [])
      .filter((button) => button !== link && !button.contains?.(link));
    for (const button of rowButtons.filter(isStableConversationMenuTrigger)) add(button, 'session-row');
    // Some sidebar implementations expose the ellipsis control without
    // aria-haspopup/aria-controls. The exact session row is still a safe
    // structural scope; the opened menu must later prove the stable delete
    // action test id before anything destructive is clicked.
    for (const button of rowButtons) add(button, 'session-row');
  }

  for (const element of Array.from(document.querySelectorAll([
    '[data-testid="conversation-options-button"]',
    '[data-testid="conversation-menu-button"]',
    '[data-testid="chat-options-button"]',
    '[data-testid="chat-menu-button"]',
    '[data-testid*="conversation-options" i]',
    '[data-testid*="conversation-menu" i]',
    '[data-testid*="chat-options" i]',
    '[data-testid*="chat-menu" i]',
  ].join(', ')))) add(element, 'explicit-testid');

  // Header controls are a language-independent fallback for collapsed
  // sidebars. Only menu triggers near the top of the page are considered,
  // and the resulting menu still has to contain the exact conversation
  // delete action test id.
  const topMenuTriggers = Array.from(document.querySelectorAll([
    'header button[aria-haspopup="menu"]',
    'header [role="button"][aria-haspopup="menu"]',
    'header button[aria-controls]',
    'header [role="button"][aria-controls]',
    'main button[aria-haspopup="menu"]',
    'main [role="button"][aria-haspopup="menu"]',
    'main button[aria-controls]',
    'main [role="button"][aria-controls]',
  ].join(', '))).filter((element) => {
    if (!isStableConversationMenuTrigger(element)) return false;
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.top <= 160;
  });
  for (const element of topMenuTriggers) add(element, 'top-menu-trigger');

  return scored
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.element);
}

function deleteActionDescriptor(element) {
  return {
    testId: element?.getAttribute?.('data-testid') || '',
    text: visibleText(element),
    ariaLabel: element?.getAttribute?.('aria-label') || '',
    title: element?.getAttribute?.('title') || '',
    role: element?.getAttribute?.('role') || element?.tagName?.toLowerCase?.() || '',
    dataColor: element?.getAttribute?.('data-color') || '',
    dataVariant: element?.getAttribute?.('data-variant') || '',
    dataDestructive: element?.getAttribute?.('data-destructive') || '',
  };
}

function visibleDeleteActions(root = document) {
  return Array.from(root.querySelectorAll?.([
    '[data-testid="delete-chat-menu-item"]',
    '[data-testid="delete-conversation-menu-item"]',
    '[data-testid*="delete-chat" i]',
    '[data-testid*="chat-delete" i]',
    '[data-testid*="delete-conversation" i]',
    '[data-testid*="conversation-delete" i]',
  ].join(', ')) || [])
    .filter(isVisible)
    .filter((element) => DOM_PARSER.isConversationDeleteActionDescriptor(deleteActionDescriptor(element)));
}

function visibleMenus() {
  return Array.from(document.querySelectorAll('[role="menu"], [data-radix-menu-content]')).filter(isVisible);
}

function visibleConversationDeleteMenus() {
  return visibleMenus().filter((menu) => visibleDeleteActions(menu).length > 0);
}

function menuOwnedByTrigger(menu, trigger) {
  return DOM_PARSER.menuTriggerOwnsMenu({
    triggerId: trigger?.id || '',
    triggerAriaControls: trigger?.getAttribute?.('aria-controls') || '',
    menuId: menu?.id || '',
    menuAriaLabelledby: menu?.getAttribute?.('aria-labelledby') || '',
  });
}

function conversationMenuCandidateDescriptors(candidates) {
  return candidates.slice(0, 12).map((element) => ({
    id: element.id || '',
    testId: element.getAttribute?.('data-testid') || '',
    ariaHaspopup: element.getAttribute?.('aria-haspopup') || '',
    ariaControls: element.getAttribute?.('aria-controls') || '',
    ariaExpanded: element.getAttribute?.('aria-expanded') || '',
    rect: (() => {
      const rect = element.getBoundingClientRect?.();
      return rect ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : null;
    })(),
  }));
}

async function openDeleteActionForCurrentSession(sessionId, expectedUrl) {
  for (let round = 1; round <= 4; round += 1) {
    assertSessionDeletionTarget(sessionId, expectedUrl);
    const candidates = currentSessionMenuCandidates(sessionId);
    diagnostic('session.delete.menu_candidates', {
      sessionId,
      round,
      count: candidates.length,
      candidates: conversationMenuCandidateDescriptors(candidates),
    });
    for (const button of candidates) {
      assertSessionDeletionTarget(sessionId, expectedUrl);
      try { button.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); } catch {}

      const alreadyOwnedMenu = visibleConversationDeleteMenus().find((menu) => menuOwnedByTrigger(menu, button));
      const alreadyOwnedAction = alreadyOwnedMenu ? visibleDeleteActions(alreadyOwnedMenu)[0] : null;
      if (alreadyOwnedAction) {
        diagnostic('session.delete.action_found', { sessionId, round, source: 'already_open_owned_menu', descriptor: deleteActionDescriptor(alreadyOwnedAction) });
        return alreadyOwnedAction;
      }

      const menusBeforeOpen = new Set(visibleMenus());
      try { button.click(); } catch { continue; }
      for (let attempt = 0; attempt < 24; attempt += 1) {
        await delay(150);
        const menus = visibleMenus();
        const ownedMenu = menus.find((menu) => menuOwnedByTrigger(menu, button) && visibleDeleteActions(menu).length > 0);
        const newlyOpenedMenu = menus.find((menu) => !menusBeforeOpen.has(menu) && visibleDeleteActions(menu).length > 0);
        const menu = ownedMenu || newlyOpenedMenu || null;
        const menuAction = menu ? visibleDeleteActions(menu)[0] : null;
        if (menuAction) {
          diagnostic('session.delete.action_found', {
            sessionId,
            round,
            source: ownedMenu ? 'trigger_owned_menu' : 'new_delete_menu',
            menuId: menu.id || '',
            menuLabelledBy: menu.getAttribute?.('aria-labelledby') || '',
            descriptor: deleteActionDescriptor(menuAction),
          });
          return menuAction;
        }
      }
      diagnostic('session.delete.menu_open_failed', {
        sessionId,
        round,
        trigger: conversationMenuCandidateDescriptors([button])[0],
        visibleMenus: visibleMenus().map((menu) => ({
          id: menu.id || '',
          ariaLabelledby: menu.getAttribute?.('aria-labelledby') || '',
          deleteActions: visibleDeleteActions(menu).map(deleteActionDescriptor),
        })),
      });
      try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); } catch {}
      await delay(150);
    }
    if (round < 4) {
      schedulePageStatus('page.changed', 0);
      await delay(500 * round);
    }
  }
  throw new Error(`Could not find the structurally identified delete action for current ChatGPT session ${sessionId}`);
}

function visibleModalDialogs() {
  return Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).filter(isVisible);
}

function visibleDeleteConfirmation(dialogsBefore = new Set()) {
  const candidates = visibleModalDialogs().filter((dialog) => !dialogsBefore.has(dialog));
  for (const dialog of candidates) {
    const buttons = Array.from(dialog.querySelectorAll('button, [role="button"]')).filter(isVisible);
    const exact = buttons.filter((button) => {
      const descriptor = deleteActionDescriptor(button);
      return DOM_PARSER.isConversationDeleteConfirmationDescriptor({ ...descriptor, dataColor: '', dataVariant: '', dataDestructive: '' });
    });
    if (exact.length === 1) return { dialog, confirm: exact[0], source: 'semantic_testid' };

    const destructive = buttons.filter((button) => DOM_PARSER.isConversationDeleteConfirmationDescriptor(deleteActionDescriptor(button)));
    if (destructive.length === 1) return { dialog, confirm: destructive[0], source: 'single_destructive_button' };
  }
  return null;
}

function boundedUiBackoffDelay(attempt, { initialMs = 100, factor = 1.7, maxMs = 2_000 } = {}) {
  const index = Math.max(0, Number(attempt) || 0);
  return Math.min(maxMs, Math.max(initialMs, Math.round(initialMs * (factor ** index))));
}

async function waitForConversationToDisappear(sessionId, timeoutMs = 12_000) {
  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started < timeoutMs) {
    if (conversationIdFromUrl(location.href) !== sessionId) return true;
    const remaining = timeoutMs - (Date.now() - started);
    await delay(Math.min(remaining, boundedUiBackoffDelay(attempt++, { initialMs: 100, factor: 1.5, maxMs: 1_000 })));
  }
  return false;
}

async function waitForDeleteConfirmation(dialogsBefore, sessionId, timeoutMs = 10_000) {
  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started < timeoutMs) {
    if (conversationIdFromUrl(location.href) !== sessionId) return { disappeared: true };
    const confirmation = visibleDeleteConfirmation(dialogsBefore);
    if (confirmation) return { confirmation };
    const waitedMs = Date.now() - started;
    if (attempt === 0 || attempt === 3 || attempt === 6) {
      diagnostic('session.delete.confirmation_waiting', {
        sessionId,
        attempt: attempt + 1,
        waitedMs,
        timeoutMs,
        visibleDialogs: visibleModalDialogs().length,
      });
    }
    const remaining = timeoutMs - waitedMs;
    await delay(Math.min(remaining, boundedUiBackoffDelay(attempt++, { initialMs: 100, factor: 1.7, maxMs: 2_000 })));
  }
  diagnostic('session.delete.confirmation_timeout', {
    sessionId,
    waitedMs: Date.now() - started,
    timeoutMs,
    visibleDialogs: visibleModalDialogs().map((dialog) => ({
      role: dialog.getAttribute?.('role') || '',
      testId: dialog.getAttribute?.('data-testid') || '',
      buttons: Array.from(dialog.querySelectorAll?.('button, [role="button"]') || []).filter(isVisible).map(deleteActionDescriptor),
    })),
  });
  return { confirmation: null, disappeared: false };
}

async function deleteCurrentSessionSafely({ expectedSessionId, expectedUrl }) {
  await waitForDocumentReady();
  const readyStarted = Date.now();
  while (Date.now() - readyStarted < 10_000) {
    assertSessionDeletionTarget(expectedSessionId, expectedUrl);
    const readiness = chatPageReadiness();
    if (readiness.chatMainReady) break;
    await delay(200);
  }
  const before = assertSessionDeletionTarget(expectedSessionId, expectedUrl);
  const deleteAction = await openDeleteActionForCurrentSession(before.currentId, expectedUrl);
  assertSessionDeletionTarget(expectedSessionId, expectedUrl);
  const dialogsBeforeDelete = new Set(visibleModalDialogs());
  deleteAction.click();

  const confirmationResult = await waitForDeleteConfirmation(dialogsBeforeDelete, before.currentId, 10_000);
  if (confirmationResult.disappeared) {
    return { deleted: true, deletedSessionId: before.currentId, beforeUrl: before.currentCanonical, afterUrl: location.href, confirmed: false };
  }

  const confirmation = confirmationResult.confirmation;
  if (!confirmation) {
    // The navigation can win the race immediately after the final confirmation probe.
    // Give URL removal one short bounded grace period before reporting a UI failure.
    const disappearedAfterTimeout = await waitForConversationToDisappear(before.currentId, 2_000);
    if (disappearedAfterTimeout) {
      diagnostic('session.delete.completed_during_confirmation_grace', {
        sessionId: before.currentId,
        waitedMs: 2_000,
      });
      return { deleted: true, deletedSessionId: before.currentId, beforeUrl: before.currentCanonical, afterUrl: location.href, confirmed: false };
    }
    throw new Error(`Delete confirmation dialog did not appear with a stable destructive action for ChatGPT session ${before.currentId}`);
  }
  diagnostic('session.delete.confirmation_found', {
    sessionId: before.currentId,
    source: confirmation.source || '',
    descriptor: deleteActionDescriptor(confirmation.confirm),
    waitedWithBackoff: true,
  });
  assertSessionDeletionTarget(expectedSessionId, expectedUrl);
  confirmation.confirm.click();
  const removed = await waitForConversationToDisappear(before.currentId);
  if (!removed) throw new Error(`ChatGPT session ${before.currentId} still appears in the current URL after delete confirmation`);
  return { deleted: true, deletedSessionId: before.currentId, beforeUrl: before.currentCanonical, afterUrl: location.href, confirmed: true };
}

async function openNewSession() {
  const button = Array.from(document.querySelectorAll('a, button, [role="button"]')).find((element) => {
    if (!isVisible(element)) return false;
    const text = [element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('data-testid'), visibleText(element)].filter(Boolean).join(' ');
    return /new chat|new conversation|новый чат|создать чат/i.test(text);
  });
  if (button) button.click();
  else location.href = '/';
  await waitForUrlChangeOrDelay(800);
  return getCurrentSession();
}

async function selectSessionById(sessionId) {
  const raw = String(sessionId || '').trim();
  const id = conversationIdFromUrl(raw) || raw;
  if (!id) throw new Error('No sessionId provided');
  if (conversationIdFromUrl(location.href) === id) return getCurrentSession();

  const sessions = collectSessions();
  const session = sessions.find((item) => item.id === id || item.url === raw || item.url.endsWith(`/c/${id}`));
  if (session) {
    const link = Array.from(document.querySelectorAll('a[href*="/c/"]')).find((a) => conversationIdFromUrl(a.href || a.getAttribute('href')) === session.id);
    if (link) link.click();
    else location.href = session.url;
  } else if (/^https?:\/\//.test(raw)) {
    location.href = raw;
  } else {
    location.href = `/c/${id}`;
  }

  await waitForUrlChangeOrDelay(1000);
  const switched = await waitForSessionId(id, 6000);
  const sessionAfterSwitch = getCurrentSession();
  if (!switched || sessionAfterSwitch.id !== id) {
    throw new Error(`Could not switch ChatGPT tab to session ${id}; current session is ${sessionAfterSwitch.id || 'unknown'}.`);
  }
  return sessionAfterSwitch;
}

function waitForUrlChangeOrDelay(minDelayMs = 800) {
  const before = location.href;
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (location.href !== before && document.readyState !== 'loading') {
        setTimeout(resolve, 350);
        return;
      }
      if (Date.now() - started >= minDelayMs) {
        resolve();
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

function waitForSessionId(sessionId, timeoutMs = 6000) {
  const desired = conversationIdFromUrl(sessionId) || String(sessionId || '').trim();
  if (!desired) return Promise.resolve(false);
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (conversationIdFromUrl(location.href) === desired && document.readyState !== 'loading') {
        setTimeout(() => resolve(true), 350);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(tick, 150);
    };
    tick();
  });
}



    return Object.freeze({
      getCurrentSession,
      conversationIdFromUrl,
      collectSessions,
      handleSessionsList,
      handleSessionsNew,
      handleSessionsSelect,
      handleSessionsDelete,
      handleBrowserTabOpen,
      handleBrowserTabClose,
      handleBrowserOwnedTabClose,
      handleBrowserTabReload,
      handleExtensionReload,
      openNewSession,
      selectSessionById,
    });
  }

  globalThis.ChatGptSessionCommands = Object.freeze({ createSessionCommands });
})();
