import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { APPROVED_ACTIONS, CANONICAL, checkWorkflows, normalise, structuralFindings, WORKFLOW_FILES } from '../src/workflows.ts';

const ROOT = resolve(import.meta.dirname, '..');
const NAMES = ['ci.yml', 'cut-release.yml', 'dependabot-merge.yml', 'labels.yml', 'settings-check.yml'];
const FILES: Readonly<Record<string, string>> = Object.fromEntries(NAMES.map((n) => [n, readFileSync(join(ROOT, '.github', 'workflows', n), 'utf8')]));
const REAL = FILES['ci.yml'] ?? '';

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

/** Runs the checker on the real five files with `name` transformed. */
function mutantIn(name: string, transform: (text: string) => string): string[] {
  const before = FILES[name] ?? '';
  const out = transform(before);
  assert.notEqual(out, before, 'the mutant changed nothing');
  return check({ ...FILES, [name]: out });
}

function mutant(transform: (text: string) => string): string[] {
  return mutantIn('ci.yml', transform);
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
  assert.deepEqual([...WORKFLOW_FILES], NAMES);
  assert.deepEqual([...APPROVED_ACTIONS], ['actions/checkout', 'actions/create-github-app-token', 'actions/setup-node']);
  assert.deepEqual(check({ ...FILES }), []);
});

