export type KeyedLock = <Result>(
  key: string,
  work: () => Promise<Result>,
) => Promise<Result>;

export const createKeyedLock = (): KeyedLock => {
  const tails = new Map<string, Promise<void>>();
  return async <Result>(
    key: string,
    work: () => Promise<Result>,
  ): Promise<Result> => {
    const result = (tails.get(key) ?? Promise.resolve()).then(work);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    try {
      return await result;
    } finally {
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
};
