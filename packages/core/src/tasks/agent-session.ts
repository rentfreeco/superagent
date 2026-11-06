import { randomUUID } from "node:crypto";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createAsyncQueue } from "../utils/create-async-queue.ts";

export interface AgentPrompt {
  /** What the prompt carries, such as an input's or a candidate's ID. */
  id: number;
  text: string;
}

export interface AgentTurn {
  /** The IDs of the prompts this turn read. */
  readIds: number[];
  isError: boolean;
  resultText: string;
  /** No prompt is left unread and no turn is queued. */
  isIdle: boolean;
}

export interface AgentSessionEvents {
  onSessionId(sessionId: string): void;
  onTurnEnd(turn: AgentTurn): void;
  onEnd(error: unknown): void;
}

export interface AgentSession {
  send(prompts: readonly AgentPrompt[]): void;
  interrupt(): Promise<void>;
  end(): void;
  close(): void;
}

export interface AgentConversation extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>;
  close(): void;
}

export interface ConversationRequest {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}

export type StartConversation = (
  request: ConversationRequest,
) => AgentConversation;

export interface AgentSessionRequest {
  startConversation: StartConversation;
  options: Options;
  prompts: readonly AgentPrompt[];
  events: AgentSessionEvents;
}

const sessionInitSchema = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.string(),
});

const turnResultSchema = z.object({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
  errors: z.array(z.string()).optional(),
  user_message_uuid: z.string().optional(),
  user_message_uuids: z.array(z.string()).optional(),
  queued_turn_count: z.number().optional(),
});

/**
 * Runs one Agent SDK query fed by streamed prompts, and tells which prompts
 * each turn read from the uuids its result lists.
 */
export const startAgentSession = ({
  startConversation,
  options,
  prompts: initialPrompts,
  events,
}: AgentSessionRequest): AgentSession => {
  const prompts = createAsyncQueue<SDKUserMessage>();
  const unreadIds = new Map<string, number>();

  const send = (nextPrompts: readonly AgentPrompt[]): void => {
    for (const { id, text } of nextPrompts) {
      const uuid = randomUUID();
      unreadIds.set(uuid, id);
      prompts.push({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
        uuid,
      });
    }
  };

  const takeReadIds = (consumedUuids: readonly string[]): number[] =>
    consumedUuids.flatMap((uuid) => {
      const id = unreadIds.get(uuid);
      unreadIds.delete(uuid);
      return id === undefined ? [] : [id];
    });

  const handleMessage = (message: unknown): void => {
    const init = sessionInitSchema.safeParse(message);
    if (init.success) {
      events.onSessionId(init.data.session_id);
      return;
    }
    const result = turnResultSchema.safeParse(message);
    if (!result.success) return;
    const turn = result.data;
    const consumedUuids =
      turn.user_message_uuids ??
      (turn.user_message_uuid === undefined
        ? [...unreadIds.keys()]
        : [turn.user_message_uuid]);
    events.onTurnEnd({
      readIds: takeReadIds(consumedUuids),
      isError: turn.is_error || turn.subtype !== "success",
      resultText:
        turn.subtype === "success"
          ? (turn.result ?? "")
          : (turn.errors ?? []).join("\n"),
      isIdle: unreadIds.size === 0 && (turn.queued_turn_count ?? 0) === 0,
    });
  };

  send(initialPrompts);
  const conversation = startConversation({ prompt: prompts, options });

  const consume = async (): Promise<unknown> => {
    try {
      for await (const message of conversation) handleMessage(message);
      return undefined;
    } catch (error) {
      return error;
    } finally {
      prompts.end();
      conversation.close();
    }
  };
  void consume().then(events.onEnd);

  return {
    send,
    interrupt: async () => {
      await conversation.interrupt();
    },
    end: prompts.end,
    close: () => {
      prompts.end();
      conversation.close();
    },
  };
};
