export function tabScopedClientId(baseClientId = '', tabId = null) {
  const base = String(baseClientId || '').trim().replace(/:tab:\d+$/i, '');
  if (!Number.isInteger(tabId) || tabId < 0) return base;

  // Chrome's tab id is the authoritative source identity. The content-generated
  // id can change across document lifetimes and is retained separately for diagnostics.
  return `extension:tab:${tabId}`;
}
