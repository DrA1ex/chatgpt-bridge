// Attachment preparation and upload commands for the extension content runtime.
// Loaded as a classic MV3 content script before content.js.
(() => {
  'use strict';

  function createAttachmentCommands(deps = {}) {
    const {
      CONFIG,
      EXTENSION_API,
      delay,
      diagnostic,
      emitChatEvent,
      findComposerRoot,
      findSendButton,
      isUsableButton,
      isVisible,
      send,
      visibleText,
    } = deps;

async function attachFiles(attachments, request) {
  emitChatEvent(request, 'files.attach.started', { count: attachments.length, files: attachments.map(stripAttachmentContent) });
  const files = [];

  for (const attachment of attachments) {
    try {
      files.push(await attachmentToFile(attachment));
      diagnostic('file.prepared', { requestId: request.requestId, id: attachment.id, name: attachment.name, size: attachment.size });
    } catch (err) {
      diagnostic('file.prepare_failed', { requestId: request.requestId, id: attachment.id, name: attachment.name, message: err.message });
      throw err;
    }
  }

  const input = await waitForFileInput(request);
  const dataTransfer = new DataTransfer();
  for (const file of files) dataTransfer.items.add(file);
  input.files = dataTransfer.files;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  diagnostic('file.input.changed', { requestId: request.requestId, count: files.length, names: files.map((file) => file.name) });
  emitChatEvent(request, 'files.attach.changed', { count: files.length, names: files.map((file) => file.name) });

  await waitForAttachmentChips(files, request).catch((err) => {
    diagnostic('file.upload_wait.warning', { requestId: request.requestId, message: err.message });
    emitChatEvent(request, 'files.attach.warning', { message: err.message });
  });
  emitChatEvent(request, 'files.attach.done', { count: files.length, names: files.map((file) => file.name) });
}

function stripAttachmentContent(attachment) {
  if (!attachment || typeof attachment !== 'object') return attachment;
  const { contentBase64, content, ...rest } = attachment;
  return rest;
}

async function attachmentToFile(attachment) {
  const name = String(attachment.name || attachment.filename || attachment.id || 'attachment');
  const mime = String(attachment.mime || attachment.type || 'application/octet-stream');

  if (attachment.contentBase64) {
    return new File([base64ToUint8Array(attachment.contentBase64)], name, { type: mime });
  }

  if (attachment.content) {
    return new File([String(attachment.content)], name, { type: mime || 'text/plain' });
  }

  if (attachment.url) {
    const blob = await fetchAttachmentBlob(attachment.url, mime);
    return new File([blob], name, { type: blob.type || mime });
  }

  throw new Error(`Attachment has no content: ${name}`);
}

function base64ToUint8Array(base64) {
  const binary = atob(String(base64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function fetchAttachmentBlob(url, fallbackMime = 'application/octet-stream') {
  try {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.blob();
  } catch (err) {
    if (typeof EXTENSION_API.httpRequest !== 'function') throw new Error(`Could not fetch attachment URL: ${err.message || err}`);
    return await new Promise((resolve, reject) => {
      EXTENSION_API.httpRequest({
        method: 'GET',
        url,
        responseType: 'blob',
        anonymous: false,
        onload(response) {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`Could not fetch attachment URL through extension HTTP transport: HTTP ${response.status}`));
            return;
          }
          const blob = response.response instanceof Blob ? response.response : new Blob([response.response], { type: fallbackMime });
          resolve(blob);
        },
        onerror() { reject(new Error('Could not fetch attachment URL through extension HTTP transport')); },
        ontimeout() { reject(new Error('Timed out fetching attachment URL')); },
      });
    });
  }
}

async function waitForFileInput(request, timeoutMs = 10_000) {
  const existing = findFileInput();
  if (existing) return existing;

  const attachButton = findAttachButton();
  if (attachButton) {
    attachButton.click();
    diagnostic('file.attach_button.clicked', { requestId: request.requestId });
    await delay(350);
  } else {
    diagnostic('file.attach_button.not_found', { requestId: request.requestId });
  }

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const input = findFileInput();
    if (input) return input;
    await delay(200);
  }

  throw new Error('File input not found in ChatGPT composer');
}

function findFileInput() {
  return Array.from(document.querySelectorAll('input[type="file"]')).find((input) => !input.disabled) || null;
}

function findAttachButton() {
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(isUsableButton);
  return buttons.find((button) => {
    const text = [button.getAttribute('aria-label'), button.getAttribute('title'), button.getAttribute('data-testid'), button.innerText || button.textContent || ''].filter(Boolean).join(' ');
    return /attach|upload|file|add photos|paperclip|прикреп|загруз|файл|скреп/i.test(text);
  }) || null;
}

async function waitForAttachmentChips(files, request) {
  const started = Date.now();
  const names = files.map((file) => file.name).filter(Boolean);
  let lastVisibleCount = 0;

  while (Date.now() - started < CONFIG.attachmentUploadTimeoutMs) {
    const root = findComposerRoot();
    const rootText = visibleText(root || document.body);
    const visibleNames = names.filter((name) => rootText.includes(name) || visibleText(document.body).includes(name));
    lastVisibleCount = visibleNames.length;

    const uploadError = findUploadError(root || document.body);
    if (uploadError) {
      diagnostic('file.upload_error', { requestId: request.requestId, message: uploadError });
      throw new Error(`Attachment upload failed: ${uploadError}`);
    }

    const busy = isAttachmentUploadBusy(root || document.body);
    const sendButton = findSendButton();
    if (visibleNames.length === names.length && !busy && sendButton) {
      diagnostic('file.upload.complete', { requestId: request.requestId, names, elapsedMs: Date.now() - started });
      return;
    }

    if (visibleNames.length !== lastVisibleCount || (Date.now() - started) % 3000 < 350) {
      emitChatEvent(request, 'files.attach.progress', { visible: visibleNames.length, total: names.length, busy });
    }
    await delay(350);
  }

  throw new Error(`Timed out waiting for file attachment upload completion (${lastVisibleCount}/${names.length} visible)`);
}

function findUploadError(root) {
  const text = visibleText(root);
  const match = text.match(/(upload failed|failed to upload|could not upload|unsupported file|file too large|ошибка загрузки|не удалось загрузить|файл слишком большой)/i);
  return match ? match[0] : '';
}

function isAttachmentUploadBusy(root) {
  const candidates = Array.from((root || document.body).querySelectorAll('[aria-busy="true"], [role="progressbar"], progress, [data-testid*="progress" i], [data-testid*="upload" i], svg[class*="spinner" i], div[class*="spinner" i]'));
  return candidates.some((element) => isVisible(element) && !/send|submit/i.test(element.getAttribute('data-testid') || ''));
}


function readComposerAttachmentState() {
  const root = findComposerRoot();
  if (!root || root === document.body) return { known: false, count: 0 };
  const buttons = findAttachmentRemoveButtons(root);
  return { known: true, count: buttons.length };
}

async function handleComposerAttachmentsClear(payload) {
  try {
    const result = await clearComposerAttachments();
    send({ type: 'composer.attachments.cleared', commandId: payload.commandId, ...result });
  } catch (err) {
    send({ type: 'command.error', commandId: payload.commandId, message: err.message || String(err) });
  }
}

async function clearComposerAttachments() {
  const root = findComposerRoot();
  const buttons = findAttachmentRemoveButtons(root);
  let removed = 0;
  for (const button of buttons) {
    try {
      button.click();
      removed += 1;
      await delay(120);
    } catch {
      // Continue with other candidates.
    }
  }
  diagnostic('composer.attachments.clear', { removed });
  return { removed, message: removed ? '' : 'No visible composer attachment remove buttons found' };
}

function findAttachmentRemoveButtons(root) {
  const candidates = Array.from((root || document.body).querySelectorAll('button, [role="button"]'));
  return candidates.filter((element) => {
    if (!isUsableButton(element)) return false;
    const attrs = [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.getAttribute('data-testid'),
      visibleText(element),
    ].filter(Boolean).join(' ');
    if (!/(remove|delete|clear|close|dismiss|attachment|file|удал|убрать|очист|закры)/i.test(attrs)) return false;
    if (/send|submit|voice|microphone|settings|share|regenerate/.test(attrs.toLowerCase())) return false;
    return true;
  });
}

    return Object.freeze({ attachFiles, handleComposerAttachmentsClear, readComposerAttachmentState });
  }

  globalThis.ChatGptAttachmentCommands = Object.freeze({ createAttachmentCommands });
})();
