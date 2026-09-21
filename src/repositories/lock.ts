const tails = new Map<string, Promise<void>>();

// ponytail: same-repository operations are serialized; replace with a read/write gate only if measured query throughput requires it.
export async function withRepositoryLock<T>(id: string, work: () => Promise<T>): Promise<T> {
  const previous = tails.get(id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current, () => current);
  tails.set(id, tail);

  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (tails.get(id) === tail) tails.delete(id);
  }
}
