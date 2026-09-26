/** Cancellation helpers also bound dependencies which do not cooperate with signals. */
export interface Deadline { signal: AbortSignal; readonly timedOut: boolean; dispose(): void; }

export function createDeadline(timeoutMs: number, parent?: AbortSignal): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(parent?.reason ?? new Error("Cancelled"));
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
      if (!controller.signal.aborted) controller.abort(new Error("Execution closed"));
    },
  };
}

export function withAbort<T>(work: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  const promise = Promise.resolve(work);
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("Cancelled"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise.then(
      value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

export async function* abortableStream<T>(stream: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]();
  let ended = false;
  try {
    for (;;) {
      signal.throwIfAborted();
      const step = await withAbort(iterator.next(), signal);
      if (step.done) { ended = true; return; }
      yield step.value;
    }
  } finally {
    if (!ended && iterator.return) {
      const closing = Promise.resolve(iterator.return()).catch(() => undefined);
      if (!signal.aborted) await withAbort(closing, signal);
    }
  }
}

export async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await withAbort(new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }), signal);
  } finally {
    clearTimeout(timer);
  }
}
