import { IN_MEMORY_STORE, openStore, type Store } from "./open-store.ts";

export interface TestClock {
  now: number;
}

export interface TestStore {
  store: Store;
  clock: TestClock;
}

export const openTestStore = (): TestStore => {
  const clock: TestClock = { now: 1_700_000_000_000 };
  return {
    store: openStore({ path: IN_MEMORY_STORE, now: () => clock.now }),
    clock,
  };
};
