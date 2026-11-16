// Boot-resource retries are read-only HTTP operations, never device retries.
export function createBootResourceLoader({ fetchFn = globalThis.fetch.bind(globalThis),
  onProgress = () => {}, onRetry = () => {}, onFailure = () => {},
  concurrency = 16, recoveryConcurrency = 4, timeoutMs = 30000 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16 ||
      !Number.isInteger(recoveryConcurrency) || recoveryConcurrency < 1 ||
      !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Invalid engine download limits.');
  let active = 0, checked = 0, failure = null, limit = concurrency;
  const waiting = [];
  const supported = new Set(['assembly', 'dotnetwasm', 'globalization', 'pdb']);
  function pump() {
    if (failure) { for (const waiter of waiting.splice(0)) waiter.reject(failure); return; }
    while (waiting.length && active < limit) { active++; waiting.shift().resolve(); }
  }
  function acquire() { return new Promise((resolve, reject) => { waiting.push({ resolve, reject }); pump(); }); }
  function release() { active--; pump(); }
  function fail(error) {
    if (!failure) { failure = error; onFailure(error); }
    pump();
    return failure;
  }
  async function download(name, uri, integrity) {
    try {
      if (failure) throw failure;
      if (!/^sha256-[A-Za-z0-9+/]{43}=$/.test(integrity)) throw new Error('Missing engine integrity: ' + name);
      for (let attempt = 0; attempt < 3; attempt++) {
        let retryable = true;
        await acquire();
        try {
          if (failure) throw failure;
          // The immutable manifest supplies an exact SHA256, including on cache
          // hits. Stale/corrupt cached bytes fail SRI and retry with a fresh read.
          const response = await fetchFn(uri, { integrity, cache: attempt ? 'reload' : 'force-cache',
            credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
          if (!response.ok) {
            retryable = response.status === 408 || response.status === 429 || response.status >= 500;
            throw new Error('HTTP ' + response.status);
          }
          // Consume the body before releasing the slot. Integrity and transfer
          // failures must be caught here, including failures after the headers.
          const bytes = await response.arrayBuffer();
          onProgress(++checked);
          return new Response(bytes, { headers: { 'Content-Type':
            response.headers.get('Content-Type') || 'application/octet-stream' } });
        } catch (error) {
          if (failure) throw failure;
          if (!retryable || attempt === 2) throw fail(new Error('Engine download failed: ' + name + ' (' + error.message + ')', { cause: error }));
          // Existing requests finish normally. New requests and retries share
          // the smaller limit; a retry never bypasses the full-body semaphore.
          limit = Math.min(limit, recoveryConcurrency);
          onRetry(name, attempt + 1);
        } finally { release(); }
      }
    } catch (error) {
      throw fail(error);
    }
  }
  return (type, name, uri, integrity) => supported.has(type) ? download(name, uri, integrity) : null;
}

export async function startValidationEngine(start, timeoutMs = 120000) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(start), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Validation engine startup timed out. Reload this page to try again.')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
