// Worktree bookkeeping for reviews. The review agent creates the worktree
// wherever its own conventions dictate (we no longer dictate a path), so we
// identify the one it made by diffing `git worktree list` around the run and
// matching the PR's head sha. Cleanup then removes it by its recorded path,
// wherever it landed.

export interface WorktreeInfo {
  path: string;
  head?: string;
  branch?: string;
  detached?: boolean;
  prunable?: boolean; // registered, but its directory is gone
}

// Parse `git worktree list --porcelain`: records separated by blank lines,
// each a set of "key value" (or bare "detached") lines.
export function parseWorktrees(porcelain: string): WorktreeInfo[] {
  const out: WorktreeInfo[] = [];
  let cur: WorktreeInfo | null = null;
  for (const line of porcelain.split("\n")) {
    if (line === "") {
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    const sp = line.indexOf(" ");
    const key = sp === -1 ? line : line.slice(0, sp);
    const val = sp === -1 ? "" : line.slice(sp + 1);
    if (key === "worktree") cur = { path: val };
    else if (!cur) continue;
    else if (key === "HEAD") cur.head = val;
    else if (key === "branch") cur.branch = val;
    else if (key === "detached") cur.detached = true;
    else if (key === "prunable") cur.prunable = true;
  }
  if (cur) out.push(cur);
  return out;
}

// The worktree(s) this review created: present after but not before, and — when
// we know the PR head sha — checked out at it. Without a sha (gh unavailable),
// every freshly-appeared worktree is recorded; better to over-record than leak,
// since removal is idempotent.
export function pickReviewWorktrees(
  before: string[],
  after: WorktreeInfo[],
  sha?: string,
): string[] {
  const seen = new Set(before);
  const fresh = after.filter((w) => !seen.has(w.path));
  const picked = sha ? fresh.filter((w) => w.head === sha) : fresh;
  return picked.map((w) => w.path);
}
