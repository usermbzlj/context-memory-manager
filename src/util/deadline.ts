/**
 * A deadline whose ref'd timer holds its controller strongly; call clear() when the work ends.
 * `AbortSignal.timeout()` is unref'd and references its signal weakly, and undici's fetch can lose its
 * link to a caller signal once headers arrive, so a stalled body could otherwise wait for undici's 300 s.
 */
export interface Deadline { readonly signal: AbortSignal; clear(): void }

const MAX_TIMER_MS = 2 ** 31 - 1;

export function createDeadline(ms: number, reason: () => Error, outer?: AbortSignal): Deadline {
  const controller = new AbortController();
  const onOuter = () => controller.abort(outer?.reason);
  const delay = Number.isNaN(ms) ? MAX_TIMER_MS : Math.max(0, Math.min(ms, MAX_TIMER_MS));
  const timer = setTimeout(() => controller.abort(reason()), delay);
  if (outer?.aborted) onOuter(); else outer?.addEventListener('abort', onOuter, { once: true });
  return {
    signal: controller.signal,
    clear: () => { clearTimeout(timer); outer?.removeEventListener('abort', onOuter); },
  };
}

/** A promise that rejects once the signal aborts; release() detaches the listener. */
export function whenAborted(signal: AbortSignal, reason: () => Error): { promise: Promise<never>; release(): void } {
  let onAbort: () => void = () => {};
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => reject(reason());
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  });
  promise.catch(() => {});
  return { promise, release: () => signal.removeEventListener('abort', onAbort) };
}
