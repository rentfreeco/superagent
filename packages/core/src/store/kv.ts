import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

export interface KeyValueStore {
  get<Value>(key: string, schema: z.ZodType<Value>): Value | undefined;
  set(key: string, value: unknown): void;
}

const storedValueSchema = z.object({ value: z.string() });

export const createKeyValueStore = (
  database: DatabaseSync,
  now: () => number,
): KeyValueStore => {
  const selectValue = database.prepare("select value from kv where key = :key");
  const upsertValue = database.prepare(
    `insert into kv (key, value, updated_at) values (:key, :value, :now)
     on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
  );

  return {
    get: (key, schema) => {
      const row = selectValue.get({ key });
      if (row === undefined) return undefined;
      return schema.parse(JSON.parse(storedValueSchema.parse(row).value));
    },
    set: (key, value) => {
      upsertValue.run({ key, value: JSON.stringify(value), now: now() });
    },
  };
};
