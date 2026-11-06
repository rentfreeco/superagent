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

| Capability                                                | dsh-superagent                                                             | superagent                                             | Status                                                                  |
| --------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| Intake: dedupe, own-message drop, read position, catch-up | GitHub and Feishu                                                          | Slack                                                  | Done for Slack; GitHub in M4                                            |
| Who may ask                                               | Allowed lists, admission table, bot lists, mandates                        | The owner gate                                         | Done; the rest left out on purpose                                      |
| Deciding new work                                         | Router session                                                             | Channel → repo map                                     | M3                                                                      |
| Ticket lifecycle: resume, stop, one state machine         | ✓                                                                          | Task states, resume on reply, `stop`                   | Done; 🛑 in M2                                                          |
| A worker per Ticket: session and directory                | ✓                                                                          | Agent SDK session and worktree on `agent/<id>`         | Done, across several repos                                              |
| Inputs delivered and read, redelivery after a restart     | ✓                                                                          | ✓                                                      | Done                                                                    |
| Restart recovery                                          | ✓                                                                          | Snapshot, replay, catch-up, resume with a restart note | Done                                                                    |
| Durable, ordered posts                                    | ✓                                                                          | The outbox                                             | Done                                                                    |
| Acknowledgement                                           | One specific sentence                                                      | 👀 when the worker calls `ack`                         | Done, as a reaction by choice                                           |
| Reports                                                   | progress, ready, blocked, failed, dropped; a question apart from the state | waiting, ready, done, blocked, failed                  | Partial: no internal progress, no silent drop, a question ends the turn |
| Thread context                                            | ✓                                                                          | `read_thread`, the owner's and the bot's messages      | Done                                                                    |
| Handing a follow-up back                                  | ✓                                                                          | —                                                      | M3                                                                      |
| The PR follows the Ticket: CI, reviews, merge ends it     | ✓                                                                          | —                                                      | M4                                                                      |
| Retrying passing model and network failures               | Three times with backoff                                                   | The task fails and a reply retries it                  | M5                                                                      |
| A slot kept for a person's follow-up                      | ✓                                                                          | A cap of three, oldest first                           | M5                                                                      |
| Never merging as the agent                                | ✓                                                                          | —                                                      | M2                                                                      |
| Team prompt sections                                      | ✓                                                                          | The repo's `CLAUDE.md` and fixed instructions          | M5                                                                      |
| Panel, pause                                              | ✓                                                                          | —                                                      | The panel is left out; a Slack `status` reply in M3                     |
| Proactive rules                                           | ✓                                                                          | —                                                      | M6                                                                      |
| Isolation                                                 | Full access, a dedicated OS user                                           | Permission checks off, no `SLACK_` variables           | M2 and M5                                                               |

Known risks:

- Nothing has run end to end against real Slack and a real Claude Code session yet.
- Claude Code keeps session transcripts under `~/.claude`. In a container they must live on the volume, or resuming a task breaks after a restart.
- Pull requests open as your own GitHub account, and GitHub does not let you approve your own PR.
- The worker's summary posts as it wrote it. The length limit is an instruction, not enforced.

## Milestones

The order to do them in: M2, then M4, M3, M5, and M6. The PR loop pays off sooner than the router while the channel map still works.

### M1 — Foundation (done)

The Slack gateway and owner gate, channel → repo routing, the SQLite store, the outbox, and restart recovery.

### M2 — Finish the worker loop (in progress)

Done so far: the task runner, worktrees, the `ack`, `read_thread`, and `report` tools, follow-ups into live sessions, resume after a restart, and `stop`.

- **A live smoke test** with a scratch repo and a Slack app of your own:
  - a mention, then 👀, a PR, and the ready post;
  - a follow-up mid-turn;
  - `stop`;
  - a restart mid-task;
  - a DM.

  It settles the two assumptions not yet checked: that the bot can find its own earlier posts by their metadata, and how the Agent SDK reports which prompts a turn read.

