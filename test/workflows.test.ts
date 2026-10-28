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
  for (const rule of ['W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'W10', 'W11', 'W12', 'W13']) {
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
