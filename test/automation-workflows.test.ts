// The four automation workflows against the constraint text, read from the real
// files and independent of the checker's canonical text (SC-U2-42 to SC-U2-46,
// and the commit B part of SC-U2-1), plus a table over the structural rules W5
// to W13 (SC-U2-47) that probes each spelling a rule is meant to refuse or allow.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { structuralFindings } from '../src/workflows.ts';
import { FILES } from '../src/settings.ts';
import { jobNames, jobOf, NAMES, runOf, stepNamed, stepsOf, workflow } from './step-harness.ts';

const CI = workflow('ci.yml');
const CR = workflow('cut-release.yml');
const DM = workflow('dependabot-merge.yml');
const LB = workflow('labels.yml');
const SC = workflow('settings-check.yml');
const KEY = 'Iv23liAz4GUkls9I3nc2';
/** Another repository name, built at run time so the publication scan has nothing to read. */
const OTHER_REPO = ['ircx', 'server'].join('-');
const MINT = 'uses: actions/create-github-app-token@';

/** The lines of `text` that start with `prefix`, in order. */
function lines(text: string, prefix: string): string[] {
  return text.split('\n').filter((l) => l.startsWith(prefix));
}

/** The keys of the top-level `on:` mapping. */
function triggers(text: string): string[] {
  const body = text.split('\non:\n')[1]?.split('\n\n')[0] ?? '';
  return [...body.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1] ?? '');
}

/** The `with:` input lines of the first step of `job` that uses the App token action, trimmed. */
function mintInputs(step: string): string[] {
  return step.split('\n').filter((l) => /^ {10}\S/.test(l)).map((l) => l.trim());
}

test('SC-U2-1 the triggers: only ci.yml runs on pull_request or push, and each other workflow has exactly its ruled trigger', () => {
  assert.deepEqual(triggers(CI), ['pull_request', 'push']);
  assert.deepEqual(triggers(CR), ['workflow_dispatch']);
  assert.deepEqual(triggers(DM), ['workflow_run']);
  assert.deepEqual(triggers(LB), ['pull_request_target']);
  assert.deepEqual(triggers(SC), ['schedule', 'workflow_dispatch']);
});

test('SC-U2-1 no workflow but ci.yml runs repository code from a pull request head: no checkout in labels or cut-release, and no ref or repository input on any checkout', () => {
  assert.ok(!LB.includes('actions/checkout') && !LB.includes('setup-node'));
  assert.ok(!CR.includes('actions/checkout') && !CR.includes('setup-node'));
  for (const [name, text] of [['dependabot-merge.yml', DM], ['settings-check.yml', SC], ['ci.yml', CI]] as const) {
    for (const step of stepsOf(text).filter((s) => s.includes('uses: actions/checkout@'))) {
      assert.deepEqual(step.split('\n').filter((l) => /^ {10}\S/.test(l)).map((l) => l.trim()), ['persist-credentials: false'], name);
    }
  }
  assert.ok(!/node |npm |npx /.test(LB));
});

test('SC-U2-1 ci.yml is still the canonical CI: name CI, one job docs, read-only token, and no secret or environment', () => {
  assert.ok(CI.startsWith('name: CI\n'));
  assert.deepEqual(jobNames(CI), ['docs']);
  assert.ok(CI.includes('\npermissions:\n  contents: read\n'));
  assert.ok(!/secrets|environment:|id-token|pull_request_target/.test(CI));
  for (const other of [CR, DM, LB, SC]) {
    assert.ok(!other.split('\n').includes('name: CI'));
  }
});

// ---------------------------------------------------------------------------
// SC-U2-43 a, b, d: dependabot-merge.yml.

test('SC-U2-43 a the trigger, the top-level permissions and the absence of a concurrency group', () => {
  assert.ok(DM.startsWith('name: Dependabot merge\n\non:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\n\npermissions: {}\n\njobs:\n'));
  assert.deepEqual(jobNames(DM), ['decide', 'merge']);
  assert.ok(!DM.includes('concurrency'));
  const decide = jobOf(DM, 'decide');
  assert.ok(decide.includes('    timeout-minutes: 10\n    permissions:\n      contents: read\n      pull-requests: read\n    outputs:\n'));
  const condition = decide.split('    if: >-\n')[1]?.split('    runs-on:')[0] ?? '';
  assert.deepEqual(
    condition.split('\n').filter((l) => l !== '').map((l) => l.trim().replace(/ &&$/, '')),
    [
      "github.event.workflow_run.conclusion == 'success'",
      "github.event.workflow_run.event == 'pull_request'",
      "github.event.workflow_run.path == '.github/workflows/ci.yml'",
      "github.event.workflow_run.head_repository.full_name == 'ircx-io/ircx-docs'",
    ],
  );
  assert.ok(!decide.includes('environment:'));
});

test('SC-U2-43 b the decide job checks out main with no ref or repository, and never names the head SHA, head branch or a PR ref', () => {
  const decide = jobOf(DM, 'decide');
  const steps = stepsOf(decide);
  assert.ok(steps[0]?.startsWith('      - uses: actions/checkout@'));
  assert.deepEqual(mintInputs(steps[0] ?? ''), ['persist-credentials: false']);
  assert.ok(!/head_sha|head_branch|refs\/pull|pull\/|\bref:|repository:/.test(DM.replace("github.event.workflow_run.head_repository.full_name == 'ircx-io/ircx-docs'", '')));
  assert.ok(steps[1]?.startsWith('      - uses: actions/setup-node@'));
});

test('SC-U2-43 e the decide job exposes exactly merge, number, sha and workflows', () => {
  const outputs = jobOf(DM, 'decide').split('    outputs:\n')[1]?.split('    steps:')[0] ?? '';
  assert.deepEqual(
    outputs.split('\n').filter((l) => l !== ''),
    ['merge', 'number', 'sha', 'workflows'].map((k) => `      ${k}: \${{ steps.decide.outputs.${k} }}`),
  );
});

