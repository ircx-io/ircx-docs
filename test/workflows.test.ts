import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { APPROVED_ACTIONS, CANONICAL_CI, checkWorkflows, normalise, WORKFLOW_FILES } from '../src/workflows.ts';

const ROOT = resolve(import.meta.dirname, '..');
const REAL = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

/** Runs the checker on a temporary tree whose workflows directory holds `files`. */
function check(files: Record<string, string>): string[] {
  const root = mkdtempSync(join(tmpdir(), 'docs-wf-'));
  try {
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(root, '.github', 'workflows', name), text);
    }
    return checkWorkflows(root).map((f) => f.rule);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function mutant(transform: (text: string) => string): string[] {
  const out = transform(REAL);
  assert.notEqual(out, REAL, 'the mutant changed nothing');
  return check({ 'ci.yml': out });
}

/** Replaces exactly one occurrence. */
function sub(from: string, to: string): (text: string) => string {
  return (text) => {
    assert.equal(text.split(from).length, 2, `need exactly one ${JSON.stringify(from)}`);
    return text.replace(from, to);
  };
}

const USES = /^( *)(- )?uses: (actions\/[a-z-]+)@([0-9a-f]{40}) # (v[0-9.]+)$/gm;

/** A different, well-formed SHA for `sha`: the same digits reversed. */
function otherSha(sha: string): string {
  const flipped = [...sha].reverse().join('');
  assert.notEqual(flipped, sha);
  return flipped;
}

function usesLine(action: string): string {
  const line = REAL.split('\n').find((l) => l.includes(`uses: ${action}@`));
  assert.ok(line !== undefined);
  return line;
}

test('the canonical ci.yml passes', () => {
  assert.deepEqual(checkWorkflows(ROOT), []);
  assert.deepEqual([...WORKFLOW_FILES], ['ci.yml']);
  assert.deepEqual([...APPROVED_ACTIONS], ['actions/checkout', 'actions/setup-node']);
});

test('SC-U2-1 the real ci.yml states each requirement, independent of the canonical text', () => {
  const lines = REAL.split('\n');
  assert.ok(REAL.startsWith('name: CI\n'), 'the workflow is named CI, which the required check depends on');
  const jobsAt = lines.indexOf('jobs:');
  assert.deepEqual(lines.slice(jobsAt + 1).filter((l) => /^ {2}[A-Za-z_-]+:/.test(l)), ['  docs:'], 'one job, named docs');
  assert.equal(lines.filter((l) => /^on:/.test(l)).length, 1);
  assert.ok(REAL.includes('on:\n  pull_request:\n  push:\n    branches: [main]\n'));
  assert.ok(REAL.includes('\npermissions:\n  contents: read\n'));
  assert.equal(lines.filter((l) => /permissions:/.test(l)).length, 1, 'no job-level permissions');
  for (const forbidden of ['secrets', 'vars.', 'environment:', 'id-token', '${{ github.event', 'head_ref', 'pull_request_target', 'workflow_run', 'issue_comment', 'actions/cache', 'write']) {
    assert.ok(!REAL.includes(forbidden), forbidden);
  }
  assert.ok(REAL.includes('concurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true\n'));
  assert.equal(lines.filter((l) => /^\s+cache:/.test(l)).length, 0, 'no cache input');
  assert.ok(REAL.includes('\njobs:\n  docs:\n'));
  assert.ok(REAL.includes('    timeout-minutes: 15\n'));
  assert.ok(REAL.includes('        with:\n          persist-credentials: false\n'));
  assert.ok(REAL.includes('          node-version-file: .nvmrc\n          package-manager-cache: false\n'));
  const runs = lines.filter((l) => /^ {6}- run: /.test(l)).map((l) => l.replace(/^ {6}- run: /, ''));
  assert.deepEqual(runs, ['npm ci --ignore-scripts', 'npm audit --audit-level=high', 'npm run typecheck', 'npm test', 'npm run check', 'npm run scan']);
});

