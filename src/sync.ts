import {
  ghUser,
  prMineInfo,
  prThreads,
  prView,
  type PrMineInfo,
} from "./github";
import { feedbackNotification, notify } from "./notify";
import { prepareCheckout, shouldAutoRun } from "./receive";
import {
  cleanupEntry,
  spawnRunner,
  type Ctx,
  type StartResult,
} from "./reviewer";
import {
  isLiveReview,
  bareKey,
  entryKind,
  loadState,
  markDone,
  markReviewed,
  patchEntry,
  splitKey,
  type Entry,
  type Verdict,
} from "./state";

export interface PrSyncInfo {
  state: string;
  latestReviews?: {
    author?: { login?: string };
    state?: string;
    submittedAt?: string;
  }[];
  reviewRequests?: { login?: string }[];
  commits?: { committedDate?: string }[];
}

export type SyncDecision =
  | { kind: "unchanged" }
  | { kind: "done"; reason: "merged" | "closed" }
  | { kind: "reviewed"; verdict: Verdict; reviewedAt: string; flags: string[] };

export function decideSync(info: PrSyncInfo, me: string): SyncDecision {
  if (info.state === "MERGED") return { kind: "done", reason: "merged" };
  if (info.state === "CLOSED") return { kind: "done", reason: "closed" };
  const rev = (info.latestReviews ?? []).find((r) => r.author?.login === me);
  if (!rev) return { kind: "unchanged" };
  const verdict = (rev.state ?? "")
    .toLowerCase()
    .replaceAll("_", "-") as Verdict;
  const flags: string[] = [];
  if ((info.reviewRequests ?? []).some((r) => r.login === me))
    flags.push("re-requested");
  const lastCommit = (info.commits ?? []).at(-1)?.committedDate ?? "";
  if (lastCommit > (rev.submittedAt ?? "")) flags.push("new-commits");
  return {
    kind: "reviewed",
    verdict,
    reviewedAt: rev.submittedAt ?? "",
    flags,
  };
}

export type MineSyncDecision =
  | { kind: "done" }
  | {
      kind: "feedback";
      at: string;
      verdict: "approved" | "changes-requested" | "commented";
      // Who left the review the verdict came from — the panel shows it, and
      // the TUI never fetches, so sync records it on the entry.
      reviewer: string;
    }
  | { kind: "none" };

// Verdict severity for "the worst actionable state wins".
const VERDICT_RANK: Record<Verdict, number> = {
  "changes-requested": 2,
  commented: 1,
  approved: 0,
};

// The PR's standing as its reviewers currently see it: each other reviewer's
// latest review, worst verdict wins (newest on ties). This is what the row
// shows — the cursor below decides what to act on, never what to display, so
// an approval older than docket's discovery of the PR still reads "approved".
export function mineStanding(
  info: PrMineInfo,
  me: string,
): { verdict: Verdict; reviewer: string } | undefined {
  const latest = new Map<string, PrMineInfo["reviews"][number]>();
  for (const r of info.reviews) {
    if (r.author === me || !(toVerdict(r.state) in VERDICT_RANK)) continue;
    const prev = latest.get(r.author);
    if (!prev || r.submittedAt > prev.submittedAt) latest.set(r.author, r);
  }
  if (latest.size === 0) return undefined;
  const worst = [...latest.values()].reduce((a, b) => {
    const diff =
      VERDICT_RANK[toVerdict(b.state)] - VERDICT_RANK[toVerdict(a.state)];
    return diff > 0 || (diff === 0 && b.submittedAt > a.submittedAt) ? b : a;
  });
  return { verdict: toVerdict(worst.state), reviewer: worst.author };
}

// Statuses that describe the PR rather than a run: only these give way to
// the standing. A run in flight or finished keeps telling its own story.
const VERDICT_STATES = new Set<string>([
  "open",
  "approved",
  "changes-requested",
  "commented",
]);

