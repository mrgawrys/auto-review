# My PRs view and auto-receive — Design

> **To act on this design:** pick a mode — *vibe* (inline, no machinery),
> *review each task* (per-task diffs), *review at the end* (one subagent
> builds, one review at the end), or *plan first* (`writing-plans`, then how it
> gets built). Ask the user which; don't pick for them.

## What and why

docket today watches PRs awaiting the user's review. This feature adds the
mirror image: a second, always-present TUI view listing PRs the user
*authored*, with the same working verbs (shell, diff, claude), plus the
receive side of the review loop — when someone leaves actionable feedback on
one of the user's PRs, docket can pre-run `/receive-code-review` headlessly in
that PR's checkout, so a session with the feedback already addressed is
waiting to be resumed, inspected, and pushed by the user.

The 2026-08-04 TUI spec deferred exactly this and left the view seam for it.

## Decisions (settled during design)

- **Scope:** PRs authored by the user across configured `orgs` plus the
  user's own login, only in repos mapped in `repos`. Drafts are listed
  (flagged) but never auto-run.
- **Trigger:** a submitted review by someone else that is not a bare
  comment-less approval — `CHANGES_REQUESTED`, `COMMENTED`, or `APPROVED`
  with a body/comments. Detection runs in the background poller.
- **Auto-run is opt-in:** `receive_enabled` (default false) plus an optional
  `receive_prompt`. The manual verb works regardless of the boolean.
- **The run may edit and commit locally** in the PR's checkout. Never push,
  never write to GitHub — enforced by a dedicated allowlist.
- **Checkout reuse:** if the PR branch is already checked out locally, all
  verbs use that checkout, and the auto-run is skipped (flagged for manual
  action) when it is dirty or ahead of the PR head. Only when the branch
  exists nowhere locally does docket create its own worktree.
  *Superseded 2026-09-02:* a dirty, diverged or not-checked-out branch now
  gets a detached copy at the PR head instead of a skip — see
  `docs/specs/2026-09-02-receive-checkout-fallback-design.md`.
