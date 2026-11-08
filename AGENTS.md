## Project

superagent is a personal coding agent you talk to in Slack. Each request becomes a task, worked on by its own Claude Code session in its own git worktree, and the results come back in the Slack thread as short replies and as GitHub pull requests. It borrows DeepSeek's super-agent architecture without its multi-user permission machinery.

- MUST: Keep it single-owner. Never add users, roles, or permission tiers.
- MUST: Route everything that reaches the bot from Slack (events, actions, commands, shortcuts) through the owner gate in `packages/core/src/slack/inbound.ts`. It is the only access control the service has.

## General Rules

- MUST: Use pnpm, pinned through `packageManager`. `pnpm install` to install, `pnpm SCRIPT_NAME` to run, `pnpm --filter PACKAGE SCRIPT_NAME` for one workspace, `pnpm remove` to uninstall.
- MUST: Use TypeScript interfaces over types. Type aliases only for what an interface cannot express: unions, intersections, and function types.
- MUST: Keep all types at the top level of the module, never inside functions.
- MUST: Use arrow functions over function declarations.
- MUST: Never comment unless absolutely necessary.
  - If the code is a hack (like a setTimeout or potentially confusing code), it must be prefixed with // HACK: reason for hack
- MUST: Use kebab-case for files.
- MUST: Use descriptive names for variables (avoid shorthands, or 1-2 character names).
  - Example: for .map(), you can use `innerX` instead of `x`
  - Example: instead of `moved` use `didPositionChange`
- MUST: Frequently re-evaluate and refactor variable names to be more accurate and descriptive.
- MUST: Do not type cast ("as") unless absolutely necessary.
- MUST: Remove unused code and don't repeat yourself.
- MUST: Search for existing symbols with `rg` before adding a utility, helper, type, or constant, and again after finishing a task to catch duplicates and dead code.
- MUST: Always search the codebase, think of many solutions, then implement the most _elegant_ solution.
- MUST: Put all magic numbers in the package's `src/constants.ts` using `SCREAMING_SNAKE_CASE` with unit suffixes (`_MS`, `_PX`).
- MUST: Put small, focused utility functions in `src/utils/` with one utility per file.
- MUST: Use Boolean over !!.

## Package Layout

