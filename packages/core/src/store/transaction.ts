import type { DatabaseSync } from "node:sqlite";

export type Transaction = <Result>(work: () => Result) => Result;

export const createTransaction =
  (database: DatabaseSync): Transaction =>
  (work) => {
    if (database.isTransaction) return work();
    database.exec("begin immediate");
    try {
      const result = work();
      if (result instanceof Promise) {
        throw new Error(
          "Store transactions are synchronous. Finish async work before starting one.",
        );
      }
      database.exec("commit");
      return result;
    } catch (error) {
      database.exec("rollback");
      throw error;
    }
  };
