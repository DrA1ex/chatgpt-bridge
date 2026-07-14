function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function matchesProjectContextAcknowledgement(answer, marker) {
  const expected = String(marker || '').trim();
  if (!expected) return false;
  const source = String(answer || '');
  const boundaryClass = 'A-Za-z0-9_-';
  const pattern = new RegExp(`(^|[^${boundaryClass}])${escapeRegExp(expected)}(?=$|[^${boundaryClass}])`, 'm');
  return pattern.test(source);
}
