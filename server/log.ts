// One context-rich line per notable event, prefixed with its area: "[scan] …", "[media] …",
// "[journey] …". Injected everywhere so tests can capture lines instead of printing.
// Never pass a JS Journey token or student link into a log line.
export type Log = (line: string) => void;

export const stdoutLog: Log = (line) => {
  process.stdout.write(line + '\n');
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