```
packages/
  core/                        PRIVATE  the service's core logic, one module per subpath export
    src/
      repos/                   @repo/core/repos: which repo a message belongs to
        config.ts              SuperagentConfig and Repo types, defineConfig, and parseConfig
                               (the zod schema, including channel -> repo cross-checks)
        load-config.ts         loadConfig: import the config file, validate it, confirm each
                               repo path is a git checkout, return every repo by name and
                               channel ID -> Repo
        route-message.ts       routeMessage: a mapped channel's repo, or the reply for a DM
                               or an unmapped channel
        index.ts               the module's public exports
      slack/                   @repo/core/slack: the bot's Socket Mode connection
        gateway.ts             SlackGateway: connect (auth.test, then Bolt App, then start),
                               fetchThread, post, react, findPost, classifyFailure, replay,
                               catchUp, close
        resolve-bot-identity.ts resolveBotIdentity: the bot's IDs from auth.test, refusing a
                               token with none or an owner ID that is the bot's own
        inbound.ts             the global gate (record the event once, then self, then owner,
                               then handled types); the listeners for DMs, @-mentions, replies
                               in followed threads (isFollowedThread), which claim the message
                               and build InboundMessage, and reactions (InboundReaction);
                               replayEvent runs a recorded but unsettled event back through the
                               same checks; EventLog is what the store's events table satisfies
        catch-up.ts            catchUpConversation: read a channel or thread after a ts and feed
                               the owner's missed messages through the real gate, as synthetic
                               events with catchup:<channel>:<ts> IDs
        thread.ts              fetchThread: conversations.replies with cursor pagination
        delivery.ts            postMessage (dedupe key in message metadata), addReaction,
                               findOwnPost, and which Slack errors are permanent
        index.ts               the module's public exports
      store/                   @repo/core/store: everything the service needs after a restart
        open-store.ts          openStore: pragmas, the write-ahead-log check, migrations
        migrations.ts          MIGRATIONS, applied in order and tracked by PRAGMA user_version
        transaction.ts         BEGIN IMMEDIATE / COMMIT; nested calls join the outer one
        events.ts              each Slack event once, its disposition, one claim per message
        threads.ts             which task owns a thread; null means the router
        tasks.ts               tasks and TASK_TRANSITIONS, the one task state machine
        inputs.ts              what each worker has been told, deduped by (source, ref)
        reports.ts             what each worker last said
        outbox.ts              what must reach Slack, with dedupe keys and retry backoff
        kv.ts                  JSON values by key, read back through a zod schema
        candidates.ts          owner messages no task owns, waiting for the router, once per
                               message and once more per task that hands one back
        decisions.ts           what was decided for each candidate, why, and by the router or
                               the fallback; at most one per candidate
        open-test-store.ts     an in-memory store with a settable clock, for tests
      github/                  @repo/core/github: superagent's own GitHub account
        client.ts              createGitHubClient: GET with the token, answers parsed with zod
        resolve-agent-account.ts resolveAgentAccount: whose the token is, refusing the
                               owner's own, with the noreply address commits are authored with
        agent-account-environment.ts agentAccountEnvironment: gh, git pushes, and commit
                               identity as the agent, over the machine's own credentials
        index.ts               the module's public exports
      outbox/                  @repo/core/outbox: turns outbox rows into Slack posts
        sender.ts              createOutboxSender: one pass at a time, woken on enqueue and
                               polled every second; checks before re-posting; stops cleanly
        index.ts               the module's public exports
      recovery/                @repo/core/recovery: what runs once on every start
        recover.ts             recoverAfterRestart: replay unfinished events, tell running
                               tasks about the restart, catch up on what was sent while down
        index.ts               the module's public exports
      router/                  @repo/core/router: what happens to a message no task owns
        decide.ts              start_task, reply, attach, stop, ignore: each records the
                               decision, writes its rows, settles the event, in one transaction
        decide-by-channel-map.ts the fallback: today's channel-map routing, replying when it
                               can't start a task, so every candidate gets a decision
        router.ts              createRouter: one router session, resumed by its kv session ID;
                               candidates in, fallback on an idle turn, a crash, or a timeout
        router-session.ts      createRouterSessionStarter: no built-in tools, no settings
                               files, dontAsk with only the routing tools
        router-tools.ts        the routing tools, and list_tasks
        router-instructions.ts the router's system prompt and each candidate's card
        queue-candidate.ts     queueCandidate: the handler's side
        list-tasks.ts          listTasks: one line per task, for status questions
        index.ts               the module's public exports
      tasks/                   @repo/core/tasks: Claude Code sessions that work on tasks
        agent-session.ts       startAgentSession: one Agent SDK query fed by streamed prompts,
                               and which prompts each turn read; the worker and router use it
        start-task.ts          startTask: a queued task that owns the thread, with the message
                               as its first input
        take-follow-up.ts      takeFollowUp: a message in a task's thread becomes an input, or,
                               if it is just "stop", stops the task
        take-reaction.ts       takeReaction: 🛑 on a task's first message, or on one of the
                               owner's messages in its thread, stops the task
        stop-task.ts           stopTask: what stopping does, for the word and the reaction
        runner.ts              createTaskRunner: starts queued tasks, pushes new inputs into live
                               sessions, resumes ended tasks on new input and running ones after
                               a restart, ends stopped and idle sessions, caps concurrency; gets
                               the Slack thread reader at start
        claude-session.ts      createClaudeSessionStarter: one Agent SDK query per session, fed
                               inputs as streamed prompts; the ack, read_thread, report,
                               hand_back, and nothing_to_report MCP tools
        acknowledge-messages.ts acknowledgeMessages: the worker's ack, an 👀 on each Slack
                               message it was given and hasn't finished, as ack:<event_id>
        read-task-thread.ts    readTaskThread: the worker's read_thread, the owner's and the
                               bot's messages in the task's thread, newest that fit
        record-report.ts       recordReport: the report row, the state change, and the thread
                               post, in one transaction
        hand-back-message.ts   handBackMessage: the worker's hand_back, the message it names as
                               a router candidate naming the task and why
        tool-outcome.ts        ToolOutcome, what a worker or router tool answers, and
                               toToolResult
        worker-guard.ts        createWorkerGuard: the PreToolUse hook that refuses merges,
                               approvals, closing issues, force pushes, pushes to the base
                               branch, writes outside the worktree, and credential reads
        prepare-worktree.ts    prepareWorktree: agent/<task id> from the freshly fetched base
                               branch, in $SUPERAGENT_DATA_DIR/worktrees/<task id>, one
                               checkout at a time
        worker-instructions.ts what the worker is told on top of Claude Code's own system prompt
        index.ts               the module's public exports
      utils/                   small helpers, one per file
      constants.ts             magic numbers: SQLite busy timeout, outbox backoff and polling,
                               Slack delivery timeout, task IDs and titles, the session cap, the
                               worker's model and effort
    slack-app-manifest.json    the Slack app's events, scopes, and Socket Mode switch
  eslint-config/               PRIVATE  shared ESLint flat config (Babel parser for TS)
  typescript-config/           PRIVATE  shared tsconfig bases
apps/
  agent/                       the bot process; `pnpm dev` runs it with restarts on change
    src/
      main.ts                  startup: environment, config, the agent's GitHub account,
                               store, the recovery snapshot, connect, outbox sender, recovery,
                               then the task runner and the router; on SIGINT / SIGTERM closes the sessions, disconnects,
                               and closes the store
      environment.ts           parseEnvironment: the Slack settings, LOG_LEVEL,
                               SUPERAGENT_DATA_DIR, and the agent's GitHub account, checked
                               with zod
      handle-message.ts        createMessageHandler: in one transaction, give a message in a
                               task's thread to takeFollowUp, or queue it for the router; wake
                               the outbox, the runner, and the router
      handle-reaction.ts       createReactionHandler: takeReaction in one transaction, settle
                               the event, wake the outbox and runner
      constants.ts             CONFIG_PATH (superagent.config.ts at the repository root),
                               STORE_FILE_NAME, WORKTREES_DIRECTORY_NAME, and
                               ROUTER_DIRECTORY_NAME
    .env.example               the settings to copy into the git-ignored apps/agent/.env
superagent.config.example.ts   the committed example; the real superagent.config.ts is git-ignored
```

