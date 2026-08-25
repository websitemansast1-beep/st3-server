/**
 * withLock(key, fn)
 *
 * Collapses concurrent calls that share the same key into a single
 * in-flight execution of `fn`. Every caller (the first one and any
 * duplicates that arrive while it's still running) gets the SAME
 * settled result — resolved value or rejected error.
 *
 * This is what makes "double-click Login / Start / Submit" safe:
 * instead of racing two writes to Google Sheets, the second request
 * just waits on the first one's promise and returns its result.
 *
 * Deliberately in-memory / per-process. That's fine for a single
 * Railway/Render dyno; if the backend is ever scaled horizontally to
 * multiple instances, this stops deduping *across* instances (each
 * instance still dedupes its own concurrent requests correctly) —
 * true cross-instance idempotency would need a shared store (Redis).
 */

const inFlight = new Map(); // key -> Promise

function withLock(key, fn) {
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = Promise.resolve().then(fn);
  inFlight.set(key, promise);

  const clear = () => {
    // Only clear if we're still the current holder of this key
    if (inFlight.get(key) === promise) inFlight.delete(key);
  };
  promise.then(clear, clear);

  return promise;
}

module.exports = { withLock };
