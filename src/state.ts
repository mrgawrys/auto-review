import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { DenialGroup } from "./denials";
import type { Logger } from "./log";
import { pidAlive } from "./proc";
import type { Summary } from "./summary";

export type Verdict = "approved" | "changes-requested" | "commented";
export type Status =
  | "reviewing"
  | "ready"
  | "failed"
  | "canceled"
  | "skipped"
  | "done"
  | "open"
  | Verdict;

// Which world an entry belongs to: "review" — a PR awaiting the user's review
// (bare org/repo#N keys); "mine" — a PR the user authored ("mine:" prefix).
export type EntryKind = "review" | "mine";

export interface Entry {
  status: Status;
  title?: string;
  url?: string;
  local_path?: string;
  session_id?: string;
  pid?: number;
  error?: string;
  flags?: string[];
  done_reason?: "merged" | "closed";
  // The review event this entry last accounted for — review kind: the user's
  // own review of someone's PR; mine kind: someone else's review of the
  // user's PR. Sync only acts on reviews submitted after this cursor.
  review_at?: string;
  // Mine entries: the PR's head branch, captured at poll time so TUI
  // keypresses resolve checkouts without a gh round-trip.
  branch?: string;
  // Mine entries: the resolved working copy for the PR branch — the user's
  // clone, the user's worktree, or docket's own. Openers, enter, and the
  // receive runner's cwd all read it.
  checkout_path?: string;
  // Set when checkout_path is docket's own detached copy rather than the
  // user's checkout: base is the PR head it was created at, so a HEAD past it
  // means the run committed work that lives nowhere else yet.
  checkout_fallback?: { base: string; reason: string };
  // Mine entries: who left the newest actionable review. The panel shows it,
  // and the TUI never fetches — so sync records it here.
  reviewer?: string;
  // Review threads on the user's own PR, as of the last sync: the unresolved
  // count is what the row shows where a review row shows its issue count.
  threads?: { unresolved: number; total: number };
  note?: string;
  // Absolute paths of git worktrees this review created, discovered after the
  // run wherever the agent put them; cleanupEntry removes exactly these.
  worktrees?: string[];
  // Parsed once when the review finishes, so the queue renders from state
  // alone instead of reading a run log per row.
  summary?: Summary;
  // Parsed once from the run log too, for the same reason; absent when the
  // run had no denials.
  denials?: DenialGroup[];
  updated_at: string;
}

export type State = Record<string, Entry>;

export function timestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function ensureState(statePath: string): void {
  mkdirSync(dirname(statePath), { recursive: true });
  // size check mirrors the bash original's self-heal for a truncated/empty state.json
  if (!existsSync(statePath) || statSync(statePath).size === 0)
    writeFileSync(statePath, "{}\n");
}

export function loadState(statePath: string): State {
  ensureState(statePath);
  const s = JSON.parse(readFileSync(statePath, "utf8")) as State;
  // review_at used to be called my_review_at; migrate on read, so the old
  // name dies on the next save.
  for (const e of Object.values(s)) {
    const legacy = e as Entry & { my_review_at?: string };
    if (legacy.my_review_at !== undefined) {
      e.review_at ??= legacy.my_review_at;
      delete legacy.my_review_at;
    }
  }
  return s;
}

