export interface AsyncQueue<Item> extends AsyncIterable<Item> {
  push(item: Item): void;
  end(): void;
}

export const createAsyncQueue = <Item>(): AsyncQueue<Item> => {
  const buffered: IteratorResult<Item, undefined>[] = [];
  const waiters: ((result: IteratorResult<Item, undefined>) => void)[] = [];
  let isEnded = false;

  const end = (): void => {
    isEnded = true;
    for (const waiter of waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  };

  return {
    push: (item) => {
      if (isEnded) throw new Error("Can't push to a queue that has ended.");
      const result: IteratorResult<Item, undefined> = {
        value: item,
        done: false,
      };
      const waiter = waiters.shift();
      if (waiter === undefined) buffered.push(result);
      else waiter(result);
    },
    end,
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const result = buffered.shift();
        if (result !== undefined) return Promise.resolve(result);
        if (isEnded) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => waiters.push(resolve));
      },
      return: () => {
        end();
        return Promise.resolve({ value: undefined, done: true });
      },
    }),
  };
};
