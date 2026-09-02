import { Box, Text } from "ink";

export interface Binding {
  keys: string;
  label: string;
  // The footer is one line and already full: a binding whose label does not
  // fit there carries a terser one for it, and keeps the full one for `?`.
  short?: string;
  // Set when the binding hands the terminal to something that may be missing.
  verb?: string;
}

export type KeymapView = "queue" | "mine" | "denials" | "log";

export const QUEUE_KEYS: Binding[] = [
  { keys: "j/k ↑/↓", label: "move" },
  { keys: "tab", label: "my PRs" },
  { keys: "enter", label: "claude", verb: "claude" },
  { keys: "s", label: "shell", verb: "shell" },
  { keys: "d", label: "diff", verb: "diff" },
  { keys: "o", label: "open on GitHub", short: "github", verb: "browse" },
  { keys: "D", label: "denials", verb: "denials" },
  { keys: "w", label: "watch live" },
  { keys: "r", label: "retry" },
  { keys: "n", label: "review a PR by hand", short: "review by hand" },
  { keys: "x", label: "dismiss" },
  { keys: "K", label: "kill" },
  { keys: "p", label: "poll — find new PRs and review them" },
  { keys: "S", label: "sync — refresh the PRs already listed" },
  { keys: "l", label: "log" },
  { keys: "?", label: "more" },
  { keys: "q", label: "quit" },
];

// The mine view: the user's own PRs. Same movement, receive instead of retry
// as the run verb, and every working verb aimed at the PR branch's checkout.
export const MINE_KEYS: Binding[] = [
  { keys: "j/k ↑/↓", label: "move" },
  { keys: "tab", label: "queue" },
  { keys: "enter", label: "claude", verb: "claude" },
  { keys: "s", label: "shell", verb: "shell" },
  { keys: "d", label: "diff", verb: "diff" },
  { keys: "R", label: "receive now", short: "receive", verb: "receive" },
  { keys: "o", label: "open on GitHub", short: "github", verb: "browse" },
  { keys: "D", label: "denials", verb: "denials" },
  { keys: "w", label: "watch live" },
  { keys: "r", label: "retry" },
  { keys: "n", label: "receive a PR by hand", short: "receive by hand" },
  { keys: "x", label: "dismiss" },
  { keys: "K", label: "kill" },
  { keys: "p", label: "poll — find new PRs and review them" },
  { keys: "S", label: "sync — refresh the PRs already listed" },
  { keys: "l", label: "log" },
  { keys: "?", label: "more" },
  { keys: "q", label: "quit" },
];

// The denials view is a mode, not a panel: its own keys, its own way out. The
// verbs are spelled out in full in the view's action block; what the legend
// adds is how to move and how to leave.
export const DENIAL_KEYS: Binding[] = [
  { keys: "enter", label: "hand all of it to claude", verb: "handoff" },
  { keys: "a", label: "add every safe rule to your config" },
  { keys: "r", label: "re-run this review" },
  { keys: "j/k ↑/↓", label: "scroll" },
  { keys: "esc D", label: "back to the queue" },
  { keys: "?", label: "help" },
  { keys: "q", label: "quit" },
];

// The log pane: this session's log lines, and the output of a poll or sync
// running as a child. Leaving it leaves the job running.
export const LOG_KEYS: Binding[] = [
  { keys: "j/k ↑/↓", label: "scroll" },
  { keys: "esc l", label: "back to the queue (the job keeps running)" },
  { keys: "?", label: "help" },
  { keys: "q", label: "quit" },
];

const KEYMAPS: Record<KeymapView, Binding[]> = {
  queue: QUEUE_KEYS,
  mine: MINE_KEYS,
  denials: DENIAL_KEYS,
  log: LOG_KEYS,
};

// The one-line footer: the verbs that differ between the two lists, plus the
// way to the rest. `tab` is not here — the tab strip shows it, where the thing
// it switches is.
const FOOTER: Record<KeymapView, string[]> = {
  queue: ["enter", "s", "d", "o", "D", "w", "n", "?"],
  mine: ["enter", "s", "d", "o", "R", "D", "n", "?"],
  denials: ["j/k ↑/↓", "esc D", "?", "q"],
  log: ["j/k ↑/↓", "esc l", "?", "q"],
};

export function Legend({
  view = "queue",
  unavailable,
}: {
  view?: KeymapView;
  unavailable: Record<string, string>;
}) {
  const items = KEYMAPS[view].filter((b) => FOOTER[view].includes(b.keys));
  // One Text, not a row of them: laid out as a row, a narrow terminal squeezes
  // each binding until it wraps, and the frame grows a line the height math
  // never budgeted for.
  return (
    <Text wrap="truncate-end">
      {items.map((b, i) => {
        const off = b.verb !== undefined && b.verb in unavailable;
        return (
          <Text key={b.keys} color={off ? "gray" : undefined} dimColor={off}>
            {i > 0 ? " · " : ""}
            <Text bold={!off}>{b.keys}</Text>
            <Text dimColor> {b.short ?? b.label}</Text>
          </Text>
        );
      })}
    </Text>
  );
}

function Keys({
  title,
  bindings,
  unavailable,
}: {
  title: string;
  bindings: Binding[];
  unavailable: Record<string, string>;
}) {
  return (
    <>
      <Text bold>{title}</Text>
      {bindings.map((b) => {
        const reason = b.verb !== undefined ? unavailable[b.verb] : undefined;
        return (
          <Box key={b.keys}>
            <Box width={12}>
              <Text bold color={reason ? "gray" : "cyan"}>
                {b.keys}
              </Text>
            </Box>
            <Text color={reason ? "gray" : undefined}>{b.label}</Text>
            {reason ? <Text color="gray"> — {reason}</Text> : null}
          </Box>
        );
      })}
    </>
  );
}

export function Help({ unavailable }: { unavailable: Record<string, string> }) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Keys title="queue" bindings={QUEUE_KEYS} unavailable={unavailable} />
      <Keys
        title="my PRs view"
        bindings={MINE_KEYS}
        unavailable={unavailable}
      />
      <Keys
        title="denials view"
        bindings={DENIAL_KEYS}
        unavailable={unavailable}
      />
      <Keys title="log pane" bindings={LOG_KEYS} unavailable={unavailable} />
      <Text dimColor>? or esc closes this</Text>
    </Box>
  );
}
