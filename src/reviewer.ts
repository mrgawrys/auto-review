import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  ALLOWED_TOOLS,
  claudeBin,
  claudeEnv,
  effectiveReceiveAllowedTools,
  effectiveReviewPrompt,
  ghBin,
  runLogPath,
  type Config,
  type Paths,
} from "./config";
import { prepareCheckout, receivePrompt } from "./receive";
import { denialGroups, type DenialGroup } from "./denials";
import type { GhCtx } from "./github";
import type { Logger } from "./log";
import { notify } from "./notify";
import { selfArgs } from "./proc";
import { parseRunEvent, tailLines } from "./runlog";
import {
  entryKind,
  isLiveReview,
  loadState,
  patchEntry,
  setStatus,
  splitKey,
  timestamp,
  updateEntry,
  type Entry,
} from "./state";
import { SUMMARY_INSTRUCTION, splitSummary, type Summary } from "./summary";
import {
  parseWorktrees,
  pickReviewWorktrees,
  type WorktreeInfo,
} from "./worktree";

// Fixed worktree hygiene wraps a configurable task body. The preamble (work in
// an isolated worktree, never touch the main copy) and the suffix (keep it
// afterwards) are NOT configurable; only the middle is. We deliberately do not
// dictate the worktree's path — the agent follows its own conventions — and
// discover where it landed afterwards (see recordWorktrees).
export function reviewPrompt(
  number: string,
  repo: string,
  cfg: Config,
  note?: string,
): string {
  const body = effectiveReviewPrompt(cfg)
    .replaceAll("{number}", number)
    .replaceAll("{repo}", repo);
  let p =
    `Create a git worktree to review PR #${number} (fetch the PR branch ` +
    `first), following your usual worktree conventions. Do ALL branch ` +
    `checkouts and code inspection inside that worktree — never modify the ` +
    `main working copy.\n\n` +
    `${body}\n\n` +
    `Keep the worktree in place afterwards so follow-up questions can use it.` +
    `\n\n${SUMMARY_INSTRUCTION}`;
  if (note) p += `\n\nAdditional context from the reviewer: ${note}`;
  return p;
}

export interface Counters {
  started: number;
  reviewed: number;
  failed: number;
  skipped: number;
  synced: number;
}

export interface Ctx {
  cfg: Config;
  paths: Paths;
  log: Logger;
  gh: GhCtx;
  counters: Counters;
  current: { key: string; child?: { kill(sig?: number | string): void } };
}