- **Thread replies without an @-mention:** subscribe to `message.channels` and `message.groups`. The owner's messages in a task's thread pass the gate unmentioned. Everyone else's are still dropped.
- **Stop by 🛑:** the `reaction_added` event and the `reactions:read` scope. The gate handles reaction events, and the stop path is the same as for the word.
- **Locked-down workers:**
  - the Agent SDK's `sandbox`, with writes limited to the worktree and temp, and network limited to a list;
  - `dontAsk` with a tool allowlist;
  - a pre-tool hook that refuses `gh pr merge`, auto-merge, force pushes, pushes to the base branch, and reads of credential files;
  - an environment allowlist in place of the `SLACK_` denylist.
- **Worker instructions:** never merge or close issues. The restart note asks the worker to check git, its branch, and its PR before repeating anything outside its worktree.
- **Done when:** the smoke test passes twice in a row; no one else's thread message reaches a worker; a sandboxed worker can't write outside its worktree or merge.

### M3 — Router

- **A long-lived router session:** its ID kept in the store, low effort, and only routing tools: no shell and no file reads.
- **It sees** every owner message no task owns: DMs, mentions outside task threads, and hand-backs. Each comes with the channel's repo, the thread, and related tasks.
- **Its tools:**
  - `start_task(repo, title)`: idempotent per Slack event; the channel map becomes a default, not a rule;
  - `reply(text)`: a short answer or one question;
  - `attach(task_id)`: only when the message points at a task explicitly;
  - `stop(task_id)`;
  - `list_tasks`, which answers "what's waiting on me?" in place of a panel.
- **A worker `hand_back(reason)` tool** for a follow-up that isn't about its task.
- **A `description` for each repo** in `superagent.config.ts`, so the router can choose.
- **A `decisions` table** recording why each message went where. M6 uses it too.
- **If the router fails,** a mapped channel still routes by the map.
- **Done when:**
  - "fix X in repo Y" by DM starts a task in Y;
  - an ambiguous DM gets one question;
  - an off-topic reply in a task's thread is handed back and routed;
  - the router keeps its session across restarts.

### M4 — Pull request feedback

- **Poll every 60 seconds** for each task with an open PR: its state, reviews, comments, and the checks on its head commit. A read position per PR is kept in `kv`.
- **A PR is the task's** only when its branch is `agent/<task id>` in the task's repo. This is checked when the worker reports the URL.
- **What wakes the worker:**
  - human reviews and comments, and failed checks, become inputs that wake a waiting or ready task;
  - passing checks are recorded only;
  - automated reviewers get at most three rounds per PR;
  - the agent's own comments are dropped;
  - CI and bots never wake a failed or stopped task.
- **A merge or a close** posts once in the Slack thread and moves the task to done. A later reply still resumes it.
- **Review instructions:** fix and resolve quietly, decline with one sentence, push, report ready again, and never merge.
- **Done when:** a failing CI run is fixed without anyone writing in Slack, and a merge posts once and closes the task.

### M5 — Deploy and harden

- **Mirrors:** a repo's `path` becomes optional, and the repo is cloned into `/data/mirrors` for worktrees.
- **Docker Compose:**
  - Node 24, git, and `gh`, running as a non-root user;
  - a `/data` volume for the store, mirrors, worktrees, and `CLAUDE_CONFIG_DIR`;
  - secrets in an env file.
- **A dedicated agent GitHub account,** so its PRs can be approved.
- **Automatic retries** for API overload, 429s, 5xx errors, and network errors: up to three "go on" turns with backoff before failing the task.
- **A session slot kept** for the owner's follow-ups.
- **Worktree cleanup** seven days after a task ends; branches stay.
- **Per-repo instructions in the config,** such as delivery and scope rules, added to the worker's prompt.
- **A `status` reply,** and a pause switch if it earns its place.
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
2. A dedicated GitHub agent account before M4?
3. The worker sandbox on macOS as well, or only in the Linux container?
4. A word limit on posts, like dsh-superagent's 100?
