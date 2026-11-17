# Roadmap

superagent is a Slack, multi-repo take on DeepSeek's [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype) prototype, which is a single-repo agent for GitHub and Feishu. This file says what is built, what is left, and what we deliberately leave out.

## How dsh-superagent works

- **Flow:** a Source (GitHub, Feishu) emits Triggers. A gate and an assessment judge them. Accepted work becomes a Ticket, an Assignment hands it to a worker, and results go back to the original conversation.
- **Two kinds of model session:** a router ("main Session") that only routes: accept, attach to a Ticket, stop, or ignore. It never reads code or adds requirements. And one worker per Ticket, each with its own directory and branch.
- **Workers report internally, and the router writes what people see.** Chat messages are one sentence by default, 100 words at most. The principle: take as little human attention as possible.
- **Follow-ups belong to the worker.** A person's message in a Ticket's thread goes straight to its worker, which hands back what is beyond its scope. A reply resumes an ended Ticket unless a person stopped it.
- **The pull request is part of the Ticket.** Review comments and CI reach the worker, and a merge or close ends the Ticket with one chat notice. CI and bots never wake an ended Ticket.
- **Proactive work** runs only under written rules, starting in an observe mode that records what it would have done.
- **Reliability:** durable side effects with ordered retries, idempotent intake, tracking of which inputs a worker read, and a recovery note after a restart.
- **Security:** workers run with full access as the operator's user. The project says its account wrappers are not isolation, and recommends a dedicated OS account.

## Where we are

