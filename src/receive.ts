// The receive side of the review loop: build the prompt a receive run gets,
// gate the automatic path, and resolve+record the checkout it runs in.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveCheckout } from "./checkout";
import { effectiveReceivePrompt, type Config, type Paths } from "./config";
import { prMineInfo } from "./github";
// type-only: receive.ts must not pull the runner in at runtime (reviewer.ts
// imports this module for the mine RunPlan)
import type { Ctx } from "./reviewer";
import { patchEntry, splitKey, type Entry } from "./state";
import { RECEIVE_SUMMARY_INSTRUCTION } from "./summary";

// Fixed checkout hygiene wraps a configurable task body, exactly like the
// review prompt: the preamble (stay in the checkout, no push, no GitHub
// writes) and the summary demand are NOT configurable; only the middle is.
export function receivePrompt(
  cfg: Config,
  key: string,
  entry: Entry,
  note?: string,
): string {
  const { repo, number } = splitKey(key);
  const body = effectiveReceivePrompt(cfg)
    .replaceAll("{number}", number)
    .replaceAll("{repo}", repo);
  let p =
    `You are addressing code review feedback on PR #${number} (${repo}), in ` +
    `the checkout of its branch at ${entry.checkout_path ?? "."} — the ` +
    `current directory. Work ONLY in this checkout; never touch any other ` +
    `working copy. You may edit files and commit locally. NEVER push, and ` +
    `NEVER write to GitHub (no comments, no reviews, no API mutations) — ` +
    `the author reviews your work and pushes themselves.\n\n` +
    `The feedback lives in three places; read all of them first: inline ` +
    `thread comments via \`gh api repos/${repo}/pulls/${number}/comments\`, ` +
    `review bodies via \`gh api repos/${repo}/pulls/${number}/reviews\`, ` +
    `and conversation comments via ` +
    `\`gh api repos/${repo}/issues/${number}/comments\`. ` +
    `If none of them can be read, stop and say so — do not go looking for ` +
    `other work to do instead.\n\n` +
    `${body}\n\n${RECEIVE_SUMMARY_INSTRUCTION}`;
  if (note) p += `\n\nAdditional context from the author: ${note}`;
  return p;
}

// The automatic trigger's gate — and only the automatic one: docket receive
// and the R verb run regardless, though a blocked checkout still refuses.
export function shouldAutoRun(
  cfg: Config,
  entry: Entry,
): { ok: true } | { ok: false; reason: string } {
  if (!cfg.receive_enabled)
    return { ok: false, reason: "receive_enabled is off" };
  if ((entry.flags ?? []).includes("draft"))
    return { ok: false, reason: "PR is a draft" };
  return { ok: true };
}

// Where docket-created checkouts for one repo live. Per-repo, so equal branch
// names in different repos never collide.
export const checkoutsDirFor = (paths: Paths, repo: string): string =>
  join(paths.stateDir, "checkouts", repo.replace(/\//g, "-"));

export type PreparedCheckout =
  | { ok: true; path: string }
  | { ok: false; reason: string };

// Resolve the PR's working copy and record it on the entry. Runs at trigger
// time and again inside the run process right before spawning claude (the
// TOCTOU guard — a checkout can change between poll and spawn).
export function prepareCheckout(
  ctx: Ctx,
  key: string,
  entry: Entry,
): PreparedCheckout {
  const { repo, number } = splitKey(key);
  const clone = entry.local_path ?? ctx.cfg.repos[repo];
  if (!clone || !existsSync(clone))
    return { ok: false, reason: "no local clone mapped" };
  const info = prMineInfo(ctx.gh, repo, number);
  if (!info)
    return { ok: false, reason: "cannot fetch the PR head from GitHub" };
  const branch = info.headRefName || entry.branch;
  if (!branch) return { ok: false, reason: "PR head branch unknown" };
  const r = resolveCheckout(
    clone,
    branch,
    info.headRefOid,
    checkoutsDirFor(ctx.paths, repo),
  );
  if (!r.ok) return r;
  patchEntry(ctx.paths.statePath, key, {
    checkout_path: r.path,
    local_path: clone,
    branch,
    // written every time, undefined included: a checkout that resolves in
    // place again must stop claiming its commits live somewhere else
    checkout_fallback: r.fallback,
    // worktrees[] means "paths docket may delete" — only a docket-created
    // checkout ever goes in.
    ...(r.owned && !(entry.worktrees ?? []).includes(r.path)
      ? { worktrees: [...(entry.worktrees ?? []), r.path] }
      : {}),
  });
  return { ok: true, path: r.path };
}