- MUST: Keep `@repo/core/slack` transport-only: it delivers `InboundMessage`s and reads threads. Repo selection, tasks, and Claude Code sessions belong in their own `core` modules.
- A task is keyed by `channel` + `threadTs`. `threadTs` is the thread root, so follow-ups in a thread land on the same task.
- MUST: Start a task only in a configured repo. The router's `start_task` refuses any other name, and the channel-map fallback decides with `routeMessage`. A message with no repo gets a reply, never a guessed repo.
- MUST: Keep `apps/agent` to wiring: reading the environment, connecting, and passing messages to `core`. Logic that could be tested without a process belongs in `@repo/core`.
- A task starts through `startTask` from `@repo/core/tasks`, called by the router's `decideStartTask` inside the decision's transaction. It is synchronous and only writes rows; the task runner acts on those rows in its own loop, as the outbox sender does for posts.
- A message in a thread a task owns goes to `takeFollowUp`, before routing. The router sees it only if the task's worker hands it back.

## TypeScript and Node

Internal packages export their TypeScript source and have no build step. Node 24 runs it directly by stripping types, which sets hard limits on the syntax:

- ALWAYS: relative imports name the `.ts` file: `import { postMessage } from "./delivery.ts"`.
- ALWAYS: `import type` for type-only imports. `verbatimModuleSyntax` enforces it.
- NEVER: `enum`, `namespace`, or constructor parameter properties. `erasableSyntaxOnly` enforces it.
- `noUncheckedIndexedAccess` is on, so `array[0]` is `T | undefined`.

