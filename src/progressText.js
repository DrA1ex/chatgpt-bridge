export function mergeMonotonicText(previous = '', next = '') {
  const left = String(previous || '');
  const right = String(next || '');
  if (!left) return right;
  if (!right || left === right || left.startsWith(right)) return left;
  if (right.startsWith(left)) return right;

  const limit = Math.min(left.length, right.length);
  for (let size = limit; size >= 4; size -= 1) {
    if (left.slice(-size) === right.slice(0, size)) return `${left}${right.slice(size)}`;
    if (right.slice(-size) === left.slice(0, size)) return `${right}${left.slice(size)}`;
  }
  return right.length >= left.length ? right : left;
}
