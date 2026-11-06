# Contributing

👍🎉 First off, thanks for taking the time to contribute! 🎉👍

superagent follows the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) code of conduct. Please read it before taking part.

## What can you do for superagent?

Contributions come in many forms:

- Help others with their issues
  - Try to reproduce a reported bug
  - Ask the reporter for the exact message they sent the bot when it is missing
  - Point to the relevant code or share a workaround
- Open pull requests that fix bugs or implement features
- Improve the documentation, including this file
- Review open pull requests
- ...

## Issues

Before opening an issue, search the existing ones, including closed ones. If you can reproduce a problem that was closed, open a new issue and link the old one.

There are no issue templates yet, so please include:

- **For bugs:** what you did, what you expected, what happened instead, and the versions of Node, pnpm, and Claude Code (`claude --version`) involved. When the bug is in how the bot handled a request, add the message you sent and what it replied, with tokens and private details removed. A minimal reproduction, as a snippet or a branch, is the single most helpful thing you can add.
- **For feature requests:** the problem you are trying to solve, not only the solution you have in mind. That leaves room to find the best fit for the codebase.

Questions in the form of _how do I get superagent to ..._ are welcome in the issue tracker. Mark them as questions so they are not triaged as bugs.

## Planning and releases

superagent is early. There is no release cadence or milestone process yet, and nothing is published to npm: this repository is the service itself.

You talk to the bot in Slack. Each request becomes a task, worked on by its own Claude Code session in its own git worktree, and the results come back in the Slack thread as short replies and as GitHub pull requests. The architecture is borrowed from DeepSeek's super-agent, minus its multi-user permission machinery: superagent has a single owner and ignores everyone else. A change that adds users, roles, or permissions is out of scope unless an issue makes the case for it first.

For anything larger than a bug fix, open an issue describing the change before you start. That gives the design a chance to be discussed, and it keeps you from spending time on work that cannot be merged.

## Pull requests