## Library versions newer than you know

Bolt 5.1, `@slack/web-api` 8.3, `@slack/types` 3.3, the Claude Agent SDK 0.3, zod 4.6, Vitest 5.1, TypeScript 7.0, ESLint 10.9, Babel 8, and pnpm 11.25 may all differ from your training data. Read the installed source and `.d.ts` files before relying on a remembered API. Bolt is at `packages/core/node_modules/@slack/bolt/dist/`, and the Agent SDK's types are in `packages/core/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`.

Verified against the installed versions:

- Bolt acks Events API payloads before global middleware runs (`App.js` → `processEvent`). Non-event payloads and `function_executed` events leave the ack to the listener.
- Passing `botId` and `botUserId` to `new App` skips Bolt's own `auth.test`.
- `context.userId` is the acting user for every payload type: `event.user`, `user.id` for actions, `user_id` for commands.
- `WebClient.paginate` returns untyped pages. Paginate the typed method with `cursor` instead.
- zod 4 reports a record key that fails its schema as a generic "Invalid key in record", dropping the key schema's message. Give the record an `error` function that handles `invalid_key`, as `repos/config.ts` does.
- `@babel/eslint-parser` 8 parses in a worker thread unless `babelOptions` sets both `babelrc: false` and `configFile: false`. The shared config sets neither, so its parser options must be structured-cloneable: a path string, never a function or an imported module.
- `node:sqlite` on Node 24.21 needs no flag, bundles SQLite 3.53, and has no transaction helper; `DatabaseSync.isTransaction` says whether one is open. Binding a named parameter the SQL doesn't use throws, so pass exactly the parameters a statement names. `INSERT … ON CONFLICT DO NOTHING RETURNING` returns no row for a conflict.
- A default `webApi.WebClient` retries for about 30 minutes (`tenRetriesInAboutThirtyMinutes`), waits out rate limits, and has no timeout. The gateway's delivery client sets `retryConfig: { retries: 0 }`, `rejectRateLimitedCalls: true`, and a 10-second timeout, so the outbox does the retrying. Its errors carry `code` (`webApi.ErrorCode`), and platform errors carry Slack's error string in `data.error`.
- The Agent SDK's `query` with an `AsyncIterable` prompt keeps the session open for more prompts. A prompt sent while a turn runs is folded into that turn between tool calls. Each turn ends with one `result` message, whose `user_message_uuids` lists the `uuid`s of the prompts it consumed and whose `queued_turn_count` says whether more turns are queued.
- Verified in a live session (Claude Code 2.1.311): without a `tools` list, a session loads every built-in tool (Cron, `SendMessage`, `Workflow`, `RemoteTrigger`, and more), and from its second turn the machine's claude.ai connectors (Gmail, Drive, Calendar, Docs). A `tools` list plus `strictMcpConfig: true` loads only the listed built-ins and the `mcpServers` given. `tools` silently drops names it doesn't know; this build has no `MultiEdit`, `BashOutput`, `KillShell`, `TodoWrite`, `WebFetch`, or `Agent`. Each turn starts with a `system`/`init` message listing the session's tools.
- Verified live: `dontAsk` refuses Edit and Write under any directory named `.claude`, even when they're allowlisted. Shell commands aren't affected.
- Verified live: Claude Code refuses a foreground `sleep N && …` and sends long commands to the background, which ends the turn while the command still runs. `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` keeps every command in the foreground, with a `timeout` of up to ten minutes.
- The Agent SDK's `permissionMode: "dontAsk"` denies every tool not in `allowedTools` instead of asking; `bypassPermissions` would need `allowDangerouslySkipPermissions: true`. A `PreToolUse` hook denies a call with `hookSpecificOutput.permissionDecision: "deny"`, and its matcher's `onFailure: "block"` blocks the call when the hook throws. The `sandbox` settings are about shell commands (`autoAllowBashIfSandboxed`, `allowUnsandboxedCommands`), so the guard checks the file tools. The SDK loads `CLAUDE.md` only when `settingSources` includes `"project"`. Its message union is large and grows; `claude-session.ts` parses only the fields it reads, with zod, and ignores the rest.
- pnpm 11 holds back versions newer than its minimum release age and offers to add them to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`. Pin an older version instead of accepting the exclusion.

## Store

All state the service needs after a restart lives in `@repo/core/store`, one SQLite file in write-ahead-logging mode at `$SUPERAGENT_DATA_DIR/state.db`.

- MUST: Settle every event. The gate or the message handler sets its disposition once it has acted; an event left `received` is unfinished and gets retried after a restart.
- MUST: Set a disposition only after the work it records, so a crash in between leaves the event unfinished instead of lost.
- MUST: Change a task's state only through `store.tasks.transition`. `TASK_TRANSITIONS` is the one state machine; an illegal move throws.
- MUST: Never edit a migration that has shipped. Add a new one to the end of `MIGRATIONS`.
- MUST: Keep transactions synchronous and short. `store.transaction` refuses async work, and the whole store is synchronous.
- NEVER: open the same store from two processes, or keep it on a network filesystem. `openStore` refuses to run unless SQLite really switched to write-ahead logging.
- MUST: Every Slack post and reaction goes through `store.outbox`. Only the outbox sender calls `SlackGateway.post` or `react`.
- MUST: Queue an outbox entry in the same transaction as the event disposition or row change that caused it, with a dedupe key built from that cause (`reply:<event_id>`, `report:<report_id>`), so handling the same thing twice queues one post.
- MUST: Keep message handling safe to run twice. Restart recovery replays every event still `received`, so a handler, and any decision, must give the same result when it sees an event it may already have half-handled.
- MUST: Take the recovery snapshot (`takeRecoverySnapshot`) before connecting to Slack, and recover only from it. Once connected, live events are recorded, including the bot's own posts echoed back by Slack. An event the live gate is still handling is also `received`, so replaying it would handle it twice, and any newer event moves a conversation's latest ts past the messages catch-up has to read.
- MUST: Feed anything read back from Slack history through the gate (`SlackGateway.catchUp`), never straight to the handler. The gate's per-message claim is what stops a caught-up message from being handled again when its live event was already handled.

## Tasks

Each task is one Claude Code session at a time, run through the Agent SDK in the task's own worktree on `agent/<task id>`. The runner (`@repo/core/tasks`) is the only thing that starts, feeds, or ends sessions.

- MUST: Reach a worker only through rows. A handler adds an input (`store.inputs`) or changes the task's state and wakes the runner; it never touches a session.
- An input is delivered when the runner sends it into a session, and read when a turn's result lists its prompt. A session started or resumed gets every unread input, so nothing sent before a crash is lost; it may see one twice.
- A worker has five tools, on the in-process `superagent` MCP server: `ack` puts 👀 on the Slack messages it was given and hasn't finished, `read_thread` reads the task's thread, `report` posts where the task stands, `hand_back` gives the router a message that isn't about the task, and `nothing_to_report` ends a turn that only handed messages back. Nothing reacts to or answers the owner until the worker does.
- MUST: Show a worker only the owner's messages and the bot's own. `read_thread` leaves out everyone else's, since the owner gate is the only access control and workers run unattended.
- MUST: Post what a worker says only through `recordReport`. It turns down a report for a task that isn't `running`, which is what keeps a stopped task quiet.
- A task that has reported goes back to `running` when its session ends a turn with another one queued (a follow-up arrived before the report) or when its worker reports again (a follow-up was folded in after the report). A `stopped` task never goes back this way; only the owner's next message, through a new launch, resumes it.
- A turn that ends idle without a report posts the worker's last message and waits on the owner, unless the worker called `nothing_to_report` in that turn: then the task quietly returns to its last reported state. The runner accepts `nothing_to_report` only in a turn that handed a message back, for a task that has reported before. It doesn't guess from turn timing whether anything is left unanswered, since the SDK doesn't say when within a turn a folded-in message was read; a turn that fails, a session that ends early, or a launch that fails marks the task `failed`. The owner's next message in the thread resumes it.
- The owner stops a task with `stop` alone in its thread, or 🛑 on its first message or one of the owner's messages there. Stopping drops every input the worker hadn't read, in the handler's transaction, and marks the task `stopped` when its state allows. A `done`, `failed`, or `blocked` task keeps its state, but a retry still waiting for a session slot is cancelled. The runner then interrupts any live session. The branch and worktree stay.
- Restart recovery catches up the threads of open tasks and of tasks that ended in the last seven days (`RECOVERY_ENDED_TASK_WINDOW_MS`), since a reply can resume an ended task and channel history doesn't include thread replies.
- `git fetch origin <branch>` updates `origin/<branch>` only when the remote's fetch refspec covers it, which a single-branch or shallow clone's doesn't, and two fetches in one checkout at once fail on the ref lock. `prepareWorktree` fetches into an explicit `refs/remotes/origin/<branch>` and runs one checkout's git commands one at a time.
- Workers run in `dontAsk` mode with an allowlist of working tools, so no tool waits on a person. They load only those built-in tools (`WORKER_BUILT_IN_TOOLS`) and only the `superagent` MCP server (`strictMcpConfig`), so neither a repo's `.mcp.json` nor the machine's claude.ai connectors reach them. `SUPERAGENT_DATA_DIR` is refused inside a `.claude` directory, where workers couldn't edit files. `worker-guard.ts` refuses merges, approvals, closing issues, force pushes, pushes to the base branch, file writes outside the worktree and its checkout's `.git`, reads of credential files, and searches whose root holds them. It checks real paths, after symlinks, including credential directories that are themselves links.
- The guard splits a shell command into the words of each command it runs (`utils/split-shell-commands.ts`, including `sh -c`, `$(…)`, and subshells), so a quoted PR body or commit message that mentions `gh pr merge` passes. It checks every word of each command, so a keyword or wrapper in front (`if`, `env -i`, `xargs`) doesn't hide one, and an unquoted mention such as `echo gh pr merge` is refused. It is still a guard rail, not a boundary: a command it can't see into, such as one built in a variable, gets past it. Bash can still reach whatever the service's user can, unless `SUPERAGENT_WORKER_SANDBOX=on` runs shell commands in Claude Code's sandbox, with writes limited to the worktree and the checkout's `.git` and network limited to GitHub and package registries. Run the service where that is acceptable, such as its own container or machine.
- MUST: Pass workers only the environment they need. `claude-session.ts` keeps an allowlist (`WORKER_ENVIRONMENT_NAMES` and its prefixes): add a variable there, never pass the whole environment. It also sets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`: the runner ends a session whose turn goes idle, so a command a worker backgrounded would never finish.
- MUST: Act on GitHub as superagent's own account when it has one, never the owner's. With `SUPERAGENT_GITHUB_TOKEN`, `agentAccountEnvironment` gives workers the agent's `GH_TOKEN`, a git credential helper that answers with it (after an empty `credential.helper` that drops the machine's own), `insteadOf` rewrites so SSH remotes for GitHub push over https, and the agent as commit author. Startup refuses a token that belongs to `SUPERAGENT_OWNER_GITHUB`.
- NEVER: start a real Claude Code session in tests. Pass a fake `StartConversation` to `createClaudeSessionStarter`, or a fake `StartWorkerSession` to `createTaskRunner`.

