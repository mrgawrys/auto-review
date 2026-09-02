# Configuration reference

Config lives at `~/.config/docket/config.json`. Running `docket` in a terminal
with no config offers to write one for you; `docket doctor` writes a starter
file there instead, to fill in by hand. `DOCKET_CONFIG_DIR` and
`DOCKET_STATE_DIR` override the config and state locations
(`~/.config/docket/` and `~/.local/state/docket/`).

A complete example with every key is in
[config.example.json](../config.example.json).

## orgs

GitHub orgs to poll for PRs where your review is requested. Required.

## repos

`org/repo` → absolute path of your local clone. Required. A PR in a repo
with no mapping is marked `skipped`, not reviewed.

## poll_interval_minutes

How often the launchd job polls. Default `15`.

## claude_bin

The claude binary to run. Default `claude`.

## claude_config_dir

Set to run every claude invocation with a specific `CLAUDE_CONFIG_DIR` —
useful with multiple Claude accounts. Empty = default.

Credentials live per config dir, so pointing docket at a second one means
logging in there too: `CLAUDE_CONFIG_DIR=<dir> claude auth login`. `docket
doctor` reports which dir it checked.

## claude_env

Extra environment variables for every claude invocation, review runs and
resumes alike — e.g. to mute a notification hook of your Claude setup that
would otherwise fire from unattended review sessions. If both this and
`claude_config_dir` set `CLAUDE_CONFIG_DIR`, `claude_config_dir` wins.
Empty = none.

## gh_account

Pin all GitHub access to this `gh` account (its token is resolved via
`gh auth token --user`). Without it, polling uses whichever account
`gh auth switch` last left active — with a personal + work account that
means the poller can go blind without any error. Empty = active account.

## ignored_teams

Org-qualified team slugs (e.g. `your-github-org/some-team`). A PR that lands
in your queue **only** because one of these teams was asked to review
(CODEOWNERS or a manual team request) is skipped — nothing is recorded, so if
someone later requests *you* directly the PR is picked up normally. A PR
where you are requested personally, or via any team not listed here, is
always reviewed. Empty = review everything.

## notifications

macOS notifications on review completion. Default `true`.

## review_prompt

The review task handed to claude. Omit (or leave blank) to run the default,
`Review the PR by running /code-review {number}.`

Two parts of every run are fixed and not configurable; `review_prompt` is
only the task in between:

- Every run is first told to do its work in a git worktree and never touch
  the main working copy. The agent picks *where* the worktree goes
  (following your own worktree conventions in CLAUDE.md, if any); docket
  discovers it afterwards and removes it on dismiss.
- Every run is asked to end its final message with a fenced `json` block,
  `{"headline": …, "issues": …, "risk": "low"|"medium"|"high"}`, which is
  what the queue renders per row. A prompt that cannot answer a field omits
  it: one that never hunts for issues reports no count rather than a
  misleading zero, and the row simply shows less. A run that ignores the
  block falls back to the first lines of its prose, so nothing breaks.

Tokens `{number}` and `{repo}` (org/repo) are substituted; a prompt with no
token is used as-is. A prompt that doesn't run `/code-review` needs no
code-review plugin (doctor checks this).

`docket prompt` is the intended way to set this key: it opens the task in
`$EDITOR` and can ask claude to derive the `extra_allowed_tools` the task
needs, so the two keys stay in step. Picking the default there removes the
key. The same step runs as step 4 of the first-run wizard.

## extra_allowed_tools

Entries appended to the built-in tool allowlist for the headless run, in
claude's `--allowedTools` grammar (e.g. `"Bash(bun test:*)"`,
`"Skill(my-review)"`). Needed when a custom `review_prompt` uses tools the
baseline doesn't cover — headless runs can't prompt, so anything outside the
allowlist is denied mid-run; the queue's `D` view is where those denials show
up afterwards, and its `a` key appends here.