test('SC-U2-43 d the merge job has two mints, one per flag value, and only the workflows value adds Workflows write', () => {
  const merge = jobOf(DM, 'merge');
  assert.ok(merge.startsWith("  merge:\n    needs: decide\n    if: needs.decide.outputs.merge == 'true'\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    environment: ircx-bot\n    permissions: {}\n    steps:\n"));
  const mints = stepsOf(merge).filter((s) => s.includes(MINT));
  assert.equal(mints.length, 2);
  const [contents, workflows] = mints;
  assert.ok(contents?.startsWith('      - id: contents-token\n        if: needs.decide.outputs.workflows == \'false\'\n'));
  assert.ok(workflows?.startsWith('      - id: workflows-token\n        if: needs.decide.outputs.workflows == \'true\'\n'));
  const common = [`client-id: ${KEY}`, 'private-key: ${{ secrets.IRCX_BOT_PRIVATE_KEY }}', 'owner: ircx-io', 'repositories: ircx-docs'];
  assert.deepEqual(mintInputs(contents ?? ''), [...common, 'permission-contents: write']);
  assert.deepEqual(mintInputs(workflows ?? ''), [...common, 'permission-contents: write', 'permission-workflows: write']);
  assert.equal(lines(merge, '        run: gh api -X PUT').length, 1);
  assert.ok(merge.endsWith('merge_method=squash -f sha=$SHA\n') || merge.endsWith('merge_method=squash -f sha=$SHA'));
});

// ---------------------------------------------------------------------------
// SC-U2-44 a: labels.yml.

test('SC-U2-44 a the trigger types, token permissions, timeout and concurrency group', () => {
  assert.ok(LB.startsWith('name: Labels\n\non:\n  pull_request_target:\n    types: [opened, reopened, synchronize, ready_for_review]\n\npermissions: {}\n\njobs:\n'));
  assert.deepEqual(jobNames(LB), ['label']);
  const job = jobOf(LB, 'label');
  assert.ok(job.startsWith("  label:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    permissions:\n      pull-requests: write\n    concurrency:\n      group: labels-${{ github.event.pull_request.number }}\n      cancel-in-progress: true\n    steps:\n"));
  assert.ok(!/uses:|environment:|secrets|checkout/.test(LB));
  assert.equal(stepsOf(job).length, 1);
});

