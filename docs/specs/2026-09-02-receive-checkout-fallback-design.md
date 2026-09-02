# Receive checkout fallback — Design

> **To act on this design:** pick a mode — *vibe* (inline, no machinery),
> *review each task* (per-task diffs), *review at the end* (one subagent
> builds, one review at the end), or *plan first* (`writing-plans`, then how it gets built).
> Ask the user which; don't pick for them.

## Problem

A receive run refuses to start whenever the PR's local checkout is "ahead of
the PR head". In practice that fires constantly, because the common cause is
the most ordinary thing a PR author does: commit locally and not push yet.
The entry lands as `skipped`, a "docket: receive blocked" notification goes
out, and nothing happens.

The check that decides this is `src/checkout.ts:71-74`:

```ts
const ahead = git(path, ["rev-list", "--count", `${headSha}..HEAD`]);
if (Number(ahead.out) > 0)
  return { ok: false, reason: `checkout ahead of PR head: ${path}` };
```

`rev-list --count <headSha>..HEAD` is non-zero in two unrelated situations,
and the reason string names only the harmless one:

- **Strictly ahead** — `headSha` is an ancestor of `HEAD`. Unpushed local
  commits sit on top of exactly what the reviewer saw. The checkout is a
  superset of the PR.
- **Diverged** — `headSha` is not an ancestor. A rebase, an amend, or a
  force-push from elsewhere means the reviewed commit is not in this branch
  at all.

Blocking the first is wrong. A receive run never pushes and never resets —
the prompt forbids GitHub writes and the resolver's only mutation on a usable
checkout is `merge --ff-only` — so there is nothing to clobber, and running
on top of the author's newest work is what they want.

Blocking the other unusable states (`dirty`, `diverged`, branch-exists-but-
not-checked-out) is defensible, but dead-ending there is not: docket has a
perfectly good alternative it declines to reach for.

## Decisions (settled during design)

- **Strictly ahead is usable, everywhere.** No config key, no manual-only
  carve-out: the automatic trigger, `docket receive`, and the TUI's `R` verb
  all use the checkout in place, exactly as they do a clean one.
  `receive_enabled` and the draft rule are unchanged.
- **Every remaining unusable state falls back to a fresh worktree** rather
  than refusing. `dirty`, `diverged`, and branch-exists-but-not-checked-out
  each get a docket-created copy at the PR head instead of a `skipped` entry.
  Only genuine infrastructure failures (git errors, no clone mapped, `gh`
  unreachable) still refuse — there is nothing to fall back *to*.
- **The fallback worktree is detached**, at `headSha`. No branch is created,
  so nothing can collide with the user's own ref and cleanup has no branch of
  its own to delete. The cost — commits on no branch — is bounded by the
  cleanup guard below.
- **The user's own checkout is never touched when it is unusable.** A dirty
  working copy stays dirty; docket works elsewhere.
- **No new config key and no new TUI verb.** The behavior is a correction to
  an over-strict check, not something to opt into, and per `CLAUDE.md` a new
  key would drag in doctor checks, wizard questions and a config surface that
  earns nothing here.

## Rationale for the detached fallback

A linked worktree shares the clone's object database, so a commit the agent
makes in the fallback is reachable by sha from the author's own checkout
immediately — no fetch, no remote, no branch:

```
git cherry-pick 0c17e12          # straight onto their branch
git log --oneline 0c17e12 -5     # or read it first
```

Verified in a sandbox: `worktree add -b docket/feature <path> <sha>` and
`worktree add --detach <path> <sha>` both succeed while the branch is checked
out in the clone; a commit made in such a worktree pushes with
`push origin <ref>:<branch>`. The named-branch variant was rejected in favour
of detached to keep the clone's ref namespace clean and to delete the
branch-deletion code path rather than complicate it.

## Design

### 1. Checkout resolution — `src/checkout.ts`

`resolveCheckout` keeps its signature and its `CheckoutResult` shape, gains
one discrimination and one fallback.

```
                    branch found in `git worktree list`?
                    │
         ┌──────────┴───────────┐
        yes                     no
         │                      │
   status --porcelain     branch ref exists in the clone?
         │                      │
    ┌────┴────┐         ┌───────┴────────┐
  dirty     clean      yes              no
    │         │         │                │
    │    merge-base     │          unchanged: fetch +
    │    --is-ancestor  │          `worktree add --track -b <branch>`
    │    headSha HEAD   │          — still the only path that
    │    ┌────┴────┐    │            creates a branch, owned: true
    │   yes       no    │
    │    │        │     │
    │  ahead    DIVERGED│
    │  or equal  │      │
    │    │       │      │
    │  ff-only   │      │
    │  if behind │      │
    │    │       │      │
    ▼    ▼       ▼      ▼
  FALLBACK   USE IN   FALLBACK
             PLACE
```

Changes:

- Replace the `rev-list --count` test with
  `git merge-base --is-ancestor <headSha> HEAD` (exit 0 = ancestor). Ancestor
  → the checkout holds everything the reviewer saw; fall through to the
  existing `found.head !== headSha` branch, whose `merge --ff-only` is a
  no-op when strictly ahead and still fast-forwards when behind.
- Non-ancestor → the fallback.
- The existing "PR head may be newer than anything fetched" guard
  (`cat-file -e` then `fetch origin <branch>`) must run *before* the
  ancestry test, as it does today — `merge-base` cannot answer about an
  object that is not present.

New, in the same module:

```ts
function fallbackWorktree(
  clone: string,
  branch: string,
  headSha: string,
  checkoutsDir: string,
): CheckoutResult
```

- Fetches `origin <branch>` in the clone if `headSha` is not present.
- If `<checkoutsDir>/<branch-slug>` already exists as a worktree, reuse it:
  `checkout --detach <headSha>` there, but **only when that worktree is clean
  and its HEAD is unchanged from the sha it was created at** — otherwise it
  holds agent work that has not been consumed, and the existing copy is
  returned as-is at its current HEAD rather than being reset.
- Otherwise `git worktree add --detach <checkoutsDir>/<branch-slug> <headSha>`.
- Returns
  `{ ok: true, path: real(path), owned: true, fallback: { base: headSha, reason } }`,
  where `reason` is the plain-words cause the user's own copy was unusable —
  the strings that are today's refusal reasons (`checkout dirty: <path>`,
  `checkout diverged from PR head: <path>`,
  `branch <b> exists locally but isn't checked out`). They stop being
  failures and become explanations.

The slug and directory are the ones today's creation path already uses
(`branch.replace(/[^A-Za-z0-9._-]/g, "-")` under `checkoutsDirFor`). No
collision with the user's own copy: that lives wherever they put it, never
under docket's state dir.

`CheckoutResult`'s success arm gains
`fallback?: { base: string; reason: string }`. Its presence is what "this is
a detached copy docket made" means — there is no separate boolean to fall out
of sync with it. The two non-fallback success paths omit it.

### 2. Recording the shape — `src/receive.ts`, `src/state.ts`

`Entry` gains `checkout_fallback?: { base: string; reason: string }`, carrying
the resolver's arm verbatim: `base` is the `headSha` the copy was created at
(§4 needs it), `reason` is why the author's own copy was passed over (§5 needs
it).

`prepareCheckout` writes the key on **every** call — the object when the
resolver returned one, and explicitly `undefined` when it did not. `patchEntry`
spreads its patch over the entry and the state file is JSON, so an `undefined`
is dropped on write: the key genuinely clears rather than lingering. A checkout
that changes shape between runs (the author commits their work, so next time it
resolves in place) therefore cannot leave a stale fallback behind claiming
commits live somewhere they don't.

### 3. Cleanup must not delete the author's branch — `src/reviewer.ts`

This is a data-loss guard, not a nicety. `cleanupEntry` ends with:

```ts
const ownedCheckout =
  !!entry?.checkout_path && recorded.includes(entry.checkout_path);
if (entryKind(key) === "mine" && entry?.branch && ownedCheckout && !stuck.length) {
  const d = Bun.spawnSync(["git", "-C", clone, "branch", "-D", entry.branch], …);
```

It deletes `entry.branch` on the assumption that an owned checkout is always
one docket created with `worktree add -b <branch>`, making the ref docket's to
remove. A fallback worktree is owned and created no branch, so that ref is the
*author's*.

Two of the three fallback cases are saved by git refusing to delete a branch
checked out in any worktree:

```
branch checked out in another worktree  →  error: cannot delete branch 'feature'
branch exists, checked out nowhere      →  Deleted branch feature (was 77d1469).
```

The third — branch-exists-but-not-checked-out — has no such protection, and it
is one of the states this change unblocks. Dismissing that entry today's way
would run `branch -D <branch>` on a branch holding unpushed work.

Fix: gate the deletion on `!entry.checkout_fallback`, so only the path that
created a branch may delete one.

### 4. Never remove a fallback the agent committed in — `src/reviewer.ts`

`removeWorktree` learns one check. When the target is a docket-owned detached
checkout whose `HEAD` no longer equals `checkout_fallback.base`, the agent
committed there and that worktree holds the only record of the work: keep it,
and report it.

The reporting channel exists — `cleanupEntry` already returns the paths it
could not remove and `dismissKey` (`src/list.ts:169-175`) renders them. Widen
that return so the message can be honest, since "could not remove" is a lie
for a deliberate keep:

```ts
export type Kept = { path: string; reason: "failed" | "has-commits" };
// dismissKey renders:
//   dismissed mine:org/repo#12 — kept /…/checkouts/org-repo/feature (has commits)
```

`dismissKey` is the only consumer.

### 5. Telling the agent where it is — `src/receive.ts`

