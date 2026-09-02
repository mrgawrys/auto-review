import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCheckout } from "../src/checkout";

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

test("dirty checkout blocks, never creates a second copy", () => {
  const s = scenario();
  git(s.clone, "checkout", "-q", "feature");
  writeFileSync(join(s.clone, "f.txt"), "uncommitted\n");
  const r = resolve(s);
  expect(r).toEqual({
    ok: false,
    reason: `checkout dirty: ${realpathSync(s.clone)}`,
  });
  // and nothing landed under checkoutsDir
  expect(
    git(s.clone, "worktree", "list", "--porcelain").includes("checkouts"),
  ).toBe(false);
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

test("checkout diverged from the PR head blocks", () => {
  const s = scenario();
  git(s.clone, "checkout", "-q", "feature");
  writeFileSync(join(s.clone, "f.txt"), "rewritten\n");
  git(s.clone, "commit", "-q", "--amend", "-am", "feature work, amended");
  const r = resolve(s);
  expect(r).toEqual({
    ok: false,
    reason: `checkout diverged from PR head: ${realpathSync(s.clone)}`,
  });
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

test("branch exists locally but checked out nowhere: blocked in plain words", () => {
  const s = scenario();
  git(s.clone, "branch", "feature", "origin/feature"); // no checkout anywhere
  const r = resolve(s);
  expect(r).toEqual({
    ok: false,
    reason: "branch feature exists locally but isn't checked out",
  });
  // and nothing landed under checkoutsDir
  expect(
    git(s.clone, "worktree", "list", "--porcelain").includes("checkouts"),
  ).toBe(false);
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