test('SC-U2-1 each requirement has a failing mutant (W4: differs from the canonical workflow)', () => {
  const cases: Array<[string, (t: string) => string]> = [
    ['pull_request_target', sub('  pull_request:\n', '  pull_request_target:\n')],
    ['workflow_run', sub('  pull_request:\n', '  pull_request:\n  workflow_run:\n    workflows: [CI]\n')],
    ['issue_comment', sub('  pull_request:\n', '  pull_request:\n  issue_comment:\n')],
    ['push to every branch', sub('    branches: [main]\n', '    branches: ["**"]\n')],
    ['contents: write', sub('  contents: read\n', '  contents: write\n')],
    ['job-level write-all', sub('    timeout-minutes: 15\n', '    timeout-minutes: 15\n    permissions: write-all\n')],
    ['id-token: write', sub('  contents: read\n', '  contents: read\n  id-token: write\n')],
    ['secrets.X', sub('      - run: npm test\n', '      - run: npm test\n        env:\n          X: ${{ secrets.X }}\n')],
    ["secrets['X']", sub('      - run: npm test\n', "      - run: npm test\n        env:\n          X: ${{ secrets['X'] }}\n")],
    ['toJSON(secrets)', sub('      - run: npm test\n', '      - run: npm test\n        env:\n          X: ${{ toJSON(secrets) }}\n')],
    ['vars.X', sub('      - run: npm test\n', '      - run: npm test\n        env:\n          X: ${{ vars.X }}\n')],
    ['environment: production', sub('    timeout-minutes: 15\n', '    timeout-minutes: 15\n    environment: production\n')],
    ['persist-credentials removed', sub('        with:\n          persist-credentials: false\n', '')],
    ['persist-credentials: true', sub('persist-credentials: false', 'persist-credentials: true')],
    ['package-manager-cache removed', sub('          package-manager-cache: false\n', '')],
    ['package-manager-cache: true', sub('package-manager-cache: false', 'package-manager-cache: true')],
    ['cache: npm added', sub('          package-manager-cache: false\n', '          package-manager-cache: false\n          cache: npm\n')],
    ['node-version-file changed', sub('node-version-file: .nvmrc', 'node-version: 24')],
    ['an actions/cache step', (t) => t.replace('      - run: npm ci --ignore-scripts\n', `      - uses: actions/cache@${'a'.repeat(40)} # v4.0.0\n        with:\n          path: x\n          key: y\n      - run: npm ci --ignore-scripts\n`)],
    ['head_ref in a run line', sub('      - run: npm test\n', '      - run: echo ${{ github.head_ref }}\n      - run: npm test\n')],
    ['concurrency group as head_ref', sub('${{ github.workflow }}-${{ github.ref }}', '${{ github.head_ref || github.ref_name }}')],
    ['cancel-in-progress false', sub('cancel-in-progress: true', 'cancel-in-progress: false')],
    ['npm ci without --ignore-scripts', sub('npm ci --ignore-scripts', 'npm ci')],
    ['timeout-minutes removed', sub('    timeout-minutes: 15\n', '')],
    ['timeout-minutes 16', sub('timeout-minutes: 15', 'timeout-minutes: 16')],
    ['audit step removed', sub('      - run: npm audit --audit-level=high\n', '')],
    ['audit level lowered', sub('--audit-level=high', '--audit-level=critical')],
    ['scan step removed', sub('      - run: npm run scan\n', '')],
    ['check step removed', sub('      - run: npm run check\n', '')],
    ['npm run build in place of npm run check', sub('      - run: npm run check\n', '      - run: npm run build\n')],
    ['typecheck step removed', sub('      - run: npm run typecheck\n', '')],
    ['two steps swapped', sub('      - run: npm run typecheck\n      - run: npm test\n', '      - run: npm test\n      - run: npm run typecheck\n')],
    ['a second job', (t) => `${t}  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`],
    ['runs-on changed', sub('runs-on: ubuntu-latest', 'runs-on: self-hosted')],
    ['name changed', sub('name: CI\n', 'name: CI2\n')],
    ['name: Build in place of name: CI', sub('name: CI\n', 'name: Build\n')],
    ['job docs renamed test', sub('\n  docs:\n', '\n  test:\n')],
  ];
  for (const [name, transform] of cases) {
    const rules = mutant(transform);
    assert.ok(rules.includes('W4'), `${name}: ${JSON.stringify(rules)}`);
  }
});

