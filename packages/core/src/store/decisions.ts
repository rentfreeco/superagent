import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

export const decisionOutcomeSchema = z.enum([
  "start_task",
  "reply",
  "attach",
  "stop",
  "ignore",
]);

export type DecisionOutcome = z.infer<typeof decisionOutcomeSchema>;

const decisionSchema = z.object({
  id: z.number(),
  candidateId: z.number(),
  outcome: decisionOutcomeSchema,
  taskId: z.string().nullable(),
  reason: z.string(),
  decidedBy: z.enum(["router", "fallback"]),
  createdAt: z.number(),
});

export interface Decision extends z.infer<typeof decisionSchema> {}

export interface NewDecision {
  candidateId: number;
  outcome: DecisionOutcome;
  taskId: string | null;
  reason: string;
  decidedBy: Decision["decidedBy"];
}

export interface DecisionStore {
  add(decision: NewDecision): Decision;
  forCandidate(candidateId: number): Decision | undefined;
}

const DECISION_COLUMNS =
  "id, candidate_id as candidateId, outcome, task_id as taskId, reason, decided_by as decidedBy, created_at as createdAt";

export const createDecisionStore = (
  database: DatabaseSync,
  now: () => number,
): DecisionStore => {
  const insertDecision = database.prepare(
    `insert into decisions (candidate_id, outcome, task_id, reason, decided_by, created_at)
     values (:candidateId, :outcome, :taskId, :reason, :decidedBy, :now)
     returning ${DECISION_COLUMNS}`,
  );
  const selectForCandidate = database.prepare(
    `select ${DECISION_COLUMNS} from decisions where candidate_id = :candidateId`,
  );

  return {
    add: (decision) =>
      decisionSchema.parse(insertDecision.get({ ...decision, now: now() })),
    forCandidate: (candidateId) => {
      const row = selectForCandidate.get({ candidateId });
      return row === undefined ? undefined : decisionSchema.parse(row);
    },
  };
};