// Actionable feedback on the user's PR: a review by someone else, newer than
// the entry's cursor, that is not a bare comment-less approval.
export function decideMineSync(
  info: PrMineInfo,
  me: string,
  entry: Entry,
): MineSyncDecision {
  if (info.state === "MERGED" || info.state === "CLOSED")
    return { kind: "done" };
  const cursor = entry.review_at ?? "";
  const actionable = info.reviews.filter(
    (r) =>
      r.author !== me &&
      r.submittedAt > cursor &&
      (r.state === "CHANGES_REQUESTED" ||
        r.state === "COMMENTED" ||
        (r.state === "APPROVED" && r.body.trim() !== "")),
  );
  if (actionable.length === 0) return { kind: "none" };
  // Verdict and reviewer both come from the worst review (newest of the worst
  // on ties), so "X requested changes" is always something X actually did. The
  // cursor still advances past the newest review, whoever left it.
  const worst = actionable.reduce((a, b) => {
    const diff =
      VERDICT_RANK[toVerdict(b.state)] - VERDICT_RANK[toVerdict(a.state)];
    return diff > 0 || (diff === 0 && b.submittedAt > a.submittedAt) ? b : a;
  });
  const newest = actionable.reduce((a, b) =>
    b.submittedAt > a.submittedAt ? b : a,
  );
  return {
    kind: "feedback",
    at: newest.submittedAt,
    verdict: toVerdict(worst.state),
    reviewer: worst.author,
  };
}

const toVerdict = (state: string): Verdict =>
  state.toLowerCase().replaceAll("_", "-") as Verdict;

// What happens when actionable feedback lands, after syncMine has recorded
// the verdict and advanced the cursor. Injectable so tests can pin it.
export type TriggerReceive = (
  ctx: Ctx,
  key: string,
  entry: Entry,
) => Promise<void>;

// The automatic path: opt-in, never on drafts. When the gate says no, the
// verdict syncMine already wrote is the whole reaction.
export const triggerReceive: TriggerReceive = async (ctx, key, entry) => {
  const gate = shouldAutoRun(ctx.cfg, entry);
  if (!gate.ok) {
    ctx.log(`SYNC ${key}: not auto-running (${gate.reason})`);
    return;
  }
  await startReceive(ctx, key, entry);
};

// Resolve the checkout and hand the key to a detached receive runner — the
// shared body of the automatic trigger, `docket receive`, and the R verb.
export async function startReceive(
  ctx: Ctx,
  key: string,
  entry: Entry,
  note?: string,
): Promise<StartResult> {
  const { statePath } = ctx.paths;
  if (isLiveReview(entry)) {
    ctx.log(
      `SKIP ${key}: a receive run is already in flight (pid ${entry.pid})`,
    );
    return "already-running";
  }
  if (note !== undefined) patchEntry(statePath, key, { note });
  const prep = prepareCheckout(ctx, key, entry);
  if (!prep.ok) {
    ctx.log(`SKIP ${key}: ${prep.reason}`);
    patchEntry(statePath, key, { status: "skipped", error: prep.reason });
    await notify(ctx.cfg, "docket: receive blocked", prep.reason);
    ctx.counters.skipped++;
    return "skipped";
  }
  patchEntry(statePath, key, { status: "reviewing" });
  return spawnRunner(ctx, key);
}

