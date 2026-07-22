export const LOCAL_E2E_COMMAND_TYPES = Object.freeze([
  'prompt.send',
  'prompt.steer',
  'prompt.cancel',
  'request.release',
  'request.resume',
  'request.effect.reconcile',
  'response.snapshot.request',
  'command.cancel',
  'passive.prompt.submit',
  'sessions.list',
  'sessions.new',
  'sessions.select',
  'sessions.delete',
  'browser.tab.open',
  'browser.tab.close',
  'browser.tab.close-owned',
  'browser.tab.reload',
  'debug.layout.capture',
  'extension.reload',
  'artifact.fetch',
  'response.recover.latest',
  'response.recover.list',
  'response.recover.turnKey',
  'models.list',
  'efforts.list',
  'intelligence.apply',
  'composer.attachments.clear',
]);

export const LOCAL_E2E_COMMAND_TYPE_SET = new Set(LOCAL_E2E_COMMAND_TYPES);

export const LOCAL_E2E_LIVE_ONLY_BOUNDARIES = Object.freeze([
  'Chrome extension installation, service-worker suspension, and browser permission behavior',
  'Authenticated ChatGPT selector and product-UI drift',
  'Chrome download-manager event identity and native download shelf behavior',
  'Real model latency, account limits, and server-side generation behavior',
]);