export function saveState(statePath: string, s: State): void {
  const tmp = `${statePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  renameSync(tmp, statePath);
}

// Parallel background runners update state concurrently; a plain
// read-modify-write would lose whichever update lands first.
function withStateLock<T>(statePath: string, fn: () => T): T {
  const lockDir = `${statePath}.lock`;
  let deadline = Date.now() + 5000;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch {
      if (Date.now() > deadline) {
        // holder died mid-write; the critical section is milliseconds
        rmSync(lockDir, { recursive: true, force: true });
        deadline = Date.now() + 5000;
        continue;
      }
      Bun.sleepSync(5);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

export function updateEntry(
  statePath: string,
  key: string,
  fn: (e: Entry | undefined) => Entry,
): void {
  withStateLock(statePath, () => {
    const s = loadState(statePath);
    s[key] = fn(s[key]);
    saveState(statePath, s);
  });
}

// Merge a patch over the existing entry (or a fresh one) and stamp updated_at,
// so callers never hand-roll the missing-entry default or the timestamp.
export function patchEntry(
  statePath: string,
  key: string,
  patch: Partial<Entry>,
): void {
  updateEntry(
    statePath,
    key,
    (e) =>
      ({
        ...(e ?? { updated_at: "" }),
        ...patch,
        updated_at: timestamp(),
      }) as Entry,
  );
}

export function setStatus(
  statePath: string,
  key: string,
  status: Status,
  error?: string,
): void {
  patchEntry(statePath, key, {
    status,
    ...(error !== undefined ? { error } : {}),
  });
}

export function markDone(
  statePath: string,
  key: string,
  reason: "merged" | "closed",
): void {
  patchEntry(statePath, key, { status: "done", done_reason: reason });
}

export function markReviewed(
  statePath: string,
  key: string,
  verdict: Verdict,
  reviewedAt: string,
  flags: string[],
): void {
  patchEntry(statePath, key, {
    status: verdict,
    review_at: reviewedAt,
    flags,
  });
}

// The one definition of "this review is running"; exceptPid lets the exec
// runner ignore its own pid when checking for a rival.
export function isLiveReview(e: Entry, exceptPid?: number): boolean {
  return (
    e.status === "reviewing" &&
    e.pid !== undefined &&
    e.pid !== exceptPid &&
    pidAlive(e.pid)
  );
}

export function liveRunners(s: State): string[] {
  return Object.entries(s)
    .filter(([, e]) => isLiveReview(e))
    .map(([k]) => k);
}

export function pendingEntries(s: State, kind?: EntryKind): [string, Entry][] {
  return Object.entries(s)
    .filter(([, e]) => e.status !== "done")
    .filter(([k]) => kind === undefined || entryKind(k) === kind)
    .sort(([, a], [, b]) => a.updated_at.localeCompare(b.updated_at));
}

// The stored status is shared between the two kinds of entry; the word the
// user reads is not. A run on one of their own PRs addresses feedback — it
// never reviews — and its finished state is fixes waiting for their eyes.
const MINE_STATUS_LABEL: Partial<Record<Status, string>> = {
  reviewing: "addressing",
  ready: "fixes ready",
};

export function statusLabel(key: string, status: Status): string {
  return entryKind(key) === "mine"
    ? (MINE_STATUS_LABEL[status] ?? status)
    : status;
}

export function entryKind(key: string): EntryKind {
  return key.startsWith("mine:") ? "mine" : "review";
}

// The key without its kind prefix; identity for review keys. gh must never
// see the prefix — splitKey strips it too.
export function bareKey(key: string): string {
  return key.startsWith("mine:") ? key.slice("mine:".length) : key;
}

export function normalizeKey(input: string): string {
  const prefix = input.startsWith("mine:") ? "mine:" : "";
  let key = input.slice(prefix.length);
  const url = key.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (url) key = `${url[1]}/${url[2]}#${url[3]}`;
  // No colon survives past the prefix: today "mine:org/repo#N" without this
  // would silently parse with "mine:org" as the org.
  if (key.includes(":") || !/^[^/#\s]+\/[^/#\s]+#\d+$/.test(key)) {
    throw new Error(
      `cannot parse '${input}' — expected ORG/REPO#NUM or a GitHub PR URL` +
        ` (optionally prefixed mine:)`,
    );
  }
  return prefix + key;
}

export function splitKey(key: string): { repo: string; number: string } {
  const bare = bareKey(key);
  const i = bare.lastIndexOf("#");
  return { repo: bare.slice(0, i), number: bare.slice(i + 1) };
}

export function reconcileOrphans(statePath: string, log: Logger): void {
  const s = loadState(statePath);
  for (const [key, e] of Object.entries(s)) {
    if (e.status !== "reviewing") continue;
    if (isLiveReview(e)) continue; // live background runner
    // a just-spawned runner records its pid within moments — give it a grace period
    if (
      e.pid === undefined &&
      Date.now() - Date.parse(e.updated_at) < 2 * 60_000
    )
      continue;
    setStatus(statePath, key, "failed", "previous run died mid-review");
    log(
      `ORPHAN ${key}: previous run died mid-review, marked failed — retry with: docket retry ${key}`,
    );
  }
}
