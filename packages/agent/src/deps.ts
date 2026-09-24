// Everything the CLI takes from the host, injected so tests and the demo run with a temp $HOME, a
// compressed clock and deterministic ids. bin.ts wires the real process.

export interface Deps {
  /** Only HOME and CLAUDE_CONFIG_DIR are read (paths.ts), plus TAPER_DOGFOOD (init). */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  /** Epoch ms. The only clock the agent reads. */
  readonly now: () => number;
  /** `bytes` random bytes as hex: device id and args-hash salt. */
  readonly randomHex: (bytes: number) => string;
  /** Whole of stdin (hook payloads). */
  readonly stdin: () => string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly isTTY: boolean;
  /** Interactive yes/no; called only when `isTTY`. */
  readonly confirm: (question: string) => boolean;
  /** Managed-settings directory; defaults to the per-OS path (facts doc B3). */
  readonly managedDir?: string;
  /** argv that runs this CLI (`[node, script]`); installed hooks run `<entry> hook <Event>`. */
  readonly entry: readonly string[];
}
