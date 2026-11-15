// Boot-resource retries are read-only HTTP operations, never device retries.
export function createBootResourceLoader({ fetchFn = globalThis.fetch.bind(globalThis),
  onProgress = () => {}, onRetry = () => {}, onFailure = () => {},
  concurrency = 4, timeoutMs = 30000 } = {}) {
  let active = 0, checked = 0, failure = null;
  const waiting = [];
  const supported = new Set(['assembly', 'dotnetwasm', 'globalization', 'pdb']);
  async function download(name, uri, integrity) {
    if (active >= concurrency) await new Promise(resolve => waiting.push(resolve));
    else active++;
    try {
      if (failure) throw failure;
      if (!/^sha256-[A-Za-z0-9+/]{43}=$/.test(integrity)) throw new Error('Missing engine integrity: ' + name);
      for (let attempt = 0; attempt < 3; attempt++) {
        let retryable = true;
        try {
          const response = await fetchFn(uri, { integrity, cache: attempt ? 'reload' : 'no-cache',
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
          if (!retryable || attempt === 2) throw new Error('Engine download failed: ' + name + ' (' + error.message + ')', { cause: error });
          onRetry(name, attempt + 1);
        }
      }
    } catch (error) {
      if (!failure) { failure = error; onFailure(error); }
      throw failure;
    } finally {
      const next = waiting.shift();
      if (next) next(); else active--;
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
