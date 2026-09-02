import { expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_RECEIVE_PROMPT,
  RECEIVE_ALLOWED_TOOLS,
  effectiveReceiveAllowedTools,
  effectiveReceivePrompt,
  type Config,
} from "../src/config";
import { receivePrompt, shouldAutoRun } from "../src/receive";
import type { Entry } from "../src/state";
import { makeSandbox, type Sandbox } from "./harness";

const bareCfg = (over: Partial<Config> = {}): Config => ({
  orgs: [],
  repos: {},
  ...over,
});

const entry = (over: Partial<Entry> = {}): Entry => ({
  status: "open",
  checkout_path: "/tmp/co/feature",
  updated_at: "t",
  ...over,
});

test("receivePrompt: fixed preamble — checkout only, commits yes, push and GitHub writes never", () => {
  const p = receivePrompt(bareCfg(), "mine:acme/widgets#12", entry());
  expect(p).toContain("Work ONLY in this checkout");
  expect(p).toContain("/tmp/co/feature");
  expect(p).toContain("edit files and commit locally");
  expect(p).toContain("NEVER push");
  expect(p).toContain("NEVER write to GitHub");
  expect(p).toContain(
    "Address the review feedback on PR 12: read the reviews, verify each " +
      "point against the code, implement the changes they ask for, and " +
      "commit the fixes locally.",
  );
  // the feedback's three homes are named, and an unreadable one is a stop
  expect(p).toContain("gh api repos/acme/widgets/pulls/12/comments");
  expect(p).toContain("gh api repos/acme/widgets/pulls/12/reviews");
  expect(p).toContain("gh api repos/acme/widgets/issues/12/comments");
  expect(p).toContain("do not go looking for other work");
  // the receive contract, not the review one: no issues, no risk
  expect(p).toContain('"addressed"');
  expect(p).toContain('"deferred"');
  expect(p).not.toContain('"risk"');
});

test("receivePrompt: custom body substituted, preamble still fixed, note appended", () => {
  const p = receivePrompt(
    bareCfg({ receive_prompt: "Fix the feedback on {repo}#{number}." }),
    "mine:acme/widgets#12",
    entry(),
    "skip the nits",
  );
  expect(p).toContain("Fix the feedback on acme/widgets#12.");
  expect(p).toContain("NEVER push");
  expect(p).toContain("Additional context from the author: skip the nits");
  expect(p.trimEnd().endsWith("skip the nits")).toBe(true);
});

test("receivePrompt: a fallback checkout is named as one, with its reason", () => {
  const p = receivePrompt(
    bareCfg(),
    "mine:acme/widgets#12",
    entry({
      checkout_fallback: { reason: "checkout dirty: /home/me/widgets" },
    }),
  );
  expect(p).toContain("fresh worktree docket created at the PR head");
  expect(p).toContain("(`checkout dirty: /home/me/widgets`)");
  expect(p).toContain("detached HEAD — that is expected");
  expect(p).toContain("the author cherry-picks your commits onto their branch");
  // and the opener no longer calls it the author's checkout of the branch
  expect(p).not.toContain("the checkout of its branch");
  // the fixed preamble and the summary demand survive
  expect(p).toContain("NEVER push");
  expect(p).toContain('"addressed"');

  // absent for an ordinary checkout, which the opener names as one
  const plain = receivePrompt(bareCfg(), "mine:acme/widgets#12", entry());
  expect(plain).toContain("the checkout of its branch");
  expect(plain).not.toContain("detached HEAD");
});

test("effectiveReceivePrompt: blank override falls back to the default", () => {
  expect(effectiveReceivePrompt(bareCfg({ receive_prompt: "  " }))).toBe(
    DEFAULT_RECEIVE_PROMPT,
  );
});

