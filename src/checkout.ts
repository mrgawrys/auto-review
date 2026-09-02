// Resolve the working copy for a PR branch: the user's clone, the user's
// worktree, or one docket creates under checkoutsDir. A checkout holding the
// PR head is used in place, unpushed commits and all; one of the user's that
// cannot be used — dirty, diverged, or checked out nowhere — gets a detached
// copy of docket's own at the PR head, never a second branch.

import { existsSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { parseWorktrees, type WorktreeInfo } from "./worktree";

export type CheckoutResult =
  | {
      ok: true;
      path: string;
      owned: boolean; // created by docket (this call, or previously under checkoutsDir)
      // the one path that creates the branch (`worktree add -b`) — that ref
      // is docket's to delete at cleanup, wherever later runs end up
      ownsBranch?: boolean;
      // set when path is docket's copy instead of the user's checkout: the PR
      // head it stands for, and why the user's was passed over
      fallback?: { base: string; reason: string };
    }
  | { ok: false; reason: string };

interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

function git(cwd: string, args: string[]): GitResult {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: p.exitCode === 0,
    out: p.stdout.toString().trim(),
    err: p.stderr.toString().trim(),
  };
}

const fail = (what: string, r: GitResult): CheckoutResult => ({
  ok: false,
  reason: `${what}: ${r.err || r.out || "git failed"}`,
});

// How the checkout at cwd relates to the PR head: commits of headSha it is
// missing, and commits of its own that headSha lacks.
function compare(
  cwd: string,
  headSha: string,
): { missing: number; ahead: number } | { err: GitResult } {
  const r = git(cwd, [
    "rev-list",
    "--left-right",
    "--count",
    `${headSha}...HEAD`,
  ]);
  if (!r.ok) return { err: r };
  const [missing = 0, ahead = 0] = r.out.split(/\s+/).map(Number);
  return { missing, ahead };
}

// tmpdirs and home directories are routinely symlinked (macOS /tmp) while git
// reports real paths — compare like with like.
const real = (p: string): string => (existsSync(p) ? realpathSync(p) : p);

const under = (path: string, dir: string): boolean => {
  const d = real(dir);
  return real(path) === d || real(path).startsWith(d + sep);
};

const slugPath = (checkoutsDir: string, branch: string): string =>
  join(checkoutsDir, branch.replace(/[^A-Za-z0-9._-]/g, "-"));

// docket's own copy of the PR head, for when the user's checkout cannot be
// used. Detached on purpose: a branch here would collide with the author's ref
// and hand cleanup one of theirs to delete.
function fallbackWorktree(
  clone: string,
  branch: string,
  headSha: string,
  checkoutsDir: string,
  worktrees: WorktreeInfo[],
  reason: string,
): CheckoutResult {
  const path = slugPath(checkoutsDir, branch);
  if (!git(clone, ["cat-file", "-e", `${headSha}^{commit}`]).ok) {
    const fetch = git(clone, ["fetch", "origin", branch]);
    if (!fetch.ok) return fail("git fetch", fetch);
  }
  const done = (): CheckoutResult => ({
    ok: true,
    path: real(path),
    owned: true,
    fallback: { base: headSha, reason },
  });

  const leftover = worktrees.find((w) => real(w.path) === real(path));
  if (leftover) {
    // slugPath folds `feat/x` and `feat-x` into one directory: a worktree
    // here on a branch is another PR's tracking checkout, not a copy to reuse.
    if (!leftover.detached)
      return {
        ok: false,
        reason: `${path} holds ${leftover.branch ?? "another branch"}, not a copy for ${branch}`,
      };
    const status = git(path, ["status", "--porcelain"]);
    if (!status.ok) return fail("git status", status);
    const c = compare(path, headSha);
    if ("err" in c) return fail("git rev-list", c.err);
    // Reset only a copy holding nothing the PR is missing. One holding an
    // earlier run's unpicked work is reused as it stands while it still
    // contains the PR head — and refused once it doesn't, since the agent and
    // the keep guard would be told it stands at a head it never reached.
    const held = !!status.out || c.ahead > 0;
    if (held && c.missing > 0)
      return {
        ok: false,
        reason: `${path} holds unpicked work from an earlier run and is behind the PR head — cherry-pick its commits, then remove the worktree`,
      };
    if (!held) {
      const co = git(path, ["checkout", "--detach", headSha]);
      if (!co.ok) return fail("git checkout --detach", co);
    }
    return done();
  }

  const add = addWorktree(clone, ["--detach", path, headSha]);
  if (!add.ok) return fail("git worktree add", add);
  return done();
}

