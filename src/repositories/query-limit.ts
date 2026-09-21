type Queued<T> = {
  work: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  abort: () => void;
};

function aborted(): Error & { code: "SEARCH_ABORTED" } {
  return Object.assign(new Error("검색이 취소됨"), { code: "SEARCH_ABORTED" as const });
}

export function createQueryLimit(maxConcurrent: number) {
  let active = 0;
  const queue: Queued<unknown>[] = [];
  const drain = () => {
    while (active < maxConcurrent && queue.length > 0) {
      const next = queue.shift()!;
      next.signal?.removeEventListener("abort", next.abort);
      if (next.signal?.aborted) {
        next.reject(aborted());
        continue;
      }
      active += 1;
      void Promise.resolve().then(next.work).then(next.resolve, next.reject).finally(() => {
        active -= 1;
        drain();
      });
    }
  };
  return {
    run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) return Promise.reject(aborted());
      return new Promise<T>((resolve, reject) => {
        const queued: Queued<T> = {
          work,
          resolve,
          reject,
          signal,
          abort: () => {
            const index = queue.indexOf(queued as Queued<unknown>);
            if (index >= 0) queue.splice(index, 1);
            signal?.removeEventListener("abort", queued.abort);
            reject(aborted());
          },
        };
        queue.push(queued as Queued<unknown>);
        signal?.addEventListener("abort", queued.abort, { once: true });
        drain();
      });
    },
  };
}
