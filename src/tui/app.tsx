import { Box, render, Text, useApp, useInput, useWindowSize } from "ink";
import { readFileSync, watch } from "node:fs";
import { dirname } from "node:path";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Feed, windowLines } from "../activity";
import { readAssessment } from "../assessment";
import { claudeAuth } from "../auth";
import {
  readConfigSync,
  runLogPath,
  writeConfigText,
  type Config,
  type Paths,
} from "../config";
import { applySuggestion, type DenialGroup } from "../denials";
import { addable, denialTitle, denialView, TEASER_HEIGHT } from "../denialview";
import {
  buildFreshChat,
  buildHandoff,
  buildResume,
  NO_CLONE_REASON,
  parsePrInput,
  printPending,
} from "../list";
import {
  buildOpener,
  launchDetached,
  openerContext,
  resolveOpeners,
  resolveEntryWorktree,
  type ResolvedOpeners,
} from "../openers";
import { selfArgs } from "../proc";
import type { Ctx } from "../reviewer";
import {
  entryKind,
  isLiveReview,
  loadState,
  pendingEntries,
  splitKey,
  type Entry,
  type EntryKind,
} from "../state";
import { PANEL_HEIGHT, panelLines } from "../panel";
import { Help, Legend } from "./legend";
import { Panel } from "./panel";
import { Queue, type Row } from "./queue";
import { suspendLoop, type SuspendRequest } from "./suspend";

// What a background verb did: its exit code, and the line it would have
// printed. Ink owns the terminal, so nothing a verb has to say may reach the
// user any other way.
export interface ActionResult {
  code: number;
  message?: string;
}

export interface TuiActions {
  retry(key: string): Promise<ActionResult>;
  // The two `n` submits: force-review a PR, or receive feedback on one of the
  // user's own (the latter also behind R). Keys may arrive bare or prefixed.
  review(key: string, note?: string): Promise<ActionResult>;
  receive(key: string, note?: string): Promise<ActionResult>;
  poll(): Promise<ActionResult>;
  sync(): Promise<ActionResult>;
  // Both return what to tell the user: their own output goes to the console,
  // which Ink displaces above the frame where nobody is looking.
  dismiss(key: string): string;
  kill(key: string): string;
}

export interface AppProps {
  cfg: Config;
  paths: Paths;
  actions: TuiActions;
  resolved: ResolvedOpeners;
  request: (r: SuspendRequest) => void;
  // Carried across a suspend so the cursor comes back where it was.
  initialKey?: string;
  onSelect?: (key: string) => void;
  notice?: string;
  // Broken setup, not a broken review: it belongs to no row, and a logged-out
  // poller writes no entries at all — so without this the queue looks exactly
  // like a morning with no new PRs.
  authWarning?: string;
  // The session log and the running poll/sync job, held outside React so
  // both survive a suspend's remount. Absent in tests and frames.
  feed?: Feed;
}

function Bar({
  label,
  right,
  width,
}: {
  label?: string;
  right?: string;
  width: number;
}) {
  const head = label ? `─ ${label} ` : "──";
  const tail = right ? ` ${right} ─` : "─";
  const fill = Math.max(0, width - head.length - tail.length);
  return (
    <Text dimColor>
      {label ? (
        <>
          ─ <Text dimColor={false}>{label}</Text>{" "}
        </>
      ) : (
        head
      )}
      {"─".repeat(fill)}
      {tail}
    </Text>
  );
}

// Both lists named, with their counts, the open one filled in. This is where
// `tab` lives: the key is shown next to what it switches, not in the verb list.
function Tabs({
  list,
  counts,
}: {
  list: "queue" | "mine";
  counts: Record<"queue" | "mine", number>;
}) {
  const tab = (name: "queue" | "mine", label: string) =>
    list === name ? (
      <Text backgroundColor="cyan" color="black" bold>
        {` ${label} ${counts[name]} `}
      </Text>
    ) : (
      <Text dimColor>{` ${label} ${counts[name]} `}</Text>
    );
  return (
    <Box>
      <Text> </Text>
      {tab("queue", "queue")}
      <Text> </Text>
      {tab("mine", "my PRs")}
      <Text dimColor> tab switches</Text>
    </Box>
  );
}