// A worktree whose directory is gone stays registered until pruned, and
// `worktree add` refuses its path — prune first.
function addWorktree(clone: string, args: string[]): GitResult {
  git(clone, ["worktree", "prune"]);
  return git(clone, ["worktree", "add", ...args]);
}

export function resolveCheckout(
  clone: string,
  branch: string,
  headSha: string,
  checkoutsDir: string,
): CheckoutResult {
  const list = git(clone, ["worktree", "list", "--porcelain"]);
  if (!list.ok) return fail("git worktree list", list);
  const worktrees = parseWorktrees(list.out).filter((w) => !w.prunable);
  const found = worktrees.find((w) => w.branch === `refs/heads/${branch}`);
  // A copy docket already owns is docket's own tracking worktree, and its
  // path is where the fallback would go: nothing to fall back to, so the
  // verdict is reported instead of a run on whatever it holds.
  const fallback = (reason: string): CheckoutResult =>
    found && under(found.path, checkoutsDir)
      ? { ok: false, reason }
      : fallbackWorktree(
          clone,
          branch,
          headSha,
          checkoutsDir,
          worktrees,
          reason,
        );

  if (found) {
    const path = found.path;
    const status = git(path, ["status", "--porcelain"]);
    if (!status.ok) return fail("git status", status);
    if (status.out) return fallback(`checkout dirty: ${path}`);

    // The PR head may be newer than anything fetched yet — without its object
    // the comparison below can only error out.
    if (!git(path, ["cat-file", "-e", `${headSha}^{commit}`]).ok) {
      const fetch = git(clone, ["fetch", "origin", branch]);
      if (!fetch.ok) return fail("git fetch", fetch);
    }

    // Unpushed commits on top of the PR head are usable, and so is a checkout
    // behind it — only a history the PR head is missing from entirely is not.
    const c = compare(path, headSha);
    if ("err" in c) return fail("git rev-list", c.err);
    if (c.missing > 0 && c.ahead > 0)
      return fallback(`checkout diverged from PR head: ${path}`);

    if (found.head !== headSha) {
      const ff = git(path, ["merge", "--ff-only", headSha]);
      if (!ff.ok) return fail("git merge --ff-only", ff);
    }
    return { ok: true, path, owned: under(path, checkoutsDir) };
  }

  // A local branch that is checked out nowhere is still the user's work —
  // `worktree add -b` would refuse it anyway, and taking it over would put
  // docket's cleanup in charge of a branch the author owns.
  if (
    git(clone, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok
  )
    return fallback(`branch ${branch} exists locally but isn't checked out`);

  // The branch exists nowhere locally: fetch it and give it a worktree of
  // docket's own, tracking the remote branch. Only this path is owned — the
  // caller records it in worktrees[], the set of paths docket may delete.
  const fetch = git(clone, ["fetch", "origin", branch]);
  if (!fetch.ok) return fail("git fetch", fetch);
  const path = slugPath(checkoutsDir, branch);
  // A leftover detached copy sits where the tracking worktree would go, and
  // `worktree add` only reports "already exists" — reuse it instead.
  if (worktrees.some((w) => real(w.path) === real(path)))
    return fallback(`branch ${branch} exists nowhere locally`);
  const add = addWorktree(clone, [
    "--track",
    "-b",
    branch,
    path,
    `origin/${branch}`,
  ]);
  if (!add.ok) return fail("git worktree add", add);
  // realpath, to match what `git worktree list` will report on the next call —
  // otherwise the same checkout gets recorded twice under two spellings.
  return { ok: true, path: real(path), owned: true, ownsBranch: true };
}