`docket prompt` (and the wizard's review-task step) fills this in for you: it
asks claude to read the skills the task names and proposes entries, merged
into whatever the key already holds — hand-set entries always survive.

The baseline is read-only and never posts to GitHub; entries you add here
run without prompts, so adding posting tools (e.g. `Bash(gh pr comment:*)`)
gives that guarantee up knowingly — knowingly means by hand. The deriver
never adds posting tools silently: obviously posting-shaped entries are
dropped from its proposal before you see it. That filter is best-effort, not
a guarantee — allowlist entries are prefix patterns, so reading the proposal
before accepting is the real gate. Empty = baseline only.

## receive_enabled

Turn on automatic **receive runs**: when someone leaves actionable feedback
on a PR you authored (a review that isn't a bare comment-less approval),
docket addresses that feedback headlessly in the PR's checkout, so a
session with the feedback already addressed is waiting in the TUI's *my PRs*
view (`tab`). Default `false`.

The run may edit files and commit locally in the checkout — it never pushes
and never writes to GitHub; you review its work and push yourself. Drafts are
listed but never auto-run. The manual paths — `docket receive`, the mine
view's `R` — work regardless of this key.

If the PR's branch is already checked out somewhere in your clone, that
checkout is used — unpushed commits sitting on top of the PR head and all.
When it can't be used, docket never touches it: uncommitted changes, a
history the PR head is missing from (you rebased or amended), or a branch
checked out nowhere all send the run to a detached worktree docket creates at
the PR head, under `~/.local/state/docket/checkouts/`. That copy goes away
when you dismiss the entry — unless the run committed there, in which case it
stays put and the commits are yours to cherry-pick.

## receive_prompt

The receive task handed to claude. Omit (or leave blank) to run the default:

`Address the review feedback on PR {number}: read the reviews, verify each
point against the code, implement the changes they ask for, and commit the
fixes locally.`

Tokens `{number}` and `{repo}` are substituted, like `review_prompt`.

The wrapper around the task is fixed and not configurable: work only in the
PR's checkout, edits and local commits allowed, never push, never write to
GitHub; where the feedback is (inline thread comments, review bodies and
conversation comments, each a read-only `gh api` path) and an instruction to
stop rather than invent work if none of it can be read; and a closing summary
block of its own — `headline`, `addressed`, `deferred` — which the mine view
shows as `3 addressed · 1 deferred` where a review row shows risk.

This key is also where a skill invocation goes if you have a review-receiving
skill you'd rather run — e.g. `Run /my-receive-skill on PR {number}.` — with
its `Skill(...)` entry added to `extra_receive_allowed_tools` (doctor checks
that a `Skill(plugin:name)` entry's plugin is installed, whether or not
`receive_enabled` is on — the manual verbs run this prompt either way). The
wizard never overwrites an existing custom value here.

## extra_receive_allowed_tools

Entries appended to the **receive** run's allowlist, in the same grammar as
`extra_allowed_tools`. The receive baseline is the review baseline plus
`Edit`, `Write`, `MultiEdit`, `Bash(git add:*)`, `Bash(git commit:*)` and
the three read-only `gh api` paths the feedback lives at
(`repos/*/pulls/*/comments`, `repos/*/pulls/*/reviews`,
`repos/*/issues/*/comments` — never `gh api graphql`, which mutates as
readily as it reads), minus `Bash(git checkout:*)`, `Bash(git worktree:*)`, `Bash(git branch:*)`,
`EnterWorktree` and `ExitWorktree`
— a receive run is already standing in the checkout docket resolved for it,
and that checkout may be your own worktree. It deliberately contains no push
and no GitHub-write verbs either, and a denied `git push` in the mine view's
denials is labeled as the guardrail working, not offered as a rule.
Empty = baseline only.

## openers

What the queue's `s`, `d` and `o` keys run, as a chain of candidate commands
per verb; the first whose binary is on `PATH` wins, so the shipped `diff`
chain tries `revdiff`, then `tuicr`, then plain `git diff`, and `browse` tries
`open`, then `xdg-open`. `shell` and `diff` run in the PR's worktree and are
unavailable without one; `browse` needs only the PR's url, so it works on a
row whose review has not run yet.

Tokens `{worktree}` `{clone}` `{base}` `{head}` `{number}` `{repo}` `{url}`
are substituted per argument — the command is executed directly, never
through a shell, so a path with spaces stays one argument. The one exception
is a literal `$SHELL` as the first word, taken from the environment
(`/bin/sh` if unset).

A verb you set **replaces** its default chain rather than adding to it, so
keep a fallback that always resolves. Omit = the shipped chains;
`docket doctor` prints the winner per verb.