test('SC-U2-1 the real ci.yml states each requirement, independent of the canonical text', () => {
  const lines = REAL.split('\n');
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
  const bump = (text: string): string =>
    text.replace(USES, (_m, indent: string, dash: string | undefined, action: string, sha: string, version: string) => {
      const major = Number(/^v(\d+)/.exec(version)?.[1] ?? '0');
      return `${indent}${dash ?? ''}uses: ${action}@${otherSha(sha)} # v${major + 1}.2.3`;
    });
  const bumped = Object.fromEntries(NAMES.map((n) => [n, bump(FILES[n] ?? '')]));
  const seen = new Set<string>();
  for (const n of NAMES) {
    for (const m of (FILES[n] ?? '').matchAll(USES)) {
      seen.add(m[3] ?? '');
    }
    if (n !== 'labels.yml') {
      assert.notEqual(bumped[n], FILES[n], n);
    }
  }
  assert.deepEqual([...seen].sort(), [...APPROVED_ACTIONS]);
  assert.deepEqual(check(bumped), []);
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

test('SC-U2-2 normalise accepts only the three approved action names', () => {
  const sha = 'd'.repeat(40);
  for (const action of ['actions/cache', 'actions/upload-artifact', 'actions/checkout-evil', 'actions/checkout/sub', 'evil/checkout', 'actions/setup-node2', 'dependabot/fetch-metadata', 'actions/create-github-app-token-x']) {
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

test('SC-U2-2 the set of workflow files is exactly the five', () => {
  assert.deepEqual(check({ ...FILES }), []);
  assert.deepEqual(check({ ...FILES, 'release-notes.yml': REAL }), ['W1']);
  assert.deepEqual(check({ ...FILES, 'ci.yaml': REAL }), ['W1']);
  const { 'labels.yml': _dropped, ...four } = FILES;
  assert.ok(check(four).includes('W1'));
  assert.ok(check({ 'ci.yml': REAL }).includes('W1'));
  assert.ok(check({}).includes('W1'));
  const root = mkdtempSync(join(tmpdir(), 'docs-wf-'));
  try {
    assert.deepEqual(checkWorkflows(root).map((f) => f.rule), ['W1']);
    mkdirSync(join(root, '.github', 'workflows', 'sub'), { recursive: true });
    for (const n of NAMES) {
      writeFileSync(join(root, '.github', 'workflows', n), FILES[n] ?? '');
    }
    writeFileSync(join(root, '.github', 'workflows', 'sub', 'x.yml'), REAL);
    assert.ok(checkWorkflows(root).some((f) => f.rule === 'W1'), 'a nested workflow file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SC-U2-2 the canonical text and the checker hold no SHA or version literal', () => {
  const checker = readFileSync(join(ROOT, 'src', 'workflows.ts'), 'utf8');
  assert.equal(/[0-9a-f]{40}/.test(checker), false);
  assert.deepEqual(Object.keys(CANONICAL), NAMES);
  for (const text of Object.values(CANONICAL)) {
    assert.equal(/# v\d/.test(text), false);
  }
  assert.ok(CANONICAL['ci.yml']?.includes('@<sha> # <version>'));
  assert.equal(/[0-9a-f]{40}/.test(readFileSync(new URL(import.meta.url), 'utf8')), false);
});

// Commit B: the four automation workflows (SC-U2-42 to SC-U2-47).

/** The line of `name` that pins `action`. */
function pinLine(name: string, action: string): string {
  const line = (FILES[name] ?? '').split('\n').find((l) => l.includes(`uses: ${action}@`));
  assert.ok(line !== undefined, `${name} pins ${action}`);
  return line;
}

/** A checkout step as the real files write it, for planting into another job. */
const CHECKOUT_STEP = `      - uses: ${pinLine('ci.yml', 'actions/checkout').trim().replace(/^- uses: /, '')}\n        with:\n          persist-credentials: false\n`;
const SETUP_NODE_STEP = `      - uses: ${pinLine('ci.yml', 'actions/setup-node').trim().replace(/^- uses: /, '')}\n        with:\n          node-version-file: .nvmrc\n`;

/** Applies `transform` to the step whose first line is `      - id: <id>`, up to the next step. */
function inStep(id: string, transform: (step: string) => string): (text: string) => string {
  return (text) => {
    const start = text.indexOf(`      - id: ${id}\n`);
    assert.ok(start >= 0, `step ${id}`);
    const rest = text.slice(start + 1);
    const next = rest.search(/\n {6}- |\n\n|\n {2}[a-z]/);
    const end = next < 0 ? text.length : start + 1 + next + 1;
    const step = text.slice(start, end);
    const changed = transform(step);
    assert.notEqual(changed, step, `step ${id} unchanged`);
    return text.slice(0, start) + changed + text.slice(end);
  };
}

const VALIDATE_START = '      - name: Validate the decision\n';

/** Moves merge's validation step after its first mint step. */
function validationAfterMint(text: string): string {
  const a = text.indexOf(VALIDATE_START);
  const b = text.indexOf('      - id: contents-token\n');
  const c = text.indexOf('      - id: workflows-token\n');
  assert.ok(a >= 0 && a < b && b < c);
  return text.slice(0, a) + text.slice(b, c) + text.slice(a, b) + text.slice(c);
}

/** Moves settings-check's merge-token and merge-options steps before its read step. */
function mergeStepsBeforeRead(text: string): string {
  const a = text.indexOf('      - id: read\n');
  const b = text.indexOf('      - id: merge-token\n');
  const c = text.indexOf('\n\n  compare:\n') + 1;
  assert.ok(a >= 0 && a < b && b < c);
  return text.slice(0, a) + text.slice(b, c) + text.slice(a, b) + text.slice(c);
}

/** Swaps settings-check's merge-token and merge-options steps, so merge-options comes first. */
function mergeStepsSwapped(text: string): string {
  const b = text.indexOf('      - id: merge-token\n');
  const c = text.indexOf('      - id: merge-options\n');
  const d = text.indexOf('\n\n  compare:\n') + 1;
  assert.ok(b >= 0 && b < c && c < d);
  return text.slice(0, b) + text.slice(c, d) + text.slice(b, c) + text.slice(d);
}

/** The merge-token step as the real file writes it, for planting into the compare job. */
function mergeTokenStep(text: string): string {
  const b = text.indexOf('      - id: merge-token\n');
  const c = text.indexOf('      - id: merge-options\n');
  assert.ok(b >= 0 && b < c);
  return text.slice(b, c);
}

/** Moves settings-check's read mint, the step `token`, into the compare job. */
function readMintInCompare(text: string): string {
  const a = text.indexOf('      - id: token\n');
  const b = text.indexOf('      - id: read\n');
  const c = text.indexOf('      - name: Write the responses to files\n');
  assert.ok(a >= 0 && a < b && b < c);
  return text.slice(0, a) + text.slice(b, c) + text.slice(a, b) + text.slice(c);
}

/** Appends `line` to the shell of settings-check's merge-options step. */
function mergeOptionsLine(line: string): (text: string) => string {
  return inStep('merge-options', (t) => `${t}          ${line}\n`);
}

function releaseValidationAfterMint(text: string): string {
  const a = text.indexOf('      - name: Validate the inputs\n');
  const b = text.indexOf('      - id: token\n');
  const c = text.indexOf('      - name: Create the release\n');
  assert.ok(a >= 0 && a < b && b < c);
  return text.slice(0, a) + text.slice(b, c) + text.slice(a, b) + text.slice(c);
}

type Case = readonly [name: string, file: string, transform: (text: string) => string, rule: string];

const DM = 'dependabot-merge.yml';
const LB = 'labels.yml';
const CR = 'cut-release.yml';
const SC = 'settings-check.yml';

const CASES: readonly Case[] = [
  // SC-U2-43 (a) to (d): dependabot-merge.yml.
  ['dependabot-merge on pull_request', DM, sub('  workflow_run:\n    workflows: [CI]\n    types: [completed]\n', '  pull_request:\n'), 'W4'],
  ['dependabot-merge on pull_request_target', DM, sub('  workflow_run:\n    workflows: [CI]\n    types: [completed]\n', '  pull_request_target:\n'), 'W8'],
  ['workflows: [Other]', DM, sub('workflows: [CI]', 'workflows: [Other]'), 'W4'],
  ['types: [requested]', DM, sub('types: [completed]', 'types: [requested]'), 'W4'],
  ['decide with contents: write', DM, sub('      contents: read\n      pull-requests: read\n', '      contents: write\n      pull-requests: read\n'), 'W9'],
  ['decide with pull-requests: write', DM, sub('      pull-requests: read\n', '      pull-requests: write\n'), 'W4'],
  ['decide without the conclusion condition', DM, sub("      github.event.workflow_run.conclusion == 'success' &&\n", ''), 'W4'],
  ['decide without the event condition', DM, sub("      github.event.workflow_run.event == 'pull_request' &&\n", ''), 'W4'],
  ['decide without the path condition', DM, sub("      github.event.workflow_run.path == '.github/workflows/ci.yml' &&\n", ''), 'W4'],
  ['decide without the head repository condition', DM, sub(" &&\n      github.event.workflow_run.head_repository.full_name == 'ircx-io/ircx-docs'", ''), 'W4'],
  ['decide checks out the head SHA', DM, sub('          persist-credentials: false\n', '          ref: ${{ github.event.workflow_run.head_sha }}\n          persist-credentials: false\n'), 'W4'],
  ['decide checkout without persist-credentials', DM, sub('        with:\n          persist-credentials: false\n', ''), 'W4'],
  ['merge without needs: decide', DM, sub('    needs: decide\n', ''), 'W4'],
  ['merge without its if', DM, sub("    if: needs.decide.outputs.merge == 'true'\n", ''), 'W4'],
  ['skip-token-revoke: true on a merge mint', DM, inStep('contents-token', (t) => `${t}          skip-token-revoke: true\n`), 'W11'],
  ['a merge mint without permission-contents', DM, inStep('contents-token', (t) => t.replace('          permission-contents: write\n', '')), 'W11'],
  ['permission-workflows on the workflows == false mint', DM, inStep('contents-token', (t) => `${t}          permission-workflows: write\n`), 'W4'],
  ['the workflows == true mint removed', DM, inStep('workflows-token', () => ''), 'W4'],
  ['the workflows == true mint without its if', DM, inStep('workflows-token', (t) => t.replace("        if: needs.decide.outputs.workflows == 'true'\n", '')), 'W4'],
  ["the contents-only mint on workflows != 'true'", DM, sub("if: needs.decide.outputs.workflows == 'false'", "if: needs.decide.outputs.workflows != 'true'"), 'W4'],
  ['merge_method=merge', DM, sub('merge_method=squash', 'merge_method=merge'), 'W4'],
  ['the sha guard dropped', DM, sub(' -f sha=$SHA', ''), 'W4'],
  ['a non-2xx response is ignored', DM, sub('-f sha=$SHA\n', '-f sha=$SHA || true\n'), 'W4'],
  ['a failed merge is retried', DM, (t) => sub('        run: gh api -X PUT', '        run: for i in 1 2 3; do gh api -X PUT')(t).replace('-f sha=$SHA\n', '-f sha=$SHA && break; done\n'), 'W4'],
  ['a concurrency group', DM, sub('permissions: {}\n\njobs:', 'permissions: {}\n\nconcurrency:\n  group: merge\n\njobs:'), 'W4'],
  ['github.actor in an if', DM, sub("    if: needs.decide.outputs.merge == 'true'\n", "    if: needs.decide.outputs.merge == 'true' && github.actor == 'dependabot[bot]'\n"), 'W12'],
  // SC-U2-42 (b): a key job runs no repository code.
  ['a checkout step in merge', DM, sub(`    steps:\n${VALIDATE_START}`, `    steps:\n${CHECKOUT_STEP}${VALIDATE_START}`), 'W10'],
  ['a checkout step in read', SC, sub('    steps:\n      - id: token\n', `    steps:\n${CHECKOUT_STEP}      - id: token\n`), 'W10'],
  ['a setup-node step in release', CR, sub('    steps:\n      - name: Validate the inputs\n', `    steps:\n${SETUP_NODE_STEP}      - name: Validate the inputs\n`), 'W10'],
  ['node src/dependabot.ts in merge', DM, sub('      - name: Squash-merge at the checked head\n', '      - run: node src/dependabot.ts x\n      - name: Squash-merge at the checked head\n'), 'W10'],
  ['bash .github/x.sh in read', SC, sub('      - id: read\n', '      - run: bash .github/x.sh\n      - id: read\n'), 'W10'],
  ['environment moved from merge to decide', DM, (t) => sub('    environment: ircx-bot\n', '')(t).replace('    timeout-minutes: 10\n    permissions:\n      contents: read\n', '    timeout-minutes: 10\n    environment: ircx-bot\n    permissions:\n      contents: read\n'), 'W10'],
  ['environment moved from merge to decide (W7)', DM, (t) => sub('    environment: ircx-bot\n', '')(t).replace('    timeout-minutes: 10\n    permissions:\n      contents: read\n', '    timeout-minutes: 10\n    environment: ircx-bot\n    permissions:\n      contents: read\n'), 'W7'],
  ['a decide output read directly in merge', DM, sub('-f sha=$SHA', '-f sha=${{ needs.decide.outputs.sha }}'), 'W5'],
  // SC-U2-42 (c): the key job re-validates every value before any mint.
  ['the number check removed', DM, (t) => t.replace(/ {10}\[\[ "\$NUMBER".*\n/, ''), 'W4'],
  ['the sha check removed', DM, (t) => t.replace(/ {10}\[\[ "\$SHA".*\n/, ''), 'W4'],
  ['the workflows check removed', DM, (t) => t.replace(/ {10}\[\[ "\$WORKFLOWS".*\n/, ''), 'W4'],
  ['the workflows pattern without its end anchor', DM, sub('^(true|false)$ ]]', '^(true|false) ]]'), 'W4'],
  ['the validation step after the first mint', DM, validationAfterMint, 'W4'],
  // SC-U2-44: labels.yml.
  ['labels on pull_request', LB, sub('  pull_request_target:\n', '  pull_request:\n'), 'W4'],
  ['a checkout step in labels', LB, sub('    steps:\n', `    steps:\n${CHECKOUT_STEP}`), 'W8'],
  ['secrets.GITHUB_TOKEN in labels', LB, sub('GH_TOKEN: ${{ github.token }}', 'GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}'), 'W6'],
  ['environment: ircx-bot in labels', LB, sub('    timeout-minutes: 5\n', '    timeout-minutes: 5\n    environment: ircx-bot\n'), 'W7'],
  ['labels with contents: write', LB, sub('      pull-requests: write\n', '      pull-requests: write\n      contents: write\n'), 'W9'],
  ['labels with issues: write', LB, sub('      pull-requests: write\n', '      pull-requests: write\n      issues: write\n'), 'W4'],
  ['the pull request title in run', LB, sub('          set -uo pipefail\n', '          set -uo pipefail\n          echo "${{ github.event.pull_request.title }}"\n'), 'W5'],
  ['the head repository in run', LB, sub('          set -uo pipefail\n', '          set -uo pipefail\n          echo "${{ github.event.pull_request.head.repo.full_name }}"\n'), 'W5'],
  // SC-U2-45: cut-release.yml.
  ['cut-release on push', CR, sub('on:\n  workflow_dispatch:\n', 'on:\n  push:\n  workflow_dispatch:\n'), 'W4'],
  ['cut-release on schedule', CR, sub('on:\n  workflow_dispatch:\n', "on:\n  schedule:\n    - cron: '0 0 * * *'\n  workflow_dispatch:\n"), 'W4'],
  ['cut-release without its environment', CR, sub('    environment: ircx-bot\n', ''), 'W7'],
  ['the release validation after the mint', CR, releaseValidationAfterMint, 'W4'],
  ['the tag pattern loosened', CR, (t) => t.replace(/\^v\[0-9\]\{4\}.*?\?\$ \]\]/, '^v.*$ ]]'), 'W4'],
  ['the compare check removed', CR, (t) => t.replace(/ {10}status=.*\n {10}case "\$status" in\n.*\n.*\n {10}esac\n/, ''), 'W4'],
  ['the 404 check replaced by || true', CR, (t) => t.replace(/ {10}if lookup=[\s\S]*? {10}esac\n {6}- id: token/, '          gh api "repos/ircx-io/ircx-docs/git/ref/tags/$TAG" || true\n      - id: token'), 'W4'],
  ['generate_release_notes=false', CR, sub('generate_release_notes=true', 'generate_release_notes=false'), 'W4'],
  ['target_commitish dropped', CR, sub(' -f "target_commitish=$REVISION"', ''), 'W4'],
  ['inputs.tag inside run', CR, sub('-f "tag_name=$TAG"', '-f "tag_name=${{ inputs.tag }}"'), 'W5'],
  ['a checkout step in release', CR, sub('    steps:\n', `    steps:\n${CHECKOUT_STEP}`), 'W10'],
  // SC-U2-46: settings-check.yml.
  ['compare without issues: write', SC, sub('      issues: write\n', ''), 'W4'],
  ['read with issues: write', SC, sub('      actions: read\n      contents: read\n', '      actions: read\n      contents: read\n      issues: write\n'), 'W4'],
  ['permission-administration: write', SC, sub('permission-administration: read', 'permission-administration: write'), 'W11'],
  ['read without its environment', SC, sub('    environment: ircx-bot\n', ''), 'W7'],
  ['environment: ircx-bot on compare', SC, sub('    if: always()\n', '    if: always()\n    environment: ircx-bot\n'), 'W7'],
  ['environment: ircx-bot on compare (W10)', SC, sub('    if: always()\n', '    if: always()\n    environment: ircx-bot\n'), 'W10'],
  ['compare without if: always()', SC, sub('    if: always()\n', ''), 'W4'],
  ['the issue step without its failure condition', SC, sub("        if: failure() && steps.compare.outcome == 'failure'\n", ''), 'W4'],
  ['a read output inside run', SC, sub(`printf '%s' "$RULESETS"`, `printf '%s' '\${{ needs.read.outputs.rulesets }}'`), 'W5'],
  // SC-U2-46 a and b, SC-U2-47 W11 and W14: the Contents-write mint and the merge-options read.
  ['permission-contents: write on the read mint', SC, inStep('token', (t) => t.replace('          permission-environments: read\n', '          permission-environments: read\n          permission-contents: write\n')), 'W11'],
  ['skip-token-revoke on merge-token', SC, inStep('merge-token', (t) => `${t}          skip-token-revoke: true\n`), 'W11'],
  ['merge-token renamed', SC, sub('      - id: merge-token\n', '      - id: other\n'), 'W11'],
  ['permission-administration: read added to merge-token', SC, inStep('merge-token', (t) => `${t}          permission-administration: read\n`), 'W14'],
  ['permission-workflows: write added to merge-token', SC, inStep('merge-token', (t) => `${t}          permission-workflows: write\n`), 'W14'],
  ['permission-workflows: write in place of permission-contents on merge-token', SC, inStep('merge-token', (t) => t.replace('permission-contents: write', 'permission-workflows: write')), 'W14'],
  ['the read mint moved to compare', SC, readMintInCompare, 'W14'],
  ['a third mint in read', SC, (t) => sub('      - id: read\n', `${mergeTokenStep(t).replace('id: merge-token', 'id: extra').replace('permission-contents: write', 'permission-secrets: read')}      - id: read\n`)(t), 'W14'],
  ['the read step renamed', SC, sub('      - id: read\n', '      - id: other\n'), 'W14'],
  ['a mint step in compare', SC, (t) => sub('      - name: Write the responses to files\n', `${mergeTokenStep(t)}      - name: Write the responses to files\n`)(t), 'W14'],
  ['merge-token and merge-options moved before the read step', SC, mergeStepsBeforeRead, 'W14'],
  ['a step after merge-options', SC, sub('\n\n  compare:\n', '\n      - run: true\n\n  compare:\n'), 'W14'],
  ['the merge-field filter without allow_auto_merge', SC, sub(' allow_auto_merge,', ''), 'W4'],
  ['merge-options read through the read mint', SC, sub('GH_TOKEN: ${{ steps.merge-token.outputs.token }}', 'GH_TOKEN: ${{ steps.token.outputs.token }}'), 'W14'],
  ['a merge-token output on read', SC, sub('      merge-options: ${{ steps.merge-options.outputs.merge-options }}\n', '      merge-options: ${{ steps.merge-options.outputs.merge-options }}\n      merge-token: ${{ steps.merge-token.outputs.token }}\n'), 'W14'],
  ['merge-token in the read step env', SC, sub('APP_TOKEN: ${{ steps.token.outputs.token }}', 'APP_TOKEN: ${{ steps.merge-token.outputs.token }}'), 'W14'],
  ['merge-token under another env key', SC, inStep('merge-options', (t) => t.replace('GH_TOKEN: ${{', 'TOKEN: ${{').replace('$(gh api', '$(GH_TOKEN="$TOKEN" gh api')), 'W14'],
  ['GH_TOKEN renamed on merge-options', SC, sub('          GH_TOKEN: ${{ steps.merge-token.outputs.token }}\n', '          TOKEN: ${{ steps.merge-token.outputs.token }}\n'), 'W14'],
  ['a second env key on merge-options', SC, sub('          GH_TOKEN: ${{ steps.merge-token.outputs.token }}\n', '          GH_TOKEN: ${{ steps.merge-token.outputs.token }}\n          X: y\n'), 'W14'],
  ['a PATCH on the repository', SC, sub('gh api repos/ircx-io/ircx-docs |', 'gh api -X PATCH repos/ircx-io/ircx-docs -F allow_auto_merge=true |'), 'W14'],
  ['a field flag on the read', SC, sub('gh api repos/ircx-io/ircx-docs |', 'gh api -f name=x repos/ircx-io/ircx-docs |'), 'W14'],
  ['another endpoint in merge-options', SC, sub('gh api repos/ircx-io/ircx-docs |', 'gh api repos/ircx-io/ircx-docs/hooks |'), 'W14'],
  ['a second gh call in merge-options', SC, mergeOptionsLine('gh api repos/ircx-io/ircx-docs/collaborators > /dev/null'), 'W14'],
  ['declare in merge-options', SC, mergeOptionsLine('declare -p > /dev/null'), 'W14'],
  ['env as a command in merge-options', SC, mergeOptionsLine('env | sort > /dev/null'), 'W14'],
  ['a second output in merge-options', SC, mergeOptionsLine(`printf 'other=1\\n' >> "$GITHUB_OUTPUT"`), 'W14'],
  ['a graphql call in merge-options', SC, mergeOptionsLine('gh api graphql -f query=x'), 'W14'],
  ['the token written to an output', SC, mergeOptionsLine(`printf 'token=%s\\n' "$GH_TOKEN" >> "$GITHUB_OUTPUT"`), 'W14'],
  ['a GITHUB_ENV write in merge-options', SC, mergeOptionsLine('echo x=y >> "$GITHUB_ENV"'), 'W14'],
  ['printenv into the step summary', SC, mergeOptionsLine('printenv >> "$GITHUB_STEP_SUMMARY"'), 'W14'],
  ['merge-options before merge-token', SC, mergeStepsSwapped, 'W14'],
  ['a step between merge-token and merge-options', SC, sub('      - id: merge-options\n', '      - run: true\n      - id: merge-options\n'), 'W14'],
  ['repositories removed from merge-token', SC, inStep('merge-token', (t) => t.replace('          repositories: ircx-docs\n', '')), 'W11'],
  ['owner removed from merge-token', SC, inStep('merge-token', (t) => t.replace('          owner: ircx-io\n', '')), 'W11'],
  // SC-U2-47: one mutant per rule.
  ['W6 secrets.IRCX_BOT_PRIVATE_KEY in labels', LB, sub('GH_TOKEN: ${{ github.token }}', 'GH_TOKEN: ${{ secrets.IRCX_BOT_PRIVATE_KEY }}'), 'W6'],
  ['W6 toJSON(secrets) in cut-release', CR, sub('REVISION: ${{ inputs.revision }}\n        run: |', 'REVISION: ${{ inputs.revision }}\n          ALL: ${{ toJSON(secrets) }}\n        run: |'), 'W6'],
  ['W6 the private-key line in a run step env', CR, sub('          TAG: ${{ inputs.tag }}\n          REVISION: ${{ inputs.revision }}\n        run: gh', '          TAG: ${{ inputs.tag }}\n          REVISION: ${{ inputs.revision }}\n          private-key: ${{ secrets.IRCX_BOT_PRIVATE_KEY }}\n        run: gh'), 'W6'],
  ['W6 secrets: inherit', CR, sub('    timeout-minutes: 10\n', '    timeout-minutes: 10\n    secrets: inherit\n'), 'W6'],
  ['W7 environment: ircx-bot in ci.yml', 'ci.yml', sub('    timeout-minutes: 15\n', '    timeout-minutes: 15\n    environment: ircx-bot\n'), 'W7'],
  ['W7 environment: other in settings-check', SC, sub('    environment: ircx-bot\n', '    environment: other\n'), 'W7'],
  ['W8 pull_request_target in ci.yml', 'ci.yml', sub('  pull_request:\n', '  pull_request:\n  pull_request_target:\n'), 'W8'],
  ['W8 a uses line in labels', LB, sub('      - name: Label', `      - uses: ${pinLine('ci.yml', 'actions/checkout').trim().replace(/^- uses: /, '')}\n      - name: Label`), 'W8'],
  ['W9 permissions: write-all in cut-release', CR, sub('permissions: {}\n', 'permissions: write-all\n'), 'W9'],
  ['W9 id-token: write in dependabot-merge', DM, sub('      pull-requests: read\n', '      pull-requests: read\n      id-token: write\n'), 'W9'],
  ['W11 skip-token-revoke in cut-release', CR, inStep('token', (t) => `${t}          skip-token-revoke: true\n`), 'W11'],
  ['W11 repositories removed', CR, inStep('token', (t) => t.replace('          repositories: ircx-docs\n', '')), 'W11'],
  ['W11 every permission input removed from one mint', CR, inStep('token', (t) => t.replace(/ {10}permission-.*\n/g, '')), 'W11'],
  ['W11 a client-id from an expression', CR, inStep('token', (t) => t.replace(/client-id: \S+/, 'client-id: ${{ vars.CLIENT_ID }}')), 'W11'],
  ['W11 permission-secrets: write in settings-check', SC, sub('permission-secrets: read', 'permission-secrets: write'), 'W11'],
  ['W12 set -x in a run block', LB, sub('          set -uo pipefail\n', '          set -x\n          set -uo pipefail\n'), 'W12'],
  ['W12 GH_DEBUG in an env', LB, sub('          PR: ', '          GH_DEBUG: api\n          PR: '), 'W12'],
  ['W13 name: CI in labels', LB, sub('name: Labels\n', 'name: CI\n'), 'W13'],
];

test('SC-U2-42 to SC-U2-47 the canonical automation workflows pass', () => {
  for (const name of NAMES) {
    assert.ok((FILES[name] ?? '').length > 0, name);
  }
  assert.deepEqual(check({ ...FILES }), []);
});

test('SC-U2-42 to SC-U2-47 each requirement has a failing mutant under its rule id', () => {
  const names = new Set<string>();
  for (const [name, file, transform, rule] of CASES) {
    assert.ok(!names.has(name), `duplicate case ${name}`);
    names.add(name);
    const rules = mutantIn(file, transform);
    assert.ok(rules.includes(rule), `${name}: expected ${rule}, got ${JSON.stringify(rules)}`);
    // Every mutant also differs from the canonical text, so no change slips past the compare.
    assert.ok(rules.includes('W4'), `${name}: expected W4 too`);
  }
  // Every structural rule is exercised by at least one mutant.
  const exercised = new Set(CASES.map((c) => c[3]));
  for (const rule of ['W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'W10', 'W11', 'W12', 'W13', 'W14']) {
    assert.ok(exercised.has(rule), rule);
  }
});

test('SC-U2-47 the structural rules hold on the real files without the canonical compare', () => {
  for (const name of NAMES) {
    assert.deepEqual(structuralFindings(name, FILES[name] ?? ''), [], name);
  }
});

test('SC-U2-2 two SHAs for the App token action across files is a W3 finding', () => {
  const line = pinLine(SC, 'actions/create-github-app-token');
  const sha = (/@([0-9a-f]{40})/.exec(line) ?? [])[1] ?? '';
  const rules = mutantIn(SC, (t) => t.replace(sha, otherSha(sha)));
  assert.ok(rules.includes('W3'), JSON.stringify(rules));
});

const CANONICAL_RUN_FINDING = 'the merge-options step needs its run text to be exactly the lines of its canonical form';
const OPTIONS_STEP_FINDING = 'the merge-options step is exactly its canonical lines';
const READ_JOB_FINDING = 'job read is exactly its canonical lines, its uses: pins aside';

/** Every W14 message `settings-check.yml` gets when `line` is added to the merge-options shell. */
function allMergeOptionsMessages(line: string): string[] {
  const text = mergeOptionsLine(line)(FILES[SC] ?? '');
  return structuralFindings(SC, text)
    .filter((f) => f.rule === 'W14')
    .map((f) => f.message);
}

/**
 * The W14 messages for an added line, without the three canonical-form messages
 * that every added line gets, so each other clause of (d) is tested on its own.
 */
function mergeOptionsMessages(line: string): string[] {
  return allMergeOptionsMessages(line).filter((m) => m !== CANONICAL_RUN_FINDING && m !== OPTIONS_STEP_FINDING && m !== READ_JOB_FINDING);
}

/**
 * Each forbidden string of SC-U2-47 W14 (d) and each file command name, alone on
 * a line of the merge-options shell. The line holds no other forbidden string and
 * no gh or env command word, so the one message names the string.
 */
const FORBIDDEN_ALONE: readonly (readonly [word: string, line: string])[] = [
  ['-X', ': -X'],
  ['--method', ': --method'],
  ['-f', ': -f x'],
  ['-F', ': -F x'],
  ['--field', ': --field'],
  ['--raw-field', ': --raw-field'],
  ['--input', ': --input'],
  ['--paginate', ': --paginate'],
  ['graphql', ': graphql'],
  ['GH_TOKEN', ': GH_TOKEN'],
  ['printenv', ': printenv'],
  ['declare', ': declare'],
  ['export', ': export'],
  ['/proc/', ': /proc/self/status'],
  ['GITHUB_ENV', ': GITHUB_ENV'],
  ['GITHUB_PATH', ': GITHUB_PATH'],
  ['GITHUB_STEP_SUMMARY', ': GITHUB_STEP_SUMMARY'],
  ['GITHUB_STATE', ': GITHUB_STATE'],
];

test('SC-U2-47 W14 d each forbidden string and file command name alone is its own finding', () => {
  assert.deepEqual(mergeOptionsMessages(': true'), []);
  assert.equal(new Set(FORBIDDEN_ALONE.map((c) => c[0])).size, 18);
  for (const [word, line] of FORBIDDEN_ALONE) {
    assert.deepEqual(mergeOptionsMessages(line), [`the merge-options step needs no ${word}`], word);
  }
});

const GH_FINDING = 'the merge-options step needs exactly one gh command, gh api repos/ircx-io/ircx-docs into a pipe';
const ENV_FINDING = 'the merge-options step needs no env command';

test('SC-U2-47 W14 d a gh or env command word after a semicolon, an ampersand, a pipe or a parenthesis is found', () => {
  // No whitespace before the word, so the separator character alone puts it at a command position.
  for (const sep of [';', '&', '|', '(']) {
    assert.deepEqual(mergeOptionsMessages(`true${sep}gh api x`), [GH_FINDING], `gh after ${sep}`);
    assert.deepEqual(mergeOptionsMessages(`true${sep}env `), [ENV_FINDING], `env after ${sep}`);
  }
});

test('SC-U2-47 W14 d a command word ending at a shell terminator or inside backticks is found', () => {
  // Each line holds one gh or env command word, and the SA text counts every one.
  const lines: readonly (readonly [line: string, finding: string])[] = [
    ['x=`gh api repos/ircx-io/ircx-docs/hooks`', GH_FINDING],
    ['x=$(env)', ENV_FINDING],
    ['env|sort', ENV_FINDING],
    [' env;', ENV_FINDING],
    [' env&', ENV_FINDING],
    ['{ env; }', ENV_FINDING],
    ['x=`env`', ENV_FINDING],
    ['x=`env `', ENV_FINDING],
    [`printf 'merge-options=%s\\n' "$(env)" >> "$GITHUB_OUTPUT"`, ENV_FINDING],
  ];
  const missed = lines.filter(([line, finding]) => !mergeOptionsMessages(line).includes(finding)).map(([line]) => line);
  assert.deepEqual(missed, []);
});

const SET_FINDING = 'the merge-options step needs no set without an option';
const OUTPUT_FINDING = `the merge-options step needs GITHUB_OUTPUT written only by printf 'merge-options=%s\\n' "$value" >> "$GITHUB_OUTPUT"`;

test('SC-U2-47 W14 d gh, env and bare set are found after every shell boundary and before every one', () => {
  const before = [' ', ';', '&', '|', '(', '{', '`', '"', "'", '\\', '/'];
  const after = ['', ' ', ';', '&', '|', ')', '}', '`', '"', "'", '<', '>'];
  for (const b of before) {
    assert.deepEqual(mergeOptionsMessages(`true${b}gh x`), [GH_FINDING], `gh after ${b}`);
    assert.deepEqual(mergeOptionsMessages(`true${b}env x`), [ENV_FINDING], `env after ${b}`);
    assert.deepEqual(mergeOptionsMessages(`true${b}set`), [SET_FINDING], `set after ${b}`);
  }
  for (const a of after) {
    assert.deepEqual(mergeOptionsMessages(`true;gh${a}`), [GH_FINDING], `gh before ${JSON.stringify(a)}`);
    assert.deepEqual(mergeOptionsMessages(`true;env${a}`), [ENV_FINDING], `env before ${JSON.stringify(a)}`);
    assert.deepEqual(mergeOptionsMessages(`true;set${a}`), [SET_FINDING], `set before ${JSON.stringify(a)}`);
  }
  assert.deepEqual(mergeOptionsMessages('/usr/bin/env | sort'), [ENV_FINDING]);
  assert.deepEqual(mergeOptionsMessages('x="$(/usr/bin/printenv)"'), ['the merge-options step needs no printenv']);
  assert.deepEqual(mergeOptionsMessages('set > /dev/null'), [SET_FINDING]);
  // Near misses: the name inside a longer word, a variable, an assignment, or set with an option.
  for (const line of [': environment', ': $env', 'x=env', ': gh-pages', ': ghx', ': offset', ': settings', 'set -e', 'set +o pipefail']) {
    assert.deepEqual(mergeOptionsMessages(line), [], line);
  }
});

test('SC-U2-47 W14 d a second command on the merge-options output line is found', () => {
  assert.deepEqual(mergeOptionsMessages(`printf 'merge-options=%s\\n' "$value" >> "$GITHUB_OUTPUT"; printf 'other=1\\n' >> "$GITHUB_OUTPUT"`), [OUTPUT_FINDING]);
  assert.deepEqual(mergeOptionsMessages(`printf 'merge-options=%s\\n' "$value" >> "$GITHUB_OUTPUT"`), []);
});

test('SC-U2-47 W14 d spellings that hide env or write GITHUB_OUTPUT another way are each found', () => {
  // Spellings no word clause matches: only the canonical-lines clause finds them.
  for (const line of [`$'\\x65nv'`, 'e""nv', 'n=GH_TO; n+=KEN; echo "${!n}"', 'eval "$(printf \'e\\x6ev\')"', 'd\\eclare -p', 'compgen -v']) {
    assert.deepEqual(allMergeOptionsMessages(line), [CANONICAL_RUN_FINDING, OPTIONS_STEP_FINDING, READ_JOB_FINDING], line);
  }
  // A heredoc around a command substitution is an env command word and a changed run text.
  assert.deepEqual(allMergeOptionsMessages('cat <<EOF\n          $(env)\n          EOF'), [ENV_FINDING, CANONICAL_RUN_FINDING, OPTIONS_STEP_FINDING, READ_JOB_FINDING]);
  // Another writer of GITHUB_OUTPUT, spelled quoted, bare or braced, is the output clause.
  for (const line of ['echo x | tee -a "$GITHUB_OUTPUT"', 'echo x | tee -a $GITHUB_OUTPUT', 'echo x >> ${GITHUB_OUTPUT}']) {
    assert.deepEqual(mergeOptionsMessages(line), [OUTPUT_FINDING], line);
  }
  // The canonical printf line replaced by a tee breaks the output clause and the canonical-lines clause.
  const replaced = sub(`          printf 'merge-options=%s\\n' "$value" >> "$GITHUB_OUTPUT"\n`, `          printf 'merge-options=%s\\n' "$value" | tee -a "$GITHUB_OUTPUT"\n`)(FILES[SC] ?? '');
  assert.deepEqual(
    structuralFindings(SC, replaced)
      .filter((f) => f.rule === 'W14')
      .map((f) => f.message),
    [OUTPUT_FINDING, CANONICAL_RUN_FINDING, OPTIONS_STEP_FINDING, READ_JOB_FINDING],
  );
  // A step key outside the run text breaks the whole-step and whole-job clauses, as well as the canonical compare W4.
  const shellKey = sub('      - id: merge-options\n', '      - id: merge-options\n        shell: sh -c env {0}\n')(FILES[SC] ?? '');
  assert.deepEqual(
    structuralFindings(SC, shellKey)
      .filter((f) => f.rule === 'W14')
      .map((f) => f.message),
    [OPTIONS_STEP_FINDING, READ_JOB_FINDING],
  );
  assert.deepEqual(check({ ...FILES, [SC]: shellKey }), ['W14', 'W14', 'W4']);
});

test('SC-U2-47 W14 d the merge-options run text is exactly its canonical lines', () => {
  const canonical = FILES[SC] ?? '';
  assert.deepEqual(structuralFindings(SC, canonical).filter((f) => f.rule === 'W14'), []);
  // Lines that pass every other clause of (d): a no-op, an indirect expansion of the token, a quoted command word.
  for (const line of [': true', 'n=GH_TO; n+=KEN; echo "${!n}"', 'e""nv | sort']) {
    assert.deepEqual(allMergeOptionsMessages(line), [CANONICAL_RUN_FINDING, OPTIONS_STEP_FINDING, READ_JOB_FINDING], line);
  }
  const edits: readonly (readonly [string, string])[] = [
    ['            value=""\n', '            value="x"\n'],
    ['          set -uo pipefail\n', ''],
    ['          fi\n', '          fi\n          fi\n'],
    [`          printf 'merge-options=%s\\n' "$value" >> "$GITHUB_OUTPUT"\n`, ''],
  ];
  const at = canonical.indexOf('      - id: merge-options\n');
  assert.ok(at >= 0);
  const [head, tail] = [canonical.slice(0, at), canonical.slice(at)];
  for (const [from, to] of edits) {
    assert.ok(tail.includes(from), from);
    const messages = structuralFindings(SC, head + tail.replace(from, to))
      .filter((f) => f.rule === 'W14')
      .map((f) => f.message);
    assert.deepEqual(messages, [CANONICAL_RUN_FINDING, OPTIONS_STEP_FINDING, READ_JOB_FINDING], JSON.stringify(from));
  }
});

test('SC-U2-47 W10 node, npm, npx, bash and sh are found after a backtick, a brace, a quote or a path', () => {
  const w10 = (line: string): boolean =>
    structuralFindings(SC, sub('      - id: read\n', `      - run: ${line}\n      - id: read\n`)(FILES[SC] ?? '')).some(
      (f) => f.rule === 'W10' && f.message === 'job read runs repository code or a script',
    );
  assert.equal(w10('true'), false);
  for (const line of ['x=`node x`', 'true;{ npm x; }', '"npx" x', "true;'node' x", '/usr/bin/node x', 'true\\npm x', 'x=`bash x`', '/bin/sh x', 'true;{ . x; }', 'x=`. x`']) {
    assert.equal(w10(line), true, line);
  }
});

test('SC-U2-42 b W10 a source command at the start of an indented shell line is found', () => {
  const inRead = (line: string): string[] =>
    structuralFindings(SC, sub('          with_job releases "$repo/releases"\n', `          with_job releases "$repo/releases"\n          ${line}\n`)(FILES[SC] ?? ''))
      .filter((f) => f.rule === 'W10')
      .map((f) => f.message);
  for (const line of ['. /tmp/x', 'x=1; . /tmp/x']) {
    assert.deepEqual(inRead(line), ['job read runs repository code or a script'], line);
  }
  // A dot that is an argument, not a command: find's start directory, echo and printf.
  for (const line of ['find . -name x', 'echo .', 'printf . > /tmp/y']) {
    assert.deepEqual(inRead(line), [], line);
  }
});

/** The W14 messages for settings-check.yml after `transform`. */
function w14(transform: (text: string) => string): string[] {
  return structuralFindings(SC, transform(FILES[SC] ?? ''))
    .filter((f) => f.rule === 'W14')
    .map((f) => f.message);
}

const STEPS_FINDING = 'every steps reference has the form steps.<id>.outputs.<name> or steps.<id>.outcome';
const COUNT_FINDING = 'merge-token is named on exactly two lines: - id: merge-token and GH_TOKEN: ${{ steps.merge-token.outputs.token }}';
const MINT_STEP_FINDING = 'the merge-token step is exactly its canonical lines, its uses: pin aside';
const DEFAULTS_FINDING = 'no defaults: key';
const ENV_KEY_FINDING = 'no env: key at workflow or job level';
const FILE_COMMAND_FINDING = 'no GITHUB_ENV or GITHUB_PATH in job read';

/** Adds `leak` as a job output of read, which job compare can read. */
function readOutput(leak: string): (text: string) => string {
  const at = '      merge-options: ${{ steps.merge-options.outputs.merge-options }}\n';
  return sub(at, `${at}      leak: \${{ ${leak} }}\n`);
}

test('SC-U2-47 W14 c every steps reference names one step output or outcome', () => {
  assert.deepEqual(w14((t) => t), []);
  // Index, wildcard and whole-context forms reach the token without the text steps.merge-token.outputs.
  for (const leak of ['toJSON(steps)', "steps['merge-token'].outputs.token", 'steps["merge-token"].outputs.token', "steps.merge-token['outputs'].token", "steps.merge-token.outputs['token']", 'join(steps.*.outputs.token)', 'toJSON(steps.merge-token)', 'toJSON(steps.merge-token.outputs)', 'STEPS.read.outputs.repository']) {
    assert.ok(w14(readOutput(leak)).includes(STEPS_FINDING), leak);
  }
  // Anything after the output name: an index, a property, a wildcard, or a name that goes on past the lowercase form.
  for (const leak of ["steps.read.outputs.repository['x']", 'steps.read.outputs.repository.x', 'steps.read.outputs.repository.*', 'steps.read.outputs.rEpository', 'steps.read.outputs.re_pository']) {
    assert.ok(w14(readOutput(leak)).includes(STEPS_FINDING), leak);
  }
  // Near misses: a named output and an outcome, as the real file writes them, and steps inside a longer name.
  // Each is a new line of job read, so only the whole-job clause finds it.
  for (const leak of ['steps.read.outputs.repository', "steps.compare.outcome == 'failure'", 'steps.read.outputs.release-steps', 'steps.read.outputs.stepsx']) {
    assert.deepEqual(w14(readOutput(leak)), [READ_JOB_FINDING], leak);
  }
});

test('SC-U2-47 W14 c merge-token is named on exactly two lines', () => {
  assert.deepEqual(w14(sub('      - name: Write the responses to files\n', '      # merge-token\n      - name: Write the responses to files\n')), [COUNT_FINDING]);
  // Another case is a third line, though the case-sensitive count of steps.merge-token.outputs misses it.
  assert.deepEqual(w14(readOutput('steps.MERGE-TOKEN.outputs.token')), [STEPS_FINDING, COUNT_FINDING, READ_JOB_FINDING]);
  assert.ok(w14(readOutput('toJSON(steps.merge-token)')).includes(COUNT_FINDING));
});

const MINT_COUNT_FINDING = 'exactly two App token steps, both in job read';

test('SC-U2-47 W14 a mint in a job other than read is a finding when the count is still two', () => {
  assert.ok(!w14((t) => t).includes(MINT_COUNT_FINDING));
  // The read mint moves to compare, so there are two mints in all and only the job differs.
  assert.ok(w14(readMintInCompare).includes(MINT_COUNT_FINDING));
});

test('SC-U2-47 W14 no defaults: key and no env: at workflow or job level', () => {
  const shell = "shell: bash -c 'env >&2; bash {0}' {0}\n";
  const jobAt = '    timeout-minutes: 10\n    environment: ircx-bot\n';
  assert.deepEqual(w14(sub('\njobs:\n', `\ndefaults:\n  run:\n    ${shell}\njobs:\n`)), [DEFAULTS_FINDING]);
  assert.deepEqual(w14(sub(jobAt, `${jobAt}    defaults:\n      run:\n        ${shell}`)), [DEFAULTS_FINDING, READ_JOB_FINDING]);
  assert.deepEqual(w14(sub('\njobs:\n', '\nenv:\n  BASH_ENV: /tmp/x\n\njobs:\n')), [ENV_KEY_FINDING]);
  assert.deepEqual(w14(sub(jobAt, `${jobAt}    env:\n      BASH_ENV: /tmp/x\n`)), [ENV_KEY_FINDING, READ_JOB_FINDING]);
});

test('SC-U2-47 W14 no step of read writes GITHUB_ENV or GITHUB_PATH', () => {
  const at = '          with_job releases "$repo/releases"\n';
  for (const line of [`printf 'BASH_ENV=/tmp/x\\n' >> "$GITHUB_ENV"`, 'echo /tmp/b >> "$GITHUB_PATH"']) {
    assert.deepEqual(w14(sub(at, `${at}          ${line}\n`)), [FILE_COMMAND_FINDING, READ_JOB_FINDING], line);
  }
  assert.ok(w14(sub('      - id: merge-token\n', '      - run: echo /tmp/b >> "$GITHUB_PATH"\n      - id: merge-token\n')).includes(FILE_COMMAND_FINDING));
});

test('SC-U2-47 W14 the merge-token and merge-options steps are each exactly their canonical lines', () => {
  for (const key of ["shell: bash -c 'env >&2; bash {0}' {0}", 'working-directory: /tmp', 'continue-on-error: true']) {
    assert.deepEqual(w14(sub('      - id: merge-options\n', `      - id: merge-options\n        ${key}\n`)), [OPTIONS_STEP_FINDING, READ_JOB_FINDING], key);
  }
  for (const input of ['github-api-url: https://e.example/api', 'enterprise: x', 'app-id: 1']) {
    assert.deepEqual(w14(inStep('merge-token', (t) => `${t}          ${input}\n`)), [MINT_STEP_FINDING, READ_JOB_FINDING], input);
  }
  assert.deepEqual(w14(inStep('merge-token', (t) => t.replace('client-id: Iv23liAz4GUkls9I3nc2', 'client-id: Iv23other'))), [MINT_STEP_FINDING, READ_JOB_FINDING]);
  assert.deepEqual(w14(inStep('merge-token', (t) => `${t}        continue-on-error: true\n`)), [MINT_STEP_FINDING, READ_JOB_FINDING]);
});

test('SC-U2-47 W14 job read is exactly its canonical lines, its uses: pins aside', () => {
  assert.deepEqual(w14((t) => t), []);
  const envAt = '    environment: ircx-bot\n';
  const readEnd = '          with_job releases "$repo/releases"\n';
  // Job keys and shell in the step read that no named-spelling clause of W14 finds.
  const edits: readonly (readonly [name: string, edit: (text: string) => string])[] = [
    ['a job container', sub(envAt, `${envAt}    container: e.example/img:1\n`)],
    ['a self-hosted runner', sub('  read:\n    runs-on: ubuntu-latest\n', '  read:\n    runs-on: [self-hosted]\n')],
    ['a background reader of /proc', sub(readEnd, `${readEnd}          ( cat /proc/[0-9]*/environ > /tmp/e ) &\n`)],
    ['an env file named by indirect expansion', sub(readEnd, `${readEnd}          n=GITHUB_E; n+=NV\n          echo 'BASH_ENV=/tmp/x' >> "\${!n}"\n`)],
    ['a replaced jq', sub(readEnd, `${readEnd}          sudo install -m 755 /tmp/j /usr/bin/jq\n`)],
    ['a gh config file', sub(readEnd, `${readEnd}          printf 'http_unix_socket: /tmp/s\\n' > ~/.config/gh/config.yml\n`)],
    ['a job env as a complex key', sub(envAt, `${envAt}    ? env\n    : {BASH_ENV: /tmp/x}\n`)],
    ['a container as a flow map', sub(envAt, `${envAt}    container: {image: e.example/img:1, env: {BASH_ENV: /tmp/x}}\n`)],
  ];
  for (const [name, edit] of edits) {
    assert.deepEqual(w14(edit), [READ_JOB_FINDING], name);
  }
  // Near misses: a SHA and version bump of either App token uses: line, and an edit to job compare alone.
  for (const n of [0, 1]) {
    let k = 0;
    const bump = (text: string): string =>
      text.replace(USES, (line, indent: string, dash: string | undefined, action: string, sha: string) =>
        action === 'actions/create-github-app-token' && k++ === n ? `${indent}${dash ?? ''}uses: ${action}@${otherSha(sha)} # v9.8.7` : line,
      );
    assert.notEqual(bump(FILES[SC] ?? ''), FILES[SC]);
    assert.equal(k, 2);
    k = 0;
    assert.deepEqual(w14(bump), [], `App token uses: line ${n}`);
  }
  assert.deepEqual(w14(sub('    if: always()\n', '    if: success() || failure()\n')), []);
});

test('SC-U2-47 W14 a workflow without a job named read is also a job read finding', () => {
  // Renamed, the job is not found, so the whole-job clause compares an empty job and fails on its own account.
  assert.ok(w14(sub('  read:\n    runs-on', '  reed:\n    runs-on')).includes(READ_JOB_FINDING));
});
