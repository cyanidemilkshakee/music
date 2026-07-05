class AsyncQueue {
  constructor(concurrency = 1) {
    const parsed = Number(concurrency);
    this.concurrency = Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
    this.active = 0;
    this.pending = [];
  }

  run(task) {
    if (typeof task !== 'function') {
      return Promise.reject(new TypeError('Queue task must be a function.'));
    }

    return new Promise((resolve, reject) => {
      this.pending.push({ task, resolve, reject });
      this.drain();
    });
  }

  drain() {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const item = this.pending.shift();
      this.active++;

      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active--;
          this.drain();
        });
    }
  }
}

function positiveIntegerEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) return fallback;
  return Math.min(value, max);
}

module.exports = {
  AsyncQueue,
  positiveIntegerEnv
};