`receivePrompt` opens by naming the checkout as "the checkout of its branch".
For a fallback that is wrong twice over: it is not the author's checkout, and
it is on a detached HEAD, which the agent will otherwise meet as a warning it
has to interpret. When `checkout_fallback` is set, the prompt says so and
tells it what to do:

> This is a fresh worktree docket created at the PR head because your own
> checkout of this branch could not be used (`<reason>`). It is on a detached
> HEAD — that is expected. Commit normally; the author cherry-picks your
> commits onto their branch.

`<reason>` is `checkout_fallback.reason`, recorded by §2. The fixed
preamble's other rules (never push, never write to GitHub, stay in this
checkout) are unchanged.

### 6. Documentation

Per `CLAUDE.md`, dependency changes must update doctor and README. This change
adds no external dependency, binary, allowed tool or config key, so
`src/doctor.ts` is unaffected — but two documented statements become false:

- `README.md:152` — "refuses a dirty or diverged checkout" for
  `docket receive`.
- `docs/configuration.md:128-132` — "a dirty checkout, or one ahead of the PR
  head, blocks the run (`skipped`, with the reason shown) rather than risking
  your work. Only when the branch exists nowhere locally does docket create
  its own worktree".

Both must describe the new behavior: an ahead checkout is used in place; an
unusable one gets a detached worktree at the PR head under
`~/.local/state/docket/checkouts/`, which is kept on dismiss if the run
committed there.

## Testing

Seams, all pure or subprocess-against-scratch-repos — the existing style in
`tests/checkout.test.ts`, which already builds scripted git repos in temp
dirs via a `scenario()` helper.

**`resolveCheckout`** (`tests/checkout.test.ts`) — the state machine is the
whole feature, so each arm earns a test:

- strictly ahead (unpushed commits) → `{ ok: true }` at the user's own path,
  `detached: false`, and the local commits still present afterwards
- diverged (rebase/amend) → a detached worktree under `checkoutsDir` at
  `headSha`, `owned: true`, and the user's checkout untouched
- dirty → same fallback, and the uncommitted file still uncommitted
- branch exists but is checked out nowhere → same fallback
- reusing an existing fallback whose HEAD moved → returned at its current
  HEAD, not reset
- the unchanged arms still pass: clean, behind (ff-only, fetching a new sha),
  absent (creates the tracking branch)

**`cleanupEntry` / `removeWorktree`** (`tests/review.test.ts` or a sibling,
following whatever already covers cleanup):

- `checkout_fallback` set → the branch survives; assert against the
  branch-exists-but-not-checked-out shape, since that is the case with no
  accidental protection
- a fallback whose HEAD moved past `checkout_fallback.base` → kept, and
  returned as `{ reason: "has-commits" }`
- a fallback still at `checkout_fallback.base` → removed
- the old owned-with-branch path still deletes its branch

**`receivePrompt`** (`tests/receive.test.ts`) — the detached paragraph appears
only when `checkout_fallback` is set, and the fixed no-push preamble survives.

**`prepareCheckout`** (`tests/receive.test.ts`) — a run that resolves in place
after a fallback run clears `checkout_fallback` from the entry, rather than
leaving the old object behind.

**`dismissKey`** (`tests/list.test.ts`) — renders the kept-with-commits case
distinctly from a removal failure.

No TUI component tests: per `CLAUDE.md` the TUI stays thin, and the only
TUI-visible change is a status-line string.

## Out of scope

- Any config key gating this behavior.
- A TUI verb to force a run, or to choose between in-place and fallback.
- Automatically merging or cherry-picking the fallback's commits onto the
  author's branch — the author does that, deliberately.
- Changing what counts as actionable feedback, or the auto-run gate
  (`receive_enabled`, drafts).

## Amendments from the post-implementation review (2026-09-02)

The review of the built branch reshaped four points above; the code is the
authority where they differ.

- **Ancestry is one `rev-list --left-right --count headSha...HEAD`**, not two
  `merge-base --is-ancestor` calls: both non-zero counts is *diverged*, and a
  failing git is an error rather than a "no".
- **`base` lives per path, not on `checkout_fallback`.** `Entry.fallback_bases`
  maps each detached copy to the PR head it was last handed and survives a
  later run resolving in place; `checkout_fallback` keeps only `reason`. The
  keep guard reads the map, so a copy's commits outlive the entry pointing
  elsewhere.
- **Branch ownership is recorded, not inferred.** `Entry.branch_owned` is
  written once by the `worktree add -b` path; cleanup deletes the branch on
  that, not on `!checkout_fallback`. A docket-created tracking worktree that
  has gone dirty or diverged is therefore *refused* with its reason — it sits
  where the fallback would go, so there is nothing to fall back to.
- **A leftover at the slug is reused only if it is detached** (`feat/x` and
  `feat-x` share a slug) **and only while it still contains the PR head**; a
  copy holding unpicked commits that the PR has moved past is refused.
  Prunable worktree records are ignored and pruned before `worktree add`.

