import { expect, test } from "bun:test";
import { type Feed, makeFeed } from "../src/activity";
import { render } from "ink-testing-library";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paths, type Config } from "../src/config";
import { resolveOpeners } from "../src/openers";
import { setStatus, type Entry, type State } from "../src/state";
import { App, type TuiActions } from "../src/tui/app";
import type { SuspendRequest } from "../src/tui/suspend";

// Few component tests, deliberately — see "TUI tests stay thin" in CLAUDE.md.
// Each one here guards a wrong wiring that costs work or money silently, or a
// fallback path. Everything else about the UI is verified by running it.

const cfg: Config = { orgs: [], repos: {} };
const resolved = resolveOpeners(
  cfg,
  (bin) => bin === "git" || bin === "/bin/sh" || bin === "open",
);

// `real` makes dismiss do what the command does — mark the entry done, which
// drops it from the queue. A stub that only records the call cannot catch a
// cursor that moves when the row under it disappears.
function mount(
  state: State,
  real = false,
  configText = JSON.stringify(cfg),
  authWarning?: string,
  overrides: Partial<TuiActions> = {},
  feed?: Feed,
) {
  const dir = mkdtempSync(join(tmpdir(), "docket-tui-"));
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  writeFileSync(join(dir, "config.json"), configText);
  const p = paths({
    DOCKET_CONFIG_DIR: dir,
    DOCKET_STATE_DIR: dir,
  } as NodeJS.ProcessEnv);
  const calls: string[] = [];
  const requests: SuspendRequest[] = [];
  const actions: TuiActions = {
    retry: async (k) => {
      calls.push(`retry:${k}`);
      return { code: 0 };
    },
    review: async (k, note) => {
      calls.push(`review:${k}${note ? `:${note}` : ""}`);
      return { code: 0 };
    },
    receive: async (k, note) => {
      calls.push(`receive:${k}${note ? `:${note}` : ""}`);
      return { code: 0 };
    },
    poll: async () => {
      calls.push("poll");
      return { code: 0 };
    },
    sync: async () => {
      calls.push("sync");
      return { code: 0 };
    },
    dismiss: (k) => {
      calls.push(`dismiss:${k}`);
      if (real) setStatus(p.statePath, k, "done");
      return `dismissed ${k}`;
    },
    kill: (k) => {
      calls.push(`kill:${k}`);
      return `${k}: killed`;
    },
  };
  const r = render(
    <App
      cfg={cfg}
      paths={p}
      actions={{ ...actions, ...overrides }}
      resolved={resolved}
      request={(req) => requests.push(req)}
      authWarning={authWarning}
      feed={feed}
    />,
  );
  return { ...r, calls, requests, paths: p };
}

// A real directory: enter refuses to resume into a clone that is gone, so a
// made-up path would make every row's session look unavailable.
const clone = mkdtempSync(join(tmpdir(), "docket-tui-clone-"));