test("receive allowlist: edit + local git verbs, and never push or GitHub writes", () => {
  const joined = RECEIVE_ALLOWED_TOOLS.join(",");
  expect(RECEIVE_ALLOWED_TOOLS).toContain("Edit");
  expect(RECEIVE_ALLOWED_TOOLS).toContain("Write");
  expect(RECEIVE_ALLOWED_TOOLS).toContain("MultiEdit");
  expect(RECEIVE_ALLOWED_TOOLS).toContain("Bash(git add:*)");
  expect(RECEIVE_ALLOWED_TOOLS).toContain("Bash(git commit:*)");
  // the feedback itself is readable — inline threads are not in `gh pr view`
  expect(RECEIVE_ALLOWED_TOOLS).toContain(
    "Bash(gh api repos/*/pulls/*/comments:*)",
  );
  expect(RECEIVE_ALLOWED_TOOLS).toContain(
    "Bash(gh api repos/*/pulls/*/reviews:*)",
  );
  expect(RECEIVE_ALLOWED_TOOLS).toContain(
    "Bash(gh api repos/*/issues/*/comments:*)",
  );
  // but only those paths: graphql mutates, and a bare `gh api` is everything
  expect(joined).not.toContain("gh api graphql");
  expect(joined).not.toContain("Bash(gh api:*)");
  // no pinned skill name: the default task is plain words, and a user's own
  // receive skill arrives via receive_prompt + extra_receive_allowed_tools
  expect(joined).not.toContain("receive-code-review");
  // a receive run stands in a checkout that may be the user's own worktree:
  // the verbs that would switch it out from under them are not inherited
  expect(RECEIVE_ALLOWED_TOOLS).not.toContain("Bash(git checkout:*)");
  expect(RECEIVE_ALLOWED_TOOLS).not.toContain("Bash(git worktree:*)");
  expect(RECEIVE_ALLOWED_TOOLS).not.toContain("Bash(git branch:*)");
  expect(RECEIVE_ALLOWED_TOOLS).not.toContain("EnterWorktree");
  expect(RECEIVE_ALLOWED_TOOLS).not.toContain("ExitWorktree");
  // the guarantee the receive feature rests on: assert the absence
  expect(joined).not.toContain("push");
  expect(joined).not.toContain("gh pr comment");
  expect(joined).not.toContain("gh pr review");
  expect(joined).not.toContain("gh pr merge");
  expect(joined).not.toContain("gh pr edit");
  expect(joined).not.toContain("gh pr ready");
  expect(joined).not.toContain("gh api -X");
  // extras append after the baseline
  expect(
    effectiveReceiveAllowedTools(
      bareCfg({ extra_receive_allowed_tools: ["Bash(bun test:*)"] }),
    ).at(-1),
  ).toBe("Bash(bun test:*)");
});

test("shouldAutoRun: requires receive_enabled and a non-draft PR", () => {
  expect(shouldAutoRun(bareCfg(), entry())).toEqual({
    ok: false,
    reason: "receive_enabled is off",
  });
  expect(
    shouldAutoRun(
      bareCfg({ receive_enabled: true }),
      entry({ flags: ["draft"] }),
    ),
  ).toEqual({ ok: false, reason: "PR is a draft" });
  expect(shouldAutoRun(bareCfg({ receive_enabled: true }), entry())).toEqual({
    ok: true,
  });
});