test('SC-U2-44 e the step reads the pull request number, head repository and token only through env', () => {
  const step = stepNamed(jobOf(LB, 'label'), 'Label the pull request by the paths it changes');
  const env = step.split('        env:\n')[1]?.split('        run:')[0] ?? '';
  assert.deepEqual(env.split('\n').filter((l) => l !== ''), ['          GH_TOKEN: ${{ github.token }}', '          PR: ${{ github.event.pull_request.number }}', '          HEAD_REPO: ${{ github.event.pull_request.head.repo.full_name }}']);
  assert.equal((LB.match(/\$\{\{/g) ?? []).length, 4, 'the group and the three env entries are the only expressions');
});

// ---------------------------------------------------------------------------
// SC-U2-45 a, c: cut-release.yml.

test('SC-U2-45 a the dispatch inputs, permissions and the one key job', () => {
  assert.ok(CR.startsWith('name: Cut release\n\non:\n  workflow_dispatch:\n    inputs:\n      tag:\n'));
  const inputs = CR.split('    inputs:\n')[1]?.split('\n\npermissions:')[0] ?? '';
  const keys = [...inputs.matchAll(/^ {6}([a-z]+):$/gm)].map((m) => m[1]);
  assert.deepEqual(keys, ['tag', 'revision']);
  assert.equal((inputs.match(/^ {8}required: true$/gm) ?? []).length, 2);
  assert.equal((inputs.match(/^ {8}type: string$/gm) ?? []).length, 2);
  assert.ok(CR.includes('\n\npermissions: {}\n\njobs:\n'));
  assert.deepEqual(jobNames(CR), ['release']);
  assert.ok(jobOf(CR, 'release').startsWith('  release:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    environment: ircx-bot\n    permissions:\n      contents: read\n    steps:\n'));
});

test('SC-U2-45 c the mint asks for Contents write and Workflows write and nothing else; the validation sits first; env carries the inputs', () => {
  const release = jobOf(CR, 'release');
  const steps = stepsOf(release);
  assert.equal(steps.length, 3);
  assert.deepEqual(mintInputs(steps[1] ?? ''), [`client-id: ${KEY}`, 'private-key: ${{ secrets.IRCX_BOT_PRIVATE_KEY }}', 'owner: ircx-io', 'repositories: ircx-docs', 'permission-contents: write', 'permission-workflows: write']);
  assert.ok(steps[0]?.includes('          GH_TOKEN: ${{ github.token }}\n          TAG: ${{ inputs.tag }}\n          REVISION: ${{ inputs.revision }}\n'));
  assert.ok(steps[2]?.includes('          GH_TOKEN: ${{ steps.token.outputs.token }}\n          TAG: ${{ inputs.tag }}\n          REVISION: ${{ inputs.revision }}\n'));
  assert.ok(!/upload|assets|asset/.test(release));
});

// ---------------------------------------------------------------------------
// SC-U2-46 a, b: settings-check.yml.

test('SC-U2-46 a the triggers, the permissions of each job, and a mint that asks for four read permissions', () => {
  assert.ok(SC.startsWith("name: Settings check\n\non:\n  schedule:\n    - cron: '17 6 * * 1'\n  workflow_dispatch:\n\npermissions: {}\n\njobs:\n"));
  assert.deepEqual(jobNames(SC), ['read', 'compare']);
  const read = jobOf(SC, 'read');
  assert.ok(read.startsWith('  read:\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    environment: ircx-bot\n    permissions:\n      actions: read\n      contents: read\n    outputs:\n'));
  assert.deepEqual(mintInputs(stepNamed(read, 'token')), [`client-id: ${KEY}`, 'private-key: ${{ secrets.IRCX_BOT_PRIVATE_KEY }}', 'owner: ircx-io', 'repositories: ircx-docs', 'permission-administration: read', 'permission-secrets: read', 'permission-dependabot-secrets: read', 'permission-environments: read']);
  const compare = jobOf(SC, 'compare');
  assert.ok(compare.startsWith('  compare:\n    needs: read\n    if: always()\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    permissions:\n      contents: read\n      issues: write\n    steps:\n'));
  assert.ok(!compare.includes('environment:') && !/\$\{\{[^}]*(?<![\w.-])secrets(?![\w-])/.test(compare));
});

test('SC-U2-46 b the read job declares one output per settings file, and the compare job reads each from needs.read', () => {
  const declared = [...(jobOf(SC, 'read').split('    outputs:\n')[1]?.split('    steps:')[0] ?? '').matchAll(/^ {6}([a-z-]+): \$\{\{ steps\.([a-z-]+)\.outputs\.([a-z-]+) \}\}$/gm)];
  assert.ok(declared.every((m) => m[1] === m[3] && m[2] === (m[1] === 'merge-options' ? 'merge-options' : 'read')));
  assert.deepEqual(declared.map((m) => m[1]).sort(), [...FILES].sort());
  const used = [...jobOf(SC, 'compare').matchAll(/needs\.read\.outputs\.([a-z-]+) \}\}/g)].map((m) => m[1]);
  assert.deepEqual([...used].sort(), [...FILES].sort());
  const compare = stepsOf(jobOf(SC, 'compare'));
  assert.ok(compare[0]?.includes('actions/checkout@') && compare[1]?.includes('actions/setup-node@'));
  assert.equal(runOf(compare[3] ?? ''), 'set -o pipefail\nnode src/settings.ts "$RUNNER_TEMP/settings" | tee "$RUNNER_TEMP/findings.txt"\n');
  assert.ok(compare[4]?.includes("if: failure() && steps.compare.outcome == 'failure'"));
});

// ---------------------------------------------------------------------------
// SC-U2-47: the structural rules, spelling by spelling.

type Transform = (text: string) => string;

function sub(from: string, to: string): Transform {
  return (text) => {
    assert.equal(text.split(from).length, 2, `need exactly one ${JSON.stringify(from)}`);
    return text.replace(from, to);
  };
}

function rulesOf(file: string, text: string): string[] {
  return [...new Set(structuralFindings(file, text).map((f) => f.rule))].sort();
}

function base(file: string): string {
  return workflow(file);
}

test('SC-U2-47 the real files give no structural finding, so every row below is its own change', () => {
  for (const name of NAMES) {
    assert.deepEqual(structuralFindings(name, base(name)), [], name);
  }
});

/** Appends a step to the labels job (no key job, no environment) so a rule sees only the added text. */
const withLabelsRun = (script: string): string => LB.replace('        run: |\n', `        run: ${script}\n      - name: extra\n        run: |\n`);

test('SC-U2-47 W5 an expression inside a run block, in every block and one-line spelling, and not outside one', () => {
  const onlyW5 = (file: string, t: Transform): boolean => rulesOf(file, t(base(file))).includes('W5');
  for (const style of ['|', '|-', '|+', '>', '>-', '>+']) {
    assert.ok(onlyW5('labels.yml', sub('        run: |\n          set -uo pipefail\n', `        run: ${style}\n          set -uo pipefail\n          echo \${{ github.run_id }}\n`)), style);
  }
  assert.ok(rulesOf('labels.yml', withLabelsRun('echo ${{ github.run_id }}')).includes('W5'), 'one-line run');
  assert.ok(onlyW5('cut-release.yml', sub('        run: gh api -X POST', '        run: echo ${{ inputs.tag }} && gh api -X POST')), 'one-line run after a dash-less key');
  assert.ok(onlyW5('settings-check.yml', sub('      - id: compare\n        run: |\n', '      - run: echo ${{ github.run_id }}\n      - id: compare\n        run: |\n')), 'a "- run:" step');
  assert.ok(onlyW5('labels.yml', sub('          set -uo pipefail\n', '          set -uo pipefail\n\n          echo ${{ github.run_id }}\n')), 'after a blank line inside the block');
  const afterBlock = `${LB.trimEnd()}\n      - name: after\n        run: |\n          echo hi\n        env:\n          X: \${{ github.run_id }}\n`;
  assert.ok(!rulesOf('labels.yml', afterBlock).includes('W5'), 'an env entry after a run key is not shell text');
  assert.ok(!rulesOf('labels.yml', sub('GH_TOKEN: ${{ github.token }}\n', 'GH_TOKEN: ${{ github.token }}\n          Y: ${{ github.run_id }}\n')(LB)).includes('W5'), 'env before run');
});

/** The private-key input line, as the key workflows write it. */
const KEY_LINE = 'private-key: ${{ secrets.IRCX_BOT_PRIVATE_KEY }}';

test('SC-U2-47 W6 a secret read is allowed only as the private-key line of an App token step in the three key workflows', () => {
  const has = (file: string, t: Transform): boolean => rulesOf(file, t(base(file))).includes('W6');
  for (const name of ['cut-release.yml', 'dependabot-merge.yml', 'settings-check.yml']) {
    assert.ok(!has(name, (t) => t + '\n'), `${name} as shipped`);
  }
  const step = `      - name: extra\n        uses: actions/create-github-app-token@${'a'.repeat(40)} # v1.2.3\n        with:\n          client-id: ${KEY}\n          ${KEY_LINE}\n          owner: ircx-io\n          repositories: ircx-docs\n          permission-contents: read\n`;
  assert.ok(!rulesOf('cut-release.yml', `${CR.trimEnd()}\n${step}`).includes('W6'), 'a second App token step in a key workflow');
  for (const file of ['ci.yml', 'labels.yml']) {
    const text = file === 'ci.yml' ? `${CI.trimEnd()}\n${step}` : `${LB.trimEnd()}\n${step}`;
    assert.ok(rulesOf(file, text).includes('W6'), `${file}: the exact line in an App token step of a non-key workflow`);
  }
  assert.ok(has('cut-release.yml', sub('          owner: ircx-io\n', `          ${KEY_LINE}\n          owner: ircx-io\n`)) === false, 'two key lines in one App step: both exact');
  assert.ok(has('cut-release.yml', sub(KEY_LINE, 'private-key: ${{ secrets.OTHER }}')), 'another secret name');
  assert.ok(has('cut-release.yml', sub(KEY_LINE, "private-key: ${{ secrets['IRCX_BOT_PRIVATE_KEY'] }}")), 'index syntax');
  assert.ok(has('cut-release.yml', sub(KEY_LINE, 'private-key: ${{ secrets.IRCX_BOT_PRIVATE_KEY || secrets.OTHER }}')), 'extra operand');
  assert.ok(has('cut-release.yml', sub(KEY_LINE, "private-key: ${{ format('{0}', secrets.IRCX_BOT_PRIVATE_KEY) }}")), 'inside a function');
  assert.ok(has('cut-release.yml', sub(KEY_LINE, 'private-key: ${{ toJSON(secrets) }}')), 'whole context');
  assert.ok(has('cut-release.yml', sub('    timeout-minutes: 10\n', '    timeout-minutes: 10\n    secrets: inherit\n')), 'secrets: inherit');
  assert.ok(has('cut-release.yml', sub('    timeout-minutes: 10\n', '    timeout-minutes: 10\n    secrets:  inherit\n')), 'secrets:  inherit, two spaces');
  assert.ok(has('settings-check.yml', sub('          APP_TOKEN: ${{ steps.token.outputs.token }}\n', '          APP_TOKEN: ${{ steps.token.outputs.token }}\n          K: ${{ secrets.IRCX_BOT_PRIVATE_KEY }}\n')), 'the exact secret in a run step env');
  assert.ok(has('dependabot-merge.yml', sub('        with:\n          persist-credentials: false\n', `        with:\n          persist-credentials: false\n          ${KEY_LINE}\n`)), 'the exact line in a checkout step');
  assert.ok(has('settings-check.yml', sub('          GH_TOKEN: ${{ github.token }}\n', '          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n')), 'GITHUB_TOKEN through the secrets context');
  // Names that contain the word but are not the context.
  assert.ok(!rulesOf('settings-check.yml', base('settings-check.yml')).includes('W6'), 'actions-secrets outputs and endpoint paths');
});

test('SC-U2-47 W7 exactly one environment, with the value ircx-bot, indented as a job key, on the key job', () => {
  const has = (file: string, t: Transform): boolean => rulesOf(file, t(base(file))).includes('W7');
  assert.ok(has('cut-release.yml', sub('    environment: ircx-bot\n', '    environment: ircx-bot\n    environment: ircx-bot\n')), 'twice on the key job');
  assert.ok(has('cut-release.yml', sub('    environment: ircx-bot\n', '    environment: Ircx-bot\n')), 'case');
  assert.ok(has('cut-release.yml', sub('    environment: ircx-bot\n', '    environment: ircx-bot \n')), 'trailing space');
  assert.ok(has('cut-release.yml', sub('    environment: ircx-bot\n', '    environment: "ircx-bot"\n')), 'quoted');
  assert.ok(has('cut-release.yml', sub('    environment: ircx-bot\n', '    environment:\n      name: ircx-bot\n')), 'object form');
  assert.ok(has('cut-release.yml', sub('    environment: ircx-bot\n', '      environment: ircx-bot\n')), 'deeper indent');
  assert.ok(has('cut-release.yml', sub('    environment: ircx-bot\n', '')), 'none');
  assert.ok(has('dependabot-merge.yml', sub('    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    permissions:\n      contents: read\n      pull-requests: read\n', '    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    environment: ircx-bot\n    permissions:\n      contents: read\n      pull-requests: read\n')), 'a second environment on the keyless job, beside the right one');
  assert.ok(has('dependabot-merge.yml', (t) => t.replace('    environment: ircx-bot\n', '').replace('    timeout-minutes: 10\n    permissions:\n      contents: read\n', '    timeout-minutes: 10\n    environment: ircx-bot\n    permissions:\n      contents: read\n')), 'on the wrong job');
  assert.ok(has('settings-check.yml', sub('    environment: ircx-bot\n', '    environment: other\n')), 'another name');
  for (const file of ['ci.yml', 'labels.yml']) {
    assert.ok(has(file, (t) => t.replace('    timeout-minutes:', '    environment: ircx-bot\n    timeout-minutes:')), `${file} has none`);
  }
});

test('SC-U2-47 W8 pull_request_target only in labels.yml, and labels.yml holds no uses line', () => {
  const has = (file: string, t: Transform): boolean => rulesOf(file, t(base(file))).includes('W8');
  for (const file of ['ci.yml', 'cut-release.yml', 'dependabot-merge.yml', 'settings-check.yml']) {
    assert.ok(has(file, (t) => `${t.trimEnd()}\n# pull_request_target\n`), `${file} even as a comment`);
  }
  assert.ok(!has('labels.yml', (t) => `${t}\n`), 'labels.yml as shipped');
  for (const spelling of ['      - uses: actions/checkout@' + 'a'.repeat(40) + ' # v1.2.3', '        uses: actions/checkout@' + 'a'.repeat(40) + ' # v1.2.3', '      - uses: ./local', '      - uses: docker://alpine']) {
    assert.ok(has('labels.yml', sub('    steps:\n', `    steps:\n${spelling}\n`)), spelling);
  }
});

test('SC-U2-47 W9 top-level permissions, and no id-token, write-all, actions write or contents write permission', () => {
  const has = (file: string, t: Transform): boolean => rulesOf(file, t(base(file))).includes('W9');
  assert.ok(has('ci.yml', sub('\npermissions:\n  contents: read\n', '\npermissions: {}\n')), 'ci.yml with none');
  for (const file of ['cut-release.yml', 'dependabot-merge.yml', 'labels.yml', 'settings-check.yml']) {
    assert.ok(has(file, sub('\npermissions: {}\n', '\npermissions:\n  contents: read\n')), `${file} with a top-level grant`);
    assert.ok(has(file, sub('\npermissions: {}\n', '\n')), `${file} with none`);
    assert.ok(has(file, sub('\npermissions: {}\n', '\npermissions: read-all\n')), `${file} read-all`);
  }
  for (const [name, text] of [
    ['id-token write', '      id-token: write\n'],
    ['id-token read', '      id-token: read\n'],
    ['actions write', '      actions: write\n'],
    ['contents write', '      contents: write\n'],
    ['contents write, no space', '      contents:write\n'],
    ['contents write, flow style', '      x: { contents: write }\n'],
    ['write-all', '      x: write-all\n'],
  ] as const) {
    assert.ok(has('labels.yml', sub('      pull-requests: write\n', `      pull-requests: write\n${text}`)), name);
  }
  for (const [name, text] of [['pull-requests write', '      pull-requests: write\n'], ['issues write', '      issues: write\n'], ['contents read', '      contents: read\n'], ['actions read', '      actions: read\n']] as const) {
    assert.ok(!has('labels.yml', sub('      pull-requests: write\n', `      pull-requests: write\n${text}`)), name);
  }
  assert.ok(!has('cut-release.yml', (t) => t + '\n'), 'permission-contents: write on a mint is allowed');
});

/** Adds one run step to the key job `release` of cut-release.yml. */
function keyRun(script: string): Transform {
  return sub('      - name: Create the release\n', `      - name: extra\n        run: ${script}\n      - name: Create the release\n`);
}

test('SC-U2-47 W10 a key job runs no repository code: every command and path spelling, in a one-line and a block run', () => {
  const refused = [
    'node x.js', 'npm ci', 'npx tsc', 'source x', 'source ./x', '. ./x', 'true; . x', 'bash x.sh', 'sh x.sh', 'bash ./x.sh', 'bash src/x.sh', 'cat src/a', 'cat test/a', 'cat content/a', 'cat .github/x',
    'cat ./x', 'FOO=1 node x', 'true && node x', '(node x)', 'x | node', 'x;node y', 'echo "$(node x)"', 'cat "src/a"', "cat 'content/a'", 'x=src/a',
  ];
  for (const script of refused) {
    assert.ok(rulesOf('cut-release.yml', keyRun(script)(CR)).includes('W10'), `one-line: ${script}`);
    const block = sub('      - name: Create the release\n', `      - name: extra\n        run: |\n          echo start\n          ${script}\n      - name: Create the release\n`)(CR);
    assert.ok(rulesOf('cut-release.yml', block).includes('W10'), `block: ${script}`);
  }
  for (const script of ['gh api repos/ircx-io/ircx-docs', "jq -c . <<< '{}'", 'echo "$TAG" | grep -c .', 'git --version', 'printf "%s" "$X"']) {
    assert.ok(!rulesOf('cut-release.yml', keyRun(script)(CR)).includes('W10'), `allowed: ${script}`);
  }
  for (const action of ['actions/checkout', 'actions/setup-node', 'actions/cache', './local-action', 'docker://alpine', 'someone/else']) {
    const pin = action.startsWith('actions/') ? `@${'a'.repeat(40)} # v1.2.3` : '';
    const step = `      - uses: ${action}${pin}\n`;
    assert.ok(rulesOf('cut-release.yml', sub('      - name: Create the release\n', `${step}      - name: Create the release\n`)(CR)).includes('W10'), `action ${action}`);
    assert.ok(rulesOf('settings-check.yml', sub('    steps:\n      - id: token\n', `    steps:\n${step}      - id: token\n`)(SC)).includes('W10'), `action ${action} in read`);
  }
  assert.ok(!rulesOf('dependabot-merge.yml', base('dependabot-merge.yml')).includes('W10'), 'the keyless decide job runs node and checkout');
  assert.ok(!rulesOf('settings-check.yml', base('settings-check.yml')).includes('W10'), 'the keyless compare job runs node and checkout');
});

test('SC-U2-47 W11 every App token step names this App, owner and repository, asks for something, and revokes its token', () => {
  const inStep = (file: string, id: string, t: (step: string) => string): Transform => (text) => {
    const at = text.indexOf(`      - id: ${id}\n`);
    assert.ok(at >= 0);
    const end = text.indexOf('\n      - ', at + 10);
    const step = text.slice(at, end);
    const changed = t(step);
    assert.notEqual(changed, step);
    return text.slice(0, at) + changed + text.slice(end);
  };
  const has = (file: string, id: string, t: (step: string) => string): boolean => rulesOf(file, inStep(file, id, t)(base(file))).includes('W11');
  for (const [file, id] of [['cut-release.yml', 'token'], ['settings-check.yml', 'token'], ['dependabot-merge.yml', 'contents-token'], ['dependabot-merge.yml', 'workflows-token']] as const) {
    assert.ok(has(file, id, (s) => s.replace(/ {10}client-id: .*\n/, '')), `${file} ${id}: no client-id`);
    assert.ok(has(file, id, (s) => s.replace(/client-id: \S+/, 'client-id: ${{ vars.X }}')), `${file} ${id}: client-id from an expression`);
    assert.ok(has(file, id, (s) => s.replace(/client-id: \S+/, 'app-id: 5512599')), `${file} ${id}: app-id instead`);
    assert.ok(has(file, id, (s) => s.replace('owner: ircx-io', 'owner: ircx-bot')), `${file} ${id}: another owner`);
    assert.ok(has(file, id, (s) => s.replace(/ {10}owner: ircx-io\n/, '')), `${file} ${id}: no owner`);
    assert.ok(has(file, id, (s) => s.replace('repositories: ircx-docs', `repositories: ircx-docs,${OTHER_REPO}`)), `${file} ${id}: two repositories`);
    assert.ok(has(file, id, (s) => s.replace('repositories: ircx-docs', `repositories: ${OTHER_REPO}`)), `${file} ${id}: another repository`);
    assert.ok(has(file, id, (s) => s.replace(/ {10}repositories: .*\n/, '')), `${file} ${id}: no repositories`);
    assert.ok(has(file, id, (s) => s.replace(/\n {10}permission-[^\n]*/g, '')), `${file} ${id}: no permission`);
    assert.ok(has(file, id, (s) => `${s}\n          skip-token-revoke: true`), `${file} ${id}: skip-token-revoke true`);
    assert.ok(has(file, id, (s) => `${s}\n          skip-token-revoke: false`), `${file} ${id}: skip-token-revoke false`);
  }
  assert.ok(has('settings-check.yml', 'token', (s) => s.replace('permission-environments: read', 'permission-environments: write')), 'settings write');
  assert.ok(has('settings-check.yml', 'token', (s) => `${s}\n          permission-contents: write`), 'settings extra write');
  assert.ok(has('settings-check.yml', 'token', (s) => `${s}\n          permission-contents: read # note`), 'settings read with a trailing comment');
  assert.ok(!has('settings-check.yml', 'token', (s) => `${s}\n          permission-contents: read`), 'settings read');
});

// ---------------------------------------------------------------------------
// SC-U2-54 (G-3): the with: block of an App token step sets only the inputs the App needs.

const MINTS: readonly (readonly [file: string, id: string])[] = [
  ['cut-release.yml', 'token'],
  ['dependabot-merge.yml', 'contents-token'],
  ['dependabot-merge.yml', 'workflows-token'],
  ['settings-check.yml', 'token'],
  ['settings-check.yml', 'merge-token'],
];
const G3_MESSAGE = 'the App token step needs only client-id, private-key, owner, repositories and permission- inputs';
const WITH_PROBLEM = 'one with: key alone on its line';
const WITH_MESSAGE = `the App token step needs ${WITH_PROBLEM}`;
/** A host no real input names, built at run time so the publication scan has nothing to read. */
const PLANTED_HOST = ['example', 'invalid'].join('.');
const EXTRA_INPUT = `github-api-url: https://${PLANTED_HOST}`;

/** Applies `change` to the App token step `id` of `file`, from its `- id:` line to the next step. */
function inMint(id: string, change: (step: string) => string): Transform {
  return (text) => {
    const at = text.indexOf(`      - id: ${id}\n`);
    assert.ok(at >= 0, id);
    const end = text.indexOf('\n      - ', at + 10);
    assert.ok(end > at, `${id} is not the last step`);
    const step = text.slice(at, end);
    const changed = change(step);
    assert.notEqual(changed, step);
    return text.slice(0, at) + changed + text.slice(end);
  };
}

/** The W11 messages of `file` after `change`. */
function w11(file: string, change: Transform): string[] {
  return structuralFindings(file, change(base(file)))
    .filter((f) => f.rule === 'W11')
    .map((f) => f.message);
}

test('SC-U2-54 c an input outside the approved set in the with: block of each of the five App token steps is a W11 finding', () => {
  for (const [file, id] of MINTS) {
    assert.deepEqual(w11(file, (t) => t), [], `${file} ${id} as shipped`);
    const found = w11(file, inMint(id, (s) => `${s}\n          ${EXTRA_INPUT}`));
    assert.deepEqual(found, [G3_MESSAGE], `${file} ${id}`);
  }
});

test('SC-U2-54 c each spelling of a line that is not an approved input is a W11 finding, and the message prints none of it', () => {
  const refused = [
    `"github-api-url": https://${PLANTED_HOST}`,
    `'github-api-url': https://${PLANTED_HOST}`,
    '? github-api-url',
    `: https://${PLANTED_HOST}`,
    'client-id-x: y',
    'x-client-id: y',
    'owner2: x',
    'private-keys: x',
    'repositoriesx: y',
    'permission-Contents: read',
    'permission-contents:write',
    'permission-: read',
    'permission-contents',
  ];
  for (const line of refused) {
    const found = w11('cut-release.yml', inMint('token', (s) => `${s}\n          ${line}`));
    assert.deepEqual(found, [G3_MESSAGE], line);
  }
  // A continuation line under an approved input is a line of the block that sets no approved input.
  assert.deepEqual(w11('cut-release.yml', inMint('token', (s) => s.replace('repositories: ircx-docs', 'repositories: ircx-docs\n            more'))), [G3_MESSAGE], 'a continuation line');
  assert.deepEqual(w11('cut-release.yml', inMint('token', (s) => s.replace('owner: ircx-io', 'owner: >-\n            ircx-io'))).length > 0, true, 'a folded owner');
  for (const line of [...refused, EXTRA_INPUT]) {
    const message = w11('cut-release.yml', inMint('token', (s) => `${s}\n          ${line}`)).join('\n');
    assert.ok(!message.includes(PLANTED_HOST) && !message.includes('github-api-url') && !message.includes(line), `the message echoes ${line}`);
  }
});

test('SC-U2-54 c a valid approved input line passes, and so does an input with a trailing comment', () => {
  for (const line of ['permission-issues: read', 'permission-pull-requests: read # note', 'permission-contents: write']) {
    assert.deepEqual(w11('cut-release.yml', inMint('token', (s) => `${s}\n          ${line}`)), [], line);
  }
});

test('SC-U2-54 b blank and comment lines neither end the with: block nor count as inputs', () => {
  const fillers = ['# c', '#c', '    # c', '          # c', '', '   ', '\t'];
  for (const filler of fillers) {
    // As the only addition, a filler line is not an input.
    assert.deepEqual(w11('cut-release.yml', inMint('token', (s) => `${s}\n${filler}`)), [], `alone ${JSON.stringify(filler)}`);
    // Before an extra input, it does not end the block, so the input is still seen.
    for (const [file, id] of MINTS) {
      const found = w11(file, inMint(id, (s) => `${s}\n${filler}\n          ${EXTRA_INPUT}`));
      assert.deepEqual(found, [G3_MESSAGE], `${file} ${id} after ${JSON.stringify(filler)}`);
    }
  }
  // In the middle of the block, ahead of the approved inputs that follow it.
  assert.deepEqual(w11('cut-release.yml', inMint('token', (s) => s.replace('          owner: ircx-io\n', `# c\n\n          ${EXTRA_INPUT}\n          owner: ircx-io\n`))), [G3_MESSAGE], 'a comment and a blank line ahead of more inputs');
});

test('SC-U2-54 b the block ends at the first line indented no deeper than with:', () => {
  // A step key at the indent of with: is not a line of the block, and neither is the next step.
  assert.deepEqual(w11('cut-release.yml', inMint('token', (s) => `${s}\n        timeout-minutes: 5`)), [], 'a step key after the block');
  assert.deepEqual(w11('cut-release.yml', inMint('token', (s) => `${s}\n        timeout-minutes: 5\n        ${EXTRA_INPUT}`)), [], 'a step key, then a line at the same indent');
  assert.deepEqual(w11('cut-release.yml', inMint('token', (s) => `${s}\n        ${EXTRA_INPUT}`)), [], 'a line at the indent of with:');
  // One column deeper than with: is in the block.
  assert.deepEqual(w11('cut-release.yml', inMint('token', (s) => `${s}\n         ${EXTRA_INPUT}`)), [G3_MESSAGE], 'one column deeper');
});

test('SC-U2-54 a the with: line is exactly with: and the step has one', () => {
  const withBlock = (s: string): string => s.slice(s.indexOf('        with:'));
  for (const [file, id] of MINTS) {
    // An inline flow mapping holds the inputs on the with: line.
    const flow = w11(file, inMint(id, (s) => s.replace(withBlock(s), `        with: { client-id: ${KEY}, ${EXTRA_INPUT} }`)));
    assert.ok(flow.some((m) => m.includes(WITH_PROBLEM)), `${file} ${id}: inline flow`);
    // A comment after the colon, a quoted key, a second with: key and no with: key.
    const others: readonly (readonly [string, (s: string) => string])[] = [
      ['a trailing comment', (s) => s.replace('        with:\n', '        with: # c\n')],
      ['a quoted key', (s) => s.replace('        with:\n', '        "with":\n')],
      ['a second with: key', (s) => `${s}\n        with:\n          owner: ircx-io`],
      ['no with: key', (s) => s.replace(withBlock(s), '')],
    ];
    for (const [name, change] of others) {
      assert.ok(w11(file, inMint(id, change)).some((m) => m.includes(WITH_PROBLEM)), `${file} ${id}: ${name}`);
    }
  }
  // With the comment after the colon the block lines are unchanged, so this is the only problem.
  assert.deepEqual(w11('cut-release.yml', inMint('token', (s) => s.replace('        with:\n', '        with: # c\n'))), [WITH_MESSAGE]);
});

test('SC-U2-54 d INPUT_ in any case on any line of any of the five workflows is a W11 finding', () => {
  const found = (file: string, text: string): string[] =>
    structuralFindings(file, text)
      .filter((f) => f.rule === 'W11')
      .map((f) => f.message);
  for (const file of NAMES) {
    for (const word of ['INPUT_X', 'input_x', 'Input_X', 'iNpUt_x', 'user_input_x']) {
      const messages = found(file, `${base(file).trimEnd()}\n# ${word}\n`);
      assert.equal(messages.length, 1, `${file}: ${word}`);
      assert.ok(messages[0]?.includes('INPUT_'), `${file}: ${word}`);
      assert.ok(!messages[0]?.includes(word), `${file}: the message echoes ${word}`);
    }
    // The words input and inputs, as the dispatch inputs are spelled, are not the environment form.
    assert.deepEqual(found(file, `${base(file).trimEnd()}\n# input inputs.tag input-x\n`), [], file);
  }
  // A step env on the cut-release mint, and a job env on merge in dependabot-merge.yml.
  const stepEnv = found('cut-release.yml', inMint('token', (s) => s.replace('        with:\n', `        env:\n          INPUT_GITHUB-API-URL: https://${PLANTED_HOST}\n        with:\n`))(base('cut-release.yml')));
  assert.equal(stepEnv.length, 1);
  assert.ok(stepEnv[0]?.includes('INPUT_') && !stepEnv[0].includes(PLANTED_HOST));
  const jobEnv = found('dependabot-merge.yml', sub('    environment: ircx-bot\n', '    environment: ircx-bot\n    env:\n      input_github-api-url: x\n')(base('dependabot-merge.yml')));
  assert.equal(jobEnv.length, 1);
  assert.ok(jobEnv[0]?.includes('INPUT_'));
});

test('SC-U2-54 d a YAML escape or a line-ending backslash on any line of any of the five workflows is a W11 finding', () => {
  const ESCAPE = 'no YAML hex or unicode escape and no line ending in a backslash';
  const found = (file: string, text: string): string[] =>
    structuralFindings(file, text)
      .filter((f) => f.rule === 'W11')
      .map((f) => f.message);
  // Each spelling decodes to an INPUT_ key, but no line holds the text INPUT_.
  const spellings = [
    '"\\x49NPUT_GITHUB-API-URL"',
    '"\\x69nput_github-api-url"',
    '"INPUT\\x5FGITHUB-API-URL"',
    '"INPUT\\x5fGITHUB-API-URL"',
    '"\\u0049NPUT_GITHUB-API-URL"',
    '"\\U00000049NPUT_GITHUB-API-URL"',
    '"INPUT\\\n          _GITHUB-API-URL"',
  ];
  for (const file of NAMES) {
    for (const key of spellings) {
      const messages = found(file, `${base(file).trimEnd()}\n# ${key}: x\n`);
      assert.deepEqual(messages, [ESCAPE], `${file}: ${key}`);
    }
    // A CR LF line ending keeps the backslash last.
    assert.deepEqual(found(file, `${base(file).trimEnd()}\n# "INPUT\\\r\n# _X": x\n`), [ESCAPE], `${file}: CR LF`);
    // Other escapes cannot spell a key letter, and a backslash before the end of the line is not a continuation.
    assert.deepEqual(found(file, `${base(file).trimEnd()}\n# printf 'a\\n\\t' "\\N" x\\.y \\\\ \\x4 \\u004 z\n`), [], file);
  }
  // As a step env: key on each mint, and as a job env: key on merge in dependabot-merge.yml.
  for (const [file, id] of MINTS) {
    for (const key of spellings) {
      const text = inMint(id, (s) => s.replace('        with:\n', `        env:\n          ${key}: https://${PLANTED_HOST}\n        with:\n`))(base(file));
      const messages = found(file, text);
      assert.deepEqual(messages, [ESCAPE], `${file} ${id}: ${key}`);
    }
  }
  const jobEnv = found('dependabot-merge.yml', sub('    environment: ircx-bot\n', '    environment: ircx-bot\n    env:\n      "\\x49NPUT_GITHUB-API-URL": x\n')(base('dependabot-merge.yml')));
  assert.deepEqual(jobEnv, [ESCAPE]);
  // The real files hold a \n in a printf format and a \. in a tag pattern, and neither is a finding.
  assert.ok(SC.split('\n').some((l) => l.includes("printf 'The weekly settings check found drift.\\n")));
  assert.ok(CR.split('\n').some((l) => l.includes('(\\.[2-9])?$')));
  for (const file of NAMES) {
    assert.deepEqual(found(file, workflow(file)), [], file);
  }
});

test('SC-U2-54 d an env: key with a value on its own line, or fromJSON in any case, on any of the five workflows is a W11 finding', () => {
  const ENV = 'an env: key holds a block mapping on the lines below it and nothing after its colon';
  const FROM_JSON = 'no fromJSON in any case, since it can build an env: mapping at run time';
  const found = (file: string, text: string): string[] =>
    structuralFindings(file, text)
      .filter((f) => f.rule === 'W11')
      .map((f) => f.message);
  // An expression that builds an INPUT_ key at run time, with no INPUT_ text and no escape on the line.
  const built = `\${{ fromJSON(format('{{"{0}NPUT_GITHUB-API-URL":"x"}}', 'I')) }}`;
  // Each value an env: key could hold on its own line, and the W11 messages it gives.
  const values: (readonly [value: string, messages: readonly string[]])[] = [
    [built, [ENV, FROM_JSON]],
    ['${{ vars }}', [ENV]],
    ['"${{ github.event.client_payload }}"', [ENV]],
    [">-\n  ${{ github.event.client_payload }}", [ENV]],
    ['{ FOO: x }', [ENV]],
    ['*shared', [ENV]],
  ];
  for (const file of NAMES) {
    for (const [value, messages] of values) {
      // Workflow level, as a top-level key after the jobs.
      assert.deepEqual(found(file, `${base(file).trimEnd()}\nenv: ${value}\n`), messages, `${file} workflow: ${value}`);
      // Step level, as the first key of an added step.
      assert.deepEqual(found(file, `${base(file).trimEnd()}\n      - env: ${value}\n        run: echo\n`), messages, `${file} step: ${value}`);
    }
    for (const spelling of ['"env": ${{ vars }}', "'env': ${{ vars }}", 'env : ${{ vars }}', '      - { name: x, env: ${{ vars }} }']) {
      assert.deepEqual(found(file, `${base(file).trimEnd()}\n${spelling}\n`), [ENV], `${file}: ${spelling}`);
    }
    for (const word of ['fromJSON(x)', 'FromJson(x)', 'fromjson (x)', 'FROMJSON']) {
      const messages = found(file, `${base(file).trimEnd()}\n# ${word}\n`);
      assert.deepEqual(messages, [FROM_JSON], `${file}: ${word}`);
      assert.ok(!messages[0]?.includes(word), `${file}: the message echoes ${word}`);
    }
    // A comment after the colon, the env context and words that end in env are not an env: value.
    assert.deepEqual(found(file, `${base(file).trimEnd()}\n    env:   # the token\n# printenv: x \${{ env.FOO }} myenv: y environment: ircx-bot\n`), [], file);
  }
  // Job level, on merge in dependabot-merge.yml, and step level on each mint.
  for (const [value, messages] of values) {
    const job = found('dependabot-merge.yml', sub('    environment: ircx-bot\n', `    environment: ircx-bot\n    env: ${value}\n`)(base('dependabot-merge.yml')));
    assert.deepEqual(job, messages, `job: ${value}`);
    for (const [file, id] of MINTS) {
      const step = found(file, inMint(id, (st) => st.replace('        with:\n', `        env: ${value}\n        with:\n`))(base(file)));
      assert.deepEqual(step, messages, `${file} ${id}: ${value}`);
      assert.ok(!step.some((m) => m.includes(value)), `${file} ${id}: the message echoes the value`);
    }
  }
  // The real files hold env: blocks whose keys take expressions as values, and that is not a finding.
  assert.ok(CR.includes('        env:\n          GH_TOKEN: ${{ github.token }}\n'));
  assert.ok(SC.includes('        env:\n          REPOSITORY: ${{ needs.read.outputs.repository }}\n'));
  for (const file of NAMES) {
    assert.deepEqual(found(file, workflow(file)), [], file);
  }
});

test('SC-U2-47 W12 and W13: github.actor, a debug switch and the CI name', () => {
  for (const file of NAMES) {
    for (const text of ['github.actor', 'set -x', 'GH_DEBUG', 'ACTIONS_STEP_DEBUG']) {
      assert.ok(rulesOf(file, `${base(file).trimEnd()}\n# ${text}\n`).includes('W12'), `${file}: ${text}`);
    }
  }
  assert.ok(rulesOf('labels.yml', sub('          set -uo pipefail\n', '          set -xuo pipefail\n')(LB)).includes('W12'), 'set -xuo');
  for (const file of NAMES.filter((n) => n !== 'ci.yml')) {
    assert.ok(rulesOf(file, base(file).replace(/^name: .*\n/, 'name: CI\n')).includes('W13'), file);
  }
  assert.ok(!rulesOf('ci.yml', CI).includes('W13'));
});
