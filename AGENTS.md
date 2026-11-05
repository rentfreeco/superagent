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
                               repo path is a git checkout, return channel ID -> Repo
        route-message.ts       routeMessage: a mapped channel's repo, or the reply for a DM
                               or an unmapped channel
        index.ts               the module's public exports
      slack/                   @repo/core/slack: the bot's Socket Mode connection
        gateway.ts             SlackGateway: connect (auth.test, then Bolt App, then start),
                               fetchThread, post, react, findPost, classifyFailure, close
        inbound.ts             the global gate (record the event once, then self, then owner,
                               then handled types) and the DM / app_mention listeners that
                               claim the message and build InboundMessage; EventLog is the
                               interface the store's events table satisfies
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
        open-test-store.ts     an in-memory store with a settable clock, for tests
      outbox/                  @repo/core/outbox: turns outbox rows into Slack posts
        sender.ts              createOutboxSender: one pass at a time, woken on enqueue and
                               polled every second; checks before re-posting; stops cleanly
        index.ts               the module's public exports
      utils/                   small helpers, one per file
      constants.ts             magic numbers: SQLite busy timeout, outbox backoff and polling,
                               Slack delivery timeout, task IDs
    slack-app-manifest.json    the Slack app's events, scopes, and Socket Mode switch
  eslint-config/               PRIVATE  shared ESLint flat config (Babel parser for TS)
  typescript-config/           PRIVATE  shared tsconfig bases
apps/
  agent/                       the bot process; `pnpm dev` runs it with restarts on change
    src/
      main.ts                  startup: environment, config, store, then connect; disconnects
                               and closes the store on SIGINT / SIGTERM
      environment.ts           parseEnvironment: the Slack settings, LOG_LEVEL and
                               SUPERAGENT_DATA_DIR, checked with zod
      handle-message.ts        createMessageHandler: route, then in one transaction queue the
                               reply or call startTask, and settle the event
      acknowledge-task.ts      the stand-in startTask until a task runner exists
      constants.ts             CONFIG_PATH (superagent.config.ts at the repository root) and
                               STORE_FILE_NAME
    .env.example               the settings to copy into the git-ignored apps/agent/.env
superagent.config.example.ts   the committed example; the real superagent.config.ts is git-ignored
```

- MUST: Keep `@repo/core/slack` transport-only: it delivers `InboundMessage`s and reads threads. Repo selection, tasks, and Claude Code sessions belong in their own `core` modules.
- A task is keyed by `channel` + `threadTs`. `threadTs` is the thread root, so follow-ups in a thread land on the same task.
- MUST: Decide a request's repo with `routeMessage` before any work starts. A message with no repo gets the route's reply, never a guessed repo.
- MUST: Keep `apps/agent` to wiring: reading the environment, connecting, and passing messages to `core`. Logic that could be tested without a process belongs in `@repo/core`.
- New work for a routed request plugs in as a `StartTask` (`apps/agent/src/handle-message.ts`), replacing `acknowledgeTask`. A `StartTask` is synchronous and only writes rows, inside the handler's transaction; whatever acts on those rows runs in its own loop, as the outbox sender does. Its type returns `undefined`, so an `async` one doesn't compile, and the handler also rolls back if one returns a promise anyway.

## TypeScript and Node

Internal packages export their TypeScript source and have no build step. Node 24 runs it directly by stripping types, which sets hard limits on the syntax:

- ALWAYS: relative imports name the `.ts` file: `import { postMessage } from "./delivery.ts"`.
- ALWAYS: `import type` for type-only imports. `verbatimModuleSyntax` enforces it.
- NEVER: `enum`, `namespace`, or constructor parameter properties. `erasableSyntaxOnly` enforces it.
- `noUncheckedIndexedAccess` is on, so `array[0]` is `T | undefined`.

## Library versions newer than you know

Bolt 5.1, `@slack/web-api` 8.3, `@slack/types` 3.3, zod 4.6, Vitest 5.1, TypeScript 7.0, ESLint 10.9, Babel 8, and pnpm 11.25 may all differ from your training data. Read the installed source and `.d.ts` files before relying on a remembered API. Bolt is at `packages/core/node_modules/@slack/bolt/dist/`.

Verified against the installed versions:

- Bolt acks Events API payloads before global middleware runs (`App.js` → `processEvent`). Non-event payloads and `function_executed` events leave the ack to the listener.
- Passing `botId` and `botUserId` to `new App` skips Bolt's own `auth.test`.
- `context.userId` is the acting user for every payload type: `event.user`, `user.id` for actions, `user_id` for commands.
- `WebClient.paginate` returns untyped pages. Paginate the typed method with `cursor` instead.
- zod 4 reports a record key that fails its schema as a generic "Invalid key in record", dropping the key schema's message. Give the record an `error` function that handles `invalid_key`, as `repos/config.ts` does.
- `@babel/eslint-parser` 8 parses in a worker thread unless `babelOptions` sets both `babelrc: false` and `configFile: false`. The shared config sets neither, so its parser options must be structured-cloneable: a path string, never a function or an imported module.
- `node:sqlite` on Node 24.21 needs no flag, bundles SQLite 3.53, and has no transaction helper; `DatabaseSync.isTransaction` says whether one is open. Binding a named parameter the SQL doesn't use throws, so pass exactly the parameters a statement names. `INSERT … ON CONFLICT DO NOTHING RETURNING` returns no row for a conflict.
- A default `webApi.WebClient` retries for about 30 minutes (`tenRetriesInAboutThirtyMinutes`), waits out rate limits, and has no timeout. The gateway's delivery client sets `retryConfig: { retries: 0 }`, `rejectRateLimitedCalls: true`, and a 10-second timeout, so the outbox does the retrying. Its errors carry `code` (`webApi.ErrorCode`), and platform errors carry Slack's error string in `data.error`.

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
- `packages/core/README.md`: what `@repo/core/slack` lets through and why
- `node_modules/turbo/docs/`: Turborepo docs matching the installed version (see the block at the top)
- `packages/core/node_modules/@slack/bolt/dist/`: Bolt 5 source and types
