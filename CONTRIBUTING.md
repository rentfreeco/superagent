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

### Environment variables

Nothing reads environment variables yet: `SlackGateway.connect` in `@repo/core/slack` takes the two tokens and the owner ID as arguments. Keep the values in a `.env` or `.env.local` file, both of which are git-ignored, and never commit a token.

### Repository layout

| Path                         | What it is                                                            |
| ---------------------------- | --------------------------------------------------------------------- |
| `packages/core`              | `@repo/core`: the service's core logic, one module per subpath export |
| `packages/eslint-config`     | shared ESLint configuration                                           |
| `packages/typescript-config` | shared `tsconfig` bases                                               |

The first `core` module is `@repo/core/slack`, the bot's Socket Mode connection; `packages/core/README.md` describes what it lets through. `apps/*` is part of the workspace but empty for now.

Internal packages are named `@repo/<name>`, export their TypeScript source directly, and have no build step. Consumers depend on them with `"@repo/<name>": "workspace:*"`.

Node 24 runs that source as it is, by stripping the types, so `@repo/core` sticks to what type stripping allows:

- Relative imports name the `.ts` file: `import { Deduper } from "./dedupe.ts"`.
- Only erasable TypeScript syntax: no `enum`, no `namespace`, no constructor parameter properties. The `erasableSyntaxOnly` compiler option enforces this.
- Type-only imports use `import type`, which `verbatimModuleSyntax` enforces.

### Everyday commands

From the root, Turborepo runs a task across every workspace that defines it:

```sh
pnpm lint         # eslint across the repo
pnpm typecheck  # tsc across the repo
pnpm test         # vitest across the repo
pnpm format       # prettier --write on ts, tsx and md files
```

`pnpm dev` and `pnpm build` exist as well, but no workspace defines those tasks yet.

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