## Router

Every owner message no task owns, a DM or a mention outside a task's thread, is a candidate for the router (`@repo/core/router`): one Claude session that only routes.

- MUST: Give every candidate exactly one decision, through the functions in `decide.ts`. Each records the decision, writes its rows, and settles the event in one transaction, and refuses a candidate already decided.
- MUST: Keep the router to routing. Its session has no built-in tools, no MCP server but its own (`strictMcpConfig`), loads no settings files, and is allowed only the routing tools. Never give it a tool that reads code or runs commands; the worker owns the work.
- `ignore` still answers with a reaction (`ROUTER_IGNORE_REACTIONS`, queued as `ignore:<event_id>`), so no message the owner sends goes unacknowledged.
- When the router doesn't decide a candidate (its turn goes idle, its session fails or can't start, or the candidate waits past `ROUTER_DECISION_TIMEOUT_MS`), the channel map decides it, recorded as `decidedBy: "fallback"`.
- The handler leaves a candidate's event `received` until a decision settles it. Restart recovery replays it, and queuing it again is a no-op.
- MUST: When a task takes over a thread, pass it the candidates still waiting there, in the same transaction (`decideStartTask` does). Otherwise a replay after a restart gives the waiting message to the task as a follow-up while its candidate is still routed.
- A worker sees each Slack message as `[message N]`, the input's ID. Its `hand_back` names one and queues it as a new candidate naming the task and why, once per task. The task's first input, its request, can't be handed back. The worker doesn't report about a message it handed back, since the router answers it; when that was all the turn had to do, it calls `nothing_to_report`. The router never attaches it back to that task, and no task can start in that task's thread, so a new request there gets a reply asking for a new message.
- `SUPERAGENT_ROUTER=off` runs the router without a session: the channel map decides every candidate as soon as it's queued.