// --- the mocked end-to-end flows ---

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(
    ["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (p.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

// An origin with a reviewed `feature` branch and a clone mapped in the config.
function prScenario(sb: Sandbox, over: Partial<Config> = {}) {
  const origin = join(sb.tmp, "origin");
  mkdirSync(origin);
  git(sb.tmp, "init", "-q", "-b", "main", origin);
  writeFileSync(join(origin, "f.txt"), "one\n");
  git(origin, "add", "f.txt");
  git(origin, "commit", "-qm", "init");
  git(origin, "checkout", "-qb", "feature");
  writeFileSync(join(origin, "f.txt"), "two\n");
  git(origin, "commit", "-qam", "feature work");
  const headSha = git(origin, "rev-parse", "HEAD");
  git(origin, "checkout", "-q", "main");
  const clone = join(sb.tmp, "clone");
  git(sb.tmp, "clone", "-q", origin, clone);
  sb.writeConfig({
    orgs: ["testorg"],
    repos: { "testorg/demo": clone },
    ...over,
  });
  const mineJson = JSON.stringify({
    state: "OPEN",
    isDraft: false,
    headRefOid: headSha,
    headRefName: "feature",
    reviews: [
      {
        author: { login: "colleague" },
        state: "CHANGES_REQUESTED",
        body: "please fix",
        submittedAt: "2026-07-19T10:00:00Z",
      },
    ],
  });
  return { clone, headSha, mineJson };
}

test("feedback on an opted-in PR runs receive headlessly in a docket-owned checkout", async () => {
  const sb = makeSandbox();
  const { clone, mineJson } = prScenario(sb, { receive_enabled: true });
  sb.writeState({
    "mine:testorg/demo#7": {
      status: "open",
      title: "My PR",
      url: "u",
      branch: "feature",
      local_path: clone,
      updated_at: "2026-01-01T00:00:00Z",
    },
  });

  const r = sb.run(["sync"], { GH_PR_MINE_JSON: mineJson });
  expect(r.code).toBe(0);
  const e = await sb.waitEntry(
    "mine:testorg/demo#7",
    (x) => x.status === "ready",
  );
  expect(e.session_id).toBe("sess-1234");
  expect(e.review_at).toBe("2026-07-19T10:00:00Z");
  expect(e.reviewer).toBe("colleague");

  // the checkout is docket's own, recorded as deletable, and the run's cwd
  const expected = realpathSync(
    join(sb.stateDir, "checkouts", "testorg-demo", "feature"),
  );
  expect(realpathSync(e.checkout_path)).toBe(expected);
  expect(e.worktrees).toEqual([expected]);
  expect(realpathSync(sb.cwdCapture())).toBe(expected);

  // the receive allowlist and prompt, not the review ones
  expect(sb.allowedCapture()).toBe(RECEIVE_ALLOWED_TOOLS.join(","));
  expect(sb.promptCapture()).toContain("Address the review feedback on PR 7");
  expect(sb.promptCapture()).toContain("NEVER push");
});

test("feedback with a dirty checkout runs in a fallback, not in the user's work", async () => {
  const sb = makeSandbox();
  const { clone, mineJson } = prScenario(sb, { receive_enabled: true });
  git(clone, "checkout", "-q", "feature");
  writeFileSync(join(clone, "f.txt"), "uncommitted local work\n");
  sb.writeState({
    "mine:testorg/demo#7": {
      status: "open",
      title: "My PR",
      url: "u",
      branch: "feature",
      local_path: clone,
      updated_at: "2026-01-01T00:00:00Z",
    },
  });

  const r = sb.run(["sync"], { GH_PR_MINE_JSON: mineJson });
  expect(r.code).toBe(0);
  const e = await sb.waitEntry(
    "mine:testorg/demo#7",
    (x) => x.status === "ready",
  );
  const expected = realpathSync(
    join(sb.stateDir, "checkouts", "testorg-demo", "feature"),
  );
  expect(realpathSync(e.checkout_path)).toBe(expected);
  expect(realpathSync(sb.cwdCapture())).toBe(expected);
  // the uncommitted work is the author's: never stashed, committed, or reset
  expect(git(clone, "status", "--porcelain")).toContain("f.txt");
});

test("the entry records the fallback it ran in, and drops it once the checkout is usable", async () => {
  const sb = makeSandbox();
  const { clone, headSha, mineJson } = prScenario(sb, {
    receive_enabled: true,
  });
  git(clone, "checkout", "-q", "feature");
  writeFileSync(join(clone, "f.txt"), "uncommitted local work\n");
  sb.writeState({
    "mine:testorg/demo#7": {
      status: "open",
      branch: "feature",
      local_path: clone,
      updated_at: "2026-01-01T00:00:00Z",
    },
  });

  expect(sb.run(["sync"], { GH_PR_MINE_JSON: mineJson }).code).toBe(0);
  // recorded by the trigger and still there after the run rewrote the entry
  const e = await sb.waitEntry(
    "mine:testorg/demo#7",
    (x) => x.status === "ready",
  );
  expect(e.checkout_fallback).toEqual({
    reason: `checkout dirty: ${realpathSync(clone)}`,
  });
  expect(e.fallback_bases).toEqual({ [e.checkout_path]: headSha });

  // the author commits their work: their checkout is usable again, and the
  // entry must stop pointing the reader at a copy the run no longer used
  git(clone, "commit", "-qam", "the author's own commit");
  expect(
    sb.run(["receive", "testorg/demo#7"], { GH_PR_MINE_JSON: mineJson }).code,
  ).toBe(0);
  const after = await sb.waitEntry(
    "mine:testorg/demo#7",
    (x) => realpathSync(x.checkout_path) === realpathSync(clone),
  );
  expect("checkout_fallback" in after).toBe(false);
});

test("feedback while not opted in records the verdict only", () => {
  const sb = makeSandbox();
  const { clone, mineJson } = prScenario(sb); // receive_enabled absent
  sb.writeState({
    "mine:testorg/demo#7": {
      status: "open",
      branch: "feature",
      local_path: clone,
      updated_at: "2026-01-01T00:00:00Z",
    },
  });
  const before = sb.claudeCalls();
  expect(sb.run(["sync"], { GH_PR_MINE_JSON: mineJson }).code).toBe(0);
  const e = sb.state()["mine:testorg/demo#7"];
  expect(e.status).toBe("changes-requested");
  expect(e.checkout_path).toBeUndefined(); // nothing resolved, nothing created
  expect(sb.claudeCalls()).toBe(before);
});

test("docket receive runs regardless of receive_enabled, keys under mine:", async () => {
  const sb = makeSandbox();
  const { mineJson } = prScenario(sb); // opted out — the manual verb ignores that
  const r = sb.run(["receive", "testorg/demo#7", "skip the wording nits"], {
    GH_PR_MINE_JSON: mineJson,
  });
  expect(r.code).toBe(0);
  const e = await sb.waitEntry(
    "mine:testorg/demo#7",
    (x) => x.status === "ready",
  );
  expect(e.title).toBe("Manual PR"); // fetched via gh pr view
  expect(e.note).toBeUndefined(); // consumed by the run it was given for
  expect(sb.promptCapture()).toContain(
    "Additional context from the author: skip the wording nits",
  );
  // a URL normalizes into the same key shape
  expect(sb.run(["receive", "total garbage"]).code).not.toBe(0);

  // a now-dirty checkout of docket's own blocks the run — whatever left the
  // uncommitted work there, the next run neither throws it away nor runs on it
  writeFileSync(join(e.checkout_path, "f.txt"), "dirty\n");
  const again = sb.run(["receive", "testorg/demo#7"], {
    GH_PR_MINE_JSON: mineJson,
  });
  expect(again.code).not.toBe(0);
  // the checkout resolves before the run detaches, so this is settled here
  expect(sb.state()["mine:testorg/demo#7"].status).toBe("skipped");
  expect(git(e.checkout_path, "status", "--porcelain")).toContain("f.txt");
});

test("docket retry on a mine key with a dirty checkout runs in the fallback", async () => {
  const sb = makeSandbox();
  const { clone, mineJson } = prScenario(sb);
  git(clone, "checkout", "-q", "feature");
  writeFileSync(join(clone, "f.txt"), "uncommitted local work\n");
  sb.writeState({
    "mine:testorg/demo#7": {
      status: "skipped",
      title: "My PR",
      url: "u",
      branch: "feature",
      local_path: clone,
      updated_at: "2026-01-01T00:00:00Z",
    },
  });
  const r = sb.run(["retry", "mine:testorg/demo#7"], {
    GH_PR_MINE_JSON: mineJson,
  });
  expect(r.code).toBe(0);
  const e = await sb.waitEntry(
    "mine:testorg/demo#7",
    (x) => x.status === "ready",
  );
  expect(realpathSync(e.checkout_path)).toBe(
    realpathSync(join(sb.stateDir, "checkouts", "testorg-demo", "feature")),
  );
});

test("docket retry on a mine key that still cannot resolve reports it, exit 1", () => {
  const sb = makeSandbox();
  const { mineJson } = prScenario(sb);
  sb.writeState({
    "mine:testorg/demo#7": {
      status: "skipped",
      title: "My PR",
      url: "u",
      branch: "feature",
      local_path: join(sb.tmp, "clone-the-user-deleted"),
      updated_at: "2026-01-01T00:00:00Z",
    },
  });
  const before = sb.claudeCalls();
  const r = sb.run(["retry", "mine:testorg/demo#7"], {
    GH_PR_MINE_JSON: mineJson,
  });
  expect(r.code).toBe(1); // same contract as docket receive, not a silent 0
  expect(r.err).toContain("no local clone mapped");
  expect(sb.claudeCalls()).toBe(before);
});

test("docket receive on an unmapped repo refuses without writing state", () => {
  const sb = makeSandbox();
  sb.writeConfig({ orgs: ["testorg"], repos: {} });
  const r = sb.run(["receive", "testorg/typoed#3"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain('testorg/typoed is not mapped in "repos"');
  // no permanent skipped row lands in the mine view
  expect(sb.state()["mine:testorg/typoed#3"]).toBeUndefined();
});

test("exec re-checks the checkout before spawning claude (TOCTOU move)", () => {
  const sb = makeSandbox();
  const { clone, mineJson } = prScenario(sb, { receive_enabled: true });
  // the checkout went dirty between trigger and runner
  git(clone, "checkout", "-q", "feature");
  writeFileSync(join(clone, "f.txt"), "raced\n");
  sb.writeState({
    "mine:testorg/demo#7": {
      status: "reviewing",
      branch: "feature",
      local_path: clone,
      checkout_path: clone,
      updated_at: new Date().toISOString(),
    },
  });
  const r = sb.run(["exec", "mine:testorg/demo#7"], {
    GH_PR_MINE_JSON: mineJson,
  });
  expect(r.code).toBe(0);
  // the run moved to the fallback: the clone it was aimed at is not the cwd
  const expected = realpathSync(
    join(sb.stateDir, "checkouts", "testorg-demo", "feature"),
  );
  expect(realpathSync(sb.cwdCapture())).toBe(expected);
  expect(realpathSync(sb.state()["mine:testorg/demo#7"].checkout_path)).toBe(
    expected,
  );
});

test("poll while logged out starts no receive run and leaves the cursor put", () => {
  const sb = makeSandbox();
  const { clone, mineJson } = prScenario(sb, { receive_enabled: true });
  sb.writeState({
    "mine:testorg/demo#7": {
      status: "open",
      title: "My PR",
      url: "u",
      branch: "feature",
      local_path: clone,
      updated_at: "2026-01-01T00:00:00Z",
    },
  });

  const before = sb.claudeCalls();
  const r = sb.run(["poll"], {
    GH_PR_MINE_JSON: mineJson,
    CLAUDE_LOGGED_OUT: "1",
  });
  expect(r.code).toBe(0);
  expect(sb.claudeCalls()).toBe(before);
  // the cursor must not move past feedback no run ever addressed
  expect(sb.state()["mine:testorg/demo#7"].review_at).toBeUndefined();
  expect(sb.state()["mine:testorg/demo#7"].status).toBe("open");
});

test("a clean receive run clears the previous run's summary and denials", async () => {
  const sb = makeSandbox();
  const { clone, mineJson } = prScenario(sb);
  sb.writeState({
    "mine:testorg/demo#7": {
      status: "ready",
      title: "My PR",
      url: "u",
      branch: "feature",
      local_path: clone,
      review_at: "2026-07-19T10:00:00Z",
      reviewer: "colleague",
      session_id: "sess-old",
      summary: {
        headline: "stale headline from the run before",
        issues: 3,
        risk: "high",
      },
      denials: [
        {
          tool: "Bash",
          suggestion: "Bash(rg:*)",
          count: 2,
          examples: ["rg --files"],
          writeShaped: false,
          alreadyAllowed: false,
        },
      ],
      updated_at: "2026-01-01T00:00:00Z",
    },
  });

  const r = sb.run(["receive", "testorg/demo#7"], {
    GH_PR_MINE_JSON: mineJson,
  });
  expect(r.code).toBe(0);
  const e = await sb.waitEntry(
    "mine:testorg/demo#7",
    (x) => x.session_id === "sess-1234",
  );
  // the run that produced them is gone; its evidence must not outlive it
  expect(e.summary).toBeUndefined();
  expect(e.denials).toBeUndefined();
  // the fields the run must not lose are still there
  expect(e.review_at).toBe("2026-07-19T10:00:00Z");
  expect(e.reviewer).toBe("colleague");
  expect(e.branch).toBe("feature");
});

test("dismissing a mine entry frees its branch for the next receive", async () => {
  const sb = makeSandbox();
  const { clone, mineJson } = prScenario(sb);

  const first = sb.run(["receive", "testorg/demo#7"], {
    GH_PR_MINE_JSON: mineJson,
  });
  expect(first.code).toBe(0);
  const e = await sb.waitEntry(
    "mine:testorg/demo#7",
    (x) => x.status === "ready",
  );
  expect(e.worktrees).toEqual([realpathSync(e.checkout_path)]);

  expect(sb.run(["dismiss", "mine:testorg/demo#7"]).code).toBe(0);
  // the worktree docket created is gone, and so is the branch it created with
  // it — otherwise the next receive refuses forever
  expect(existsSync(e.checkout_path)).toBe(false);
  expect(git(clone, "branch", "--list", "feature")).toBe("");

  const again = sb.run(["receive", "testorg/demo#7"], {
    GH_PR_MINE_JSON: mineJson,
  });
  expect(again.err).not.toContain("exists locally");
  expect(again.code).toBe(0);
  await sb.waitEntry("mine:testorg/demo#7", (x) => x.status === "ready");
});

test("a dirty checkout of docket's own blocks the run, and is still docket's to clean up", async () => {
  const sb = makeSandbox();
  const { clone, mineJson } = prScenario(sb);

  expect(
    sb.run(["receive", "testorg/demo#7"], { GH_PR_MINE_JSON: mineJson }).code,
  ).toBe(0);
  const e = await sb.waitEntry(
    "mine:testorg/demo#7",
    (x) => x.status === "ready",
  );
  expect(e.branch_owned).toBe(true);
  writeFileSync(join(e.checkout_path, "f.txt"), "uncommitted\n");

  // nowhere to fall back to — docket's copy is where the fallback would go —
  // so the run is blocked out loud rather than run over the dirt
  sb.run(["receive", "testorg/demo#7"], { GH_PR_MINE_JSON: mineJson });
  const again = await sb.waitEntry(
    "mine:testorg/demo#7",
    (x) => x.status === "skipped",
  );
  expect(again.error).toBe(`checkout dirty: ${realpathSync(e.checkout_path)}`);

  expect(sb.run(["dismiss", "mine:testorg/demo#7"]).code).toBe(0);
  expect(existsSync(e.checkout_path)).toBe(false);
  expect(git(clone, "branch", "--list", "feature")).toBe("");
});

test("the branch docket created is deleted even after its worktree was removed by hand", async () => {
  const sb = makeSandbox();
  const { clone, mineJson } = prScenario(sb);

  expect(
    sb.run(["receive", "testorg/demo#7"], { GH_PR_MINE_JSON: mineJson }).code,
  ).toBe(0);
  const e = await sb.waitEntry(
    "mine:testorg/demo#7",
    (x) => x.status === "ready",
  );
  // the user tidies the state dir: the worktree goes, docket's ref stays
  git(clone, "worktree", "remove", "--force", e.checkout_path);
  expect(git(clone, "branch", "--list", "feature")).toContain("feature");

  // the next receive lands in a fallback for a branch checked out nowhere...
  expect(
    sb.run(["receive", "testorg/demo#7"], { GH_PR_MINE_JSON: mineJson }).code,
  ).toBe(0);
  const again = await sb.waitEntry(
    "mine:testorg/demo#7",
    (x) => x.status === "ready" && !!x.checkout_fallback,
  );
  expect(again.checkout_fallback.reason).toBe(
    "branch feature exists locally but isn't checked out",
  );

  // ...which does not make the ref the author's: docket created it
  expect(sb.run(["dismiss", "mine:testorg/demo#7"]).code).toBe(0);
  expect(git(clone, "branch", "--list", "feature")).toBe("");
});

test("dismissing a fallback run never deletes the author's branch", async () => {
  const sb = makeSandbox();
  const { clone, mineJson } = prScenario(sb);
  // the branch exists in the clone, checked out nowhere, and carries a commit
  // that exists nowhere else — the one fallback shape git does not protect
  const authorWt = join(sb.tmp, "author-wt");
  git(clone, "worktree", "add", "-q", authorWt, "-b", "feature");
  writeFileSync(join(authorWt, "f.txt"), "the author's unpushed work\n");
  git(authorWt, "commit", "-qam", "unpushed");
  const authorSha = git(authorWt, "rev-parse", "HEAD");
  git(clone, "worktree", "remove", authorWt);

  expect(
    sb.run(["receive", "testorg/demo#7"], { GH_PR_MINE_JSON: mineJson }).code,
  ).toBe(0);
  const e = await sb.waitEntry(
    "mine:testorg/demo#7",
    (x) => x.status === "ready",
  );
  expect(e.checkout_fallback.reason).toBe(
    "branch feature exists locally but isn't checked out",
  );

  expect(sb.run(["dismiss", "mine:testorg/demo#7"]).code).toBe(0);
  expect(existsSync(e.checkout_path)).toBe(false);
  expect(git(clone, "rev-parse", "refs/heads/feature")).toBe(authorSha);
});

test("dismiss keeps a fallback the run committed in, and says so", async () => {
  const sb = makeSandbox();
  const { clone, mineJson } = prScenario(sb);
  git(clone, "checkout", "-q", "feature");
  writeFileSync(join(clone, "f.txt"), "uncommitted local work\n");

  expect(
    sb.run(["receive", "testorg/demo#7"], { GH_PR_MINE_JSON: mineJson }).code,
  ).toBe(0);
  const e = await sb.waitEntry(
    "mine:testorg/demo#7",
    (x) => x.status === "ready",
  );
  // stand in for the agent: a commit that lives only in the fallback
  writeFileSync(join(e.checkout_path, "f.txt"), "the fix the reviewer asked\n");
  git(e.checkout_path, "commit", "-qam", "address the feedback");
  const fixSha = git(e.checkout_path, "rev-parse", "HEAD");

  const d = sb.run(["dismiss", "mine:testorg/demo#7"]);
  expect(d.code).toBe(0);
  expect(d.out).toContain(`kept ${e.checkout_path} (has commits)`);
  expect(d.out).not.toContain("could not remove");
  expect(existsSync(e.checkout_path)).toBe(true);
  // the point of a detached copy: the author reaches the commit from the clone
  expect(git(clone, "cat-file", "-t", fixSha)).toBe("commit");
});

test("a fallback's commits survive a later run that resolved in place", async () => {
  const sb = makeSandbox();
  const { clone, mineJson } = prScenario(sb);
  git(clone, "checkout", "-q", "feature");
  writeFileSync(join(clone, "f.txt"), "uncommitted local work\n");

  expect(
    sb.run(["receive", "testorg/demo#7"], { GH_PR_MINE_JSON: mineJson }).code,
  ).toBe(0);
  const e = await sb.waitEntry(
    "mine:testorg/demo#7",
    (x) => x.status === "ready",
  );
  const fallbackPath = e.checkout_path;
  writeFileSync(join(fallbackPath, "f.txt"), "the fix the reviewer asked\n");
  git(fallbackPath, "commit", "-qam", "address the feedback");
  const fixSha = git(fallbackPath, "rev-parse", "HEAD");

  // the author's checkout becomes usable: the next run happens there, and
  // the entry stops calling itself a fallback — the copy is still standing
  git(clone, "checkout", "-q", "--", "f.txt");
  expect(
    sb.run(["receive", "testorg/demo#7"], { GH_PR_MINE_JSON: mineJson }).code,
  ).toBe(0);
  const after = await sb.waitEntry(
    "mine:testorg/demo#7",
    (x) => realpathSync(x.checkout_path) === realpathSync(clone),
  );
  expect("checkout_fallback" in after).toBe(false);

  const d = sb.run(["dismiss", "mine:testorg/demo#7"]);
  expect(d.code).toBe(0);
  expect(d.out).toContain(`kept ${fallbackPath} (has commits)`);
  expect(git(clone, "cat-file", "-t", fixSha)).toBe("commit");
});

test("a checkout git can no longer read is a removal failure, not a keep", () => {
  const sb = makeSandbox();
  const { clone } = prScenario(sb);
  // the directory outlived its worktree record — a pruned admin file, a
  // restored state dir: nothing here was preserved for the author
  const stale = join(sb.tmp, "stale-fallback");
  mkdirSync(stale);
  sb.writeState({
    "mine:testorg/demo#7": {
      status: "ready",
      branch: "feature",
      local_path: clone,
      checkout_path: stale,
      worktrees: [stale],
      checkout_fallback: { reason: "checkout dirty: x" },
      fallback_bases: { [stale]: "0".repeat(40) },
      updated_at: "2026-01-01T00:00:00Z",
    },
  });

  const d = sb.run(["dismiss", "mine:testorg/demo#7"]);
  expect(d.code).toBe(0);
  expect(d.out).toContain(`could not remove ${stale}`);
  expect(d.out).not.toContain("has commits");
});

test("a newly discovered PR does not re-address the feedback it arrived with", async () => {
  const sb = makeSandbox();
  const { mineJson } = prScenario(sb, { receive_enabled: true });
  const search = JSON.stringify([
    {
      number: 7,
      title: "My PR",
      url: "https://example.test/pr/7",
      isDraft: false,
      repository: { nameWithOwner: "testorg/demo" },
    },
  ]);

  // GH_SEARCH_JSON empty: no review requests, so every claude call below is
  // the receive side's
  const env = {
    GH_MINE_SEARCH_JSON: search,
    GH_PR_MINE_JSON: mineJson,
    GH_SEARCH_JSON: "[]",
  };

  // poll 1 discovers it — the PR already carries a review from 2026-07-19
  expect(sb.run(["poll"], env).code).toBe(0);
  const discovered = sb.state()["mine:testorg/demo#7"];
  expect(discovered.status).toBe("open");
  expect(discovered.review_at).toBeTruthy();

  // poll 2 reconciles it: that review is behind the cursor, so nothing runs —
  // but the row still shows what the reviewer said
  expect(sb.claudeCalls()).toBe(0);
  expect(sb.run(["poll"], env).code).toBe(0);
  expect(sb.claudeCalls()).toBe(0);
  expect(sb.state()["mine:testorg/demo#7"].status).toBe("changes-requested");
});

test("a note applies to the run it was given for, not to every run after it", async () => {
  const sb = makeSandbox();
  const { mineJson } = prScenario(sb);

  const first = sb.run(
    ["receive", "testorg/demo#7", "skip the perf comments"],
    {
      GH_PR_MINE_JSON: mineJson,
    },
  );
  expect(first.code).toBe(0);
  await sb.waitEntry("mine:testorg/demo#7", (x) => x.status === "ready");
  expect(sb.promptCapture()).toContain(
    "Additional context from the author: skip the perf comments",
  );
  // the run it belonged to is over — a later automatic run must not inherit it
  expect(sb.state()["mine:testorg/demo#7"].note).toBeUndefined();

  const second = sb.run(["receive", "testorg/demo#7"], {
    GH_PR_MINE_JSON: mineJson,
  });
  expect(second.code).toBe(0);
  await sb.waitEntry(
    "mine:testorg/demo#7",
    (x) => x.status === "ready" && !x.note,
  );
  expect(sb.promptCapture()).not.toContain("skip the perf comments");
});
