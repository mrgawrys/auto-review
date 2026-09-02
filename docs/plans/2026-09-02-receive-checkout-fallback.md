# Receive Checkout Fallback Implementation Plan

> **To execute this plan:** use the `executing-plans` skill. It reviews the plan,
> then asks how you want it built — review at the end (delegated: one subagent
> builds it all, an independent review at the end), or review each task
> (inline: a diff per task for you to approve).

**Goal:** A receive run stops refusing a checkout that merely has unpushed
commits, and stops dead-ending when the checkout genuinely can't be used —
it works in a detached worktree docket makes at the PR head instead.

**Architecture:** `resolveCheckout` gains one discrimination and one fallback.
`git merge-base --is-ancestor` separates "unpushed commits on top of the PR
head" (usable in place) from "the reviewed commit isn't in this branch at all"
(not usable). Every unusable state — dirty, diverged, branch-exists-but-not-
checked-out — routes to a detached `git worktree add --detach` copy under the
state dir instead of a `skipped` entry. That copy is recorded on the entry as
`checkout_fallback`, which is what stops cleanup from deleting the author's own
branch and from throwing away a worktree the agent committed in.

**Tech Stack:** TypeScript on Bun, `bun test`, biome. Git subprocesses via
`Bun.spawnSync`. No new dependencies.

**Source:** `docs/specs/2026-09-02-receive-checkout-fallback-design.md`.

## Global Constraints

- `bun test` is fully mocked — no network, no tokens, no real `gh` or `claude`.
  New tests either build scratch git repos in temp dirs (`tests/checkout.test.ts`,
  the `scenario()` helper) or run through `tests/harness.ts`'s `makeSandbox()`.
  Keep it that way.
- No new config key, no new external binary, no new entry in the receive
  allowlist, no new claude plugin or skill. `src/doctor.ts` is therefore
  untouched — verified: it holds no checkout- or worktree-related check. A task
  that finds itself editing doctor means the design has drifted; stop.
- No TUI component tests (`CLAUDE.md`: TUI tests stay thin). The only
  TUI-visible change is one status-line string, and it is covered through
  `dismissKey` in `tests/list.test.ts`.
- Reason strings are user-visible, reach the agent's prompt, and are asserted
  verbatim in tests. Copy them exactly as written here.
- Every task ends green — `bun test` and `bun run format:check`, the repo's two
  CI jobs — and ends with a commit. Formatting fixes go through
  `bun run format` (biome), never by hand.
- The user's own checkout is never mutated on a path that decides it is
  unusable. No stash, no reset, no checkout in their working copy.

## Files touched

| File | Responsibility after this change |
| --- | --- |
| `src/checkout.ts` | ancestry discrimination + `fallbackWorktree`; owns `<checkoutsDir>/<slug>` |
| `src/state.ts` | `Entry.checkout_fallback` — the recorded shape |
| `src/receive.ts` | writes/clears that key; tells the agent it is detached |
| `src/reviewer.ts` | cleanup: never delete the author's branch, never bin a copy holding commits |
| `src/list.ts` | `dismissKey` renders a deliberate keep distinctly from a failure |
| `README.md`, `docs/configuration.md` | two statements that become false |

---

### Task 1: Split "ahead" from "diverged" in `resolveCheckout`

**Units:** `resolveCheckout` (`src/checkout.ts:44-113`) — the ahead test becomes
an ancestry test.

**Interacts:** nothing outside the module changes. Callers still see
`{ok: true}` / `{ok: false}`; only which inputs land in which arm moves.

**Signatures:** unchanged.

**Constraints:**

- Replace `git rev-list --count ${headSha}..HEAD` (`src/checkout.ts:71-74`) with
  `git merge-base --is-ancestor <headSha> HEAD`, run in `path`. Exit 0 means
  `headSha` is an ancestor of HEAD — the checkout holds everything the reviewer
  saw — so fall through to the existing `found.head !== headSha` branch.