async function syncMine(
  ctx: Ctx,
  key: string,
  entry: Entry,
  me: string,
  trigger: TriggerReceive,
): Promise<void> {
  const { statePath } = ctx.paths;
  const { repo, number } = splitKey(key);
  const info = prMineInfo(ctx.gh, repo, number);
  if (!info) {
    ctx.log(`SYNC ${key}: gh pr view failed, leaving entry as-is`);
    return;
  }
  const d = decideMineSync(info, me, entry);
  if (d.kind === "done") {
    await retire(ctx, key, info.state === "MERGED" ? "merged" : "closed");
    return;
  }

  // Drafts flip to ready-for-review, and a force-recreated PR can change its
  // head branch — refresh both from what gh just said.
  const flags = (entry.flags ?? []).filter((f) => f !== "draft");
  if (info.isDraft) flags.push("draft");
  const changed =
    flags.join(" ") !== (entry.flags ?? []).join(" ") ||
    (info.headRefName !== "" && info.headRefName !== entry.branch);
  if (changed) {
    patchEntry(statePath, key, {
      flags,
      ...(info.headRefName ? { branch: info.headRefName } : {}),
    });
    entry = loadState(statePath)[key] ?? entry;
  }

  const standing = mineStanding(info, me);
  if (
    standing &&
    VERDICT_STATES.has(entry.status) &&
    (standing.verdict !== entry.status || standing.reviewer !== entry.reviewer)
  ) {
    patchEntry(statePath, key, {
      status: standing.verdict,
      reviewer: standing.reviewer,
    });
    entry = loadState(statePath)[key] ?? entry;
  }

  // The thread counts ride along on every sync: resolving a thread is not a
  // review event, so nothing else would notice it.
  const threads = prThreads(ctx.gh, repo, number);
  if (
    threads &&
    (threads.unresolved !== entry.threads?.unresolved ||
      threads.total !== entry.threads?.total)
  ) {
    patchEntry(statePath, key, { threads });
    entry = loadState(statePath)[key] ?? entry;
  }

  if (d.kind !== "feedback") return;
  // Advance the cursor and record their verdict before acting: the same
  // review must never re-trigger, even if the trigger path crashes.
  patchEntry(statePath, key, {
    status: d.verdict,
    review_at: d.at,
    reviewer: d.reviewer,
  });
  ctx.log(`SYNC ${key}: ${d.reviewer} left feedback (${d.verdict})`);
  ctx.counters.synced++;
  const n = feedbackNotification(bareKey(key), d.verdict, d.reviewer);
  await notify(ctx.cfg, n.title, n.body);
  await trigger(ctx, key, loadState(statePath)[key] ?? entry);
}

// The PR is over: mark the entry done and retire what the review left on
// disk. A copy kept for its commits is the one thing the user must hear about
// now — the entry is about to leave every list they look at.
async function retire(
  ctx: Ctx,
  key: string,
  reason: "merged" | "closed",
): Promise<void> {
  markDone(ctx.paths.statePath, key, reason);
  const held = cleanupEntry(ctx, key, "SYNC")
    .filter((k) => k.reason === "has-commits")
    .map((k) => k.path);
  ctx.log(`SYNC ${key}: PR ${reason} — marked done`);
  if (held.length)
    await notify(
      ctx.cfg,
      `docket: ${bareKey(key)} ${reason}`,
      `kept ${held.join(", ")} — it has commits to cherry-pick`,
    );
  ctx.counters.synced++;
}

export async function reconcile(
  ctx: Ctx,
  trigger: TriggerReceive = triggerReceive,
): Promise<void> {
  const { statePath } = ctx.paths;
  const active = Object.entries(loadState(statePath)).filter(
    ([, e]) => e.status !== "done" && e.status !== "reviewing",
  );
  if (active.length === 0) return;

  const me = ghUser(ctx.gh);
  if (!me) {
    ctx.log("sync: cannot resolve GitHub login, skipping");
    return;
  }

  for (const [key, entry] of active) {
    if (entryKind(key) === "mine") {
      await syncMine(ctx, key, entry, me, trigger);
      continue;
    }
    const { repo, number } = splitKey(key);
    const info = prView<PrSyncInfo>(
      ctx.gh,
      repo,
      number,
      "state,latestReviews,reviewRequests,commits",
    );
    if (!info) {
      ctx.log(`SYNC ${key}: gh pr view failed, leaving entry as-is`);
      continue;
    }
    const d = decideSync(info, me);
    if (d.kind === "done") {
      await retire(ctx, key, d.reason);
    } else if (d.kind === "reviewed") {
      const cur = `${entry.status} ${(entry.flags ?? []).join(" ")}`;
      const next = `${d.verdict} ${d.flags.join(" ")}`;
      if (cur !== next) {
        markReviewed(statePath, key, d.verdict, d.reviewedAt, d.flags);
        ctx.log(
          `SYNC ${key}: you reviewed (${d.verdict})${d.flags.length ? ` [${d.flags.join(" ")}]` : ""}`,
        );
        ctx.counters.synced++;
      }
    }
  }
}
