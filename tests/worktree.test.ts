import { expect, test } from "bun:test";
import { parseWorktrees, pickReviewWorktrees } from "../src/worktree";

const PORCELAIN = `worktree /Users/x/Work/recruitee
HEAD aaaa
branch refs/heads/master

worktree /Users/x/Work/recruitee/.claude/worktrees/pr-19373
HEAD bbbb
detached

worktree /Users/x/Work/worktrees/recruitee-pr-42
HEAD cccc
branch refs/heads/some-feature
`;

test("parseWorktrees: reads path, head, and branch/detached from porcelain", () => {
  const w = parseWorktrees(PORCELAIN);
  expect(w).toHaveLength(3);
  expect(w[0]).toMatchObject({ path: "/Users/x/Work/recruitee", head: "aaaa" });
  expect(w[1]).toMatchObject({
    path: "/Users/x/Work/recruitee/.claude/worktrees/pr-19373",
    head: "bbbb",
    detached: true,
  });
  expect(w[2]).toMatchObject({
    path: "/Users/x/Work/worktrees/recruitee-pr-42",
    head: "cccc",
    branch: "refs/heads/some-feature",
  });
});

test("parseWorktrees: a registered worktree whose directory is gone is marked prunable", () => {
  const w = parseWorktrees(`${PORCELAIN}
worktree /Users/x/Work/worktrees/gone
HEAD dddd
detached
prunable gitdir file points to non-existent location
`);
  expect(w.map((x) => !!x.prunable)).toEqual([false, false, false, true]);
});

test("pickReviewWorktrees: only worktrees that are new AND at the PR head sha", () => {
  const before = ["/Users/x/Work/recruitee"];
  const after = parseWorktrees(PORCELAIN);
  // PR head is cccc → only the freshly-created recruitee-pr-42 is the review's
  expect(pickReviewWorktrees(before, after, "cccc")).toEqual([
    "/Users/x/Work/worktrees/recruitee-pr-42",
  ]);
});

test("pickReviewWorktrees: a pre-existing worktree at the sha is not claimed", () => {
  const after = parseWorktrees(PORCELAIN);
  const before = after.map((w) => w.path); // nothing is new
  expect(pickReviewWorktrees(before, after, "cccc")).toEqual([]);
});

test("pickReviewWorktrees: without a sha, records every newly-appeared worktree", () => {
  const before = ["/Users/x/Work/recruitee"];
  const after = parseWorktrees(PORCELAIN);
  expect(pickReviewWorktrees(before, after, undefined)).toEqual([
    "/Users/x/Work/recruitee/.claude/worktrees/pr-19373",
    "/Users/x/Work/worktrees/recruitee-pr-42",
  ]);
});
