import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decide, outputLines } from '../src/dependabot.ts';
import { ROOT } from './helpers.ts';

type Json = Record<string, unknown>;

const HEAD = 'a'.repeat(40);

function message(...types: string[]): string {
  const deps = types.map((t, i) => `- dependency-name: dep${i}\n  dependency-version: 1.2.3\n  dependency-type: direct:development\n  update-type: ${t}\n`).join('');
  return `Bump dep0 from 1.2.2 to 1.2.3\n\n---\nupdated-dependencies:\n${deps}...\n`;
}

/** A clean npm patch update: every rule holds. */
function inputs(): { event: Json; pr: Json; commits: Json[]; files: Json[] } {
  return {
    event: { workflow_run: { head_sha: HEAD, pull_requests: [{ number: 7 }] } },
    pr: { number: 7, state: 'open', user: { login: 'dependabot[bot]' }, base: { ref: 'main' }, head: { ref: 'dependabot/npm_and_yarn/dep0-1.2.3', sha: HEAD, repo: { full_name: 'ircx-io/ircx-docs' } } },
    commits: [{ author: { login: 'dependabot[bot]' }, committer: { login: 'web-flow' }, parents: [{ sha: 'b'.repeat(40) }], commit: { message: message('version-update:semver-patch'), verification: { verified: true } } }],
    files: [{ filename: 'package.json' }, { filename: 'package-lock.json' }],
  };
}

function run(mutate: (i: ReturnType<typeof inputs>) => void = () => {}): ReturnType<typeof decide> {
  const i = inputs();
  mutate(i);
  return decide(i.event, i.pr, i.commits, i.files);
}

const commit0 = (i: ReturnType<typeof inputs>): Json => i.commits[0] as Json;

test('SC-U2-43 c merges an npm patch, with workflows=false', () => {
  const d = run();
  assert.equal(d.merge, true, d.reason);
  assert.deepEqual(outputLines(d), ['merge=true', 'number=7', `sha=${HEAD}`, 'workflows=false']);
});

test('SC-U2-43 c merges an npm minor', () => {
  const d = run((i) => ((commit0(i).commit as Json).message = message('version-update:semver-minor')));
  assert.equal(d.merge, true, d.reason);
});

test('SC-U2-43 c merges a GitHub Actions patch that changes only ci.yml, with workflows=true', () => {
  const d = run((i) => (i.files = [{ filename: '.github/workflows/ci.yml' }]));
  assert.equal(d.merge, true, d.reason);
  assert.equal(d.workflows, true);
  assert.deepEqual(outputLines(d).at(-1), 'workflows=true');
});

test('SC-U2-43 c merges an Actions minor that changes dependabot-merge.yml and settings-check.yml, with workflows=true', () => {
  const d = run((i) => {
    (commit0(i).commit as Json).message = message('version-update:semver-minor');
    i.files = [{ filename: '.github/workflows/dependabot-merge.yml' }, { filename: '.github/workflows/settings-check.yml' }];
  });
  assert.equal(d.merge, true, d.reason);
  assert.equal(d.workflows, true);
});