- **Trap:** `merge-base --is-ancestor` exits **1** for "not an ancestor" and
  **128** for a bad object. Both are non-zero, so the module's habitual
  `if (!r.ok) return fail(...)` would turn every diverged checkout into a
  reported git error. Exit 1 is a verdict, not a failure. `git()` returns only
  `{ok, out, err}` — this task must reach the exit code: either widen
  `GitResult` with `code`, or add a small `isAncestor()` that spawns directly.
  Whichever you pick, Task 2 uses it again.
- The existing "PR head may be newer than anything fetched" guard
  (`cat-file -e` then `fetch origin <branch>`, `src/checkout.ts:64-69`) must
  still run **before** the ancestry test. `merge-base` cannot answer about an
  object that is not present.
- Leave the `found.head !== headSha` merge branch exactly as it is.
  `git merge --ff-only <ancestor>` is a no-op that exits 0 ("Already up to
  date") when strictly ahead, and it is what still fast-forwards the behind
  case. A "skip the merge when ahead" branch changes nothing and costs a branch.
- Non-ancestor still refuses **in this task** — Task 2 turns it into a fallback
  — with the new string `checkout diverged from PR head: ${path}`. The old
  `checkout ahead of PR head: ${path}` disappears entirely.
- Verified in a scratch repo: after an ordinary unpushed commit,
  `rev-list --count <prHead>..HEAD` is 1 and `--is-ancestor` exits 0; after an
  amend, the count is *also* 1 and `--is-ancestor` exits 1. The count cannot
  separate the two cases, which is the whole bug.

**Seams:** `resolveCheckout`, driven directly through `tests/checkout.test.ts`'s
existing `scenario()` / `resolve()` helpers.

**Done when:**

- `tests/checkout.test.ts:71` ("checkout ahead of the PR head blocks") is
  replaced by its inverse: a strictly-ahead checkout resolves
  `{ ok: true, path: <clone>, owned: false }`, and the local commit is still
  HEAD afterwards — nothing was reset, nothing was merged away.
- A new test: an amended (or rebased) checkout refuses with
  `checkout diverged from PR head: <path>`.
- The unchanged arms still pass untouched — clean, behind-then-fast-forward,
  dirty, exists-nowhere, absent.
- `bun test`, `bun run format:check`. Commit.

---

### Task 2: The detached fallback worktree

**Units:** `fallbackWorktree` (new, `src/checkout.ts`) — creates or reuses
docket's own detached copy at the PR head. `CheckoutResult`'s success arm gains
`fallback?`.

**Interacts:** `resolveCheckout`'s three unusable arms — dirty, diverged,
branch-exists-but-not-checked-out — return `fallbackWorktree(...)` instead of
`{ok: false}`. Nothing outside the module reads `fallback` yet; Task 3 does.

**Signatures:**

```ts
export type CheckoutResult =
  | {
      ok: true;
      path: string;
      owned: boolean;
      fallback?: { base: string; reason: string };
    }
  | { ok: false; reason: string };

function fallbackWorktree(
  clone: string,
  branch: string,
  headSha: string,
  checkoutsDir: string,
  reason: string,
): CheckoutResult;
```

**Constraints:**

- Directory: `join(checkoutsDir, branch.replace(/[^A-Za-z0-9._-]/g, "-"))` —
  the same slug and dir the absent-branch arm already uses. One docket copy per
  branch per repo. No collision with the user's own checkout, which lives
  wherever they put it and never under the state dir.
- Fetch first: if `headSha` is not present (`cat-file -e <headSha>^{commit}`),
  `git fetch origin <branch>` in the clone. The dirty and diverged arms have
  already fetched — a linked worktree shares the clone's object database — but
  the exists-nowhere arm has not, since it returns before today's fetch.
- Create with `git worktree add --detach <path> <headSha>`. **Never `-b`.** A
  branch would collide with the author's ref and hand cleanup a branch to
  delete; detached is the entire point. Verified: `--detach` at the PR head
  succeeds while that branch is checked out in the clone.
- **Reuse rule.** If the path is already a registered worktree of this clone, do
  not blindly reset it — it may hold agent commits nobody has consumed. Reuse
  and reset (`git checkout --detach <headSha>` there) **only when** it is clean
  (`status --porcelain` empty) **and** its HEAD is an ancestor of `headSha`
  (`merge-base --is-ancestor <worktreeHEAD> <headSha>` — the reverse direction
  from Task 1). Otherwise return it as-is at its current HEAD.
  - Why ancestry and not "HEAD equals the sha it was created at": the resolver
    never sees the entry, so it cannot know the creation sha without a signature
    change. Ancestry answers the question that actually matters — is everything
    in this copy already in the PR? — and is strictly safer: it also releases a
    copy whose commits the author has since cherry-picked and pushed.
- **`base` is always `headSha`, even in the preserve-as-is case.** It means "the
  PR head this copy corresponds to", so `HEAD !== base` reads as "holds commits
  the PR does not have" — exactly what Task 5's keep guard needs. Recording the
  current HEAD instead would let a second run that commits nothing delete a
  first run's work.
- Compare paths through the module's `real()` helper. git reports real paths and
  macOS `/tmp` is a symlink; a raw string compare finds no match and creates a
  second copy. The returned `path` is `real(path)`, matching the absent-branch
  arm.
- Reason strings, verbatim — they become the explanation the agent reads in
  Task 6:
  - dirty → `checkout dirty: ${path}` (the user's path)
  - diverged → `checkout diverged from PR head: ${path}`
  - not checked out → `branch ${branch} exists locally but isn't checked out`
- The absent-everywhere arm keeps creating a tracking branch with
  `worktree add --track -b` and returns **no** `fallback` — it is the one path
  that owns a branch, and Task 4's guard depends on that distinction. It gains
  one guard: if the target path is already a registered worktree of the clone (a
  leftover detached fallback), `worktree add` fails with "already exists" —
  hand off to `fallbackWorktree` with reason
  `branch ${branch} exists nowhere locally` instead.
- Still `{ok: false}`, because there is nothing to fall back *to*:
  `worktree list` fails, `status` fails, `fetch` fails, `worktree add` fails.
- The module's own file header (`src/checkout.ts:1-4`) states the rule this task
  reverses — "a blocked (dirty/ahead) copy never falls through to creating a
  second one". Rewrite it to the new rule, or the next reader trusts the comment
  over the code.

**Seams:** `resolveCheckout` (`tests/checkout.test.ts`); the sync and receive
flows in `tests/receive.test.ts` that hard-code today's dirty refusal.

**Done when:**

- `tests/checkout.test.ts` covers each arm:
  - diverged → a detached worktree under `checkoutsDir` at `headSha`,
    `owned: true`, `fallback.reason` the diverged string, and the user's clone
    still at its own HEAD;
  - dirty → the same fallback, and `f.txt` still uncommitted in the clone;
  - branch exists but checked out nowhere → the same fallback;
  - a fallback whose HEAD moved past the PR head → returned at that HEAD, not
    reset;
  - a clean fallback at an ancestor HEAD → reset to `headSha`.
- Detachment is asserted, not assumed: `rev-parse --abbrev-ref HEAD` is `HEAD`,
  and the fallback created no `refs/heads/<branch>`.
- The three integration tests that assert the old refusal are rewritten — they
  are the only ones that break here:
  - `tests/receive.test.ts:219` "feedback with a blocked (dirty) checkout is
    skipped with the reason, no run" → the run now happens, in the fallback: the
    entry reaches `ready`, `checkout_path` is under
    `stateDir/checkouts/testorg-demo/feature`, and the user's clone is still
    dirty.
  - `tests/receive.test.ts:292` "docket retry on a mine key with a blocked
    checkout reports the reason, exit 1" → retry now succeeds into the fallback.
    Keep the exit-1 contract alive through an arm that still refuses (no clone
    mapped), so "blocked means exit 1, not a silent 0" keeps a test.
  - `tests/receive.test.ts:326` "exec re-checks the checkout before spawning
    claude (TOCTOU downgrade)" → the guard still matters and the assertion gets
    sharper: a checkout that goes dirty between trigger and spawn moves the run's
    cwd (`sb.cwdCapture()`) to the fallback rather than the clone.
- `bun test`, `bun run format:check`. Commit.

---

### Task 3: Record the fallback on the entry

**Units:** `Entry.checkout_fallback` (`src/state.ts:31-69`); `prepareCheckout`
(`src/receive.ts:72-104`) writes it.

**Interacts:** `sync.ts:193` and `reviewer.ts:351` both call `prepareCheckout`,
so both write the key; `execReview`'s `carry()` preserves it across the status
rewrite that ends a run.

**Signatures:**

```ts
// src/state.ts, on Entry
checkout_fallback?: { base: string; reason: string };
```

**Constraints:**

- Written on **every** `prepareCheckout` call — the object when the resolver
  returned one, explicitly `undefined` when it did not. `patchEntry` spreads the
  patch and the state file is JSON, so `undefined` drops the key on write. A
  checkout that resolves in place after a fallback run (the author committed
  their work, so it is now strictly ahead) must not keep claiming its commits
  live somewhere they don't. Do **not** guard the write behind `if (r.fallback)`.
- **Trap:** `carry()` in `src/reviewer.ts:450-462` keeps mine-entry fields by
  *omitting* a denylist (`error`, `pid`, `session_id`, `summary`, `denials`,
  `note`). `checkout_fallback` survives with no change at all. Do not add it to
  that destructure — doing so would drop the key on every finished run and
  silently disarm Tasks 4 and 5.
- The fallback resolves `owned: true`, so `prepareCheckout`'s existing
  `worktrees[]` append records it unchanged: it is a path docket may delete,
  subject to Task 5's keep.

**Seams:** `prepareCheckout` through the sandbox flows in
`tests/receive.test.ts` (`prScenario` plus `sb.run(["receive", …])`).

**Done when:** a receive run into a fallback records `checkout_fallback` with
the PR head as `base` and the right `reason`; a second run for the same PR after
the author commits their dirty work (so the checkout resolves in place) clears
the key — asserted absent from the entry, not merely undefined inside a
surviving object. `bun test`, `bun run format:check`. Commit.

---

### Task 4: Never delete the author's branch — data-loss guard

This is the data-loss fix in this plan. Its test is the point of the task, not
a formality.

**Units:** `cleanupEntry` (`src/reviewer.ts:186-199`) — the `branch -D` gate.

**Interacts:** reached from `dismissKey` (`src/list.ts:171`) and from sync's
auto-dismiss (`src/sync.ts:223` and `:319`).

**Constraints:**

- Add `!entry.checkout_fallback` to the condition guarding
  `git -C <clone> branch -D <entry.branch>`. Only the arm that created a branch
  (`worktree add --track -b`) may delete one. A fallback is owned and created no
  branch, so that ref is the **author's**.
- Why it is real rather than theoretical, verified in a scratch repo: two of the
  three fallback shapes are accidentally saved by git refusing to delete a
  branch checked out in a worktree —
  `error: cannot delete branch 'feature' used by worktree at …`. The third,
  branch-exists-but-checked-out-nowhere, has no such protection —
  `Deleted branch feature (was 59dfec0).` — and it is one of the states this
  change newly unblocks, so it goes from unreachable to routine.
- **The test must be built on that unprotected shape.** A test that dismisses a
  dirty or diverged fallback passes whether or not the guard exists, and proves
  nothing.

**Seams:** `cleanupEntry` through the dismiss flow. The sibling to sit next to
is `tests/receive.test.ts:427` ("dismissing a mine entry frees its branch for
the next receive") — note that cleanup coverage lives in `receive.test.ts`, not
`review.test.ts`.

**Done when:**

- New test: a receive run whose branch exists in the clone but is checked out
  nowhere lands in a fallback; `dismiss` removes the fallback worktree and
  `git branch --list feature` is **still non-empty**. Put a commit on that
  branch that exists nowhere else, so a regression reads as data loss rather
  than as a bookkeeping nit.
- `tests/receive.test.ts:427` still passes unchanged — the owned-with-branch
  path still deletes its branch, or the next receive refuses forever.
- `bun test`, `bun run format:check`. Commit.

---

### Task 5: Keep a fallback the agent committed in, and say so

**Units:** `Kept` (new type) and `removeWorktree` (`src/reviewer.ts:136-155`);
`cleanupEntry`'s return type (`:162-201`); `dismissKey`'s message
(`src/list.ts:169-175`).

**Interacts:** `cleanupEntry` → `dismissKey` is the only consumer of the return
value — verified: `sync.ts` calls `cleanupEntry` twice and discards it. The type
change spans `reviewer.ts` and `list.ts` and cannot be split across two commits
without a red state.

**Signatures:**

```ts
export type Kept = { path: string; reason: "failed" | "has-commits" };
export function cleanupEntry(ctx: Ctx, key: string, logPrefix: string): Kept[];
```

**Constraints:**

- Keep condition: the target is the entry's `checkout_path`, the entry has
  `checkout_fallback`, and `git -C <wt> rev-parse HEAD` differs from
  `checkout_fallback.base`. Then skip `worktree remove` entirely and return
  `{ path, reason: "has-commits" }`. A worktree still at `base` is removed as
  before — nothing in it that isn't already in the PR.
- A worktree git refuses to remove stays `{ reason: "failed" }`. The two must
  render differently: "could not remove" is a lie for a deliberate keep, which
  is the whole reason this type exists.
- Do not log a keep as a failure. `removeWorktree`'s
  `could not remove worktree <wt>` line is for a real failure; a keep gets its
  own line naming the reason.
- Interaction with Task 4: a non-empty `stuck` currently suppresses the
  `branch -D`. A kept fallback makes the array non-empty, which suppresses it
  again — harmless, since Task 4 already forbids deletion for fallbacks, but do
  not conflate the two. `!entry.checkout_fallback` stays the load-bearing gate.
- `dismissKey` renders `dismissed <key> — kept <path> (has commits)` for a keep
  and keeps today's `could not remove <path>` wording for a failure, both in one
  message when both happen.

**Seams:** `cleanupEntry` / `removeWorktree` through the dismiss flow
(`tests/receive.test.ts`); `dismissKey`'s returned string
(`tests/list.test.ts`, whose dismiss tests start at `:78`).

**Done when:**

- A fallback whose HEAD moved past `checkout_fallback.base` survives dismiss —
  the directory is still on disk and the commit is still reachable from the
  clone by sha, which is the property that makes a detached fallback usable at
  all.
- A fallback still at `base` is removed on dismiss.
- `dismissKey` renders the kept-with-commits case distinctly from a removal
  failure.
- `bun test`, `bun run format:check`. Commit.

---

### Task 6: Tell the agent it is in a detached copy

**Units:** `receivePrompt` (`src/receive.ts:18-45`).

**Interacts:** `runPlan` (`src/reviewer.ts:307-320`) already hands it the entry;
no plumbing needed.

**Constraints:**

- Only when `entry.checkout_fallback` is set, add after the fixed preamble's
  first paragraph:

  > This is a fresh worktree docket created at the PR head because your own
  > checkout of this branch could not be used (`<reason>`). It is on a detached
  > HEAD — that is expected. Commit normally; the author cherry-picks your
  > commits onto their branch.

- `<reason>` is `entry.checkout_fallback.reason`, verbatim, as recorded by
  Task 3.
- Today's opening sentence calls the cwd "the checkout of its branch". For a
  fallback that is wrong twice over — it is not the author's checkout, and it is
  not on the branch. Either reword the opener for the fallback case or let the
  new paragraph correct it explicitly; do not ship a flat contradiction two
  sentences apart.
- Nothing else in the fixed preamble moves: work only in this checkout, edits
  and local commits allowed, NEVER push, NEVER write to GitHub, the three
  feedback sources, and the summary instruction.

**Seams:** `receivePrompt` — a pure function called directly.
`tests/receive.test.ts:28-63` is the idiom.

**Done when:** the paragraph appears with the recorded reason when
`checkout_fallback` is set, is absent when it is not, and the no-push preamble
and the summary instruction survive in both. `bun test`,
`bun run format:check`. Commit.

---

### Task 7: Documentation

**Units:** `README.md:152`; `docs/configuration.md:128-132`.

**Interacts:** nothing. Prose only.

**Constraints:** line numbers verified against the worktree as it stands today.

- `README.md:152` — the `docket receive` row of the CLI table ends
  `; refuses a dirty or diverged checkout`. False on both counts now. Replace it
  with what the command does: runs in the PR's checkout, or in a copy docket
  makes at the PR head when that checkout can't be used. Keep it to one clause —
  it is a table cell.
- `docs/configuration.md:128-132` — the paragraph beginning "If the PR's branch
  is already checked out somewhere in your clone…". Two claims die: "one ahead
  of the PR head, blocks the run", and "Only when the branch exists nowhere
  locally does docket create its own worktree". The replacement says: a checkout
  carrying unpushed commits on top of the PR head is used in place; a dirty,
  diverged, or not-checked-out branch gets a detached worktree at the PR head
  under `~/.local/state/docket/checkouts/`, removed on dismiss unless the run
  committed there. Second person, prose, matching its neighbours.
- **No doctor change.** Verified: `src/doctor.ts` holds no checkout- or
  worktree-related check, and this change adds no binary, plugin, skill,
  allowlist entry or config key. If this task ends up editing doctor, stop — the
  design has drifted.

**Seams:** none — this is prose. The rigor here is reading it back against the
behavior Tasks 1-6 actually shipped, not a test.

**Done when:** neither false statement survives —
`grep -rn "ahead of the PR head" README.md docs/` and
`grep -rn "dirty or diverged\|exists nowhere locally" README.md docs/` both come
back empty of the old claims — and both replacements describe the shipped
behavior. Commit.

---

### Task 8: Land green

**Units:** none — a verification pass over the finished branch.

**Constraints:**

- `bun test` and `bun run format:check` are exactly the two CI jobs
  (`.github/workflows/ci.yml`, matrix `["format:check", "test"]`, bun pinned to
  1.4.0). There is no separate lint script.
- Formatting fixes go through `bun run format` (biome), never by hand.
- No frames or demo pass is required here: the only TUI-visible change is one
  status-line string, covered by `tests/list.test.ts`. `CLAUDE.md` asks for
  `bun run frames all` after a UI change; this is not one. Say which applies —
  do not invent a QA pass, and do not skip one silently.
- Any manual `bun src/main.ts` run pins scratch dirs inline, per `CLAUDE.md`:
  `DOCKET_CONFIG_DIR=$(mktemp -d) DOCKET_STATE_DIR=$(mktemp -d) bun src/main.ts …`.
  A bare run reads and writes the user's live config.
- **Do not tag a release.** A release is a pushed tag with a spoken version and
  an explicit ack (`CLAUDE.md`); this plan ends at a green branch.

**Done when:** `bun test` passes with nothing skipped or filtered,
`bun run format:check` is clean, and `git log --oneline` shows one commit per
task. Commit only if the format run changed files.

## Out of scope

Carried from the spec: no config key gating any of this, no TUI verb to force a
run or choose between in-place and fallback, no automatic cherry-pick of the
fallback's commits onto the author's branch (the author does that,
deliberately), and no change to what counts as actionable feedback or to the
auto-run gate.

One pre-existing gap this change does not widen: if `<checkoutsDir>/<slug>`
exists on disk but is **not** a registered worktree (a pruned admin record, a
restored state dir), `worktree add` fails and the run refuses. That is today's
behavior on the absent-branch arm too. Leave it.