## Slack

- MUST: Ack every payload. Bolt acks events up front; never add `processBeforeResponse` or work that delays the ack. A payload the gate drops is acked by the gate, because no listener will see it.
- MUST: Register new listeners on the App that `registerInbound` gates. Never create a second App or add a path around the gate.
- MUST: A new event subscription or OAuth scope updates `packages/core/slack-app-manifest.json` in the same change.
- NEVER: real tokens or calls to Slack in tests.
- NEVER: connect a development process with the running bot's app token. Socket Mode spreads an app's events across all of its connections, so the second process silently takes some of the real bot's messages.

## Testing

Tests sit next to the code they cover, as `*.test.ts`. The framework is Vitest.

- Drive Bolt through `app.processEvent({ body, ack })` with a no-op `Receiver` and `botId` / `botUserId` set, as `inbound.test.ts` does, instead of mocking Bolt.
- When adding a guard, confirm that some test fails once the guard is removed.

Run checks always before committing with:

```bash
pnpm format
pnpm lint
pnpm typecheck
pnpm test
```

## Tooling gotchas

- pnpm's `node_modules/.bin` wrappers export a `NODE_PATH` that reaches into `node_modules/.pnpm/node_modules`, which hides module-resolution bugs that editors hit when they load ESLint in-process. After changing ESLint or Babel config, also run ESLint without the wrapper, from the package directory: `node node_modules/eslint/bin/eslint.js .`.
- pnpm 11 can reconcile `node_modules` and rewrite `pnpm-lock.yaml` before running `pnpm exec`. Review lockfile changes you did not intend and commit them on their own.
- The shared ESLint config parses TypeScript with Babel, which cannot see type-only bindings. `no-undef` and `no-unused-vars` are off for `.ts`, and `tsc` covers both with `noUnusedLocals` and `noUnusedParameters`. New packages copy `packages/core/eslint.config.mjs` and those tsconfig options.

## Git and authorization

- MUST: Never push to `main`, force-push, or merge a pull request without fresh, explicit user confirmation for that exact action.
- MUST: Write commits as Conventional Commits, `type(scope): summary`, scoped to the workspace you touched (`core`, `eslint-config`, `typescript-config`, or `repo` for the root). Branches are `type/short-description`. `CONTRIBUTING.md` has the full process.
- MUST: Never commit a token or `superagent.config.ts`. `.env`, `.env.local`, and `superagent.config.ts` are git-ignored.
- Nothing is published to npm, so there is no release process to authorize.

## Reference reading

- `CONTRIBUTING.md`: setup, a Slack app of your own, and the pull request process
- `docs/ROADMAP.md`: what is built, the milestones left, and what superagent leaves out of dsh-superagent on purpose
- `packages/core/README.md`: what `@repo/core/slack` lets through and why
- `node_modules/turbo/docs/`: Turborepo docs matching the installed version (see the block at the top)
- `packages/core/node_modules/@slack/bolt/dist/`: Bolt 5 source and types