1. Create a branch from `main` named `type/short-description`, for example `feat/repo-routing` or `fix/thread-pagination`. Keep each pull request focused on one change, and separate refactors from behavior changes.
2. Write commit messages in the [Conventional Commits](https://www.conventionalcommits.org/) form: `type(scope): summary`.
   - Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`.
   - Scope is the workspace you touched, without the `@repo/` prefix: `core`, `eslint-config`, `typescript-config`, or `repo` for changes at the root.
   - Examples: `chore(repo): remove ui package`, `feat(core): add slack module with Socket Mode gateway`.
3. Before pushing, run the full check from the repository root and make sure all of it passes:

   ```sh
   pnpm format
   pnpm lint
   pnpm typecheck
   pnpm test
   ```

   The Code Quality workflow (`.github/workflows/code-quality.yml`) runs `pnpm lint` and `pnpm typecheck` on every pull request and every push to `main`, so a red check there means one of those would have failed locally too. It does not run `pnpm format` or `pnpm test`; those are on you.

4. In the description, say what the change does and why. Link the issue it addresses. Call out anything a reviewer must know: a new Slack scope or event subscription, a new environment variable, a behavior change.
5. Pull requests are squash-merged, so the pull request title must itself be a valid conventional commit message.

## Development setup

### Prerequisites

- **Node.js 24 or newer**, as declared in the root `package.json`. With nvm: `nvm install 24 && nvm use 24`.
- **pnpm 11.25.0**, pinned through the `packageManager` field. Run `corepack enable` once and the `pnpm` command resolves to that version automatically.

A wrong Node version shows up as a crash mentioning `node:sqlite` the moment you run pnpm. pnpm 11 needs Node 22.13 or newer, and this repository needs 24.

### Install

```sh
pnpm install
```

If pnpm reports ignored build scripts, run `pnpm approve-builds` and allow the ones it lists.

A command run through pnpm 11, `pnpm exec` for one, can first bring `node_modules` and `pnpm-lock.yaml` in line with the workspace without asking. If a lockfile change turns up that you did not make, it is usually that: review it and commit it on its own.

### A Slack app of your own

Working on the Slack side needs a Slack app and a workspace to install it in. Create your own app rather than reusing the one the running bot uses: Socket Mode spreads an app's events across all of its open connections, so a second process on the same app quietly takes a share of the real bot's messages.

1. At [api.slack.com/apps](https://api.slack.com/apps), choose **Create New App → From a manifest** and paste `packages/core/slack-app-manifest.json`.
2. Under **Basic Information → App-Level Tokens**, create a token with the `connections:write` scope. That is the `xapp-` token.
3. Install the app to the workspace and copy the **Bot User OAuth Token** (`xoxb-`).
4. Copy your own member ID from your Slack profile (**⋯ → Copy member ID**). That user is the owner, the only one the bot listens to.

A change that needs a new scope or event updates the manifest in the same pull request. Existing apps pick it up once the manifest is pasted again and the app is reinstalled.

### Repo config

Which repo a request is about comes from the channel it is sent in. Copy `superagent.config.example.ts` to `superagent.config.ts`, which is git-ignored, and fill it in:

- `repos`: one entry per repo, with its GitHub `owner/name`, the path to a local git checkout (relative to the config file, or starting with `~`), its base branch, and optionally a `description` the router reads to tell repos apart.
- `channels`: Slack channel ID → repo name. Use the ID, not the channel name: open the channel, click its name, and copy the ID from the bottom of the **About** tab. Then invite the bot to the channel with `/invite @superagent`.

The config is validated when it loads, and a mistake stops startup with an error that names it: a misspelled key, a channel name in place of an ID, a channel pointing at a repo that isn't defined, or a path that isn't a git checkout. In a mapped channel, @-mention the bot. A DM, or a mention in an unmapped channel, gets a reply saying what to do instead.

### Claude Code and GitHub

Each task runs a Claude Code session through the Claude Agent SDK, in a worktree of the repo under `$SUPERAGENT_DATA_DIR/worktrees`. The machine running the bot needs:

- **Claude Code credentials:** a `claude` login on that machine, or `ANTHROPIC_API_KEY` in `apps/agent/.env`.
- **GitHub access:** `gh auth login`, and git able to push to each configured repo, since workers push their branch and open the pull request themselves.

Workers don't ask before acting. A guard refuses merges, force pushes, pushes to the base branch, writes outside the worktree, and credential reads, but their shell commands still run as your user unless `SUPERAGENT_WORKER_SANDBOX=on`. While developing, map your channel to a scratch repo rather than one you care about.

### Environment variables

The bot reads its settings from `apps/agent/.env`, which is git-ignored. Copy `apps/agent/.env.example` and fill it in:

| Variable                    | Value                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `SLACK_BOT_TOKEN`           | the Bot User OAuth Token, `xoxb-…`                                                               |
| `SLACK_APP_TOKEN`           | the app-level token with `connections:write`, `xapp-…`                                           |
| `SLACK_OWNER_ID`            | your member ID, `U…`                                                                             |
| `LOG_LEVEL`                 | optional: `debug`, `info` (the default), `warn`, or `error`                                      |
| `SUPERAGENT_DATA_DIR`       | optional: where the store and task worktrees live; `~/.superagent` by default                    |
| `ANTHROPIC_API_KEY`         | optional: Claude Code's credentials; unset uses your `claude` login                              |
| `SUPERAGENT_WORKER_SANDBOX` | optional: `on` runs workers' shell commands in Claude Code's sandbox; `off` by default           |
| `SUPERAGENT_ROUTER`         | optional: `off` routes every new message by the channel map, without the router; `on` by default |

The bot checks all of them at startup and stops with an error naming each one that is missing or malformed, such as the two tokens swapped. `LOG_LEVEL=debug` also logs every event the owner gate drops, which helps when the bot seems to ignore a message. Never commit a token.

### The store

Everything the bot must remember across a restart, from which Slack events it has handled to its tasks and what it still has to post, lives in one SQLite file: `$SUPERAGENT_DATA_DIR/state.db`, in write-ahead-logging mode. The bot creates the file and its directory on first start, and runs any pending migrations each time it starts.

- **Look inside while the bot runs:** `sqlite3 ~/.superagent/state.db`. Write-ahead logging lets a reader in alongside the bot, for example `select event_id, type, disposition from events order by received_at desc limit 20;` shows what the gate did with recent events, and `select dedupe_key, status, attempts, last_error from outbox where status != 'sent';` shows what the bot still has to post or gave up on.
- **Back it up:** `sqlite3 ~/.superagent/state.db ".backup state-backup.db"`. Copying `state.db` on its own while the bot runs can miss writes that are still in `state.db-wal`.
- **Start over:** stop the bot, then delete `state.db`, `state.db-wal`, and `state.db-shm`.

Restarting is safe. On start the bot sends anything still in the outbox, replays events it never finished, and catches up on what you sent while it was down: your DM, each mapped channel, and each open task's thread, from the last message it recorded there. A channel it has no record of yet is skipped, and the startup log says so.

Keep the store on a local disk, such as a Docker named volume, and run one bot per store. The bot refuses to start if SQLite can't switch the file to write-ahead logging, which happens on network filesystems.

### Repository layout

| Path                         | What it is                                                            |
| ---------------------------- | --------------------------------------------------------------------- |
| `apps/agent`                 | `agent`: the bot process, which wires `@repo/core` together           |
| `packages/core`              | `@repo/core`: the service's core logic, one module per subpath export |
| `packages/eslint-config`     | shared ESLint configuration                                           |
| `packages/typescript-config` | shared `tsconfig` bases                                               |

`@repo/core/slack` is the bot's Socket Mode connection, `@repo/core/repos` decides which repo a message belongs to, and `@repo/core/store` keeps the state that must survive a restart; `packages/core/README.md` describes all three. `apps/agent` reads the environment and the config, connects, and routes each message; `apps/agent/README.md` describes it.

Internal packages are named `@repo/<name>`, export their TypeScript source directly, and have no build step. Consumers depend on them with `"@repo/<name>": "workspace:*"`.

Node 24 runs that source as it is, by stripping the types, so `@repo/core` sticks to what type stripping allows:

- Relative imports name the `.ts` file: `import { postMessage } from "./delivery.ts"`.
- Only erasable TypeScript syntax: no `enum`, no `namespace`, no constructor parameter properties. The `erasableSyntaxOnly` compiler option enforces this.
- Type-only imports use `import type`, which `verbatimModuleSyntax` enforces.

### Everyday commands

From the root, Turborepo runs a task across every workspace that defines it:

```sh
pnpm dev          # run the bot, restarting it when a source file changes
pnpm lint         # eslint across the repo
pnpm typecheck    # tsc across the repo
pnpm test         # vitest across the repo
pnpm format       # prettier --write on ts, tsx and md files
```

`pnpm --filter agent start` runs the bot once, without watching. `pnpm build` exists as well, but no workspace defines a build yet.

To target one workspace, filter by its package name:

```sh
pnpm --filter @repo/core test
pnpm --filter @repo/core typecheck
```

### Tests

Tests use Vitest and sit next to the code they cover, as `*.test.ts`. When the real dependency is cheap to run, test against it instead of a mock: the slack tests feed event payloads through Bolt's own `processEvent` with a receiver that does nothing, so they check Bolt's actual ack and dispatch behavior. When you add a guard, such as a filter or a check, make sure some test fails once the guard is removed.

### Linting TypeScript

The shared ESLint config parses TypeScript with Babel, whose scope analysis cannot see type-only bindings, so `no-undef` and `no-unused-vars` flag every interface and type import. A package with `.ts` files lists them in its `eslint.config.mjs` and turns those two rules off for them, leaving both checks to `tsc` with `noUnusedLocals` and `noUnusedParameters` on. Copy `packages/core/eslint.config.mjs` and the matching options in its `tsconfig.json`.

### Adding a workspace package

Run `turbo gen workspace` or create the folder by hand. Either way the new package needs a `package.json` named `@repo/<name>` with `"type": "module"`, a `tsconfig.json` extending `@repo/typescript-config/base.json`, and an `exports` map pointing at its source files. Give it `lint` and `typecheck` scripts, plus `test` if it has tests, so the root commands pick it up. `packages/core` is the reference.

### Turborepo configuration

Before changing `turbo.json`, read the documentation bundled with the installed `turbo` package. `AGENTS.md` at the root explains how to find it, and the bundled docs match the installed version where online docs may not. Keep the managed block in `AGENTS.md` committed; `turbo` re-adds it otherwise.

## Using code from other authors

- Being inspired by someone else's work is fine. Copying their code, even part of a file, means the copy stays under the original author's copyright, with their license notice intact.
- Be transparent. When you implement an existing idea or algorithm, say so in the pull request and in a code comment, and reference where it came from. Be precise about whether you copied code or only followed the idea; phrases like "inspired by" are vague in copyright terms.
- That applies to DeepSeek's super-agent too. Following its design is fine; porting its code is copying, so check its license first and keep its notice.
- Check license compatibility before copying anything. MIT, BSD, and Apache-2.0 code can be included with attribution. Creative Commons BY-SA material cannot, and that includes Stack Overflow answers and Wikipedia. Re-implement those in your own words instead of pasting.
- A third-party file goes in with its license header untouched and a note in the pull request that it was added.

## AI-assisted contributions

Using an AI assistant to write code or docs is fine. You remain responsible for everything you submit: you must understand it, be able to explain it in review, and have run the checks above on it. Say so in the pull request when a substantial part of the change was generated, so reviewers know where to look harder. That includes pull requests superagent opens against this repository: whoever sent the request is responsible for the result.