| Capability                                                | dsh-superagent                                                             | superagent                                                                                                  | Status                                                                  |
| --------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Intake: dedupe, own-message drop, read position, catch-up | GitHub and Feishu                                                          | Slack, and pull requests through the watcher                                                                | Done                                                                    |
| Who may ask                                               | Allowed lists, admission table, bot lists, mandates                        | The owner gate                                                                                              | Done; the rest left out on purpose                                      |
| Deciding new work                                         | Router session                                                             | A router session; the channel → repo map as its fallback                                                    | Done; smoke-tested live in Slack on 2026-11-07                          |
| Ticket lifecycle: resume, stop, one state machine         | ✓                                                                          | Task states, resume on reply, `stop` or 🛑                                                                  | Done                                                                    |
| A worker per Ticket: session and directory                | ✓                                                                          | Agent SDK session and worktree on `agent/<id>`                                                              | Done, across several repos                                              |
| Inputs delivered and read, redelivery after a restart     | ✓                                                                          | ✓                                                                                                           | Done                                                                    |
| Restart recovery                                          | ✓                                                                          | Snapshot, replay, catch-up, resume with a restart note                                                      | Done                                                                    |
| Durable, ordered posts                                    | ✓                                                                          | The outbox                                                                                                  | Done                                                                    |
| Acknowledgement                                           | One specific sentence                                                      | 👀 when the worker calls `ack`, ✅ (👍 on GitHub) once its turn ends; a reaction when the router lets it be | Done, as a reaction by choice                                           |
| Reports                                                   | progress, ready, blocked, failed, dropped; a question apart from the state | waiting, ready, done, blocked, failed                                                                       | Partial: no internal progress, no silent drop, a question ends the turn |
| Thread context                                            | ✓                                                                          | `read_thread`, the owner's and the bot's messages                                                           | Done                                                                    |
| Handing a follow-up back                                  | ✓                                                                          | `hand_back`, decided by the router; `nothing_to_report` (#15)                                               | Done; smoke-tested live in Slack                                        |
| The PR follows the Ticket: CI, reviews, merge ends it     | ✓                                                                          | The pull request watcher, as superagent's own account, answering on GitHub                                  | Done in #16; smoke-tested live                                          |
| Retrying passing model and network failures               | Three times with backoff                                                   | The task fails and a reply retries it                                                                       | M5                                                                      |
| A slot kept for a person's follow-up                      | ✓                                                                          | A cap of three, oldest first                                                                                | M5                                                                      |
| Never merging as the agent                                | ✓                                                                          | Instructions and a guard that refuses merges                                                                | Done                                                                    |
| Team prompt sections                                      | ✓                                                                          | The repo's `CLAUDE.md` and fixed instructions                                                               | M5                                                                      |
| Panel, pause                                              | ✓                                                                          | The router's `list_tasks` answers "what's waiting on me?"                                                   | Status done in #13; pause in M5; the panel left out                     |
| Proactive rules                                           | ✓                                                                          | —                                                                                                           | M6                                                                      |
| Isolation                                                 | Full access, a dedicated OS user                                           | `dontAsk`, a tool allowlist, a guard, an environment allowlist; the sandbox is opt-in                       | Done; the sandbox tried on macOS (#19); container in M5                 |

Known risks:

- The smoke test ran in Slack on 2026-11-07, against a scratch repo with a Slack app of its own. It passed every M2 and M3 check (below). It also found what #15 fixes:
  - sessions loaded every built-in tool and the machine's claude.ai connectors;
  - `.claude` directories refuse workers' edits;
  - long commands went to the background, and the task stalled;
  - an owner ID set to the bot's own was silently ignored;
  - hand-back turns posted filler, and ignored messages got no sign they were read.
- Still unexercised:
  - another person's message in a task thread, which needs a second Slack user;
  - `nothing_to_report` in Slack;
  - a Greptile summary edit reaching the worker (an owner's edit did, live);
  - one reply per pull request comment since the guard refuses the worker's own (live, the worker had answered twice before it);
  - a merge during a worker's turn, which interrupts it.
- The router follows its instructions loosely at times. In a resumed session it ignored a repeated question despite the rule to answer again. An ignored message still gets a reaction (#15).
- Claude Code keeps session transcripts under `~/.claude`. In a container they must live on the volume, or resuming a task breaks after a restart.
- Without `SUPERAGENT_GITHUB_TOKEN`, pull requests open as your own GitHub account, GitHub doesn't let you approve your own PR, and pull requests aren't watched.
- Until #19, the agent's commits were signed with the owner's GPG key, since the machine's git config signs commits. They read as signed by a key unknown to the agent account.
- The worker's summary posts as it wrote it, in Slack or on the pull request. The length limit is an instruction, not enforced.
- Greptile rewrites its summary after every push, and each rewrite uses one of a bot's three rounds on that pull request. After about three pushes, Greptile's new findings are dropped there.
- When Greptile re-scores a pull request and nothing needs doing, the worker still posts a one-line comment saying so.

## Milestones

The order: M2's last checks (the sandbox and a second run), then M5 and M6.

### M1 — Foundation (done)

The Slack gateway and owner gate, channel → repo routing, the SQLite store, the outbox, and restart recovery.

### M2 — Finish the worker loop (smoke-tested; the sandbox tried; a second run left)

Done: the task runner, worktrees, the `ack`, `read_thread`, and `report` tools, follow-ups into live sessions, resume after a restart, `stop`, thread replies without a mention, stop by 🛑, and locked-down workers (`dontAsk`, the tool allowlist, the guard, the environment allowlist, and the instructions).

Left:

- **The Slack smoke test passed on 2026-11-07:**
  - a mention led to 👀, a PR, and the ready post;
  - a follow-up sent mid-turn went into the same PR;
  - `stop` stopped a task and kept its branch;
  - a restart mid-task resumed it, caught up a message sent while the bot was down, and dropped Slack's late duplicate of it;
  - DMs were answered.

  #15 fixes what it found.

- **Checked on 2026-11-08:** the bot finds its own earlier posts by their metadata. `findOwnPost`, run against real Slack, found 8 of 8 recent posts at the ts the outbox recorded, and nothing for a made-up key. Every post is a thread reply, so the thread lookup is the one that runs.
- **Still to check:** that another person's message in a task thread never reaches the worker, which needs a second Slack user.
- **The sandbox, tried on 2026-11-08** on macOS, with a real worker session through `createClaudeSessionStarter` in a fresh worktree of the scratch repo:
  - it holds: a write to the home directory and a request to a host off the allowlist were refused;
  - worktree writes, `git ls-remote`, and `git push --dry-run` over https with the agent's token work;
  - `git commit` failed because the machine signs commits with the owner's key, and `npm install` couldn't write its cache in `~/.npm`. #19 fixes both: the agent's commits are unsigned, and package managers cache in `$SUPERAGENT_DATA_DIR/cache`, which the sandbox lets workers write;
  - `gh` can't verify TLS inside it on macOS, since Go asks `trustd`, which the sandbox blocks. With `enableWeakerNetworkIsolation` it works (tried), at the cost in open decision 2.

  It stays opt-in until that decision. On Linux `gh` reads certificates from files, so the container in M5 shouldn't need it.

- **Done when:** the smoke test passes twice in a row; no one else's thread message reaches a worker; a sandboxed worker can't write outside its worktree or merge. The last holds: the trial's write outside was refused, and the guard refuses merges, sandbox or not.

### M3 — Router (done)

Done in #13: the candidates and decisions tables, the decision functions with the channel-map fallback, the router session and its loop, the handler handing every new message to it, the worker's `hand_back` tool, `SUPERAGENT_ROUTER`, and repo descriptions. The Slack smoke test on 2026-11-07 passed every "done when" check below. #15 adds `nothing_to_report`, a reaction on messages the router lets be, and a rule to answer a repeated question again.

- **A long-lived router session:** its ID kept in the store, low effort, and only routing tools: no shell and no file reads.
- **It sees** every owner message no task owns: DMs, mentions outside task threads, and hand-backs. Each comes with the channel's repo, the thread, and related tasks.
- **Its tools:**
  - `start_task(repo, title)`: idempotent per Slack event; the channel map becomes a default, not a rule;
  - `reply(text)`: a short answer or one question;
  - `attach(task_id)`: only when the message points at a task explicitly;
  - `stop(task_id)`;
  - `ignore`, which lets a message be, with a reaction;
  - `list_tasks`, which answers "what's waiting on me?" in place of a panel.
- **A worker `hand_back(message_id, reason)` tool** for a follow-up that isn't about its task. Each Slack message reaches the worker labeled `[message N]`, and the worker names the one it hands back.
- **A `description` for each repo** in `superagent.config.ts`, so the router can choose.
- **A `decisions` table** recording why each message went where. M6 uses it too.
- **If the router fails,** a mapped channel still routes by the map.
- **Done when:**
  - "fix X in repo Y" by DM starts a task in Y;
  - an ambiguous DM gets one question;
  - an off-topic reply in a task's thread is handed back and routed;
  - the router keeps its session across restarts.

### M4 — Pull request feedback (done)

Done in #16: the agent account, the watcher, the ownership checks, merge and close, the review instructions, the guard covering `gh api`, answering on GitHub, and done reactions. The live run on 2026-11-08, in a scratch repo with CI and Greptile, passed three of the four "done when" checks below:

- a pull request opened and committed to as `pakgin-agent`; its failing CI run was fixed about 40 seconds after the failure, with no Slack message;
- the owner's review comment was fixed, and its thread resolved, by `pakgin-agent`;
- the merge posted once and closed the task.

A stranger's comment being ignored needs a third GitHub account, so only the unit tests cover it.

The same day it also showed, live:

- an owner's pull request comment answered on the pull request, with 👀 and then 👍, and nothing in Slack;
- a Slack message answered in Slack, with 👀 and then ✅;
- an owner's edited comment reaching the worker as an edit.

Live runs and Greptile's review of #16 led to these, all in #16:

- the worker answered pull request comments twice, its own `gh pr comment` and its report, so the guard refuses its own comments on the task's pull request;
- a merge during a worker's turn could be undone by its next report, so a closed task carries a `closed_at` mark that no session can clear, and the runner interrupts the session;
- CI that starts late or is rerun on the same commit went unseen, so an unchanged head's checks are read again every five minutes;
- comment edits are tracked per comment, every GitHub list is read to the end, and a closed pull request is settled without reading its lists.

- **The agent's own GitHub account, first.** Workers push, open pull requests, comment, and resolve review threads as the agent account, never as the owner, so the owner can review and approve its work and M4 can tell their comments from the agent's.
  - `.env` gets `SUPERAGENT_GITHUB_TOKEN`, a token for the agent account, and `SUPERAGENT_OWNER_GITHUB`, the owner's GitHub login.
  - At startup the bot asks GitHub whose token it is, and refuses to start if it's the owner's.
  - Workers get the token as `GH_TOKEN`. Git pushes to GitHub over https with that token, even where a remote is SSH, and commits are authored as the agent.
  - The agent account needs write access to each repo in the config.
- **Poll every 60 seconds** for each task with an open PR: its state, reviews, review comments, comments, and the checks on its head commit. A read position per PR is kept in `kv`.
- **A PR is the task's** only when it's in the task's repo and its branch is `agent/<task id>`. The repo is checked when the worker reports the URL, which turns down a PR in another repo and tells the worker why. The branch is checked on the first poll, and a PR off it, or from a fork, is left alone, and the owner is told once.
- **Whose words count:** only the owner's (`SUPERAGENT_OWNER_GITHUB`) and installed bots', such as automated reviewers and CI. Other people's comments are dropped, as other people's Slack messages are: it's the owner gate on GitHub, and it keeps a stranger's comment on a public repo from steering a worker. The agent's own comments are dropped too.
- **What wakes the worker:**
  - the owner's reviews and comments, and failed checks on the head commit, become inputs that wake the task;
  - passing checks are recorded only;
  - automated reviewers get at most three rounds per PR;
  - CI and bots never wake a failed or stopped task. The owner's comments do, as their Slack replies do.
- **A merge or a close** posts once in the Slack thread, ends any live session, and moves the task to done from any state. A later reply still resumes it.
- **Review instructions:** fix and resolve quietly, decline with one sentence on the comment, push, report ready again, and never merge.
- **Edits count:** a comment edited after it was read reaches the worker again, as an edit, such as Greptile's summary, which it rewrites in place after each review.
- **Answer where it was asked:** 👀 on a GitHub comment the worker starts on, 👍 once its turn ends (✅ in Slack), and the report on `[github]` messages posted as a pull request comment, not in Slack. The runner picks where a report goes from the messages it answers, and the outbox makes the GitHub writes, so they are durable, ordered, and posted once.
- **Done when:**
  - a failing CI run is fixed without anyone writing in Slack;
  - the owner's review comment is fixed, and its thread resolved, by the agent account;
  - another person's comment is ignored;
  - a merge posts once and closes the task.

### M5 — Deploy and harden

- **Mirrors:** a repo's `path` becomes optional, and the repo is cloned into `/data/mirrors` for worktrees.
- **Docker Compose:**
  - Node 24, git, and `gh`, running as a non-root user;
  - a `/data` volume for the store, mirrors, worktrees, and `CLAUDE_CONFIG_DIR`;
  - secrets in an env file.
- **Automatic retries** for API overload, 429s, 5xx errors, and network errors: up to three "go on" turns with backoff before failing the task.
- **A session slot kept** for the owner's follow-ups.
- **Worktree cleanup** seven days after a task ends; branches stay.
- **Per-repo instructions in the config,** such as delivery and scope rules, added to the worker's prompt.
- **A pause switch,** if it earns its place. Status questions already go to the router's `list_tasks` (M3).
- **Done when:** `docker compose up` runs on the server, a container restart resumes a running task, and the logs show no secrets.

### M6 — Proactive rules

- **Rules in the config,** each with a name, an instruction, and a mode: off, observe, or auto.
- **Candidates:** new issues, CI failures on the default branch, and, if wanted, the owner's unaddressed messages in mapped channels.
- **The router judges** each candidate against every enabled rule and records the decision with its evidence. Observe mode only records what it would accept, sent as one daily DM digest.
- **Auto mode** starts tasks limited to the matched rule. Such a task can end silently when there is nothing to do.
- **Done when:** a week of observe-mode decisions reads right, and turning one rule to auto starts tasks only for matching events.

## Left out on purpose

- Multi-user policy: allowed lists, admission tables, bot lists, and mandates and their revalidation. superagent has one owner.
- The web panel. Slack is the interface.
- Feishu.
- Versioned prompt editing in a UI.
- Correlation between threads.

## Open decisions

1. Should the router rewrite worker reports into short Slack messages, as dsh-superagent does, or should workers keep posting directly? Leaning: post directly, with a hard length cap.
2. The worker sandbox on macOS as well, or only in the Linux container? On macOS, workers need `enableWeakerNetworkIsolation` for `gh`, which opens `trustd` to sandboxed commands, a path the SDK warns could carry data out. Leaning: turn it on with the sandbox on macOS, since a sandbox with that gap still beats none, and rely on the container in M5.
3. A word limit on posts, like dsh-superagent's 100?

Decided: superagent gets its own GitHub account, as the first step of M4.
