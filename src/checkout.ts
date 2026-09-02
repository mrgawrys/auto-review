// Resolve the working copy for a PR branch: the user's clone, the user's
// worktree, or one docket creates under checkoutsDir. A checkout holding the
// PR head is used in place, unpushed commits and all; one of the user's that
// cannot be used — dirty, diverged, or checked out nowhere — gets a detached
// copy of docket's own at the PR head, never a second branch.

import { existsSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { parseWorktrees } from "./worktree";

export type CheckoutResult =
  | {
      ok: true;
      path: string;
      owned: boolean; // created by docket (this call, or previously under checkoutsDir)
      // set when path is docket's copy instead of the user's checkout: the PR
      // head it stands for, and why the user's was passed over
      fallback?: { base: string; reason: string };
    }
  | { ok: false; reason: string };

interface GitResult {
  ok: boolean;
  code: number;
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
    code: p.exitCode,
    out: p.stdout.toString().trim(),
    err: p.stderr.toString().trim(),
  };
}

// `merge-base --is-ancestor` answers by exit code: 0 yes, 1 no. Anything
// higher is git failing to answer, so a caller testing `ok` alone would read a
// broken repo as a "no" verdict.
function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
): { yes: boolean; err?: GitResult } {
  const r = git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
  return r.code > 1 ? { yes: false, err: r } : { yes: r.code === 0 };
}

const fail = (what: string, r: GitResult): CheckoutResult => ({
  ok: false,
  reason: `${what}: ${r.err || r.out || "git failed"}`,
});

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
  reason: string,
): CheckoutResult {
  const path = slugPath(checkoutsDir, branch);
  if (!git(clone, ["cat-file", "-e", `${headSha}^{commit}`]).ok) {
    const fetch = git(clone, ["fetch", "origin", branch]);
    if (!fetch.ok) return fail("git fetch", fetch);
  }

  const list = git(clone, ["worktree", "list", "--porcelain"]);
  if (!list.ok) return fail("git worktree list", list);
  const done = (): CheckoutResult => ({
    ok: true,
    path: real(path),
    owned: true,
    fallback: { base: headSha, reason },
  });

  if (parseWorktrees(list.out).some((w) => real(w.path) === real(path))) {
    const status = git(path, ["status", "--porcelain"]);
    if (!status.ok) return fail("git status", status);
    // Reset only a copy holding nothing the PR is missing — an earlier run may
    // have committed here and nobody has picked those commits up yet.
    const spent = !status.out && isAncestor(path, "HEAD", headSha).yes;
    if (spent) {
      const co = git(path, ["checkout", "--detach", headSha]);
      if (!co.ok) return fail("git checkout --detach", co);
    }
    return done();
  }

  const add = git(clone, ["worktree", "add", "--detach", path, headSha]);
  if (!add.ok) return fail("git worktree add", add);
  return done();
}

export function resolveCheckout(
  clone: string,
  branch: string,
  headSha: string,
  checkoutsDir: string,
): CheckoutResult {
  const list = git(clone, ["worktree", "list", "--porcelain"]);
  if (!list.ok) return fail("git worktree list", list);
  const worktrees = parseWorktrees(list.out);
  const found = worktrees.find((w) => w.branch === `refs/heads/${branch}`);
  // A copy docket already owns needs no fallback: it is docket's to work in as
  // it stands, and it holds the branch docket created — labelling it a
  // fallback would tell cleanup that ref is the author's and leak it.
  const fallback = (reason: string): CheckoutResult =>
    found && under(found.path, checkoutsDir)
      ? { ok: true, path: found.path, owned: true }
      : fallbackWorktree(clone, branch, headSha, checkoutsDir, reason);

  if (found) {
    const path = found.path;
    const status = git(path, ["status", "--porcelain"]);
    if (!status.ok) return fail("git status", status);
    if (status.out) return fallback(`checkout dirty: ${path}`);

    // The PR head may be newer than anything fetched yet — without its object
    // the ancestry check below can only error out.
    if (!git(path, ["cat-file", "-e", `${headSha}^{commit}`]).ok) {
      const fetch = git(clone, ["fetch", "origin", branch]);
      if (!fetch.ok) return fail("git fetch", fetch);
    }

    // Unpushed commits on top of the PR head are usable, and so is a checkout
    // behind it — only a history the PR head is missing from entirely is not,
    // which takes the question in both directions.
    const contains = isAncestor(path, headSha, "HEAD");
    if (contains.err) return fail("git merge-base", contains.err);
    if (!contains.yes) {
      const behind = isAncestor(path, "HEAD", headSha);
      if (behind.err) return fail("git merge-base", behind.err);
      if (!behind.yes)
        return fallback(`checkout diverged from PR head: ${path}`);
    }

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
  const add = git(clone, [
    "worktree",
    "add",
    "--track",
    "-b",
    branch,
    path,
    `origin/${branch}`,
  ]);
  if (!add.ok) return fail("git worktree add", add);
  // realpath, to match what `git worktree list` will report on the next call —
  // otherwise the same checkout gets recorded twice under two spellings.
  return { ok: true, path: real(path), owned: true };
}
