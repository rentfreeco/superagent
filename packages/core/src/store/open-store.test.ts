import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { openTestStore } from "./open-test-store.ts";
import { openStore, requireWriteAheadLog } from "./open-store.ts";
import { MIGRATIONS } from "./migrations.ts";

let workspaceDirectory = "";

beforeEach(async () => {
  workspaceDirectory = await mkdtemp(path.join(tmpdir(), "superagent-store-"));
});

afterEach(async () => {
  await rm(workspaceDirectory, { recursive: true, force: true });
});

const inspect = (databasePath: string, pragma: string): unknown => {
  const database = new DatabaseSync(databasePath);
  try {
    return database.prepare(`pragma ${pragma}`).get();
  } finally {
    database.close();
  }
};

describe("openStore", () => {
  it("creates the file and its directories in write-ahead logging mode", () => {
    const databasePath = path.join(workspaceDirectory, "data", "state.db");

    openStore({ path: databasePath }).close();

    expect(inspect(databasePath, "journal_mode")).toEqual({
      journal_mode: "wal",
    });
    expect(inspect(databasePath, "user_version")).toEqual({
      user_version: MIGRATIONS.length,
    });
  });

  it("keeps data across a restart without re-running migrations", () => {
    const databasePath = path.join(workspaceDirectory, "state.db");
    const firstRun = openStore({ path: databasePath });
    firstRun.kv.set("router.session_id", "session-1");
    firstRun.close();

    const secondRun = openStore({ path: databasePath });
    expect(secondRun.kv.get("router.session_id", z.string())).toBe("session-1");
    secondRun.close();
  });

  it("refuses a store written by newer code", () => {
    const databasePath = path.join(workspaceDirectory, "state.db");
    const database = new DatabaseSync(databasePath);
    database.exec("pragma user_version = 99");
    database.close();

    expect(() => openStore({ path: databasePath })).toThrow(
      new RegExp(
        `schema version 99, but this code only knows up to ${MIGRATIONS.length}`,
      ),
    );
  });

  it("refuses any journal mode but write-ahead logging", () => {
    expect(() => requireWriteAheadLog("wal", "/data/state.db")).not.toThrow();
    expect(() => requireWriteAheadLog("delete", "/data/state.db")).toThrow(
      /kept \/data\/state\.db in delete journal mode/,
    );
  });

  it("enforces foreign keys", () => {
    const { store } = openTestStore();
    expect(() =>
      store.inputs.add({
        taskId: "missing",
        source: "system",
        ref: null,
        text: "restarted",
      }),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe("transaction", () => {
  it("rolls back everything when the work throws", () => {
    const { store } = openTestStore();
    expect(() =>
      store.transaction(() => {
        store.kv.set("cursor", 1);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.kv.get("cursor", z.number())).toBeUndefined();
  });

  it("folds a nested transaction into the outer one", () => {
    const { store } = openTestStore();
    expect(() =>
      store.transaction(() => {
        store.kv.set("outer", 1);
        store.transaction(() => store.kv.set("inner", 2));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.kv.get("inner", z.number())).toBeUndefined();
  });

  it("refuses async work", () => {
    const { store } = openTestStore();
    expect(() => store.transaction(async () => undefined)).toThrow(
      /synchronous/,
    );
  });

  it("keeps the outbox's rows when migration 3 rebuilds it for reaction removals and GitHub entries", () => {
    const storePath = path.join(workspaceDirectory, "state.db");
    const database = new DatabaseSync(storePath);
    database.exec("pragma journal_mode = wal");
    for (const migration of MIGRATIONS.slice(0, 2)) database.exec(migration);
    database.exec("pragma user_version = 2");
    database.exec(
      `insert into outbox (dedupe_key, channel, thread_ts, kind, body, next_attempt_at, created_at)
       values ('report:1', 'C0123ABCD', '1.000001', 'post', '{"text":"Done."}', 1, 1)`,
    );
    database.close();

    const store = openStore({ path: storePath });
    try {
      expect(store.outbox.get(1)?.message).toEqual({
        kind: "post",
        text: "Done.",
      });
      expect(
        store.outbox.enqueue({
          dedupeKey: "done:github:comment:31",
          channel: "github:pakgin/scratch",
          threadTs: "7",
          message: {
            kind: "github_reaction",
            repository: "pakgin/scratch",
            subject: "issue-comment",
            subjectId: 31,
            content: "+1",
          },
        })?.message.kind,
      ).toBe("github_reaction");
    } finally {
      store.close();
    }
  });
});
