import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CheckoutResult, resolveCheckout } from "../src/checkout";

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(
    ["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (p.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

// An origin with a `feature` branch, a clone of it, and an empty checkouts dir.
function scenario() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "docket-co-")));
  const origin = join(tmp, "origin");
  git(tmp, "init", "-q", "-b", "main", origin);
  writeFileSync(join(origin, "f.txt"), "one\n");
  git(origin, "add", "f.txt");
  git(origin, "commit", "-qm", "init");
  git(origin, "checkout", "-qb", "feature");
  writeFileSync(join(origin, "f.txt"), "two\n");
  git(origin, "commit", "-qam", "feature work");
  const headSha = git(origin, "rev-parse", "HEAD");
  git(origin, "checkout", "-q", "main");
  const clone = join(tmp, "clone");
  git(tmp, "clone", "-q", origin, clone);
  const checkoutsDir = join(tmp, "checkouts");
  return { tmp, origin, clone, headSha, checkoutsDir };
}

const resolve = (s: ReturnType<typeof scenario>) =>
  resolveCheckout(s.clone, "feature", s.headSha, s.checkoutsDir);

// Every unusable checkout lands in the same place: docket's own detached copy
// at the PR head, under checkoutsDir.
function expectFallback(
  s: ReturnType<typeof scenario>,
  r: CheckoutResult,
  reason: string,
): void {
  if (!r.ok) throw new Error(r.reason);
  expect(r.path).toBe(realpathSync(join(s.checkoutsDir, "feature")));
  expect(r.owned).toBe(true);
  expect(r.fallback).toEqual({ base: s.headSha, reason });
  expect(git(r.path, "rev-parse", "HEAD")).toBe(s.headSha);
  expect(git(r.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
}

test("branch checked out in the clone itself: reused, not owned", () => {
  const s = scenario();
  git(s.clone, "checkout", "-q", "feature");
  const r = resolve(s);
  expect(r).toEqual({ ok: true, path: realpathSync(s.clone), owned: false });
});

test("branch in a user worktree: reused, not owned", () => {
  const s = scenario();
  const wt = join(s.tmp, "user-wt");
  git(s.clone, "worktree", "add", "-q", wt, "feature");
  const r = resolve(s);
  if (!r.ok) throw new Error(r.reason);
  expect(realpathSync(r.path)).toBe(realpathSync(wt));
  expect(r.owned).toBe(false);
});

test("dirty checkout falls back, leaving the uncommitted work alone", () => {
  const s = scenario();
  git(s.clone, "checkout", "-q", "feature");
  writeFileSync(join(s.clone, "f.txt"), "uncommitted\n");
  expectFallback(s, resolve(s), `checkout dirty: ${realpathSync(s.clone)}`);
  expect(git(s.clone, "status", "--porcelain")).toContain("f.txt");
});

test("checkout with unpushed commits on top of the PR head is used in place", () => {
  const s = scenario();
  git(s.clone, "checkout", "-q", "feature");
  writeFileSync(join(s.clone, "f.txt"), "local work\n");
  git(s.clone, "commit", "-qam", "local commit");
  const local = git(s.clone, "rev-parse", "HEAD");
  const r = resolve(s);
  expect(r).toEqual({ ok: true, path: realpathSync(s.clone), owned: false });
  // the unpushed commit is still HEAD: nothing reset it, nothing merged it away
  expect(git(s.clone, "rev-parse", "HEAD")).toBe(local);
});

test("checkout diverged from the PR head falls back, branch untouched", () => {
  const s = scenario();
  git(s.clone, "checkout", "-q", "feature");
  writeFileSync(join(s.clone, "f.txt"), "rewritten\n");
  git(s.clone, "commit", "-q", "--amend", "-am", "feature work, amended");
  const amended = git(s.clone, "rev-parse", "HEAD");
  expectFallback(
    s,
    resolve(s),
    `checkout diverged from PR head: ${realpathSync(s.clone)}`,
  );
  // the rewritten history is the author's only copy of it
  expect(git(s.clone, "rev-parse", "refs/heads/feature")).toBe(amended);
});

test("checkout behind the PR head fast-forwards (fetching the new sha)", () => {
  const s = scenario();
  git(s.clone, "checkout", "-q", "feature");
  // origin's feature moves after the clone: the new head is not local yet
  git(s.origin, "checkout", "-q", "feature");
  writeFileSync(join(s.origin, "f.txt"), "three\n");
  git(s.origin, "commit", "-qam", "more feature work");
  const newHead = git(s.origin, "rev-parse", "HEAD");
  git(s.origin, "checkout", "-q", "main");
  const r = resolveCheckout(s.clone, "feature", newHead, s.checkoutsDir);
  expect(r).toEqual({ ok: true, path: realpathSync(s.clone), owned: false });
  expect(git(s.clone, "rev-parse", "HEAD")).toBe(newHead);
});

test("branch exists locally but checked out nowhere: falls back, ref left alone", () => {
  const s = scenario();
  git(s.clone, "branch", "feature", "origin/feature"); // no checkout anywhere
  expectFallback(
    s,
    resolve(s),
    "branch feature exists locally but isn't checked out",
  );
  expect(git(s.clone, "rev-parse", "refs/heads/feature")).toBe(s.headSha);
});

test("a fallback the run committed in comes back at its own HEAD, not reset", () => {
  const s = scenario();
  git(s.clone, "checkout", "-q", "feature");
  writeFileSync(join(s.clone, "f.txt"), "uncommitted\n");
  const first = resolve(s);
  if (!first.ok) throw new Error(first.reason);
  writeFileSync(join(first.path, "f.txt"), "the agent's fix\n");
  git(first.path, "commit", "-qam", "agent commit");
  const agentSha = git(first.path, "rev-parse", "HEAD");

  const again = resolve(s);
  if (!again.ok) throw new Error(again.reason);
  expect(again.path).toBe(first.path);
  expect(git(again.path, "rev-parse", "HEAD")).toBe(agentSha);
  // base stays the PR head, so a caller can still see the copy is ahead of it
  expect(again.fallback).toEqual({
    base: s.headSha,
    reason: `checkout dirty: ${realpathSync(s.clone)}`,
  });
});

test("a clean fallback behind the PR head is reset to it", () => {
  const s = scenario();
  git(s.clone, "checkout", "-q", "feature");
  writeFileSync(join(s.clone, "f.txt"), "uncommitted\n");
  const first = resolve(s);
  if (!first.ok) throw new Error(first.reason);

  // the PR gains a commit the fallback has never seen
  git(s.origin, "checkout", "-q", "feature");
  writeFileSync(join(s.origin, "f.txt"), "three\n");
  git(s.origin, "commit", "-qam", "more feature work");
  const newHead = git(s.origin, "rev-parse", "HEAD");
  git(s.origin, "checkout", "-q", "main");

  const again = resolveCheckout(s.clone, "feature", newHead, s.checkoutsDir);
  if (!again.ok) throw new Error(again.reason);
  expect(again.path).toBe(first.path);
  expect(git(again.path, "rev-parse", "HEAD")).toBe(newHead);
  expect(again.fallback?.base).toBe(newHead);
});

test("a leftover fallback is reused once the branch has vanished from the clone", () => {
  const s = scenario();
  git(s.clone, "branch", "feature", "origin/feature");
  const first = resolve(s); // checked out nowhere: a detached fallback
  if (!first.ok) throw new Error(first.reason);
  // the author deletes the branch: docket's copy now sits exactly where the
  // tracking worktree would go, and `worktree add` would only say "exists"
  git(s.clone, "branch", "-D", "feature");
  expectFallback(s, resolve(s), "branch feature exists nowhere locally");
});

test("branch absent everywhere: created under checkoutsDir, tracking, owned", () => {
  const s = scenario();
  const r = resolve(s);
  if (!r.ok) throw new Error(r.reason);
  expect(r.owned).toBe(true);
  expect(realpathSync(r.path).startsWith(realpathSync(s.tmp))).toBe(true);
  expect(r.path).toBe(join(s.checkoutsDir, "feature"));
  expect(git(r.path, "rev-parse", "HEAD")).toBe(s.headSha);
  expect(git(r.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
  // tracks the remote branch
  expect(git(r.path, "config", "branch.feature.remote")).toBe("origin");
  expect(git(r.path, "config", "branch.feature.merge")).toBe(
    "refs/heads/feature",
  );

  // found again on the next call: still owned, no second copy
  const again = resolve(s);
  if (!again.ok) throw new Error(again.reason);
  expect(realpathSync(again.path)).toBe(realpathSync(r.path));
  expect(again.owned).toBe(true);
});

test("docket's own tracking worktree, gone dirty, is reused as itself", () => {
  const s = scenario();
  const first = resolve(s); // absent everywhere: docket creates it, on the branch
  if (!first.ok) throw new Error(first.reason);
  writeFileSync(join(first.path, "f.txt"), "uncommitted\n");

  const again = resolve(s);
  expect(again).toEqual({ ok: true, path: first.path, owned: true });
  // a fallback here would tell cleanup the branch is the author's, and docket
  // would leak the ref it created
  expect(git(first.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
});

test("docket's own tracking worktree, diverged, is reused as itself", () => {
  const s = scenario();
  const first = resolve(s);
  if (!first.ok) throw new Error(first.reason);
  writeFileSync(join(first.path, "f.txt"), "the agent's fix\n");
  git(first.path, "commit", "-qam", "agent commit");
  const agentSha = git(first.path, "rev-parse", "HEAD");

  // the PR head is rewritten under it
  git(s.origin, "checkout", "-q", "feature");
  git(s.origin, "commit", "-q", "--amend", "-m", "feature work, amended");
  const newHead = git(s.origin, "rev-parse", "HEAD");
  git(s.origin, "checkout", "-q", "main");

  const again = resolveCheckout(s.clone, "feature", newHead, s.checkoutsDir);
  expect(again).toEqual({ ok: true, path: first.path, owned: true });
  expect(git(first.path, "rev-parse", "HEAD")).toBe(agentSha);
  expect(git(first.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
});