const entry = (over: Partial<Entry>): Entry => ({
  status: "ready",
  session_id: "s",
  local_path: clone,
  updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

test("destructive verbs act on the highlighted row, not the first one", async () => {
  const ui = mount({
    "acme/one#1": entry({ title: "One", updated_at: "2026-01-01T00:00:00Z" }),
    "acme/two#2": entry({
      title: "Two",
      status: "reviewing",
      pid: 1,
      updated_at: "2026-01-02T00:00:00Z",
    }),
  });
  ui.stdin.write("j"); // move off row 1
  await Bun.sleep(20);
  ui.stdin.write("x");
  await Bun.sleep(20);
  ui.stdin.write("K");
  await Bun.sleep(20);
  expect(ui.calls).toEqual(["dismiss:acme/two#2", "kill:acme/two#2"]);
  ui.unmount();
});

test("the cursor holds its place when the row under it is dismissed", async () => {
  const ui = mount(
    {
      "acme/one#1": entry({ title: "One", updated_at: "2026-01-01T00:00:00Z" }),
      "acme/two#2": entry({ title: "Two", updated_at: "2026-01-02T00:00:00Z" }),
      "acme/three#3": entry({
        title: "Three",
        updated_at: "2026-01-03T00:00:00Z",
      }),
    },
    true,
  );
  ui.stdin.write("j");
  await Bun.sleep(20);
  ui.stdin.write("j"); // last row
  await Bun.sleep(20);
  ui.stdin.write("x");
  await Bun.sleep(20);
  ui.stdin.write("x");
  await Bun.sleep(20);
  // the second x lands on what took the vacated slot, never back at row 1 —
  // dismiss force-removes the PR's worktree, so a wrong target loses work
  expect(ui.calls).toEqual(["dismiss:acme/three#3", "dismiss:acme/two#2"]);
  ui.unmount();
});

test("a dead verb launches nothing and says why in the footer", async () => {
  const ui = mount({
    "acme/one#1": entry({
      status: "failed",
      session_id: undefined,
      worktrees: ["/vanished/pr-1"],
    }),
  });
  await Bun.sleep(20);
  // The reason is not on screen until asked for: the greyed key is the cue.
  expect(ui.lastFrame() ?? "").not.toContain("worktree is gone");

  ui.stdin.write("s");
  await Bun.sleep(20);
  expect(ui.lastFrame()).toMatch(/shell: .+/);
  ui.stdin.write("\r");
  await Bun.sleep(20);
  expect(ui.lastFrame()).toContain("no session (failed)");
  expect(ui.requests).toEqual([]);
  ui.unmount();
});

test("the denials key opens the view only for a row that has denials", async () => {
  const ui = mount({
    "acme/one#1": entry({ title: "One", updated_at: "2026-01-01T00:00:00Z" }),
    "acme/two#2": entry({
      title: "Two",
      updated_at: "2026-01-02T00:00:00Z",
      denials: [
        {
          tool: "Bash",
          suggestion: "Bash(rg:*)",
          count: 2,
          examples: ["rg TODO src"],
          writeShaped: false,
          alreadyAllowed: false,
        },
      ],
    }),
  });
  await Bun.sleep(20);
  ui.stdin.write("D"); // row 1 has none: the queue stays put, and says why
  await Bun.sleep(20);
  expect(ui.lastFrame()).toContain("acme/two#2"); // the queue, not a view
  expect(ui.lastFrame()).toContain("no denials");
  ui.stdin.write("j");
  await Bun.sleep(20);
  ui.stdin.write("D");
  await Bun.sleep(20);
  expect(ui.lastFrame()).toContain("Bash(rg:*)");
  expect(ui.lastFrame()).toContain("×2");
  ui.unmount();
});

test("a adds every safe rule in one press, and never a write-shaped one", async () => {
  const ui = mount({
    "acme/two#2": entry({
      title: "Two",
      updated_at: "2026-01-02T00:00:00Z",
      denials: [
        {
          tool: "Bash",
          suggestion: "Bash(git push:*)",
          count: 1,
          examples: ["git push origin HEAD"],
          writeShaped: true,
          alreadyAllowed: false,
        },
        {
          tool: "Bash",
          suggestion: "Bash(rg:*)",
          count: 2,
          examples: ["rg TODO src"],
          writeShaped: false,
          alreadyAllowed: false,
        },
        {
          tool: "Bash",
          suggestion: "Bash(fd:*)",
          count: 1,
          examples: ["fd denials"],
          writeShaped: false,
          alreadyAllowed: false,
        },
      ],
    }),
  });
  await Bun.sleep(20);
  ui.stdin.write("D");
  await Bun.sleep(20);
  ui.stdin.write("a");
  await Bun.sleep(20);
  const config = JSON.parse(readFileSync(ui.paths.configPath, "utf8"));
  expect(config.extra_allowed_tools).toEqual(["Bash(rg:*)", "Bash(fd:*)"]);
  // the view reflects the write immediately, without restarting the TUI
  expect(ui.lastFrame()).toContain("2 rules added");
  ui.unmount();
});

test("apply reads the config off disk, not the snapshot the TUI started with", async () => {
  // every suspend verb remounts App with the startup cfg prop; a rule applied
  // before the suspend would otherwise be offered for applying all over again
  const ui = mount(
    {
      "acme/two#2": entry({
        title: "Two",
        updated_at: "2026-01-02T00:00:00Z",
        denials: [
          {
            tool: "Bash",
            suggestion: "Bash(rg:*)",
            count: 2,
            examples: ["rg TODO src"],
            writeShaped: false,
            alreadyAllowed: true,
          },
        ],
      }),
    },
    false,
    JSON.stringify({ ...cfg, extra_allowed_tools: ["Bash(rg:*)"] }),
  );
  await Bun.sleep(20);
  ui.stdin.write("D");
  await Bun.sleep(20);
  ui.stdin.write("a");
  await Bun.sleep(20);
  expect(ui.lastFrame()).toContain("nothing to add — 1 already in your config");
  expect(
    JSON.parse(readFileSync(ui.paths.configPath, "utf8")).extra_allowed_tools,
  ).toEqual(["Bash(rg:*)"]);
  ui.unmount();
});

test("the add rail holds for a suggestion the classifier now calls write-shaped", async () => {
  // the flag on the entry froze when the run ended, before npx was blocklisted
  const ui = mount({
    "acme/two#2": entry({
      title: "Two",
      updated_at: "2026-01-02T00:00:00Z",
      denials: [
        {
          tool: "Bash",
          suggestion: "Bash(npx:*)",
          count: 1,
          examples: ["npx prettier --write ."],
          writeShaped: false,
          alreadyAllowed: false,
        },
      ],
    }),
  });
  await Bun.sleep(20);
  ui.stdin.write("D");
  await Bun.sleep(20);
  ui.stdin.write("a");
  await Bun.sleep(20);
  expect(ui.lastFrame()).toContain("nothing to add — 1 write-shaped");
  expect(
    JSON.parse(readFileSync(ui.paths.configPath, "utf8")).extra_allowed_tools ??
      [],
  ).toEqual([]);
  ui.unmount();
});

test("adding writes through a symlinked config instead of replacing the link", async () => {
  // dotfiles setups point config.json at a file in their own repo; a rename
  // over the link leaves a regular file and orphans the repo copy
  const ui = mount({
    "acme/two#2": entry({
      title: "Two",
      updated_at: "2026-01-02T00:00:00Z",
      denials: [
        {
          tool: "Bash",
          suggestion: "Bash(rg:*)",
          count: 2,
          examples: ["rg TODO src"],
          writeShaped: false,
          alreadyAllowed: false,
        },
      ],
    }),
  });
  const real = join(dirname(ui.paths.configPath), "dotfiles-config.json");
  renameSync(ui.paths.configPath, real);
  symlinkSync(real, ui.paths.configPath);
  await Bun.sleep(20);
  ui.stdin.write("D");
  await Bun.sleep(20);
  ui.stdin.write("a");
  await Bun.sleep(20);
  expect(lstatSync(ui.paths.configPath).isSymbolicLink()).toBe(true);
  expect(JSON.parse(readFileSync(real, "utf8")).extra_allowed_tools).toEqual([
    "Bash(rg:*)",
  ]);
  ui.unmount();
});

// The fallback CLAUDE.md asks for a test on: enter means two different things
// depending on the row, and getting it backwards either hijacks resume or
// leaves the dead key that started this redesign.
test("enter resolves denials only when there is no session to resume", async () => {
  const denials = [
    {
      tool: "Bash",
      suggestion: "Bash(rg:*)",
      count: 2,
      examples: ["rg TODO src"],
      writeShaped: false,
      alreadyAllowed: false,
    },
  ];
  const ui = mount({
    // a session and denials: enter belongs to the session
    "acme/one#1": entry({
      title: "One",
      local_path: clone,
      updated_at: "2026-01-01T00:00:00Z",
      denials,
    }),
    // the failed run that has no session to resume
    "acme/two#2": entry({
      status: "failed",
      session_id: undefined,
      title: "Two",
      local_path: clone,
      updated_at: "2026-01-02T00:00:00Z",
      denials,
    }),
  });
  await Bun.sleep(20);
  ui.stdin.write("\r");
  await Bun.sleep(20);
  expect(ui.requests[0]?.banner).toContain("resuming acme/one#1");

  ui.stdin.write("j");
  await Bun.sleep(20);
  // the panel says what enter will do before it is pressed
  expect(ui.lastFrame()).toContain("⏎ resolves these with claude");
  ui.stdin.write("\r");
  await Bun.sleep(20);
  expect(ui.requests).toHaveLength(2);
  expect(ui.requests[1]?.banner).toContain("hand off: acme/two#2");
  expect(ui.requests[1]?.argv[1]).toContain("Bash(rg:*)");
  ui.unmount();
});

test("hand-off carries every group, and r retries the PR the view was opened on", async () => {
  const ui = mount({
    "acme/one#1": entry({ title: "One", updated_at: "2026-01-01T00:00:00Z" }),
    "acme/two#2": entry({
      title: "Two",
      local_path: clone,
      updated_at: "2026-01-02T00:00:00Z",
      denials: [
        {
          tool: "Bash",
          suggestion: "Bash(git push:*)",
          count: 1,
          examples: ["git push origin HEAD"],
          writeShaped: true,
          alreadyAllowed: false,
        },
        {
          tool: "Bash",
          suggestion: "Bash(rg:*)",
          count: 2,
          examples: ["rg TODO src"],
          writeShaped: false,
          alreadyAllowed: false,
        },
      ],
    }),
  });
  await Bun.sleep(20);
  ui.stdin.write("j");
  await Bun.sleep(20);
  ui.stdin.write("D");
  await Bun.sleep(20);
  ui.stdin.write("\r"); // one hand-off, the whole set — no per-group scope left
  await Bun.sleep(20);
  expect(ui.requests).toHaveLength(1);
  expect(ui.requests[0]?.cwd).toBe(clone);
  expect(ui.requests[0]?.argv[1]).toContain("Bash(rg:*)");
  expect(ui.requests[0]?.argv[1]).toContain("Bash(git push:*)");

  // r bills a review: it must run the PR the view is about, never row 1
  ui.stdin.write("r");
  await Bun.sleep(20);
  expect(ui.calls).toEqual(["retry:acme/two#2"]);
  ui.unmount();
});

test("an empty queue keeps the TUI open so poll can populate it", async () => {
  const ui = mount({});
  await Bun.sleep(20);
  expect(ui.lastFrame()).toContain("No pending reviews");
  ui.stdin.write("p"); // opens the log pane on the poll
  await Bun.sleep(20);
  expect(ui.calls).toEqual(["poll"]);
  ui.stdin.write("\x1b");
  await Bun.sleep(20);
  expect(ui.lastFrame()).toContain("No pending reviews"); // still mounted
  ui.unmount();
});

test("the log pane streams the job's lines and reports it running, then done", async () => {
  const feed = makeFeed();
  let finish!: () => void;
  const ui = mount(
    {},
    false,
    undefined,
    undefined,
    {
      poll: () =>
        new Promise((res) => {
          finish = () => res({ code: 0 });
        }),
    },
    feed,
  );
  await Bun.sleep(20);
  ui.stdin.write("p");
  await Bun.sleep(20);
  feed.push("12:00:01 polling acme for review requests");
  await Bun.sleep(20);
  let frame = ui.lastFrame() ?? "";
  expect(frame).toContain("polling acme for review requests");
  expect(frame).toContain("running");

  // leaving the pane leaves the job running, and the footer says where it is
  ui.stdin.write("\x1b");
  await Bun.sleep(20);
  frame = ui.lastFrame() ?? "";
  expect(frame).toContain("No pending reviews");
  expect(frame).toContain("polling… · l shows the log");

  finish();
  await Bun.sleep(20);
  ui.stdin.write("l");
  await Bun.sleep(20);
  frame = ui.lastFrame() ?? "";
  expect(frame).toMatch(/─ poll ─+ done ─/);
  expect(frame).not.toMatch(/─ poll ─+ running ─/);
  ui.unmount();
});

// The case this exists for: a logged-out poller writes no entries at all, so
// an empty queue is indistinguishable from a quiet morning unless the warning
// survives on screen. It must also not be shouted over by action feedback.
test("a broken setup is announced even when the queue is empty", async () => {
  const ui = mount({}, false, JSON.stringify(cfg), "claude is not logged in");
  await Bun.sleep(20);
  expect(ui.lastFrame()).toContain("claude is not logged in");

  ui.stdin.write("p"); // action feedback takes the line...
  await Bun.sleep(20);
  expect(ui.calls).toEqual(["poll"]);
  ui.unmount();
});

test("no warning line when the setup is fine", async () => {
  const ui = mount({});
  await Bun.sleep(20);
  expect(ui.lastFrame()).not.toContain("not logged in");
  ui.unmount();
});

test("a verb that fails says so in the footer instead of clearing the status", async () => {
  const ui = mount(
    { "acme/one#1": entry({ title: "One" }) },
    false,
    JSON.stringify(cfg),
    undefined,
    {
      retry: async () => ({
        code: 1,
        message: "cannot fetch acme/one#1 from GitHub (does the PR exist?)",
      }),
    },
  );
  ui.stdin.write("r");
  await Bun.sleep(40);
  // the verb reports through the frame — its own console output is displaced
  // above it, where nobody is looking
  expect(ui.lastFrame()).toContain("does the PR exist?");
  ui.unmount();
});

// The columns of a my-PRs row add up to more than a narrow terminal holds.
// A line wider than the terminal is soft-wrapped by the terminal, and Ink
// erases the one line it laid out — the leftover row survives into the next
// frame, so moving the cursor repeats the header. Invisible on a wide screen,
// which is where this gets developed.
const printed = (frame: string): string[] =>
  frame.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "").split("\n");

test("no row outgrows the terminal, however wide its columns want to be", async () => {
  const wide = (n: number): Partial<Entry> => ({
    title: "A title long enough to want every column the row will not give it",
    threads: { unresolved: 10, total: 12 },
    summary: { addressed: 12, deferred: 3 },
    branch: "b",
    reviewer: "carol",
    updated_at: `2026-01-0${n}T00:00:00Z`,
  });
  const ui = mount({
    "mine:acme/a-rather-long-repo-name#12345": entry(wide(1)),
    "mine:acme/another-long-repo-name#67890": entry(wide(2)),
  });
  ui.stdin.write("\t"); // into my PRs, whose receive column is 26 wide
  await Bun.sleep(40);
  // ink-testing-library renders at 100 columns
  const over = printed(ui.lastFrame() ?? "").filter((l) => l.length > 100);
  expect(over).toEqual([]);
  ui.unmount();
});
