// Shared fixtures for the automation tests. Nothing here asserts. It reads the
// real workflow files, cuts a job or a step out of one, and runs a step's shell
// text under bash with a fake `gh` on PATH that records every call.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ROOT } from './helpers.ts';

export const NAMES = ['ci.yml', 'cut-release.yml', 'dependabot-merge.yml', 'labels.yml', 'settings-check.yml'] as const;

export function workflow(name: string): string {
  return readFileSync(join(ROOT, '.github', 'workflows', name), 'utf8');
}

/** The text of job `name`: from its `  name:` line to the next job or the end of the file. */
export function jobOf(text: string, name: string): string {
  const jobs = text.split('\njobs:\n')[1];
  if (jobs === undefined) {
    throw new Error('no jobs: mapping');
  }
  for (const block of jobs.split(/\n(?=  [A-Za-z0-9_-]+:\n)/)) {
    const first = block.replace(/^\n+/, '').split('\n')[0];
    if (first === `  ${name}:`) {
      return block.replace(/^\n+/, '');
    }
  }
  throw new Error(`no job ${name}`);
}

/** The names of the jobs, in file order. */
export function jobNames(text: string): string[] {
  return [...(text.split('\njobs:\n')[1] ?? '').matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)].map((m) => m[1] ?? '');
}

/** The steps of a job, each starting at its `      - ` line. */
export function stepsOf(job: string): string[] {
  return job.split(/\n(?=      - )/).slice(1);
}

/** The step whose `name:` or `id:` is `label`. */
export function stepNamed(job: string, label: string): string {
  const hit = stepsOf(job).find((s) => s.startsWith(`      - name: ${label}\n`) || s.startsWith(`      - id: ${label}\n`) || s.includes(`\n        id: ${label}\n`));
  if (hit === undefined) {
    throw new Error(`no step ${label}`);
  }
  return hit;
}

/** The shell text of a step's `run:`, with its indent removed. */
export function runOf(step: string): string {
  const lines = step.split('\n');
  const at = lines.findIndex((l) => /^( {8}|      - )run:/.test(l));
  if (at < 0) {
    throw new Error('no run:');
  }
  const first = (lines[at] ?? '').replace(/^( {8}|      - )run:\s?/, '');
  if (first === '|') {
    const body: string[] = [];
    for (const l of lines.slice(at + 1)) {
      if (l !== '' && !l.startsWith('          ')) {
        break;
      }
      body.push(l.slice(10));
    }
    return `${body.join('\n').replace(/\n+$/, '')}\n`;
  }
  return `${first}\n`;
}

/** The `env:` entries of a step, name to the raw value text. */
export function envOf(step: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = step.split('\n');
  const at = lines.findIndex((l) => l === '        env:');
  if (at < 0) {
    return out;
  }
  for (const l of lines.slice(at + 1)) {
    const m = /^ {10}([A-Z_]+): (.*)$/.exec(l);
    if (m === null) {
      break;
    }
    out[m[1] ?? ''] = m[2] ?? '';
  }
  return out;
}

/** One answer of the fake gh: the first route whose `match` is inside the space-joined arguments wins; a `match` that starts with `=` must equal them. */
export interface Route {
  readonly match: string;
  readonly out?: string;
  readonly err?: string;
  readonly rc?: number;
}

export interface Call {
  /** The GH_TOKEN the call ran with, or `<unset>`. */
  readonly token: string;
  readonly args: string[];
}

const FAKE_GH = `#!/usr/bin/env bash
set -u
sep=$'\\x1f'
line="\${GH_TOKEN-<unset>}"
for a in "$@"; do line+="$sep\${a//$'\\n'/$'\\x1e'}"; done
printf '%s\\n' "$line" >> "$FAKE_DIR/calls"
joined="$*"
filter=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--jq" ]; then filter="$a"; fi
  prev="$a"
done
i=0
while IFS=$'\\t' read -r match rc; do
  if [[ "$match" == =* ]]; then hit=$([ "$joined" = "\${match:1}" ] && echo y || echo n); else hit=$([[ "$joined" == *"$match"* ]] && echo y || echo n); fi
  if [ "$hit" = y ]; then
    cat "$FAKE_DIR/route$i.err" >&2
    if [ "$rc" = 0 ] && [ -n "$filter" ]; then
      jq -r "$filter" "$FAKE_DIR/route$i.out"
    else
      cat "$FAKE_DIR/route$i.out"
    fi
    exit "$rc"
  fi
  i=$((i + 1))
done < "$FAKE_DIR/routes"
echo "fake gh: no route for: $joined" >&2
exit 99
`;

export interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: Call[];
  /** The text of a file the script left in its working directory, or undefined. */
  read(name: string): string | undefined;
  exists(name: string): boolean;
}

export interface RunOptions {
  readonly env?: Record<string, string>;
  readonly routes?: readonly Route[];
  /** Files written into the working directory before the run. */
  readonly files?: Record<string, string>;
}

/**
 * Runs `script` under `bash -e` in a fresh directory with a fake `gh` first on
 * PATH, hands the result to `inspect` and removes the directory.
 */
export function runShell<T>(script: string, options: RunOptions, inspect: (run: Run) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'docs-step-'));
  try {
    mkdirSync(join(dir, 'tmp'));
    writeFileSync(join(dir, 'gh'), FAKE_GH);
    chmodSync(join(dir, 'gh'), 0o755);
    writeFileSync(join(dir, 'calls'), '');
    const routes = options.routes ?? [];
    writeFileSync(join(dir, 'routes'), routes.map((r) => `${r.match}\t${r.rc ?? 0}\n`).join(''));
    routes.forEach((r, i) => {
      writeFileSync(join(dir, `route${i}.out`), r.out ?? '');
      writeFileSync(join(dir, `route${i}.err`), r.err ?? '');
    });
    for (const [name, text] of Object.entries(options.files ?? {})) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    const r = spawnSync('bash', ['-e', '-c', script], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 60_000,
      env: { PATH: `${dir}:${process.env.PATH ?? ''}`, FAKE_DIR: dir, RUNNER_TEMP: join(dir, 'tmp'), ...options.env },
    });
    const calls = readFileSync(join(dir, 'calls'), 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => {
        const [token, ...args] = l.split('\x1f');
        return { token: token ?? '', args: args.map((a) => a.replaceAll('\x1e', '\n')) };
      });
    return inspect({
      status: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      calls,
      read: (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : undefined),
      exists: (name: string) => existsSync(join(dir, name)),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