test('SC-U2-2 a Dependabot SHA and version bump still passes', () => {
  const bumped = REAL.replace(USES, (_m, indent: string, dash: string | undefined, action: string, sha: string, version: string) => {
    const major = Number(/^v(\d+)/.exec(version)?.[1] ?? '0');
    return `${indent}${dash ?? ''}uses: ${action}@${otherSha(sha)} # v${major + 1}.2.3`;
  });
  assert.notEqual(bumped, REAL);
  for (const action of APPROVED_ACTIONS) {
    assert.notEqual(usesLine(action), bumped.split('\n').find((l) => l.includes(`uses: ${action}@`)));
  }
  assert.deepEqual(check({ 'ci.yml': bumped }), []);
});

test('SC-U2-2 normalise abstracts only the SHA and the version, keeping indent, marker and name', () => {
  const shas = new Map<string, string>();
  const sha = 'c'.repeat(40);
  const n = normalise('f', `    - uses: actions/checkout@${sha} # v1.2.3\n  uses: actions/setup-node@${sha} # v10.20.30\n`, shas);
  assert.deepEqual(n.findings, []);
  assert.equal(n.text, '    - uses: actions/checkout@<sha> # <version>\n  uses: actions/setup-node@<sha> # <version>\n');
  assert.deepEqual([...shas.entries()].sort(), [
    ['actions/checkout', sha],
    ['actions/setup-node', sha],
  ]);
});

test('SC-U2-2 each malformed or unapproved uses line is a W2 finding', () => {
  const checkout = usesLine('actions/checkout');
  const indentAndName = /^( *(?:- )?uses: actions\/checkout)@[0-9a-f]{40} # v[0-9.]+$/.exec(checkout);
  assert.ok(indentAndName !== null);
  const head = indentAndName[1] ?? '';
  const sha = (checkout.match(/@([0-9a-f]{40})/) ?? [])[1] ?? '';
  const cases: Array<[string, string]> = [
    ['tag pin', `${head}@v7`],
    ['major tag pin', `${head}@v7.0.1`],
    ['branch pin', `${head}@main`],
    ['short SHA', `${head}@${sha.slice(0, 7)} # v7.0.1`],
    ['39-digit SHA', `${head}@${sha.slice(0, 39)} # v7.0.1`],
    ['41-digit SHA', `${head}@${sha}a # v7.0.1`],
    ['uppercase SHA', `${head}@${sha.toUpperCase()} # v7.0.1`],
    ['missing version comment', `${head}@${sha}`],
    ['version comment without v', `${head}@${sha} # 7.0.1`],
    ['two-part version', `${head}@${sha} # v7.0`],
    ['trailing text', `${head}@${sha} # v7.0.1 extra`],
    ['no space before the comment', `${head}@${sha}# v7.0.1`],
    ['unlisted action', `${head.replace('actions/checkout', 'actions/upload-artifact')}@${sha} # v7.0.1`],
    ['lookalike action', `${head.replace('actions/checkout', 'actions/checkout-evil')}@${sha} # v7.0.1`],
    ['third-party action', `${head.replace('actions/checkout', 'evil/checkout')}@${sha} # v7.0.1`],
    ['local action', `${head.replace('actions/checkout', './.github/actions/x')}`],
    ['docker action', `${head.replace('actions/checkout', 'docker://alpine')}`],
    ['path under an approved action', `${head.replace('actions/checkout', 'actions/checkout/sub')}@${sha} # v7.0.1`],
  ];
  for (const [name, line] of cases) {
    const rules = mutant((t) => t.replace(checkout, line));
    assert.ok(rules.includes('W2'), `${name}: ${JSON.stringify(rules)}`);
    assert.ok(rules.includes('W4'), `${name} also differs from the canonical text`);
  }
});

test('SC-U2-2 normalise accepts only the two approved action names', () => {
  const sha = 'd'.repeat(40);
  for (const action of ['actions/cache', 'actions/upload-artifact', 'actions/checkout-evil', 'actions/checkout/sub', 'evil/checkout', 'actions/setup-node2']) {
    const n = normalise('f', `      - uses: ${action}@${sha} # v1.2.3\n`, new Map());
    assert.deepEqual(n.findings.map((f) => f.rule), ['W2'], action);
    assert.ok(n.text.includes(sha), 'a refused line is left as written');
  }
  for (const action of APPROVED_ACTIONS) {
    assert.deepEqual(normalise('f', `      - uses: ${action}@${sha} # v1.2.3\n`, new Map()).findings, [], action);
  }
});