export function App({
  cfg,
  paths,
  actions,
  resolved,
  request,
  initialKey,
  onSelect,
  notice,
  authWarning,
  feed,
}: AppProps) {
  const { exit } = useApp();
  const size = useWindowSize();
  const width = size.columns || 80;
  const height = size.rows || 24;

  // Which of the two entry worlds is on screen. A mine initialKey (the cursor
  // riding across a suspend) means the suspend happened in the mine view.
  const [list, setList] = useState<"queue" | "mine">(
    initialKey && entryKind(initialKey) === "mine" ? "mine" : "queue",
  );
  const kind: EntryKind = list === "mine" ? "mine" : "review";
  // Rows are derived, not held: switching views must swap the rows in the
  // same render, or the old world's rows flash under the new view's legend.
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  // The other list's count is read in the same pass: the tab strip shows both.
  const { rows, counts } = useMemo(() => {
    const state = loadState(paths.statePath);
    const rows: Row[] = pendingEntries(state, kind).map(([key, entry]) => ({
      key,
      entry,
    }));
    const other = pendingEntries(state, kind === "mine" ? "review" : "mine");
    return {
      rows,
      counts: {
        queue: kind === "mine" ? other.length : rows.length,
        mine: kind === "mine" ? rows.length : other.length,
      },
    };
    // generation is the invalidation signal for the state file's content
  }, [paths.statePath, kind, generation]);
  // Per-view cursors, so tabbing away and back lands where the user left.
  const [cursorKeys, setCursorKeys] = useState<
    Partial<Record<"queue" | "mine", string>>
  >(initialKey ? { [list]: initialKey } : {});
  const cursorKey = cursorKeys[list];
  const setCursorKey = useCallback(
    (key: string | undefined) => setCursorKeys((c) => ({ ...c, [list]: key })),
    [list],
  );
  const [view, setView] = useState<"list" | "help" | "denials" | "log">("list");
  // Help is a detour, not a destination: esc goes back where it was opened.
  const [helpFrom, setHelpFrom] = useState<"list" | "denials" | "log">("list");
  // A counter, not a copy: the feed owns the lines, this only re-renders.
  const [feedTick, setFeedTick] = useState(0);
  useEffect(() => feed?.subscribe(() => setFeedTick((t) => t + 1)), [feed]);
  const job = feed?.job;
  const [status, setStatus] = useState<string | undefined>();
  // The `n` footer input; undefined = closed.
  const [prInput, setPrInput] = useState<string | undefined>();
  // The PR the denials view is reading, pinned when D opened it. Its verbs act
  // on this key and never on the queue cursor, which a finishing poll can move.
  const [denialKey, setDenialKey] = useState<string | undefined>();
  const [scroll, setScroll] = useState(0);
  // `cfg` is the startup snapshot, and every suspend verb remounts App with it
  // — seeding from it would drop the rules `a` wrote before the suspend. Read
  // the file instead; the prop is only the fallback.
  const [liveCfg, setLiveCfg] = useState(() =>
    readConfigSync(paths.configPath, cfg),
  );

  // saveState renames a temp file over state.json, which breaks a watch bound
  // to the file's inode — watch the directory instead.
  useEffect(() => {
    try {
      const w = watch(dirname(paths.statePath), (_ev, file) => {
        if (file === "state.json") reload();
      });
      return () => w.close();
    } catch {
      return; // no watch is survivable: every action reloads anyway
    }
  }, [paths.statePath, reload]);

  // A row can vanish under the cursor: x and K drop it, and so does a poll
  // that marks it done while the watcher reloads. Hold the position when the
  // key is gone — snapping to row 0 would aim the next x at another PR.
  const lastIndex = useRef(0);
  const found = rows.findIndex((r) => r.key === cursorKey);
  const cursor =
    found >= 0 ? found : Math.min(lastIndex.current, rows.length - 1);
  lastIndex.current = Math.max(0, cursor);
  const current = rows[cursor];
  useEffect(() => {
    if (!current) return;
    setCursorKey(current.key); // re-anchor after the row it named disappeared
    onSelect?.(current.key);
  }, [current, onSelect, setCursorKey]);
  const summary = current?.entry.summary;
  // Only read when the panel would actually fall back to it: with a headline
  // recorded on the entry, the run log has nothing left to tell this view.
  // A mine entry with no run yet shows what sync recorded instead: their
  // verdict and who left it.
  const assessment = useMemo(() => {
    if (!current || summary?.headline)
      return { kind: "none", reason: "" } as const;
    const a = readAssessment(runLogPath(paths, current.key));
    if (a.kind === "none" && kind === "mine" && current.entry.reviewer) {
      // What the reviewer said, and what is still open — not a promise of
      // feedback: a bare approval with every thread resolved has none.
      const t = current.entry.threads;
      const tail = t?.unresolved
        ? ` — ${t.unresolved} unresolved thread${t.unresolved === 1 ? "" : "s"}`
        : t?.total
          ? " — all threads resolved"
          : "";
      return {
        kind: "text",
        text: `${current.entry.status} by ${current.entry.reviewer}${tail}`,
      } as const;
    }
    return a;
  }, [current, summary, paths, kind]);

  // A failed run has no session to resume, which is exactly where the denials
  // are: enter was dead on the one row that most needed it. There it resolves
  // them instead.
  const enterResolves = useMemo(() => {
    if (!current?.entry.denials?.length || !current.entry.local_path)
      return false;
    return "error" in buildResume(current.entry, cfg, kind);
  }, [current, cfg, kind]);

  // Computed per row, never per keypress: a verb the machine cannot run is
  // greyed in the legend with its reason in the preview, not a dead key.
  const unavailable = useMemo(() => {
    const u: Record<string, string> = {};
    if (!current) return u;
    const resume = buildResume(current.entry, cfg, kind);
    // Not greyed when enter resolves: it still opens claude, just on the
    // denials rather than on a session that was never written. In the mine
    // view a fresh chat in the checkout is the second fallback.
    if ("error" in resume && !enterResolves) {
      if (kind !== "mine" || isLiveReview(current.entry)) {
        u.claude = resume.error;
      } else {
        const fresh = buildFreshChat(current.entry, cfg);
        if ("error" in fresh) u.claude = fresh.error;
      }
    }
    const wt = resolveEntryWorktree(current.key, current.entry);
    for (const verb of ["shell", "diff"]) {
      if (!resolved[verb]) u[verb] = `no ${verb} opener found on PATH`;
      else if ("missing" in wt) u[verb] = wt.missing;
    }
    // browse wants no worktree — only the url the entry was tracked with.
    if (!resolved.browse) u.browse = "no browse opener found on PATH";
    else if (!current.entry.url) u.browse = "no PR url recorded on this entry";
    if (kind === "mine") {
      // Only the statically known reasons grey R: a dirty/ahead checkout is
      // found out by the trigger flow (probing git per row per render is too
      // heavy) and lands in the panel as skipped + reason.
      const { repo } = splitKey(current.key);
      if (!current.entry.local_path && !(repo in liveCfg.repos)) {
        u.receive = NO_CLONE_REASON;
      } else if (isLiveReview(current.entry)) {
        u.receive = "a run is already in flight — w watches it";
      }
    }
    if (!current.entry.denials?.length) u.denials = "no denials recorded";
    if (!current.entry.local_path) {
      u.handoff = NO_CLONE_REASON;
    } else if (!current.entry.denials?.length) {
      u.handoff = "no denials recorded";
    }
    return u;
  }, [current, cfg, resolved, enterResolves, kind, liveCfg]);

  // Last in line: action feedback is what the user just asked for, so it takes
  // the line while it lasts. The warning is still there when it clears. An
  // open `n` input takes the same row.
  // A job running out of sight says so, and where to look.
  const jobHint =
    job?.running && view !== "log"
      ? `${job.verb}… · l shows the log`
      : undefined;
  const footer =
    prInput !== undefined
      ? "input"
      : (status ?? jobHint ?? notice ?? authWarning);
  const footerColor =
    notice !== undefined && footer === notice ? "red" : "yellow";
  // The frame is as tall as its content, never the terminal: the queue takes
  // its rows, the panel its lines down to a floor, and the keys follow right
  // under. Fixed rows: the tab strip, four bars, the legend, the footer row,
  // and the row Ink must leave spare.
  const fixedRows = 8;
  const queueHeight = Math.max(
    1,
    Math.min(rows.length || 1, 10, height - fixedRows - 1),
  );
  const denials = current?.entry.denials;
  // Bounded, and it shrinks with the terminal — the panel never takes the
  // screen away from the queue the way the old scrolling pane did. A run with
  // denials asks for the teaser's rows on top of the summary's. It is padded
  // to PANEL_HEIGHT, so a one-line headline does not pull the legend up.
  const panelHeight = Math.max(
    1,
    Math.min(
      PANEL_HEIGHT + (denials?.length ? TEASER_HEIGHT + 1 : 0),
      height - fixedRows - queueHeight,
    ),
  );
  const panel = useMemo(
    () =>
      panelLines({
        summary,
        assessment,
        denials,
        cfg: liveCfg,
        kind,
        enterResolves,
        width: width - 2,
        height: panelHeight,
      }),
    [
      summary,
      assessment,
      denials,
      liveCfg,
      kind,
      enterResolves,
      width,
      panelHeight,
    ],
  );

  // The view reads the PR D was pressed on, not whatever the queue cursor has
  // drifted to since — retrying the wrong row bills a second review. Its kind
  // rides with the key, so the rules aim at the right allowlist.
  const denialRow = rows.find((r) => r.key === denialKey);
  const denialKind: EntryKind = denialKey ? entryKind(denialKey) : kind;
  const viewGroups = denialRow?.entry.denials ?? [];
  // The denials view takes the whole region between the bars and the legend.
  const denialPanel = useMemo(
    () =>
      denialView({
        groups: viewGroups,
        kind: denialKind,
        cfg: liveCfg,
        scroll,
        width: width - 2,
        height: Math.max(1, height - fixedRows),
      }),
    [viewGroups, denialKind, liveCfg, scroll, width, height],
  );

  // The log pane's window: scroll counts up from the bottom, so the newest
  // line is on screen unless the user has scrolled away from it.
  const logPane = useMemo(
    () =>
      windowLines(feed?.lines ?? [], Math.max(1, height - fixedRows), scroll),
    // biome-ignore lint/correctness/useExhaustiveDependencies: feedTick is the invalidation signal for the feed's lines
    [feed, feedTick, height, scroll],
  );

  // p and S: start the child and open the pane on it; a second press while it
  // runs just reopens the pane. The job's own messages are in the feed, so the
  // footer carries only the outcome.
  const startJob = (
    name: "poll" | "sync",
    verb: string,
    fn: () => Promise<ActionResult>,
  ) => {
    setScroll(0);
    setView("log");
    if (!feed) return run(verb, fn);
    if (feed.job?.running) return;
    feed.setJob({ name, verb, running: true });
    fn()
      .then((r) => {
        feed.setJob({ name, verb, running: false, code: r.code });
        setStatus(r.message ?? (r.code === 0 ? `${name} done` : undefined));
      })
      .catch((e: unknown) => {
        feed.setJob({ name, verb, running: false, code: 1 });
        setStatus(`${name} failed: ${e}`);
      })
      .finally(reload);
  };

  const move = (delta: number) => {
    if (rows.length === 0) return;
    const next = Math.min(rows.length - 1, Math.max(0, cursor + delta));
    setCursorKey(rows[next]?.key);
  };

  const run = (label: string, fn: () => Promise<ActionResult>) => {
    setStatus(`${label}…`);
    fn()
      .then((r) =>
        setStatus(r.message ?? (r.code === 0 ? undefined : `${label} failed`)),
      )
      .catch((e: unknown) => setStatus(`${label} failed: ${e}`))
      .finally(reload);
  };

  // Reached from the queue and from the denials view, on the same terms.
  const handOff = (key: string, entry: Entry, groups: DenialGroup[]) => {
    const r = buildHandoff(entry, liveCfg, paths, key, groups, entryKind(key));
    if ("error" in r) return setStatus(`hand off: ${r.error}`);
    request({
      ...r,
      banner: `hand off: ${key}`,
      // an interactive claude session's exit status is whatever the user last
      // ran in it, not a verdict on the hand-off
      interactive: true,
    });
  };

  const open = (verb: "shell" | "diff") => {
    if (!current) return;
    const r = buildOpener(
      verb,
      resolved,
      openerContext(current.key, current.entry),
    );
    if ("unavailable" in r) return setStatus(`${verb}: ${r.unavailable}`);
    request({
      ...r,
      banner: `${verb}: ${current.key} in ${r.cwd}`,
      interactive: verb === "shell",
    });
  };

  // The browser gets the url off the entry, so this works on a row that has no
  // checkout yet — and never suspends: the queue stays on screen.
  const browse = () => {
    if (!current) return;
    const r = buildOpener(
      "browse",
      resolved,
      openerContext(current.key, current.entry),
    );
    if ("unavailable" in r) return setStatus(`browse: ${r.unavailable}`);
    const err = launchDetached(r.argv, r.cwd);
    setStatus(err ?? `opening ${current.entry.url} in your browser`);
  };

  // The `n` submit: parse, then hand to the view's verb — review a PR from
  // the queue, receive feedback on one of the user's own from the mine view.
  const submitPr = (text: string) => {
    setPrInput(undefined);
    const r = parsePrInput(text, liveCfg);
    if ("error" in r) return setStatus(r.error);
    if (list === "mine") {
      setCursorKey(entryKind(r.key) === "mine" ? r.key : `mine:${r.key}`);
      return run(`receiving ${r.key}`, () => actions.receive(r.key, r.note));
    }
    setCursorKey(r.key);
    run(`reviewing ${r.key}`, () => actions.review(r.key, r.note));
  };

  useInput((input, key) => {
    if (prInput !== undefined) {
      // The footer input owns the keyboard while it is open.
      if (key.escape) return setPrInput(undefined);
      if (key.return) return submitPr(prInput);
      if (key.backspace || key.delete) return setPrInput(prInput.slice(0, -1));
      if (input && !key.ctrl && !key.meta) return setPrInput(prInput + input);
      return;
    }
    if (input === "q") return exit(); // quits from any view, help included
    if (view === "help") {
      if (input === "?" || key.escape) setView(helpFrom);
      return;
    }
    if (view === "log") {
      if (input === "l" || key.escape) return setView("list");
      if (input === "?") {
        setHelpFrom("log");
        return setView("help");
      }
      if (input === "j" || key.downArrow)
        return setScroll(Math.max(0, scroll - 1));
      if (input === "k" || key.upArrow)
        return setScroll(Math.min(logPane.maxScroll, scroll + 1));
      return;
    }
    if (view === "denials") {
      if (input === "D" || key.escape) return setView("list");
      if (input === "?") {
        setHelpFrom("denials");
        return setView("help");
      }
      if (input === "j" || key.downArrow)
        return setScroll(Math.min(denialPanel.maxScroll, scroll + 1));
      if (input === "k" || key.upArrow)
        return setScroll(Math.max(0, scroll - 1));
      if (input === "a") {
        // One write for N rules: the selector decides which, so what the action
        // line promised and what reaches the config are the same set.
        const { add } = addable(viewGroups, liveCfg, denialKind);
        if (!add.length) return setStatus("nothing to add");
        try {
          let text = readFileSync(paths.configPath, "utf8");
          for (const g of add)
            text = applySuggestion(text, g.suggestion, denialKind);
          writeConfigText(paths.configPath, text);
          setLiveCfg(JSON.parse(text) as Config);
          setStatus(`added ${add.length} rule${add.length === 1 ? "" : "s"}`);
        } catch (e) {
          setStatus(`add failed: ${e}`);
        }
        return;
      }
      if (input === "r" && denialRow) {
        const target = denialRow.key;
        return run(`retrying ${target}`, () => actions.retry(target));
      }
      if (key.return) {
        if (!denialRow) return;
        return handOff(denialRow.key, denialRow.entry, viewGroups);
      }
      return;
    }
    if (input === "?") {
      setHelpFrom("list");
      return setView("help");
    }
    if (key.tab) return setList(list === "queue" ? "mine" : "queue");
    if (input === "n") return setPrInput("");
    if (input === "j" || key.downArrow) return move(1);
    if (input === "k" || key.upArrow) return move(-1);
    if (input === "p") return startJob("poll", "polling", actions.poll);
    if (input === "S") return startJob("sync", "syncing", actions.sync);
    if (input === "l") {
      setScroll(0);
      return setView("log");
    }
    if (!current) return;
    if (key.return) {
      // enter opens claude either way: the review's own session when there is
      // one, and otherwise the denials of a run that failed before it made one.
      if (enterResolves)
        return handOff(current.key, current.entry, current.entry.denials ?? []);
      const r = buildResume(current.entry, cfg, kind);
      if ("error" in r) {
        // Mine view: no session yet, but the checkout is there — a fresh chat
        // in it beats a dead key. Not while a run is in flight, though: it is
        // about to produce the session, and an empty claude in the same
        // checkout only looks like it.
        if (kind === "mine" && !isLiveReview(current.entry)) {
          const fresh = buildFreshChat(current.entry, cfg);
          if (!("error" in fresh)) return request(fresh);
          return setStatus(`${current.key} ${fresh.error}`);
        }
        return setStatus(`${current.key} ${r.error}`);
      }
      request({
        argv: r.argv,
        cwd: r.cwd,
        env: r.env,
        banner: `resuming ${current.key}`,
      });
      return;
    }
    if (input === "R" && kind === "mine") {
      if (unavailable.receive)
        return setStatus(`${current.key}: ${unavailable.receive}`);
      const target = current.key;
      return run(`receiving ${target}`, () => actions.receive(target));
    }
    if (input === "D") {
      if (!denials?.length) return setStatus(`${current.key}: no denials`);
      setDenialKey(current.key);
      setScroll(0);
      return setView("denials");
    }
    if (input === "o") return browse();
    if (input === "s") return open("shell");
    // ink reports ctrl+letter as the bare letter, and Ctrl+D is muscle memory
    // for EOF — it must not hand the terminal to the diff opener.
    if (input === "d" && !key.ctrl) return open("diff");
    if (input === "w") {
      request({
        argv: selfArgs("watch", current.key),
        cwd: process.cwd(),
        banner: `watching ${current.key} — Ctrl+C stops watching, the review keeps running`,
      });
      return;
    }
    if (input === "r") {
      const target = current.key;
      return run(`retrying ${target}`, () => actions.retry(target));
    }
    if (input === "x") {
      setStatus(actions.dismiss(current.key));
      return reload();
    }
    if (input === "K") {
      setStatus(actions.kill(current.key));
      return reload();
    }
  });

  return (
    // A line wider than the terminal is soft-wrapped by the terminal, and Ink
    // erases the one line it laid out — the leftover row survives into the next
    // frame. Clipping here is what keeps a row one row.
    <Box flexDirection="column" width={width} overflowX="hidden">
      {/* the tabs are the title: the bar under them carries only the position */}
      <Tabs list={list} counts={counts} />
      <Bar
        right={rows.length ? `${cursor + 1}/${rows.length}` : "empty"}
        width={width}
      />
      {view === "help" ? (
        <Help unavailable={unavailable} />
      ) : view === "log" ? (
        <>
          <Bar
            label={job ? job.name : "log"}
            right={
              job?.running
                ? "running"
                : job
                  ? job.code === 0
                    ? "done"
                    : `exited ${job.code}`
                  : undefined
            }
            width={width}
          />
          <Box flexDirection="column" paddingX={1} minHeight={PANEL_HEIGHT}>
            {logPane.lines.length === 0 ? (
              <Text dimColor>nothing logged yet — p polls, S syncs</Text>
            ) : (
              logPane.lines.map((l, i) => (
                <Text key={`${i}:${l}`} wrap="truncate-end">
                  {l}
                </Text>
              ))
            )}
          </Box>
        </>
      ) : view === "denials" ? (
        <>
          <Bar
            label={`denials: ${denialKey ?? ""}`}
            right={viewGroups.length ? denialTitle(viewGroups) : undefined}
            width={width}
          />
          <Panel lines={denialPanel.lines} />
        </>
      ) : (
        <>
          <Queue rows={rows} cursor={cursor} height={queueHeight} />
          {/* the bar names the row the panel belongs to, so the two regions
              read as queue-then-detail rather than one column of text */}
          <Bar label={current?.key ?? "no selection"} width={width} />
          <Panel
            lines={panel}
            minHeight={Math.min(PANEL_HEIGHT, panelHeight)}
          />
        </>
      )}
      {/* the keys are a zone like the other two: a rule of their own, not a
          blank row, is what sets them off from the panel's prose */}
      <Bar label="keys" width={width} />
      <Legend
        view={view === "denials" || view === "log" ? view : list}
        unavailable={unavailable}
      />
      {prInput !== undefined ? (
        <Text color="cyan" wrap="truncate-end">
          {list === "mine" ? "receive" : "review"} PR ▸ {prInput}█{" "}
          <Text dimColor>
            (URL or ORG/REPO#N, then a note · enter runs, esc cancels)
          </Text>
        </Text>
      ) : (
        // always a row, empty or not: a message arriving must not shift the
        // legend
        <Text color={footerColor} wrap="truncate-end">
          {footer ?? " "}
        </Text>
      )}
      <Bar width={width} />
    </Box>
  );
}

// Openers are resolved once here, not per frame; the selected key rides across
// a suspend so the cursor comes back to the PR the user acted on.
export function runTui(
  ctx: Ctx,
  actions: TuiActions,
  feed?: Feed,
): Promise<number> {
  // useInput needs raw mode, and Ink throws without a tty. The readline menu
  // this replaced read a closed stdin as "quit", so a script or a cron wrapper
  // that runs bare `docket` still gets the queue instead of a stack trace.
  if (!process.stdin.isTTY) return Promise.resolve(printPending(ctx));
  const resolved = resolveOpeners(ctx.cfg);
  // Probed once, like the openers — it costs a subprocess, and the answer
  // cannot change while the queue is on screen. `unknown` stays quiet, the
  // same way the poller carries on rather than blocking on a broken probe.
  const auth = claudeAuth(ctx.cfg);
  const authWarning =
    "ok" in auth && !auth.ok
      ? `claude is not logged in (${auth.dir}) — run: docket doctor`
      : undefined;
  let selected: string | undefined;
  // The frame is sized to the terminal, so it starts at the top of a cleared
  // screen rather than wherever the shell prompt left the cursor.
  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
  return suspendLoop((request, notice) =>
    render(
      <App
        cfg={ctx.cfg}
        paths={ctx.paths}
        actions={actions}
        resolved={resolved}
        request={request}
        notice={notice}
        authWarning={authWarning}
        feed={feed}
        initialKey={selected}
        onSelect={(key) => {
          selected = key;
        }}
      />,
    ),
  );
}