- **Architecture:** second entry kind in the existing pipeline (approach 1 of
  3 explored; the parallel-subsystem and view-only-first alternatives are in
  the session's scratchpad notes). A receive run *is* a run — same detached
  runner, run logs, denials, watch/kill/notify, lifecycle.

## Data model

Mine entries live in the same `state.json`, keyed **`mine:org/repo#N`**.
Kind is derived from the key prefix (`entryKind(key)`), never stored.

Key handling hardens with the namespace:

- `normalizeKey` learns the `mine:` prefix explicitly and rejects any other
  colon-shaped input (today `mine:org/repo#N` would silently parse with
  `mine:org` as the org).
- `splitKey` strips the prefix — every `gh` call sees the bare repo/number.
- `runLogPath`'s slug function maps `:` like `/` and `#`.
- `pendingEntries(state, kind)` filters by kind; each view sees only its own
  entries. The same PR present in both worlds (own PR with a team review
  request) is two independent entries.

`Entry` changes:

- **Renamed:** `my_review_at` → `review_at` — generalized to "the review
  event this entry last accounted for" (review kind: the user's review of
  someone's PR; mine kind: someone's review of the user's PR). `loadState`
  migrates the old field name on read; the old name dies on next save. The
  generalized meaning is documented at the type definition.
- **New:** `checkout_path` (the resolved working copy — the user's clone, the
  user's worktree, or docket's own; openers, `enter`, and the runner cwd all
  read it) and `branch` (PR head branch, captured at poll time so TUI
  keypresses resolve checkouts without a `gh` round-trip).
- **Reused with mirrored meaning:** verdict statuses
  `approved | changes-requested | commented` on a mine entry mean "their
  verdict on my PR" and read as *feedback awaiting you*; `flags[]` gains
  `"draft"`; `error` carries the auto-run skip reason under
  `status: "skipped"`; `worktrees[]` keeps its exact meaning — *paths docket
  may delete* — so only docket-created checkouts go in it and `cleanupEntry`
  is safe by construction. "Docket-owned checkout" is derived:
  `checkout_path === worktrees[0]`.

Mine entry lifecycle, in existing vocabulary:

```
open ──(feedback, no run)──▶ approved | changes-requested | commented
open ──(feedback, auto-run)─▶ reviewing ──▶ ready | failed
open ──(feedback, blocked)──▶ skipped (error = reason)
any  ──(merged/closed)──────▶ done
```

One feedback cursor: when sync sees a review newer than `review_at` it acts
once (run, flag, or skip) and advances the cursor immediately — the same
review never re-triggers. New feedback later re-triggers from any non-running
state.

## Polling and sync

- `pollCycle` gains a second loop: `gh search prs --author=@me --state=open`
  per org and for the user's own login (drafts kept, unmapped repos skipped).
  New keys become `open` entries with `title`, `url`, `branch`, draft flag.
  **No run ever starts from the poll loop** — feedback, not existence,
  triggers work.
- `sync.reconcile` branches on kind. New pure `decideMineSync(info, me,
  entry)`: merged/closed → `done` (cleanup removes only `worktrees[]` paths);
  otherwise classify reviews by others newer than `review_at` — actionable
  means not a bare comment-less approval. On feedback: advance `review_at`,
  notify, then either start the receive run (`receive_enabled`, not draft,
  checkout usable), set the verdict status (not opted in), or set
  `skipped` + reason (checkout dirty/ahead).
- Known cost, accepted: authored PRs stay in the active sync set until
  merged — one `gh pr view` per open authored PR per cycle.

## Checkout resolution — `src/checkout.ts` (new)

`resolveCheckout(clone, branch, headSha)`:

1. Find the branch in `git worktree list --porcelain` (the clone itself is
   the first entry).
2. Found: dirty (`status --porcelain`) → blocked "checkout dirty"; ahead of
   the PR head (`rev-list headSha..HEAD`) → blocked "ahead of PR head";
   behind → `merge --ff-only` to the head; clean → use it. Blocked never
   falls through to creating a second copy — the branch is where the user's
   work is.
3. Found nowhere: `git fetch origin <branch>`, `git worktree add` under
   `<stateDir>/checkouts/<slug>` tracking the remote branch. Only this path
   records the checkout in `entry.worktrees`.

Resolution runs at trigger time in the poller and re-runs inside the run
process right before spawning claude (TOCTOU guard — a checkout can change
between poll and spawn; a now-blocked checkout downgrades the run to
`skipped`).

## Runner and receive run

- `reviewer.ts`: extract the run core, parameterized by a `RunPlan` —
  prompt, allowed tools, cwd, discover-worktrees flag, notification label.
  The review plan is byte-for-byte today's behavior (including post-run
  worktree discovery); the receive plan differs in exactly those values and
  skips discovery (docket resolved the checkout itself). Detached spawn,
  run-log tee, session/summary/denials tail-parse, notify, status writes,
  kill/watch: unchanged, inherited.
- `src/receive.ts` (new): `receivePrompt(cfg, entry)` — the configured
  prompt (default: run `/receive-code-review` for the PR) wrapped in a fixed
  preamble: *work only in this checkout; you may edit and commit locally;
  never push; never write to GitHub* — plus the existing summary
  instruction; and `shouldAutoRun(cfg, entry, checkout)`.
- **Allowlist:** `RECEIVE_ALLOWED_TOOLS` = review baseline + `Edit`, `Write`,
  `MultiEdit`, `Bash(git add:*)`, `Bash(git commit:*)`. No push, no `gh`
  write verbs. Its own `extra_receive_allowed_tools` key. In the mine view
  the denials machinery targets the receive list, and a denied write-shaped
  call that the receive guarantee exists to block (e.g. `git push`) is
  labeled as the guardrail working, not offered as a rule.

## Config, doctor, wizard

- New keys: `receive_enabled` (default false), `receive_prompt`,
  `extra_receive_allowed_tools` — validated in `configProblem`, documented
  in `docs/configuration.md` and `config.example.json`.
- Doctor, when `receive_enabled`: `receive_prompt` non-blank if set, the
  `receive-code-review` skill/plugin installed (same probe style as the
  `/code-review` check), receive allowlist well-formed. README
  Requirements/Setup updated in the same change (CLAUDE.md contract).
