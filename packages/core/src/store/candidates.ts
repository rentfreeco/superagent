import type { DatabaseSync, StatementSync } from "node:sqlite";
import { z } from "zod";
import type { Transaction } from "./transaction.ts";

export const candidateViaSchema = z.enum(["dm", "mention", "thread"]);

const candidateSchema = z.object({
  id: z.number(),
  eventId: z.string(),
  channel: z.string(),
  ts: z.string(),
  threadTs: z.string(),
  user: z.string(),
  text: z.string(),
  via: candidateViaSchema,
  handedBackBy: z.string().nullable(),
  handBackReason: z.string().nullable(),
  createdAt: z.number(),
  deliveredAt: z.number().nullable(),
  decidedAt: z.number().nullable(),
});

export interface Candidate extends z.infer<typeof candidateSchema> {}

export interface NewCandidate {
  eventId: string;
  channel: string;
  ts: string;
  threadTs: string;
  user: string;
  text: string;
  via: z.infer<typeof candidateViaSchema>;
  handedBackBy: string | null;
  handBackReason: string | null;
}

export interface CandidateStore {
  add(candidate: NewCandidate): Candidate | undefined;
  get(id: number): Candidate | undefined;
  undelivered(): Candidate[];
  undecided(): Candidate[];
  markDelivered(candidateIds: readonly number[]): void;
  markDecided(candidateId: number): boolean;
  isHandedBack(eventId: string, taskId: string): boolean;
}

const CANDIDATE_COLUMNS =
  "id, event_id as eventId, channel, ts, thread_ts as threadTs, user, text, via, handed_back_by as handedBackBy, hand_back_reason as handBackReason, created_at as createdAt, delivered_at as deliveredAt, decided_at as decidedAt";

export const createCandidateStore = (
  database: DatabaseSync,
  transaction: Transaction,
  now: () => number,
): CandidateStore => {
  const insertCandidate = database.prepare(
    `insert into candidates (event_id, channel, ts, thread_ts, user, text, via, handed_back_by, hand_back_reason, created_at)
     values (:eventId, :channel, :ts, :threadTs, :user, :text, :via, :handedBackBy, :handBackReason, :now)
     on conflict do nothing
     returning ${CANDIDATE_COLUMNS}`,
  );
  const selectCandidate = database.prepare(
    `select ${CANDIDATE_COLUMNS} from candidates where id = :id`,
  );
  const selectUndelivered = database.prepare(
    `select ${CANDIDATE_COLUMNS} from candidates
     where decided_at is null and delivered_at is null order by id`,
  );
  const selectHandedBack = database.prepare(
    "select 1 from candidates where event_id = :eventId and handed_back_by = :taskId",
  );
  const selectUndecided = database.prepare(
    `select ${CANDIDATE_COLUMNS} from candidates
     where decided_at is null order by id`,
  );
  const updateDelivered = database.prepare(
    "update candidates set delivered_at = :now where id = :id and decided_at is null",
  );
  const updateDecided = database.prepare(
    "update candidates set decided_at = :now where id = :id and decided_at is null",
  );

  const parseAll = (statement: StatementSync): Candidate[] =>
    statement.all().map((row) => candidateSchema.parse(row));

  return {
    add: (candidate) => {
      const row = insertCandidate.get({ ...candidate, now: now() });
      return row === undefined ? undefined : candidateSchema.parse(row);
    },
    get: (id) => {
      const row = selectCandidate.get({ id });
      return row === undefined ? undefined : candidateSchema.parse(row);
    },
    undelivered: () => parseAll(selectUndelivered),
    undecided: () => parseAll(selectUndecided),
    markDelivered: (candidateIds) => {
      const deliveredAt = now();
      transaction(() => {
        for (const id of candidateIds) {
          updateDelivered.run({ id, now: deliveredAt });
        }
      });
    },
    markDecided: (candidateId) =>
      Number(updateDecided.run({ id: candidateId, now: now() }).changes) > 0,
    isHandedBack: (eventId, taskId) =>
      selectHandedBack.get({ eventId, taskId }) !== undefined,
  };
};
