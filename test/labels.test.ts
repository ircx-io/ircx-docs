import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from './helpers.ts';

/** The shell text of labels.yml's one run: block, with its indent removed. */
function runBlock(): string {
  const lines = readFileSync(join(ROOT, '.github', 'workflows', 'labels.yml'), 'utf8').split('\n');
  const start = lines.findIndex((l) => l === '        run: |');
  assert.ok(start > 0, 'the run block');
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line !== '' && !line.startsWith('          ')) {
      break;
    }
    body.push(line.slice(10));
  }
  return `${body.join('\n')}\n`;
}

/**
 * A fake gh on PATH. It records each call's argv, one JSON array per line;
 * answers the paginated file listing by applying the real jq program to the
 * fixture; answers the pull request read with `changed_files`; accepts the
 * label POST. `FAIL_LIST=1` makes the listing fail.
 */
const FAKE_GH = `#!/usr/bin/env bash
set -u
node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)) + "\\n")' -- "$@" >> "$FAKE_DIR/calls"
args=("$@")
if [ "\${args[1]}" = "--paginate" ]; then
  [ "\${FAIL_LIST:-0}" = 1 ] && exit 1
  jq -r "\${args[4]}" "$FAKE_DIR/files.json"
  exit $?
fi
if [ "\${args[1]}" = "-X" ]; then
  exit 0
fi
printf '%s\\n' "$CHANGED_FILES"
`;

interface Result {
  readonly status: number | null;
  readonly calls: string[][];
  readonly labels: string[];
  readonly dir: string;
}

function label(files: string[], headRepo: string, options: { changed?: number; failList?: boolean } = {}): Result {
  const dir = mkdtempSync(join(tmpdir(), 'docs-labels-'));
  try {
    writeFileSync(join(dir, 'gh'), FAKE_GH);
    chmodSync(join(dir, 'gh'), 0o755);
    writeFileSync(join(dir, 'files.json'), JSON.stringify(files.map((filename) => ({ filename }))));
    writeFileSync(join(dir, 'calls'), '');
    const r = spawnSync('bash', ['-c', runBlock()], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        FAKE_DIR: dir,
        GH_TOKEN: 'job-token',
        PR: '12',
        HEAD_REPO: headRepo,
        CHANGED_FILES: String(options.changed ?? files.length),
        FAIL_LIST: options.failList === true ? '1' : '0',
      },
    });
    const calls = readFileSync(join(dir, 'calls'), 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as string[]);
    const post = calls.find((c) => c.includes('POST'));
    const labels = post === undefined ? [] : post.filter((a) => a.startsWith('labels[]=')).map((a) => a.slice('labels[]='.length));
    return { status: r.status, calls, labels, dir: existsSync(join(dir, 'pwned')) ? 'pwned' : 'clean' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SELF = 'ircx-io/ircx-docs';
const LITERALS = ['content', 'review-as-code', 'repository-files', 'external'];

test('SC-U2-44 a content-only pull request gets exactly content', () => {
  const r = label(['content/index.md', 'content/connect/irc-client.md'], SELF);
  assert.equal(r.status, 0);
  assert.deepEqual(r.labels, ['content']);
});

test('SC-U2-44 a src/ pull request gets review-as-code; repository files get theirs', () => {
  assert.deepEqual(label(['src/scan.ts'], SELF).labels, ['review-as-code']);
  assert.deepEqual(label(['package-lock.json', '.nvmrc'], SELF).labels, ['review-as-code']);
  assert.deepEqual(label(['README.md', 'LICENSE-CODE'], SELF).labels, ['repository-files']);
  assert.deepEqual(label(['content/a.md', '.github/workflows/ci.yml', 'SECURITY.md'], SELF).labels, ['content', 'review-as-code', 'repository-files']);
});

test('SC-U2-44 b a fork head repository or an empty one adds external', () => {
  assert.deepEqual(label(['content/a.md'], 'fork/ircx-docs').labels, ['content', 'external']);
  assert.deepEqual(label(['content/a.md'], '').labels, ['content', 'external']);
});

test('SC-U2-44 b hostile file names never reach the shell or a label', () => {
  const split = label(['a\n.github/x'], SELF);
  assert.deepEqual(split.labels, []);
  const sub = label(['$(touch pwned)', 'content/$(touch pwned).md'], SELF);
  assert.equal(sub.dir, 'clean');
  assert.deepEqual(sub.labels, ['content']);
  const semi = label(['content/x; rm -rf ~'], SELF);
  assert.deepEqual(semi.labels, ['content']);
  for (const call of semi.calls) {
    assert.ok(!call.some((a) => a.includes('rm -rf')), JSON.stringify(call));
  }
});

test('SC-U2-44 d a truncated or failed listing adds review-as-code', () => {
  assert.deepEqual(label(['content/a.md', 'content/b.md'], SELF, { changed: 3 }).labels, ['content', 'review-as-code']);
  assert.deepEqual(label(['content/a.md'], SELF, { failList: true }).labels, ['review-as-code']);
  // A failed listing counts even when the pull request reports no changed file.
  assert.deepEqual(label([], SELF, { failList: true, changed: 0 }).labels, ['review-as-code']);
});

test('SC-U2-44 c every label POST holds only the four literals, and nothing is removed', () => {
  const runs = [
    label(['content/a.md', 'src/x.ts', 'README.md'], 'fork/x'),
    label(['weird name', 'a\n.github/x', '$(id)'], ''),
    label(['content/a.md'], SELF, { failList: true }),
  ];
  for (const r of runs) {
    assert.ok(r.labels.length > 0);
    assert.ok(r.labels.every((l) => LITERALS.includes(l)), JSON.stringify(r.labels));
    assert.ok(!r.calls.some((c) => c.includes('DELETE')));
    const post = r.calls.filter((c) => c.includes('POST'));
    assert.equal(post.length, 1);
    assert.deepEqual(post[0]?.slice(0, 4), ['api', '-X', 'POST', 'repos/ircx-io/ircx-docs/issues/12/labels']);
  }
  assert.deepEqual(label(['other.txt'], SELF).calls.filter((c) => c.includes('POST')), [], 'no label, no request');
});