test('SC-U2-2 a pin that is well formed but misplaced is a W4 finding', () => {
  const checkout = usesLine('actions/checkout');
  const setup = usesLine('actions/setup-node');
  const swapped = mutant((t) => t.replace(checkout, '@@A@@').replace(setup, checkout).replace('@@A@@', setup));
  assert.deepEqual(swapped.filter((r) => r !== 'W4'), []);
  assert.ok(swapped.includes('W4'));
  const moved = mutant((t) => t.replace(`      - uses: actions/setup-node@`, `        uses: actions/setup-node@`));
  assert.ok(moved.includes('W4'));
  const deeper = mutant((t) => t.replace(checkout, `  ${checkout}`));
  assert.ok(deeper.includes('W4'));
});

test('SC-U2-2 each action carries one SHA across the file', () => {
  const checkout = usesLine('actions/checkout');
  const sha = (checkout.match(/@([0-9a-f]{40})/) ?? [])[1] ?? '';
  const second = checkout.replace(sha, otherSha(sha));
  const rules = mutant((t) => t.replace('      - run: npm test\n', `${second}\n      - run: npm test\n`));
  assert.ok(rules.includes('W3'), JSON.stringify(rules));
  // The same SHA twice is not a W3 finding.
  const same = mutant((t) => t.replace('      - run: npm test\n', `${checkout}\n      - run: npm test\n`));
  assert.ok(!same.includes('W3'));
});

test('SC-U2-2 the set of workflow files is exactly ci.yml', () => {
  assert.deepEqual(check({ 'ci.yml': REAL }), []);
  assert.deepEqual(check({ 'ci.yml': REAL, 'release.yml': REAL }), ['W1']);
  assert.deepEqual(check({ 'ci.yml': REAL, 'ci.yaml': REAL }), ['W1']);
  assert.ok(check({ 'ci.yaml': REAL }).includes('W1'));
  assert.ok(check({}).includes('W1'));
  const root = mkdtempSync(join(tmpdir(), 'docs-wf-'));
  try {
    assert.deepEqual(checkWorkflows(root).map((f) => f.rule), ['W1']);
    mkdirSync(join(root, '.github', 'workflows', 'sub'), { recursive: true });
    writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), REAL);
    writeFileSync(join(root, '.github', 'workflows', 'sub', 'x.yml'), REAL);
    assert.ok(checkWorkflows(root).some((f) => f.rule === 'W1'), 'a nested workflow file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SC-U2-2 the canonical text and the checker hold no SHA or version literal', () => {
  const checker = readFileSync(join(ROOT, 'src', 'workflows.ts'), 'utf8');
  assert.equal(/[0-9a-f]{40}/.test(checker), false);
  assert.equal(/# v\d/.test(CANONICAL_CI), false);
  assert.ok(CANONICAL_CI.includes('@<sha> # <version>'));
  assert.equal(/[0-9a-f]{40}/.test(readFileSync(new URL(import.meta.url), 'utf8')), false);
});

test('SC-U2-2 a uses line is read whole: a junk prefix, a missing dash or a tab indent is still a finding', () => {
  const checkout = usesLine('actions/checkout');
  const sha = (checkout.match(/@([0-9a-f]{40})/) ?? [])[1] ?? '';
  // The junk prefix must not vanish when the line is normalised.
  for (const prefix of ['x', '#', 'run: echo ']) {
    const rules = mutant((t) => t.replace(checkout, `${prefix}${checkout}`));
    assert.ok(rules.includes('W4'), `prefix ${JSON.stringify(prefix)}: ${JSON.stringify(rules)}`);
  }
  assert.ok(normalise('f', `x${checkout}\n`, new Map()).text.startsWith('x'), 'the prefix survives normalisation');
  assert.deepEqual(normalise('f', `# ${checkout.trim()}\n`, new Map()).findings, [], 'a comment is not a uses line');
  const cases: Array<[string, string]> = [
    ['a tag pin without the dash', '        uses: actions/checkout@v7'],
    ['a local action without the dash', '        uses: ./.github/actions/x'],
    ['a tab-indented tag pin', '\t- uses: actions/checkout@v7'],
    ['a tab-indented docker action', '\t\tuses: docker://alpine'],
    ['an unlisted action without the dash', `        uses: dependabot/fetch-metadata@${sha} # v2.0.0`],
  ];
  for (const [name, line] of cases) {
    const rules = mutant((t) => t.replace(checkout, line));
    assert.ok(rules.includes('W2'), `${name}: ${JSON.stringify(rules)}`);
  }
});