test('SC-U2-43 c each failed rule leaves the pull request for a maintainer', () => {
  const cases: Array<[string, (i: ReturnType<typeof inputs>) => void]> = [
    ['a major update', (i) => ((commit0(i).commit as Json).message = message('version-update:semver-major'))],
    ['no update-type line', (i) => ((commit0(i).commit as Json).message = 'Bump dep0\n')],
    ['a grouped update holding one major', (i) => ((commit0(i).commit as Json).message = message('version-update:semver-patch', 'version-update:semver-major'))],
    ['an unparsable update type', (i) => ((commit0(i).commit as Json).message = message('version-update:semver-patch extra'))],
    ['author ricardodevries', (i) => ((i.pr.user as Json).login = 'ricardodevries')],
    ['a fork head repository', (i) => (((i.pr.head as Json).repo as Json).full_name = 'someone/ircx-docs')],
    ['head ref feature/x', (i) => ((i.pr.head as Json).ref = 'feature/x')],
    ['a head SHA other than the run', (i) => ((i.pr.head as Json).sha = 'c'.repeat(40))],
    ['an uppercase head SHA', (i) => {
      (i.pr.head as Json).sha = 'A'.repeat(40);
      (i.event.workflow_run as Json).head_sha = 'A'.repeat(40);
    }],
    ['state: closed', (i) => (i.pr.state = 'closed')],
    ['base dev', (i) => ((i.pr.base as Json).ref = 'dev')],
    ['a commit authored by another login', (i) => ((commit0(i).author as Json).login = 'someone')],
    ['a commit with no author login', (i) => (commit0(i).author = null)],
    ['committer ricardodevries, the hand-fixed case', (i) => ((commit0(i).committer as Json).login = 'ricardodevries')],
    ['verified: false', (i) => (((commit0(i).commit as Json).verification as Json).verified = false)],
    ['a two-parent commit', (i) => (commit0(i).parents = [{}, {}])],
    ['no commits', (i) => (i.commits = [])],
    ['an empty pull_requests', (i) => ((i.event.workflow_run as Json).pull_requests = [])],
    ['a pull_requests number other than the PR read', (i) => ((i.event.workflow_run as Json).pull_requests = [{ number: 8 }])],
    ['a changed file src/x.ts', (i) => i.files.push({ filename: 'src/x.ts' })],
    ['a changed file .github/workflows/evil.yml', (i) => (i.files = [{ filename: '.github/workflows/evil.yml' }])],
    ['a changed file .github/dependabot.yml', (i) => (i.files = [{ filename: '.github/dependabot.yml' }])],
    ['a path that only starts with an allowed one', (i) => (i.files = [{ filename: 'package.json.bak' }])],
    ['an empty file list', (i) => (i.files = [])],
  ];
  for (const [name, mutate] of cases) {
    const d = run(mutate);
    assert.equal(d.merge, false, name);
    assert.deepEqual(outputLines(d), ['merge=false', 'number=', 'sha=', 'workflows=false'], name);
  }
});

test('SC-U2-43 e outputs hold exactly the four keys, and workflows is exactly true or false', () => {
  for (const d of [run(), run((i) => (i.files = [{ filename: '.github/workflows/ci.yml' }])), run((i) => (i.pr.state = 'closed'))]) {
    const lines = outputLines(d);
    assert.deepEqual(lines.map((l) => l.split('=')[0]), ['merge', 'number', 'sha', 'workflows']);
    assert.match(lines[3] ?? '', /^workflows=(true|false)$/);
    assert.match(lines[0] ?? '', /^merge=(true|false)$/);
  }
});

/** Runs the real entry point over four JSON files. */
function cli(i: ReturnType<typeof inputs>): ReturnType<typeof spawnSync> & { stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'docs-dependabot-'));
  try {
    const paths = ['event', 'pr', 'commits', 'files'].map((n) => join(dir, `${n}.json`));
    [i.event, i.pr, i.commits, i.files].forEach((v, k) => writeFileSync(paths[k] ?? '', JSON.stringify(v)));
    return spawnSync(process.execPath, [join(ROOT, 'src', 'dependabot.ts'), ...paths], { encoding: 'utf8', env: {} }) as never;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('SC-U2-43 e a hostile reason value cannot start a line with ::', () => {
  const i = inputs();
  (i.pr.head as Json).ref = 'x\n::error::x';
  const r = cli(i);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'merge=false\nnumber=\nsha=\nworkflows=false\n');
  for (const line of `${r.stdout}${r.stderr}`.split('\n')) {
    assert.ok(!line.startsWith('::'), line);
  }
  const ok = cli(inputs());
  assert.equal(ok.stdout, `merge=true\nnumber=7\nsha=${HEAD}\nworkflows=false\n`);
});

test('SC-U2-43 c the module imports only node:fs, node:path and relative modules', () => {
  const source = readFileSync(join(ROOT, 'src', 'dependabot.ts'), 'utf8');
  const specifiers = [...source.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? '');
  assert.ok(specifiers.length > 0);
  for (const s of specifiers) {
    assert.ok(s === 'node:fs' || s === 'node:path' || s.startsWith('./'), s);
  }
  assert.ok(!/process\.env|fetch\(|child_process|import\(/.test(source));
});
