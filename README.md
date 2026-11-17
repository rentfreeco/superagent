# superagent

A personal coding agent you talk to in Slack. Each request becomes a task, worked on by its own Claude Code session in its own git worktree. Results come back in the Slack thread as short replies, and as GitHub pull requests the agent then follows through review and CI.

superagent is a single-owner, Slack, multi-repo take on DeepSeek's [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype), without its multi-user permission machinery. It listens to one person and ignores everyone else.

## How it works

- **The owner gate.** Every Slack event passes one gate. Only the owner's messages get through, each one once, even across reconnects and restarts.
- **The router.** A message no task owns, such as a DM or a mention outside a task's thread, goes to a router session that only routes. It starts a task in the repo the message is about, answers, asks one question, hands the message to a task it points at, stops a task, or lets it be. If the router can't decide, a channel → repo map does.
- **Workers.** Each task gets a Claude Code session in a worktree on `agent/<task id>`, locked down to a tool allowlist, with a guard that refuses merges, force pushes, and writes outside the worktree. A worker puts 👀 on your message, reports where the task stands, and swaps 👀 for ✅ when it's done. Replies in the thread go to the same worker; `stop` or 🛑 stops it.
- **Pull requests.** With an agent GitHub account of its own, superagent opens pull requests as that account, never as you. It watches each one: your reviews and comments, and failed checks, wake the worker, and it answers on GitHub. A merge or close ends the task.
- **Durability.** All state lives in one SQLite file. Every Slack post and GitHub write goes through an outbox with retries and dedupe keys, and a restart replays unfinished work and catches up on what you sent while it was down.

[`docs/ROADMAP.md`](docs/ROADMAP.md) compares it with dsh-superagent, says what is built, and lists what is left.

## Status

Early, and run by its owner for their own work. The foundation, the router, and pull request feedback are done and tested live; the worker sandbox and a second smoke run finish the worker loop. Next are a Docker deployment with automatic retries (M5), then proactive rules (M6). Nothing is published to npm: this repository is the service.

## What you need

- Node 24 and pnpm 11 (pinned through `packageManager`)
- A Slack workspace where you can install an app of your own, with Socket Mode
- Claude Code on the machine, logged in, or an `ANTHROPIC_API_KEY`
- `git`, and `gh` for pull requests; ideally a separate GitHub account for the agent, with write access to your repos
- A machine where unattended workers running as your user are acceptable, such as its own machine or container

## Quick start

```sh
pnpm install
cp apps/agent/.env.example apps/agent/.env       # Slack tokens, your member ID, the agent's GitHub token
cp superagent.config.example.ts superagent.config.ts   # your repos and channels
pnpm dev                                          # runs the bot, restarting on change
```

[`CONTRIBUTING.md`](CONTRIBUTING.md) walks through creating the Slack app, every setting, and the store. [`apps/agent/README.md`](apps/agent/README.md) describes what the running bot does.

## Repository layout

| Path                         | What it is                                                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/agent`                 | The bot process: reads its settings, connects to Slack, and wires the core modules together                                                                          |
| `packages/core`              | The service's logic, one module per subpath export: `repos`, `slack`, `store`, `github`, `outbox`, `recovery`, `router`, `tasks` ([README](packages/core/README.md)) |
| `packages/eslint-config`     | The shared ESLint flat config                                                                                                                                        |
| `packages/typescript-config` | The shared `tsconfig` base                                                                                                                                           |
| `docs/ROADMAP.md`            | Milestones, known risks, and open decisions                                                                                                                          |
| `AGENTS.md`                  | The rules and verified facts that coding agents, and people, follow when changing this repo                                                                          |

There is no build step. Node 24 runs the TypeScript source directly.

## Development

```sh
pnpm format      # prettier
pnpm lint        # eslint
pnpm typecheck   # tsc
pnpm test        # vitest
```

CI runs lint, typecheck, and the tests on every pull request. Contributions are welcome: see [`CONTRIBUTING.md`](CONTRIBUTING.md) for the process, and [`AGENTS.md`](AGENTS.md) for the conventions the code keeps.

## Safety

superagent's workers act without asking. The owner gate is its only access control, and the guard and tool allowlist are guard rails, not a boundary: a worker's shell commands run as the service's user unless the opt-in sandbox (`SUPERAGENT_WORKER_SANDBOX=on`) confines them. Run it where that is acceptable, map it to repos you're willing to let it change, and give it its own GitHub account so its work is reviewed as someone else's.
