import { existsSync } from "node:fs";
import {
  claudeBin,
  claudeEnv,
  effectiveAllowedTools,
  effectiveReceiveAllowedTools,
  runLogPath,
  type Config,
  type Paths,
} from "./config";
import { isAllowed, isWriteShaped, type DenialGroup } from "./denials";
import { handoffPrompt } from "./handoff";
import { cleanupEntry, type Ctx, type Kept } from "./reviewer";
import {
  isLiveReview,
  loadState,
  normalizeKey,
  pendingEntries,
  setStatus,
  splitKey,
  type Entry,
  type EntryKind,
} from "./state";
import type { SuspendRequest } from "./tui/suspend";

export function buildResume(
  entry: Entry,
  cfg: Config,
  kind: EntryKind = "review",
):
  | { argv: string[]; cwd: string; env: Record<string, string> }
  | { error: string } {
  if (entry.status === "reviewing") {
    return {
      error:
        kind === "mine"
          ? "still addressing the feedback — w watches it live, K kills it"
          : "still being reviewed — w watches it live, K kills it",
    };
  }
  // claude stores sessions under a slug of the directory it ran in: a review
  // ran in the clone, a receive run in the PR's checkout — resume in the same.
  const cwd = kind === "mine" ? entry.checkout_path : entry.local_path;
  if (!entry.session_id || !cwd) {
    return {
      error: `no session (${entry.status}) — r retries, docket doctor checks your setup`,
    };
  }
  // A session id outlives the directory it ran in: delete the checkout by hand
  // and enter would spawn claude in a cwd that no longer exists.
  if (!existsSync(cwd)) {
    return {
      error:
        kind === "mine"
          ? `checkout is gone (${cwd}) — R resolves a new one`
          : `worktree is gone (${cwd}) — r re-reviews`,
    };
  }
  return {
    argv: [claudeBin(cfg), "--resume", entry.session_id],
    cwd,
    env: claudeEnv(cfg),
  };
}

// The mine-view fallback when there is no session to resume but the PR's
// branch has a checkout: a bare interactive claude, started where the work is.
export function buildFreshChat(
  entry: Entry,
  cfg: Config,
): SuspendRequest | { error: string } {
  if (!entry.checkout_path || !existsSync(entry.checkout_path)) {
    return { error: `no checkout yet (${entry.status}) — R resolves one` };
  }
  return {
    argv: [claudeBin(cfg)],
    cwd: entry.checkout_path,
    env: claudeEnv(cfg),
    banner: `claude in ${entry.checkout_path}`,
    interactive: true,
  };
}

// The footer input behind `n`: a pasted PR URL or ORG/REPO#N, optionally
// followed by a note. Pure, so bad input becomes a footer message, not a key
// that silently does nothing.
export function parsePrInput(
  input: string,
  cfg: Config,
): { key: string; note?: string } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { error: "paste a PR URL or ORG/REPO#N" };
  const space = trimmed.search(/\s/);
  const ref = space === -1 ? trimmed : trimmed.slice(0, space);
  const note = space === -1 ? undefined : trimmed.slice(space + 1).trim();
  let key: string;
  try {
    key = normalizeKey(ref);
  } catch (e) {
    return { error: (e as Error).message };
  }
  const { repo } = splitKey(key);
  if (!(repo in cfg.repos)) {
    return { error: `${repo} is not mapped in "repos" — add its clone path` };
  }
  return { key, ...(note ? { note } : {}) };
}

// Shared with the TUI's `unavailable` check, so the reason greyed in the
// legend and the reason a keypress reports are never two different sentences.
export const NO_CLONE_REASON = "no clone — nothing to run claude in";

