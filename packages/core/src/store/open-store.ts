import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { SQLITE_BUSY_TIMEOUT_MS } from "../constants.ts";
import { type CandidateStore, createCandidateStore } from "./candidates.ts";
import { createDecisionStore, type DecisionStore } from "./decisions.ts";
import { createEventStore, type EventStore } from "./events.ts";
import { createInputStore, type InputStore } from "./inputs.ts";
import { createKeyValueStore, type KeyValueStore } from "./kv.ts";
import { migrate } from "./migrations.ts";
import { createOutboxStore, type OutboxStore } from "./outbox.ts";
import { createReportStore, type ReportStore } from "./reports.ts";
import { createTaskStore, type TaskStore } from "./tasks.ts";
import { createThreadStore, type ThreadStore } from "./threads.ts";
import { createTransaction, type Transaction } from "./transaction.ts";

export const IN_MEMORY_STORE = ":memory:";

export interface StoreOptions {
  path: string;
  now?: () => number;
}

export interface Store {
  events: EventStore;
  threads: ThreadStore;
  tasks: TaskStore;
  inputs: InputStore;
  reports: ReportStore;
  outbox: OutboxStore;
  kv: KeyValueStore;
  candidates: CandidateStore;
  decisions: DecisionStore;
  transaction: Transaction;
  close(): void;
}

const journalModeSchema = z.object({ journal_mode: z.string() });

export const requireWriteAheadLog = (
  journalMode: string,
  databasePath: string,
): void => {
  if (journalMode !== "wal") {
    throw new Error(
      `SQLite kept ${databasePath} in ${journalMode} journal mode instead of write-ahead logging. Keep the store on a local, writable filesystem, such as a Docker named volume, not a network share.`,
    );
  }
};

export const openStore = ({
  path: databasePath,
  now = Date.now,
}: StoreOptions): Store => {
  const isInMemory = databasePath === IN_MEMORY_STORE;
  if (!isInMemory) mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(
      `pragma busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}; pragma foreign_keys = on; pragma synchronous = normal;`,
    );
    if (!isInMemory) {
      const { journal_mode: journalMode } = journalModeSchema.parse(
        database.prepare("pragma journal_mode = wal").get(),
      );
      requireWriteAheadLog(journalMode, databasePath);
    }
    const transaction = createTransaction(database);
    migrate(database, transaction, databasePath);
    return {
      events: createEventStore(database, now),
      threads: createThreadStore(database, now),
      tasks: createTaskStore(database, now),
      inputs: createInputStore(database, transaction, now),
      reports: createReportStore(database, now),
      outbox: createOutboxStore(database, now),
      kv: createKeyValueStore(database, now),
      candidates: createCandidateStore(database, transaction, now),
      decisions: createDecisionStore(database, now),
      transaction,
      close: () => database.close(),
    };
  } catch (error) {
    database.close();
    throw error;
  }
};