// The PR's head commit, used to pin which freshly-created worktree is the
// review's. Best-effort: on any gh failure we return undefined and record every
// newly-appeared worktree instead (see pickReviewWorktrees).
function prHeadSha(
  ctx: Ctx,
  clone: string,
  number: string,
): string | undefined {
  const p = Bun.spawnSync(
    [ghBin(), "pr", "view", number, "--json", "headRefOid"],
    {
      cwd: clone,
      env: { ...process.env, ...ctx.gh.env } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (p.exitCode !== 0) return undefined;
  try {
    const sha = JSON.parse(p.stdout.toString()).headRefOid;
    return typeof sha === "string" && sha ? sha : undefined;
  } catch {
    return undefined;
  }
}

// List a clone's registered worktrees (absolute paths + head/branch), or [].
function listWorktrees(clone: string): WorktreeInfo[] {
  const p = Bun.spawnSync(
    ["git", "-C", clone, "worktree", "list", "--porcelain"],
    { stdout: "pipe", stderr: "pipe" },
  );
  return p.exitCode === 0 ? parseWorktrees(p.stdout.toString()) : [];
}

// Legacy/orphan fallback for entries written before we recorded worktree paths:
// match any registered worktree named pr-<number> (the old convention, and the
// native `.claude/worktrees/pr-N` layout).
function legacyWorktrees(clone: string, number: string): string[] {
  return listWorktrees(clone)
    .map((w) => w.path)
    .filter((p) => basename(p) === `pr-${number}`);
}

// A worktree cleanup left standing, and why — a deliberate keep reads nothing
// like a failure to the person who asked for the dismissal.
export type Kept = { path: string; reason: "failed" | "has-commits" };

const headOf = (wt: string): string =>
  Bun.spawnSync(["git", "-C", wt, "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  })
    .stdout.toString()
    .trim();

// Remove one worktree, or say what it left standing. A fallback whose HEAD has
// moved off the PR head it was created at holds commits that exist nowhere
// else until the author cherry-picks them: that one is kept, not removed.
function removeWorktree(
  ctx: Ctx,
  clone: string,
  wt: string,
  entry: Entry | undefined,
  key: string,
  logPrefix: string,
): Kept | null {
  if (!existsSync(wt)) return null; // already gone; prune will drop the admin record
  const fb = entry?.checkout_fallback;
  if (fb && entry?.checkout_path === wt && headOf(wt) !== fb.base) {
    ctx.log(`${logPrefix} ${key}: kept worktree ${wt} — it has commits`);
    return { path: wt, reason: "has-commits" };
  }
  const p = Bun.spawnSync(
    ["git", "-C", clone, "worktree", "remove", "--force", wt],
    { stderr: "pipe" },
  );
  appendFileSync(ctx.paths.logPath, p.stderr.toString());
  ctx.log(
    p.exitCode === 0
      ? `${logPrefix} ${key}: removed worktree ${wt}`
      : `${logPrefix} ${key}: could not remove worktree ${wt}`,
  );
  return p.exitCode === 0 ? null : { path: wt, reason: "failed" };
}

// Retire an entry's on-disk artifacts: its run log and the worktree(s) the
// review created — by their recorded absolute paths, wherever the agent put
// them, falling back to the pr-<number> convention for legacy entries.
// Returns the worktrees still standing: the log records them, but only a
// caller can put them somewhere the user is actually looking.
export function cleanupEntry(ctx: Ctx, key: string, logPrefix: string): Kept[] {
  rmSync(runLogPath(ctx.paths, key), { force: true });
  const { number } = splitKey(key);
  const entry = loadState(ctx.paths.statePath)[key];
  const clone = entry?.local_path;
  if (!clone || !existsSync(clone)) return [];

  const recorded = entry?.worktrees ?? [];
  // The pr-<number> fallback exists for review entries written before paths
  // were recorded. A mine entry's checkout may be the user's own worktree —
  // only what worktrees[] records (docket-created) may ever be deleted.
  const targets =
    recorded.length || entryKind(key) === "mine"
      ? recorded
      : legacyWorktrees(clone, number);
  const kept = targets
    .map((wt) => removeWorktree(ctx, clone, wt, entry, key, logPrefix))
    .filter((k) => k !== null);

  Bun.spawnSync(["git", "-C", clone, "worktree", "prune"], { stderr: "pipe" });

  // A checkout docket created also created its branch (`worktree add -b`), and
  // `worktree remove` leaves that ref behind — which makes every later receive
  // for the same PR refuse with "exists locally but isn't checked out". Only
  // the branch of a checkout we own is ever deleted; the user's own worktree
  // is not in worktrees[] and its branch is not ours to touch. A fallback is
  // owned but detached — it created no branch, so that ref is the author's.
  const ownedCheckout =
    !!entry?.checkout_path && recorded.includes(entry.checkout_path);
  if (
    entryKind(key) === "mine" &&
    entry?.branch &&
    ownedCheckout &&
    !entry.checkout_fallback &&
    !kept.length
  ) {
    const d = Bun.spawnSync(
      ["git", "-C", clone, "branch", "-D", entry.branch],
      { stderr: "pipe" },
    );
    if (d.exitCode === 0)
      ctx.log(`${logPrefix} ${key}: deleted branch ${entry.branch}`);
  }
  return kept;
}

// Mark the PR as reviewing and hand it to a detached `docket exec` runner.
// Detached = own process group: ctrl+c on the caller and launchd's cleanup of
// an exiting poll can't kill an in-flight review, and N runners go in parallel.
export type StartResult =
  | "started"
  | "skipped"
  | "already-running"
  | "spawn-failed";

// The one no-local-clone skip policy, shared by spawner and runner.
async function skipNoClone(
  ctx: Ctx,
  key: string,
  extra: Partial<Entry>,
): Promise<void> {
  ctx.log(`SKIP ${key}: no local clone mapped`);
  patchEntry(ctx.paths.statePath, key, { status: "skipped", ...extra });
  await notify(ctx.cfg, "docket: no local clone", key);
  ctx.counters.skipped++;
}

export async function startReview(
  ctx: Ctx,
  key: string,
  repo: string,
  title: string,
  url: string,
  note?: string,
): Promise<StartResult> {
  const { statePath } = ctx.paths;
  const localPath = ctx.cfg.repos[repo];

  if (!localPath || !existsSync(localPath)) {
    await skipNoClone(ctx, key, { title, url });
    return "skipped";
  }

  const existing = loadState(statePath)[key];
  if (existing && isLiveReview(existing)) {
    ctx.log(`SKIP ${key}: already being reviewed (pid ${existing.pid})`);
    return "already-running";
  }

  updateEntry(statePath, key, () => ({
    status: "reviewing",
    title,
    url,
    local_path: localPath,
    ...(note !== undefined ? { note } : {}),
    updated_at: timestamp(),
  }));

  return spawnRunner(ctx, key);
}

// Detach a `docket exec <key>` runner for an entry already marked reviewing.
// Shared by review starts and the receive trigger — the run core is the same.
export function spawnRunner(ctx: Ctx, key: string): StartResult {
  const { statePath } = ctx.paths;
  const argv = selfArgs("exec", key);
  const fd = openSync(ctx.paths.logPath, "a");
  const child = spawn(argv[0]!, argv.slice(1), {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: process.env as Record<string, string>,
  });
  child.unref();
  closeSync(fd);

  if (child.pid === undefined) {
    setStatus(statePath, key, "failed", "could not spawn review runner");
    ctx.counters.failed++;
    return "spawn-failed";
  }
  const pid = child.pid;
  // guard: with a fast review the runner may already have written its result
  updateEntry(statePath, key, (e) =>
    e && e.status === "reviewing" ? { ...e, pid } : e!,
  );
  ctx.log(`STARTED ${key} — background runner pid ${pid}`);
  ctx.counters.started++;
  return "started";
}

// Everything that differs between a review run and a receive run; the spawn,
// tee, tail-parse, notify, and status writes are shared.
export type RunPlan = {
  prompt: string;
  allowedTools: string[];
  cwd: string;
  // review: discover the worktree the agent created after the run; mine:
  // docket resolved the checkout itself, there is nothing to discover.
  discoverWorktrees: boolean;
  // notification + log prefix
  label: "review" | "receive";
};

export function runPlan(ctx: Ctx, key: string, entry: Entry): RunPlan {
  const { repo, number } = splitKey(key);
  if (entryKind(key) === "mine") {
    return {
      prompt: receivePrompt(ctx.cfg, key, entry, entry.note),
      allowedTools: effectiveReceiveAllowedTools(ctx.cfg),
      cwd: entry.checkout_path ?? "",
      discoverWorktrees: false,
      label: "receive",
    };
  }
  return {
    prompt: reviewPrompt(number, repo, ctx.cfg, entry.note),
    allowedTools: [ALLOWED_TOOLS, ...(ctx.cfg.extra_allowed_tools ?? [])],
    cwd: entry.local_path ?? ctx.cfg.repos[repo] ?? "",
    discoverWorktrees: true,
    label: "review",
  };
}

// The body of one run — runs inside the detached `docket exec` process.
export async function execReview(ctx: Ctx, key: string): Promise<number> {
  const { statePath } = ctx.paths;
  let entry = loadState(statePath)[key];
  if (!entry) {
    console.error(`unknown key: ${key} — start it with: docket review ${key}`);
    return 1;
  }
  if (isLiveReview(entry, process.pid)) {
    ctx.log(`SKIP ${key}: already being reviewed (pid ${entry.pid})`);
    return 0;
  }
  const { repo, number } = splitKey(key);
  const localPath = entry.local_path ?? ctx.cfg.repos[repo];
  const title = entry.title ?? "";

  if (!localPath || !existsSync(localPath)) {
    await skipNoClone(ctx, key, {});
    return 1;
  }

  if (entryKind(key) === "mine") {
    // TOCTOU guard: the checkout can change between the trigger's resolve and
    // this spawn — a now-blocked checkout downgrades the run to skipped.
    const prep = prepareCheckout(ctx, key, entry);
    if (!prep.ok) {
      ctx.log(`SKIP ${key}: ${prep.reason}`);
      patchEntry(statePath, key, { status: "skipped", error: prep.reason });
      await notify(ctx.cfg, "docket: receive blocked", prep.reason);
      ctx.counters.skipped++;
      return 1;
    }
    entry = loadState(statePath)[key] ?? entry; // fresh checkout_path
  }

  const plan = runPlan(ctx, key, entry);
  patchEntry(statePath, key, {
    status: "reviewing",
    local_path: localPath,
    pid: process.pid,
  });
  ctx.current.key = key;
  ctx.log(
    `${plan.label.toUpperCase()} ${key} in ${plan.cwd} — headless run, this takes a few minutes`,
  );

  // Snapshot before the agent runs so we can tell which worktree it creates.
  const sha = plan.discoverWorktrees
    ? prHeadSha(ctx, localPath, number)
    : undefined;
  const worktreesBefore = plan.discoverWorktrees
    ? listWorktrees(localPath).map((w) => w.path)
    : [];

  // gh.env carries GH_TOKEN when gh_account is pinned — claude runs gh itself
  const env = { ...ctx.gh.env, ...claudeEnv(ctx.cfg) };
  const runLog = runLogPath(ctx.paths, key);
  mkdirSync(dirname(runLog), { recursive: true });
  const proc = Bun.spawn(
    [
      claudeBin(ctx.cfg),
      "-p",
      plan.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      plan.allowedTools.join(","),
    ],
    { cwd: plan.cwd, env, stdout: "pipe", stderr: "pipe" },
  );
  // Exposed so a SIGINT/SIGTERM handler can kill the child promptly — spawnSync
  // would otherwise block the JS thread until claude exits on its own.
  ctx.current.child = proc;
  const stderrDone = new Response(proc.stderr).text();
  // tee progress into the run log as it happens — `docket` watches this file
  const fd = openSync(runLog, "w");
  try {
    for await (const chunk of proc.stdout) writeSync(fd, chunk);
  } finally {
    closeSync(fd);
  }
  const exitCode = await proc.exited;
  ctx.current.child = undefined;
  appendFileSync(ctx.paths.logPath, await stderrDone);

  // Discover the worktree the agent made (any location) and record it so
  // cleanupEntry can remove it later. Persisted after the status write below,
  // which rewrites the entry wholesale.
  const worktrees = plan.discoverWorktrees
    ? pickReviewWorktrees(worktreesBefore, listWorktrees(localPath), sha)
    : [];

  // Best-effort: a denial is worth surfacing, but never at the cost of the
  // status write below, which must land whatever this does.
  let denials: DenialGroup[] | undefined;
  try {
    const groups = denialGroups(
      readFileSync(runLog, "utf8"),
      ctx.cfg,
      entryKind(key),
    );
    if (groups.length) denials = groups;
  } catch {}

  let sessionId = "";
  let summary: Summary | undefined;
  if (exitCode === 0) {
    // a well-formed run ends with a stream-json result event carrying the session
    const ev = parseRunEvent(tailLines(runLog, 1)[0] ?? "");
    if (ev?.type === "result") {
      sessionId = ev.session_id ?? "";
      summary = splitSummary(ev.result ?? "").summary;
    }
  }

  const url = entry.url ?? "";
  // A capitalized label for the notification title: "Review" | "Receive".
  const Label = plan.label[0]!.toUpperCase() + plan.label.slice(1);
  // Review entries are rewritten wholesale, as they always were. Mine entries
  // carry fields the run must not lose (branch, checkout_path, review_at,
  // reviewer, worktrees, flags) — for them, keep everything but the run's own
  // leftovers. summary and denials belong to the finished run and are patched
  // back on below: kept here, a clean run would inherit the last run's
  // headline and denial list. note is the same — it was written for this run,
  // and a review entry already loses it by being rewritten wholesale.
  const carry = (e: Entry | undefined): Partial<Entry> => {
    if (entryKind(key) !== "mine" || !e) return {};
    const {
      error: _error,
      pid: _pid,
      session_id: _sid,
      summary: _summary,
      denials: _denials,
      note: _note,
      ...rest
    } = e;
    return rest;
  };
  if (sessionId) {
    updateEntry(statePath, key, (e) => ({
      ...carry(e),
      status: "ready",
      session_id: sessionId,
      title,
      url,
      local_path: localPath,
      updated_at: timestamp(),
    }));
    ctx.log(`READY ${key} session=${sessionId} — run \`docket\` to open it`);
    await notify(ctx.cfg, `${Label} ready: ${key}`, title);
    ctx.counters.reviewed++;
  } else {
    updateEntry(statePath, key, (e) => ({
      ...carry(e),
      status: "failed",
      title,
      url,
      local_path: localPath,
      error: "claude run failed, see docket.log",
      updated_at: timestamp(),
    }));
    ctx.log(
      `FAILED ${key} — retry with: docket retry ${key}, or check your setup: docket doctor`,
    );
    await notify(ctx.cfg, `${Label} FAILED: ${key}`, title);
    ctx.counters.failed++;
  }
  // Both are discovered facts about the finished run, and the status writes
  // above rewrite the entry wholesale — so they are patched on afterwards.
  const patch: Partial<Entry> = {};
  if (worktrees.length) patch.worktrees = worktrees;
  if (summary) patch.summary = summary;
  if (denials) patch.denials = denials;
  if (Object.keys(patch).length) patchEntry(statePath, key, patch);
  ctx.current.key = "";
  return 0;
}