// The escape hatch for what the denials panel's one-key apply can't settle:
// launches claude directly, in default permission mode, so the user answers
// any permission prompt an edit would trigger — never docket. `cfg` should be
// the freshest one available (`liveCfg` in the TUI), since a just-applied
// suggestion belongs in the prompt.
export function buildHandoff(
  entry: Entry,
  cfg: Config,
  paths: Paths,
  key: string,
  groups: DenialGroup[],
  kind: EntryKind = "review",
):
  | { argv: string[]; cwd: string; env: Record<string, string> }
  | { error: string } {
  if (!entry.local_path) {
    return { error: NO_CLONE_REASON };
  }
  if (!groups.length) {
    return { error: "no denials to hand off" };
  }
  const logPath = runLogPath(paths, key);
  const prompt = handoffPrompt({
    key,
    // Both flags were frozen when the run finished. The prompt states its own
    // "current extra_allowed_tools" a few lines further down, so a stale
    // already-allowed would hand claude two contradictory facts.
    groups: groups.map((g) => ({
      ...g,
      writeShaped: isWriteShaped(g.suggestion) || g.writeShaped,
      alreadyAllowed: isAllowed(g.suggestion, cfg, kind),
    })),
    configPath: paths.configPath,
    extraAllowedTools:
      (kind === "mine"
        ? cfg.extra_receive_allowed_tools
        : cfg.extra_allowed_tools) ?? [],
    effectiveAllowedTools:
      kind === "mine"
        ? effectiveReceiveAllowedTools(cfg).join(",")
        : effectiveAllowedTools(cfg),
    runLogPath: logPath,
    runLogExists: existsSync(logPath),
  });
  return {
    // no --permission-mode: a default session hits a real prompt on any edit,
    // which is the enforcement half of "research only, change nothing"
    argv: [claudeBin(cfg), prompt],
    cwd: entry.local_path,
    env: claudeEnv(cfg),
  };
}

// Both of these are driven from the TUI, where console output is displaced
// above the frame — so they report by returning, and the caller decides
// whether that lands in a status line or on stdout.
export function dismissKey(ctx: Ctx, key: string): string {
  setStatus(ctx.paths.statePath, key, "done");
  const kept = cleanupEntry(ctx, key, "DISMISS");
  const pathsWith = (reason: Kept["reason"]) =>
    kept.filter((k) => k.reason === reason).map((k) => k.path);
  const held = pathsWith("has-commits");
  const failed = pathsWith("failed");
  const notes = [
    ...(held.length ? [`kept ${held.join(", ")} (has commits)`] : []),
    ...(failed.length ? [`could not remove ${failed.join(", ")}`] : []),
  ];
  return notes.length
    ? `dismissed ${key} — ${notes.join("; ")}`
    : `dismissed ${key}`;
}

export function killEntry(
  ctx: Ctx,
  key: string,
): { code: number; message: string } {
  const e = loadState(ctx.paths.statePath)[key];
  if (!e || !isLiveReview(e)) {
    return { code: 1, message: `${key}: no live review to kill` };
  }
  try {
    process.kill(e.pid!, "SIGTERM"); // the runner's handler marks the entry canceled
  } catch {
    // reconcileOrphans will settle the entry
    return { code: 1, message: `${key}: runner already exited` };
  }
  return {
    code: 0,
    message: `${key}: killed — it will show as canceled; r re-runs it`,
  };
}

// Bare `docket` without a terminal: the TUI cannot mount, so print what it
// would have shown — both sections, in the TUI's order.
export function printPending(ctx: Ctx): number {
  const state = loadState(ctx.paths.statePath);
  const review = pendingEntries(state, "review");
  const mine = pendingEntries(state, "mine");
  if (!review.length && !mine.length) {
    console.log("no pending reviews");
    return 0;
  }
  const section = (label: string, rows: [string, Entry][]) => {
    if (!rows.length) return;
    console.log(`${label}:`);
    for (const [key, e] of rows) {
      console.log([key, e.status, e.title ?? ""].join("\t").trimEnd());
    }
  };
  section("queue", review);
  section("mine", mine);
  return 0;
}
