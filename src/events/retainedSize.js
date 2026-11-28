// Conservative estimate of the memory a diagnostic record can keep alive.
// Stop once the caller's limit is exceeded, without serializing the record.
export function retainedSize(value, limit = Infinity) {
  const seen = new Set();
  let size = 0;

  function visit(item) {
    if (typeof item === 'string') {
      size += 32 + item.length * 2;
    } else if (item && typeof item === 'object') {
      if (seen.has(item)) return;
      seen.add(item);
      size += 48;
      if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) {
        size += item.byteLength;
        return;
      }
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        size += 24 + (Array.isArray(item) ? 0 : key.length * 2);
        visit(item[key]);
        if (size > limit) return;
      }
    } else {
      size += 8;
    }
  }

  visit(value);
  return size;
}

export class RetainedHistory {
  #sizes = [];
  #totalBytes = 0;

  constructor({ limit, maxBytes, values = [] }) {
    this.limit = limit;
    this.maxBytes = maxBytes;
    this.values = values;
    this.#sizes = values.map(value => retainedSize(value, maxBytes));
    this.#totalBytes = this.#sizes.reduce((total, size) => total + size, 0);
  }

  push(value) {
    const size = retainedSize(value, this.maxBytes);
    if (size > this.maxBytes) return;
    this.values.push(value);
    this.#sizes.push(size);
    this.#totalBytes += size;
    let discard = 0;
    while (this.values.length - discard > this.limit || this.#totalBytes > this.maxBytes) {
      this.#totalBytes -= this.#sizes[discard++];
    }
    if (discard) {
      this.values.splice(0, discard);
      this.#sizes.splice(0, discard);
    }
  }
}
