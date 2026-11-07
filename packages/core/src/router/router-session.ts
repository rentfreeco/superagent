import { createSdkMcpServer, query } from "@anthropic-ai/claude-agent-sdk";
import { ROUTER_EFFORT, WORKER_MODEL } from "../constants.ts";
import type { Repo } from "../repos/config.ts";
import type { Candidate } from "../store/candidates.ts";
import {
  type AgentSessionEvents,
  type StartConversation,
  startAgentSession,
} from "../tasks/agent-session.ts";
import { agentEnvironment } from "../tasks/claude-session.ts";
import {
  describeCandidate,
  routerInstructions,
} from "./router-instructions.ts";
import {
  createRouterTools,
  ROUTER_SERVER_NAME,
  ROUTER_TOOL_NAMES,
  type RouterActions,
} from "./router-tools.ts";

export interface RouterSessionOptions {
  sessionId: string | null;
  candidates: readonly Candidate[];
  actions: RouterActions;
  events: AgentSessionEvents;
}

export interface RouterSession {
  send(candidates: readonly Candidate[]): void;
  interrupt(): Promise<void>;
  end(): void;
  close(): void;
}

export type StartRouterSession = (
  options: RouterSessionOptions,
) => RouterSession;

export interface RouterSessionStarterOptions {
  /** An empty directory the router's Claude Code session runs in; resuming needs the same one. */
  workingDirectory: string;
  /** Repo name -> Repo. */
  repos: ReadonlyMap<string, Repo>;
  /** Channel ID -> Repo. */
  channelRepos: ReadonlyMap<string, Repo>;
  startConversation?: StartConversation;
  environment?: Readonly<Record<string, string | undefined>>;
}

export const createRouterSessionStarter =
  ({
    workingDirectory,
    repos,
    channelRepos,
    startConversation = query,
    environment = process.env,
  }: RouterSessionStarterOptions): StartRouterSession =>
  ({ sessionId, candidates, actions, events }) => {
    const toPrompt = (candidate: Candidate) => ({
      id: candidate.id,
      text: describeCandidate(candidate, channelRepos),
    });
    const session = startAgentSession({
      startConversation,
      options: {
        cwd: workingDirectory,
        resume: sessionId ?? undefined,
        model: WORKER_MODEL,
        effort: ROUTER_EFFORT,
        tools: [],
        permissionMode: "dontAsk",
        allowedTools: ROUTER_TOOL_NAMES,
        strictMcpConfig: true,
        settingSources: [],
        systemPrompt: routerInstructions({ repos, channelRepos }),
        mcpServers: {
          [ROUTER_SERVER_NAME]: createSdkMcpServer({
            name: ROUTER_SERVER_NAME,
            version: "1.0.0",
            tools: Object.values(createRouterTools(actions)),
          }),
        },
        env: agentEnvironment(environment),
        title: "superagent router",
      },
      prompts: candidates.map(toPrompt),
      events,
    });
    return {
      send: (nextCandidates) => session.send(nextCandidates.map(toPrompt)),
      interrupt: session.interrupt,
      end: session.end,
      close: session.close,
    };
  };