- Wizard, both routes: the quick wizard asks "also act on reviews you
  receive?" (writes `receive_enabled`; same `$EDITOR` option for a custom
  `receive_prompt` as the review-prompt step); the claude-guided wizard's
  brief gains the same option. **Neither route ever overwrites an existing
  non-default `receive_prompt`** — a wizard answer deleting a hand-written
  prompt has happened before with `review_prompt`; present values are
  read-only unless explicitly edited.

## TUI and CLI

- `view` union gains `"mine"`; `tab` toggles queue ↔ mine. Per-view cursor
  and scroll. Rows come from `pendingEntries(state, kind)` via the existing
  fs-watch — no live fetching in the TUI; `S` (sync) works in both views.
- Chips reuse the existing vocabulary: verdict status, `draft` flag,
  `⊘ n` denials, run summary chips for `ready`. The panel shows the run's
  headline when a run happened (same `assessment.ts` path), else the
  feedback verdict and reviewer (from sync-fetched data at display time).
- Mine verbs:
  - `enter` — resume the receive session (cwd = `checkout_path`); no
    session → fresh `claude` chat in the checkout; greyed with reason when
    no checkout exists yet.
  - `s` / `d` — existing openers; `{worktree}` resolves to `checkout_path`.
  - `R` — run receive now; independent of `receive_enabled`; refuses a
    dirty/ahead checkout with the reason in the panel.
  - `w` / `K` / `x` — inherited unchanged; `x` removes only
    `worktrees[]` paths.
- `n` (new, both views) — footer input line: paste a PR URL or
  `ORG/REPO#N`, optionally followed by a note; `enter` submits, `esc`
  cancels. View-scoped verb: queue → `actions.review`, mine →
  `actions.receive`. Parse/validate in a pure helper (reuses
  `normalizeKey` + mapped-repo check); bad input shows the reason in the
  footer.
- CLI: `docket receive ORG/REPO#N|URL ["note"]` mirrors `docket review`
  (both accept URLs via `normalizeKey`). `retry`, `watch`, `dismiss` accept
  `mine:` keys. `printPending` prints both sections.

## Error handling

- Unmapped repo: not listed (poll skips it), and `n`/CLI reject with the
  reason.
- Blocked checkout at any stage → `skipped` + reason, notified, visible in
  the panel; `R` is the retry path after the user cleans up.
- `gh` hiccup during sync: leave the entry as-is (fail open, like today).
- Receive run failure → `failed` with `error`, run log kept; `enter` falls
  back to the denials hand-off exactly as the queue does.

## Testing

Seams, in the repo's fully-mocked idiom (no network, no tokens):

- `checkout.ts` against scripted git repos in temp dirs: reuse hit,
  dirty/ahead/behind/clean, create path, ownership recording.
- `decideMineSync`, `receivePrompt`, `shouldAutoRun`, the `n`-input parser:
  pure functions.
- `state.ts`: `mine:` normalization/rejection, `entryKind`/`bareKey`,
  `review_at` migration, `pendingEntries` kind filter, `runLogPath` slug.
- `config.ts`/`doctor.ts`: new keys, receive checks.
- TUI stays thin (CLAUDE.md): at most "R on a blocked checkout is refused,
  not run".

## Delivery order

Staged so each lands green with its tests, small commits throughout:

1. Key namespace, `review_at` rename + migration, new Entry fields.
2. `checkout.ts`.
3. Poll + sync detection (view data exists; nothing runs yet).
4. Runner generalization (`RunPlan`) — behavior-preserving for review.
5. `receive.ts`, allowlist, auto-run trigger, `docket receive`.
6. TUI mine view, verbs, `n` input.
7. Wizard, doctor, README, configuration docs.

## Out of scope

- CI status on mine rows (would need per-row `statusCheckRollup` fetches).
- Acting on review-thread-only comments outside a submitted review.
- Any GitHub write (replying to reviewers, resolving threads, pushing).
- Migrating `github.ts` to async spawns — not needed while the TUI stays
  off the network.
