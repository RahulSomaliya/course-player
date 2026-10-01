// course-player --root <courseDir> [--port 8795] [--open] [--data <dir>] [--web <dir>] [--version]
import path from 'node:path';

export const DEFAULT_PORT = 8795;

export const USAGE = `Usage: course-player --root <courseDir> [--port ${DEFAULT_PORT}] [--open] [--data <dir>] [--web <dir>] [--version]

  --root     the course folder (sections "01 …", "02 …" inside)
  --port     port on 127.0.0.1 (default ${DEFAULT_PORT}); the app is served at http://localhost:<port>
  --open     open the app in the default browser once the server is up
  --data     progress/config/outbox folder (default <root>/.player/data)
  --web      built web app (default: <binary dir>/../web as a single executable, else ./dist/web)
  --version  print the version and exit`;

export interface CliOptions {
  root: string;
  port: number;
  open: boolean;
  dataDir: string;
  webDir: string;
}

export type CliResult =
  | { kind: 'version' }
  | { kind: 'help' }
  | { kind: 'run'; options: CliOptions }
  | { kind: 'error'; message: string };

export interface CliEnv {
  /** running as the Node single-executable app (node:sea isSea()) */
  isSea: boolean;
  execPath: string;
  cwd: string;
}

type ValueFlag = 'root' | 'port' | 'data' | 'web';
const VALUE_FLAG_RE = /^--(root|port|data|web)(?:=([\s\S]*))?$/;

export function parseArgs(argv: string[], env: CliEnv): CliResult {
  const error = (message: string): CliResult => ({ kind: 'error', message });
  const values: Partial<Record<ValueFlag, string>> = {};
  let open = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--version' || arg === '-v') return { kind: 'version' };
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    if (arg === '--open') {
      open = true;
      continue;
    }
    const m = VALUE_FLAG_RE.exec(arg);
    if (!m) return error(`Unknown option ${arg}`);
    const flag = m[1] as ValueFlag;
    let value = m[2];
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) return error(`--${flag} needs a value`);
    }
    values[flag] = value;
  }

  if (!values.root) return error('--root <courseDir> is required');
  let port = DEFAULT_PORT;
  if (values.port !== undefined) {
    port = /^\d{1,5}$/.test(values.port) ? Number(values.port) : Number.NaN;
    if (!(port >= 0 && port <= 65535)) return error(`--port must be 0-65535, got "${values.port}"`);
  }
  const root = path.resolve(env.cwd, values.root);
  const defaultWeb = env.isSea ? path.resolve(path.dirname(env.execPath), '..', 'web') : path.resolve(env.cwd, 'dist', 'web');
  return {
    kind: 'run',
    options: {
      root,
      port,
      open,
      dataDir: values.data ? path.resolve(env.cwd, values.data) : path.join(root, '.player', 'data'),
      webDir: values.web ? path.resolve(env.cwd, values.web) : defaultWeb,
    },
  };
}
