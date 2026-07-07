export class AsyncMutex {
  #tail = Promise.resolve();

  async runExclusive(fn) {
    let release;
    const previous = this.#tail;
    this.#tail = new Promise((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      return await fn();
    } finally {
      release();
    }
  }
}
