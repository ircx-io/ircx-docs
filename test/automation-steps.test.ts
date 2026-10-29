// Runs the shell text of the key-job and decision steps of the real workflow
// files under bash, with a fake `gh`, and checks what each step refuses, what it
// calls and in what order (SC-U2-42 c, SC-U2-43 d, SC-U2-45 b and c, SC-U2-46).
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decide, outputLines } from '../src/dependabot.ts';
import { FILES } from '../src/settings.ts';
import { ROOT } from './helpers.ts';
import { envOf, jobOf, runOf, runShell, stepNamed, stepsOf, workflow } from './step-harness.ts';

const DM = workflow('dependabot-merge.yml');
const CR = workflow('cut-release.yml');
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const REPO = 'repos/ircx-io/ircx-docs';

// ---------------------------------------------------------------------------
// SC-U2-42 c: the merge job re-validates every value it receives, before a mint.

const VALIDATE_MERGE = runOf(stepNamed(jobOf(DM, 'merge'), 'Validate the decision'));

function validate(number: string, sha: string, workflows: string): { status: number | null; stdout: string } {
  return runShell(VALIDATE_MERGE, { env: { NUMBER: number, SHA: sha, WORKFLOWS: workflows } }, (r) => ({ status: r.status, stdout: r.stdout }));
}

test('SC-U2-42 c the merge validation step accepts a well-formed number, sha and workflows flag', () => {
  for (const [n, s, w] of [
    ['7', SHA, 'true'],
    ['1', 'f'.repeat(40), 'false'],
    ['1234567890', '0'.repeat(40), 'true'],
  ] as const) {
    const r = validate(n, s, w);
    assert.equal(r.status, 0, `${n} ${s} ${w}: ${r.stdout}`);
  }
});

test('SC-U2-42 c the merge validation step stops on each malformed number', () => {
  for (const n of ['', '0', '01', '-1', '12345678901', '7 ', ' 7', '7\n', '7a', '1;id', '1e3', '٣']) {
    const r = validate(n, SHA, 'true');
    assert.equal(r.status, 1, JSON.stringify(n));
    assert.equal(r.stdout, 'the pull request number is malformed\n', JSON.stringify(n));
  }
});

test('SC-U2-42 c the merge validation step stops on each malformed sha', () => {
  for (const s of ['', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'g'.repeat(40), `${SHA}\n`, ` ${SHA}`, SHA.replace('a1', 'a-')]) {
    const r = validate('7', s, 'true');
    assert.equal(r.status, 1, JSON.stringify(s));
    assert.equal(r.stdout, 'the head SHA is malformed\n', JSON.stringify(s));
  }
});

test('SC-U2-42 c the merge validation step stops on each flag outside exactly true or false', () => {
  for (const w of ['', 'True', 'TRUE', 'False', '1', '0', 'yes', 'true\n', 'false\n', 'true ', ' true', 'truefalse', 'true|false', 'tru', 'trueX']) {
    const r = validate('7', SHA, w);
    assert.equal(r.status, 1, JSON.stringify(w));
    assert.equal(r.stdout, 'the workflows flag is malformed\n', JSON.stringify(w));
  }
});

test('SC-U2-42 c with all three values bad the number is refused first, and the checks run in the order number, sha, flag', () => {
  assert.equal(validate('x', 'y', 'z').stdout, 'the pull request number is malformed\n');
  assert.equal(validate('7', 'y', 'z').stdout, 'the head SHA is malformed\n');
});

test('SC-U2-42 c each key job validates before its first mint step, and merge reads its values through env', () => {
  const merge = jobOf(DM, 'merge');
  const steps = stepsOf(merge);
  const validation = steps.findIndex((s) => s.startsWith('      - name: Validate the decision\n'));
  const firstMint = steps.findIndex((s) => s.includes('uses: actions/create-github-app-token@'));
  assert.equal(validation, 0);
  assert.equal(firstMint, 1);
  assert.deepEqual(envOf(stepNamed(merge, 'Validate the decision')), {
    NUMBER: '${{ needs.decide.outputs.number }}',
    SHA: '${{ needs.decide.outputs.sha }}',
    WORKFLOWS: '${{ needs.decide.outputs.workflows }}',
  });
  const release = jobOf(CR, 'release');
  const rsteps = stepsOf(release);
  assert.ok(rsteps[0]?.startsWith('      - name: Validate the inputs\n'));
  assert.ok(rsteps[1]?.includes('uses: actions/create-github-app-token@'));
  assert.equal(rsteps.length, 3);
});

// ---------------------------------------------------------------------------
// SC-U2-43 d: the merge call.

const SQUASH = runOf(stepNamed(jobOf(DM, 'merge'), 'Squash-merge at the checked head'));

test('SC-U2-43 d3 the merge step makes one squash PUT bound to the checked head, with the job token', () => {
  runShell(SQUASH, { env: { GH_TOKEN: 'app-token', NUMBER: '42', SHA }, routes: [{ match: 'pulls/42/merge', out: '{}' }] }, (r) => {
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.calls, [{ token: 'app-token', args: ['api', '-X', 'PUT', `${REPO}/pulls/42/merge`, '-f', 'merge_method=squash', '-f', `sha=${SHA}`] }]);
  });
});

test('SC-U2-43 d4 a failed merge call fails the step after exactly one call, with no retry', () => {
  runShell(SQUASH, { env: { GH_TOKEN: 't', NUMBER: '42', SHA }, routes: [{ match: 'pulls/42/merge', rc: 22, err: 'gh: Pull Request is not mergeable (HTTP 405)' }] }, (r) => {
    assert.equal(r.status, 22);
    assert.equal(r.calls.length, 1);
  });
});

test('SC-U2-43 d the merge job wires GH_TOKEN to whichever mint ran, and the number and sha to the checked outputs', () => {
  const env = envOf(stepNamed(jobOf(DM, 'merge'), 'Squash-merge at the checked head'));
  assert.deepEqual(env, {
    GH_TOKEN: '${{ steps.contents-token.outputs.token || steps.workflows-token.outputs.token }}',
    NUMBER: '${{ needs.decide.outputs.number }}',
    SHA: '${{ needs.decide.outputs.sha }}',
  });
});

// ---------------------------------------------------------------------------
// SC-U2-43 b and c: the decide job reads the pull request through the validated number only.

const READ_PR = runOf(stepNamed(jobOf(DM, 'decide'), 'Read the pull request'));
const DECIDE_RUN = runOf(stepNamed(jobOf(DM, 'decide'), 'decide'));

function readPr(event: unknown, routes: Parameters<typeof runShell>[1]['routes'] = []): { calls: string[][]; files: { pr: string; commits: string; files: string }; pwned: boolean; status: number | null } {
  return runShell(READ_PR, { env: { GH_TOKEN: 'job-token', GITHUB_EVENT_PATH: 'event.json' }, files: { 'event.json': JSON.stringify(event) }, routes }, (r) => ({
    calls: r.calls.map((c) => c.args),
    status: r.status,
    pwned: r.exists('pwned'),
    files: { pr: r.read('tmp/dependabot/pr.json') ?? '', commits: r.read('tmp/dependabot/commits.json') ?? '', files: r.read('tmp/dependabot/files.json') ?? '' },
  }));
}

test('SC-U2-43 c the read step fetches the pull request, its commits and its files for the run\'s first number', () => {
  const r = readPr({ workflow_run: { pull_requests: [{ number: 7 }, { number: 9 }] } }, [
    { match: '/pulls/7/commits', out: '[{"n":1}]\n[{"n":2}]\n' },
    { match: '/pulls/7/files', out: '[{"f":1}]\n' },
    { match: '/pulls/7', out: '{"number":7}\n' },
  ]);
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, [
    ['api', `${REPO}/pulls/7`],
    ['api', '--paginate', `${REPO}/pulls/7/commits`],
    ['api', '--paginate', `${REPO}/pulls/7/files`],
  ]);
  assert.deepEqual(JSON.parse(r.files.pr), { number: 7 });
  assert.deepEqual(JSON.parse(r.files.commits), [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(JSON.parse(r.files.files), [{ f: 1 }]);
});

test('SC-U2-43 c a number outside the grammar makes no API call and leaves empty placeholders', () => {
  const events: unknown[] = [
    { workflow_run: { pull_requests: [] } },
    { workflow_run: {} },
    { workflow_run: { pull_requests: [{ number: 0 }] } },
    { workflow_run: { pull_requests: [{ number: -3 }] } },
    { workflow_run: { pull_requests: [{ number: '07' }] } },
    { workflow_run: { pull_requests: [{ number: 12345678901 }] } },
    { workflow_run: { pull_requests: [{ number: 7.5 }] } },
    { workflow_run: { pull_requests: [{ number: '7; touch pwned' }] } },
    { workflow_run: { pull_requests: [{ number: '7\n8' }] } },
    { workflow_run: { pull_requests: [{ number: '$(touch pwned)' }] } },
    { workflow_run: { pull_requests: [{ number: null }] } },
  ];
  for (const event of events) {
    const r = readPr(event);
    assert.equal(r.status, 0, JSON.stringify(event));
    assert.deepEqual(r.calls, [], JSON.stringify(event));
    assert.equal(r.pwned, false);
    assert.deepEqual([JSON.parse(r.files.pr), JSON.parse(r.files.commits), JSON.parse(r.files.files)], [{}, [], []]);
  }
});

test('SC-U2-43 c the placeholders the read step leaves are refused by dependabot.ts', () => {
  const r = readPr({ workflow_run: { pull_requests: [] } });
  const d = decide({ workflow_run: { pull_requests: [] } }, JSON.parse(r.files.pr), JSON.parse(r.files.commits), JSON.parse(r.files.files));
  assert.deepEqual(outputLines(d), ['merge=false', 'number=', 'sha=', 'workflows=false']);
});

test('SC-U2-43 e the decide step writes only the module output to GITHUB_OUTPUT, passing four file paths', () => {
  assert.equal(
    DECIDE_RUN,
    'node src/dependabot.ts "$GITHUB_EVENT_PATH" "$RUNNER_TEMP/dependabot/pr.json" "$RUNNER_TEMP/dependabot/commits.json" "$RUNNER_TEMP/dependabot/files.json" >> "$GITHUB_OUTPUT"\n',
  );
  assert.ok(READ_PR.includes('"$RUNNER_TEMP/dependabot'));
});

// ---------------------------------------------------------------------------
// SC-U2-45 b: the release validation step.

const VALIDATE_RELEASE = runOf(stepNamed(jobOf(CR, 'release'), 'Validate the inputs'));
const CREATE_RELEASE = runOf(stepNamed(jobOf(CR, 'release'), 'Create the release'));
const NOT_FOUND = 'gh: Not Found (HTTP 404)';

interface Validation {
  readonly status: number | null;
  readonly stdout: string;
  readonly urls: string[];
}

function validateRelease(tag: string, revision: string, compare: string | { rc: number }, lookup: { rc: number; err?: string }): Validation {
  const routes = [
    typeof compare === 'string' ? { match: '/compare/', out: JSON.stringify({ status: compare }) } : { match: '/compare/', rc: compare.rc, err: 'gh: boom' },
    { match: '/git/ref/tags/', rc: lookup.rc, out: lookup.rc === 0 ? '{}' : '', err: lookup.err ?? '' },
  ];
  return runShell(VALIDATE_RELEASE, { env: { GH_TOKEN: 'job-token', TAG: tag, REVISION: revision }, routes }, (r) => ({
    status: r.status,
    stdout: r.stdout,
    urls: r.calls.map((c) => c.args[1] === '--paginate' ? '' : (c.args[1] ?? '')),
  }));
}

test('SC-U2-45 b a well-formed tag on main with no existing tag passes, checking compare before the tag lookup', () => {
  for (const tag of ['v2026.10.28', 'v2026.10.28.2', 'v2026.10.28.9', 'v0000.00.00']) {
    for (const status of ['ahead', 'identical']) {
      const r = validateRelease(tag, SHA, status, { rc: 1, err: NOT_FOUND });
      assert.equal(r.status, 0, `${tag} ${status}: ${r.stdout}`);
      assert.deepEqual(r.urls, [`${REPO}/compare/${SHA}...main`, `${REPO}/git/ref/tags/${tag}`]);
    }
  }
});

test('SC-U2-45 b each malformed tag stops the step before any API call', () => {
  const tags = ['', 'v2026.10.28.1', 'v2026.10.28.0', 'v2026.10.28.10', 'v2026.10.28.22', 'v2026.1.28', 'v26.10.28', '2026.10.28', 'V2026.10.28', 'v2026.10.28x', 'v2026.13.01x', 'v2026.10.28\n', 'v2026.10.28 ', ' v2026.10.28', 'v2026.10.28.2.3', 'v2026.10.8', 'v2026.10.', 'v2026.10.28.', 'v2026-10-28', 'v2026.10.28;id', '../v2026.10.28', 'vX', 'v2026.10.28.x'];
  for (const tag of tags) {
    const r = validateRelease(tag, SHA, 'ahead', { rc: 1, err: NOT_FOUND });
    assert.equal(r.status, 1, JSON.stringify(tag));
    assert.equal(r.stdout, 'the tag must be vYYYY.MM.DD, optionally followed by .2 to .9\n', JSON.stringify(tag));
    assert.deepEqual(r.urls, [], JSON.stringify(tag));
  }
});

test('SC-U2-45 b each malformed revision stops the step before any API call', () => {
  for (const rev of ['', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'g'.repeat(40), 'main', `${SHA}\n`, `${SHA} `, 'HEAD']) {
    const r = validateRelease('v2026.10.28', rev, 'ahead', { rc: 1, err: NOT_FOUND });
    assert.equal(r.status, 1, JSON.stringify(rev));
    assert.equal(r.stdout, 'the revision must be a full lowercase commit SHA\n', JSON.stringify(rev));
    assert.deepEqual(r.urls, [], JSON.stringify(rev));
  }
});

test('SC-U2-45 b a revision that is not ahead of or identical to main stops the step before the tag lookup', () => {
  for (const status of ['behind', 'diverged', '', 'AHEAD', 'ahead\nbehind', 'identical2']) {
    const r = validateRelease('v2026.10.28', SHA, status, { rc: 1, err: NOT_FOUND });
    assert.equal(r.status, 1, JSON.stringify(status));
    assert.equal(r.stdout, 'the revision is not on main\n', JSON.stringify(status));
    assert.deepEqual(r.urls, [`${REPO}/compare/${SHA}...main`], JSON.stringify(status));
  }
  const failed = validateRelease('v2026.10.28', SHA, { rc: 1 }, { rc: 1, err: NOT_FOUND });
  assert.notEqual(failed.status, 0);
  assert.deepEqual(failed.urls, [`${REPO}/compare/${SHA}...main`]);
});

test('SC-U2-45 b an existing tag stops the step, and so does any lookup failure other than HTTP 404', () => {
  const exists = validateRelease('v2026.10.28', SHA, 'ahead', { rc: 0 });
  assert.equal(exists.status, 1);
  assert.equal(exists.stdout, 'the tag already exists\n');
  for (const err of ['gh: Internal Server Error (HTTP 500)', 'gh: Forbidden (HTTP 403)', 'dial tcp: lookup the-api-host: no such host', '', 'HTTP 404', 'gh: Not Found']) {
    const r = validateRelease('v2026.10.28', SHA, 'ahead', { rc: 1, err });
    assert.equal(r.status, 1, JSON.stringify(err));
    assert.equal(r.stdout, 'the tag lookup failed\n', JSON.stringify(err));
  }
});

// ---------------------------------------------------------------------------
// SC-U2-45 c: the release call.

test('SC-U2-45 c the release POST carries the tag, the pinned revision, generated notes, latest and not a draft, and uploads nothing', () => {
  runShell(CREATE_RELEASE, { env: { GH_TOKEN: 'app-token', TAG: 'v2026.10.28', REVISION: SHA }, routes: [{ match: '/releases', out: '{"id":1}' }] }, (r) => {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '', 'the response is not printed');
    assert.deepEqual(r.calls, [
      {
        token: 'app-token',
        args: ['api', '-X', 'POST', `${REPO}/releases`, '-f', 'tag_name=v2026.10.28', '-f', `target_commitish=${SHA}`, '-F', 'generate_release_notes=true', '-f', 'make_latest=true', '-F', 'draft=false'],
      },
    ]);
  });
});

test('SC-U2-45 c a failed release call fails the step after one call, and a tag with shell characters stays one argument', () => {
  runShell(CREATE_RELEASE, { env: { GH_TOKEN: 't', TAG: '$(touch pwned); x', REVISION: '`touch pwned`' }, routes: [{ match: '/releases', rc: 1, err: 'gh: Validation Failed (HTTP 422)' }] }, (r) => {
    assert.equal(r.status, 1);
    assert.equal(r.calls.length, 1);
    assert.equal(r.exists('pwned'), false);
    assert.ok(r.calls[0]?.args.includes('tag_name=$(touch pwned); x'));
    assert.ok(r.calls[0]?.args.includes('target_commitish=`touch pwned`'));
  });
});

// ---------------------------------------------------------------------------
// SC-U2-46 b: the read job turns each response into one compact line of a job output.

const SC = workflow('settings-check.yml');
const READ_SETTINGS = runOf(stepNamed(jobOf(SC, 'read'), 'read'));
const WRITE_RESPONSES = runOf(stepNamed(jobOf(SC, 'compare'), 'Write the responses to files'));
const REPORT_DRIFT = runOf(stepNamed(jobOf(SC, 'compare'), 'Report the drift in an issue'));
const MERGE_OPTIONS = runOf(stepNamed(jobOf(SC, 'read'), 'merge-options'));

/** A ruleset as the read token gets it: GitHub leaves out `bypass_actors` for a token that cannot write the ruleset. */
function rs(id: number, name: string, target: string, include: string, rules: unknown[]): unknown {
  return { id, name, target, enforcement: 'active', conditions: { ref_name: { include: [include], exclude: [] } }, rules };
}

/** What the read token gets, endpoint by endpoint, when every setting is as it was set up; `GET /repos` carries no merge fields for it. */
const RAW: Record<string, string> = {
  [REPO]: JSON.stringify({
    has_wiki: false,
    has_projects: false,
    has_issues: true,
    visibility: 'public',
    security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } },
  }, null, 2),
  [`${REPO}/actions/permissions`]: '{"enabled":true,"allowed_actions":"selected","sha_pinning_required":true}',
  [`${REPO}/actions/permissions/selected-actions`]: '{"github_owned_allowed":false,"verified_allowed":false,"patterns_allowed":["actions/checkout@*","actions/create-github-app-token@*","actions/setup-node@*"]}',
  [`${REPO}/actions/permissions/workflow`]: '{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}',
  [`${REPO}/actions/permissions/fork-pr-contributor-approval`]: '{"approval_policy":"all_external_contributors"}',
  [`${REPO}/private-vulnerability-reporting`]: '{"enabled":true}',
  [`${REPO}/actions/secrets`]: '{"total_count":0,"secrets":[]}',
  [`${REPO}/dependabot/secrets`]: '{"total_count":0,"secrets":[]}',
  [`${REPO}/environments/ircx-bot/secrets`]: '{"total_count":1,"secrets":[{"name":"IRCX_BOT_PRIVATE_KEY"}]}',
  [`${REPO}/environments/ircx-bot/variables`]: '{"total_count":0,"variables":[]}',
  [`${REPO}/environments`]: '{"total_count":1,"environments":[{"name":"ircx-bot","deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true},"protection_rules":[{"type":"branch_policy"}]}]}',
  [`${REPO}/environments/ircx-bot/deployment-branch-policies`]: '{"total_count":1,"branch_policies":[{"name":"main","type":"branch"}]}',
  [`${REPO}/releases`]: '[{"author":{"login":"ircx-io-bot[bot]"},"assets":[],"draft":false}]',
  [`${REPO}/rulesets`]: '[{"id":11},{"id":12},{"id":13},{"id":14}]',
  [`${REPO}/rulesets/11`]: JSON.stringify(rs(11, 'main-history', 'branch', '~DEFAULT_BRANCH', [{ type: 'deletion' }, { type: 'non_fast_forward' }])),
  [`${REPO}/rulesets/12`]: JSON.stringify(rs(12, 'main-checks', 'branch', '~DEFAULT_BRANCH', [{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: 'docs' }] } }])),
  [`${REPO}/rulesets/13`]: JSON.stringify(rs(13, 'tags-create', 'tag', '~ALL', [{ type: 'creation' }])),
  [`${REPO}/rulesets/14`]: JSON.stringify(rs(14, 'tags-locked', 'tag', '~ALL', [{ type: 'update' }, { type: 'deletion' }])),
};

/** Output name to the endpoint whose failure empties exactly that output. */
const OUTPUT_ENDPOINT: Record<string, string> = {
  repository: REPO,
  'actions-permissions': `${REPO}/actions/permissions`,
  'selected-actions': `${REPO}/actions/permissions/selected-actions`,
  'workflow-permissions': `${REPO}/actions/permissions/workflow`,
  'fork-pr-approval': `${REPO}/actions/permissions/fork-pr-contributor-approval`,
  'private-vulnerability-reporting': `${REPO}/private-vulnerability-reporting`,
  'actions-secrets': `${REPO}/actions/secrets`,
  'dependabot-secrets': `${REPO}/dependabot/secrets`,
  'environment-secrets': `${REPO}/environments/ircx-bot/secrets`,
  'environment-variables': `${REPO}/environments/ircx-bot/variables`,
  environments: `${REPO}/environments`,
  'branch-policies': `${REPO}/environments/ircx-bot/deployment-branch-policies`,
  releases: `${REPO}/releases`,
  rulesets: `${REPO}/rulesets`,
};

const JOB_TOKEN_OUTPUTS = ['environments', 'branch-policies', 'releases'];

interface ReadResult {
  readonly status: number | null;
  readonly outputs: Map<string, string>;
  readonly lines: string[];
  readonly calls: Array<{ token: string; args: string[] }>;
}

/** Runs the read step. `fail` maps an endpoint to a failing answer; `alerts` is the vulnerability-alerts answer. */
function readSettings(fail: Record<string, { rc: number; err?: string }> = {}, alerts: { rc: number; err?: string } = { rc: 0 }, overrides: Record<string, string> = {}): ReadResult {
  const routes = [
    ...Object.entries({ ...RAW, ...overrides }).map(([url, out]) => {
      const f = fail[url];
      const jq = url === `${REPO}/rulesets` ? ' --jq .[].id' : '';
      return { match: `=api ${url}${jq}`, out: f === undefined ? out : '', rc: f?.rc ?? 0, err: f?.err ?? '' };
    }),
    ...Object.entries({ ...RAW, ...overrides })
      .filter(([url]) => [`${REPO}/environments`, `${REPO}/environments/ircx-bot/deployment-branch-policies`, `${REPO}/releases`].includes(url))
      .map(([url, out]) => {
        const f = fail[url];
        return { match: `=api --paginate ${url}`, out: f === undefined ? out : '', rc: f?.rc ?? 0, err: f?.err ?? '' };
      }),
    { match: `=api ${REPO}/vulnerability-alerts`, out: '', rc: alerts.rc, err: alerts.err ?? '' },
  ];
  return runShell(READ_SETTINGS, { env: { APP_TOKEN: 'app-token', JOB_TOKEN: 'job-token', GITHUB_OUTPUT: 'out.txt' }, files: { 'out.txt': '' }, routes }, (r) => {
    const text = r.read('out.txt') ?? '';
    const lines = text.split('\n').filter((l) => l !== '');
    const outputs = new Map<string, string>();
    for (const l of lines) {
      const at = l.indexOf('=');
      outputs.set(l.slice(0, at), l.slice(at + 1));
    }
    return { status: r.status, outputs, lines, calls: r.calls };
  });
}

const OUTPUT_NAMES = [...Object.keys(OUTPUT_ENDPOINT), 'vulnerability-alerts'].sort();

test('SC-U2-46 b with every endpoint answering, the read step writes one compact line for each of the fifteen outputs', () => {
  const r = readSettings();
  assert.equal(r.status, 0);
  assert.equal(r.lines.length, 15);
  assert.deepEqual([...r.outputs.keys()].sort(), OUTPUT_NAMES);
  for (const l of r.lines) {
    assert.match(l, /^[a-z-]+=\S/, 'one line per output, name=value');
  }
  assert.equal(r.outputs.get('repository'), JSON.stringify(JSON.parse(RAW[REPO] ?? '')), 'a pretty-printed response is compacted');
  assert.equal(r.outputs.get('vulnerability-alerts'), '{"enabled":true}');
  assert.equal(r.outputs.get('environments'), `[${RAW[`${REPO}/environments`]}]`, 'a paginated response is wrapped by jq -s');
  assert.equal(r.outputs.get('releases'), `[${RAW[`${REPO}/releases`]}]`);
  const rulesets = JSON.parse(r.outputs.get('rulesets') ?? '') as Array<{ name: string }>;
  assert.deepEqual(rulesets.map((x) => x.name), ['main-history', 'main-checks', 'tags-create', 'tags-locked']);
});

/** What the Contents-write token gets from `GET /repos`: the four plain fields plus the five merge fields, and no `security_and_analysis`. */
const MERGE_RAW = JSON.stringify({ has_wiki: false, has_projects: false, has_issues: true, visibility: 'public', allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false, allow_auto_merge: false, delete_branch_on_merge: true });
const MERGE_FIELDS = ['allow_auto_merge', 'allow_merge_commit', 'allow_rebase_merge', 'allow_squash_merge', 'delete_branch_on_merge'];

test('SC-U2-46 b the outputs the read and merge-options steps write are exactly the clean state settings.ts expects', () => {
  const r = readSettings();
  const files: Record<string, string> = {};
  for (const [name, value] of r.outputs) {
    files[`${name}.json`] = value;
  }
  const merge = runShell(MERGE_OPTIONS, { env: { GH_TOKEN: 'merge-token', GITHUB_OUTPUT: 'out.txt' }, files: { 'out.txt': '' }, routes: [{ match: `=api ${REPO}`, out: MERGE_RAW }] }, (x) => ({ status: x.status, out: x.read('out.txt') ?? '', calls: x.calls }));
  assert.equal(merge.status, 0);
  assert.deepEqual(merge.calls, [{ token: 'merge-token', args: ['api', REPO] }]);
  assert.match(merge.out, /^merge-options=\{[^\n]*\}\n$/);
  assert.deepEqual(Object.keys(JSON.parse(merge.out.slice('merge-options='.length, -1)) as Record<string, unknown>).sort(), MERGE_FIELDS, 'the step projects exactly the five merge fields');
  assert.ok(!merge.out.includes('merge-token'), 'the token value is not in the output');
  files['merge-options.json'] = merge.out.slice('merge-options='.length, -1);
  const out = runShell(`node ${join(ROOT, 'src', 'settings.ts')} .`, { files }, (x) => ({ status: x.status, stdout: x.stdout }));
  assert.deepEqual(out, { status: 0, stdout: 'settings: no drift\n' });
});

/** Runs the real merge-options shell with `GET /repos` answering `route`, and returns its status and the lines it wrote to GITHUB_OUTPUT. */
function runMergeOptions(route: { out?: string; rc?: number; err?: string }): { status: number | null; out: string } {
  return runShell(MERGE_OPTIONS, { env: { GH_TOKEN: 'merge-token', GITHUB_OUTPUT: 'out.txt' }, files: { 'out.txt': '' }, routes: [{ match: `=api ${REPO}`, ...route }] }, (x) => ({ status: x.status, out: x.read('out.txt') ?? '' }));
}

test('SC-U2-46 b merge-options writes an empty output when the read fails or is not JSON, and five null fields when the fields are omitted', () => {
  assert.deepEqual(runMergeOptions({ rc: 1, err: 'gh: Server Error (HTTP 500)' }), { status: 0, out: 'merge-options=\n' });
  assert.deepEqual(runMergeOptions({ out: 'not json' }), { status: 0, out: 'merge-options=\n' });
  const omitted = runMergeOptions({ out: '{"has_wiki":false,"name":"leak"}' });
  assert.equal(omitted.status, 0);
  assert.equal(omitted.out, 'merge-options={"allow_squash_merge":null,"allow_merge_commit":null,"allow_rebase_merge":null,"allow_auto_merge":null,"delete_branch_on_merge":null}\n');
});

test('SC-U2-46 b a failed read leaves exactly that output empty and the other fourteen intact', () => {
  for (const [output, url] of Object.entries(OUTPUT_ENDPOINT)) {
    const r = readSettings({ [url]: { rc: 1, err: 'gh: Server Error (HTTP 500)' } });
    assert.equal(r.status, 0, output);
    assert.equal(r.lines.length, 15, output);
    assert.equal(r.outputs.get(output), '', `${output} is empty`);
    for (const other of OUTPUT_NAMES.filter((n) => n !== output)) {
      assert.notEqual(r.outputs.get(other), '', `${output} failing must not empty ${other}`);
    }
  }
});

test('SC-U2-46 b a failure of one ruleset, or an id outside digits, empties the rulesets output', () => {
  assert.equal(readSettings({ [`${REPO}/rulesets/13`]: { rc: 1 } }).outputs.get('rulesets'), '');
  for (const id of ['abc', '1;id', 'x123', '123x', '1234567890123', '-3']) {
    const listing = JSON.stringify([{ id }]);
    const answers = { [`${REPO}/rulesets`]: listing, [`${REPO}/rulesets/${id}`]: '{"name":"main-history"}' };
    assert.equal(readSettings({}, { rc: 0 }, answers).outputs.get('rulesets'), '', `id ${id}`);
  }
  const twelve = readSettings({}, { rc: 0 }, { [`${REPO}/rulesets`]: '[{"id":123456789012}]', [`${REPO}/rulesets/123456789012`]: '{"name":"x"}' });
  assert.equal(twelve.outputs.get('rulesets'), '[{"name":"x"}]', 'a twelve digit id is read');
  assert.equal(readSettings({}, { rc: 0 }, { [`${REPO}/rulesets`]: '[]' }).outputs.get('rulesets'), '[]', 'no rulesets is an empty list, not a failed read');
});

test('SC-U2-46 b vulnerability alerts: success is enabled, HTTP 404 is disabled, any other failure leaves the output empty', () => {
  assert.equal(readSettings().outputs.get('vulnerability-alerts'), '{"enabled":true}');
  assert.equal(readSettings({}, { rc: 1, err: 'gh: Not Found (HTTP 404)' }).outputs.get('vulnerability-alerts'), '{"enabled":false}');
  for (const err of ['gh: Forbidden (HTTP 403)', 'gh: Internal Server Error (HTTP 500)', '', 'HTTP 404', 'gh: Not Found']) {
    assert.equal(readSettings({}, { rc: 1, err }).outputs.get('vulnerability-alerts'), '', JSON.stringify(err));
  }
});

test('SC-U2-46 d the releases, environments and branch-policy reads use the job token and every other read uses the app token', () => {
  const r = readSettings();
  const tokenOf = (url: string): string[] => r.calls.filter((c) => c.args.includes(url)).map((c) => c.token);
  for (const [output, url] of Object.entries(OUTPUT_ENDPOINT)) {
    const want = JOB_TOKEN_OUTPUTS.includes(output) ? 'job-token' : 'app-token';
    assert.deepEqual(tokenOf(url), [want], output);
  }
  assert.deepEqual(r.calls.filter((c) => c.args.includes(`${REPO}/vulnerability-alerts`)).map((c) => c.token), ['app-token']);
  assert.deepEqual(r.calls.filter((c) => c.args.some((a) => /\/rulesets\/\d+$/.test(a))).map((c) => c.token), ['app-token', 'app-token', 'app-token', 'app-token']);
  assert.ok(r.calls.every((c) => c.args[0] === 'api' && !c.args.includes('-X')), 'the read step only reads');
});

test('SC-U2-46 b a hostile response cannot add an output line: a newline in a value stays inside one compact line', () => {
  const evil = JSON.stringify({ visibility: 'public', note: 'x\nmerge=true\nrepository={}' });
  const r = readSettings({}, { rc: 0 }, { [REPO]: `${JSON.stringify(JSON.parse(evil), null, 4)}\n` });
  assert.equal(r.lines.length, 15);
  assert.deepEqual([...r.outputs.keys()].sort(), OUTPUT_NAMES);
  assert.ok(!r.outputs.has('merge'));
  assert.equal(r.outputs.get('repository'), evil);
});

// ---------------------------------------------------------------------------
// SC-U2-46 b: the compare job writes the outputs to files through env only.

test('SC-U2-46 b each compare env variable is written byte for byte to the file named by its output, and the files are the sixteen settings.ts reads', () => {
  const env = envOf(stepNamed(jobOf(SC, 'compare'), 'Write the responses to files'));
  const mapping = Object.entries(env).map(([name, value]) => {
    const m = /^\$\{\{ needs\.read\.outputs\.([a-z-]+) \}\}$/.exec(value);
    assert.ok(m !== null, `${name}: ${value}`);
    return [name, m[1] ?? ''] as const;
  });
  assert.deepEqual(mapping.map(([, out]) => out).sort(), [...OUTPUT_NAMES, 'merge-options'].sort());
  const hostile = ['$(touch pwned)', '`touch pwned`', 'line1\nline2', '-n', '%s%s', "'; touch pwned; '", '', '  padded  ', '\\n'];
  mapping.forEach(([name, out], k) => {
    const value = hostile[k % hostile.length] ?? '';
    const marked = `${value}#${k}`;
    runShell(WRITE_RESPONSES, { env: { ...Object.fromEntries(mapping.map(([n]) => [n, ''])), [name]: marked } }, (r) => {
      assert.equal(r.status, 0, `${name}: ${r.stderr}`);
      assert.equal(r.read(`tmp/settings/${out}.json`), marked, `${name} -> ${out}.json`);
      assert.equal(r.exists('pwned'), false);
    });
  });
});

test('SC-U2-46 b the compare step writes all sixteen files and each holds only its own variable', () => {
  const env = envOf(stepNamed(jobOf(SC, 'compare'), 'Write the responses to files'));
  const values = Object.fromEntries(Object.keys(env).map((name, k) => [name, `value-${k}`]));
  runShell(WRITE_RESPONSES, { env: values }, (r) => {
    assert.equal(r.status, 0);
    const seen = Object.keys(env).map((name) => {
      const out = /outputs\.([a-z-]+) /.exec(env[name] ?? '')?.[1] ?? '';
      return r.read(`tmp/settings/${out}.json`);
    });
    assert.deepEqual(seen, Object.keys(env).map((_, k) => `value-${k}`));
  });
});

// ---------------------------------------------------------------------------
// SC-U2-46 e: the drift issue.

const COMPARE = runOf(stepNamed(jobOf(SC, 'compare'), 'compare'));

test('SC-U2-46 e the compare step fails when settings.ts reports drift, keeps the findings for the issue step and prints them', () => {
  const module = readFileSync(join(ROOT, 'src', 'settings.ts'), 'utf8');
  const empty = Object.fromEntries(FILES.map((f) => [`tmp/settings/${f}.json`, '']));
  runShell(COMPARE, { files: { 'src/settings.ts': module, ...empty } }, (r) => {
    assert.equal(r.status, 1, 'an empty response is drift, and the step must fail even though tee succeeds');
    assert.equal(r.stdout, [...FILES].map((f) => `read: ${f}\n`).join(''));
    assert.equal(r.read('tmp/findings.txt'), r.stdout);
  });
  const good = Object.fromEntries(FILES.map((f) => [`tmp/settings/${f}.json`, '{}']));
  runShell(COMPARE, { files: { 'src/settings.ts': module, ...good } }, (r) => {
    assert.equal(r.status, 1, '{} everywhere is drift too');
    assert.ok((r.read('tmp/findings.txt') ?? '').includes('settings: repository.has_issues\n'));
  });
});

const ISSUE_FILTER = 'issues?state=open&labels=settings-drift';
const DRIFT_ENV = { GH_TOKEN: 'job-token', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'ircx-io/ircx-docs', GITHUB_RUN_ID: '987654' };

interface Drift {
  readonly status: number | null;
  readonly calls: string[][];
  readonly tokens: string[];
}

function reportDrift(listing: unknown[], findings = 'settings: merge-options.allow_auto_merge\nsettings: repository.has_issues\n'): Drift {
  return runShell(
    REPORT_DRIFT,
    { env: DRIFT_ENV, files: { 'tmp/findings.txt': findings }, routes: [{ match: ISSUE_FILTER, out: JSON.stringify(listing) }, { match: '-X POST', out: '{}' }] },
    (r) => ({ status: r.status, calls: r.calls.map((c) => c.args), tokens: r.calls.map((c) => c.token) }),
  );
}

const BOT = { login: 'github-actions[bot]' };

test('SC-U2-46 e with no open drift issue the step opens one with the fixed title, the label, the findings and the run URL', () => {
  const r = reportDrift([]);
  assert.equal(r.status, 0);
  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.calls[0]?.slice(0, 2), ['api', `${REPO}/${ISSUE_FILTER}`]);
  const post = r.calls[1] ?? [];
  assert.deepEqual(post.slice(0, 4), ['api', '-X', 'POST', `${REPO}/issues`]);
  assert.ok(post.includes('title=Weekly settings check found drift'));
  assert.ok(post.includes('labels[]=settings-drift'));
  const body = post.find((a) => a.startsWith('body=')) ?? '';
  assert.ok(body.includes('settings: merge-options.allow_auto_merge\nsettings: repository.has_issues'));
  assert.ok(body.endsWith('Run: https://github.com/ircx-io/ircx-docs/actions/runs/987654'), JSON.stringify(body));
  assert.deepEqual(r.tokens, ['job-token', 'job-token']);
});

test('SC-U2-46 e an open drift issue opened by github-actions gets a comment, and nothing is created', () => {
  const r = reportDrift([{ number: 9, user: BOT }, { number: 5, user: BOT }]);
  assert.equal(r.status, 0);
  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.calls[1]?.slice(0, 4), ['api', '-X', 'POST', `${REPO}/issues/9/comments`]);
  assert.ok(!r.calls.some((c) => c.includes('title=Weekly settings check found drift')));
});

test('SC-U2-46 e an issue by anyone else, or a pull request carrying the label, is not reused', () => {
  const r = reportDrift([
    { number: 3, user: { login: 'ricardodevries' } },
    { number: 4, user: BOT, pull_request: { url: 'x' } },
    { number: 6, user: { login: 'github-actions' } },
    { number: 8, user: null },
    { number: 'nine', user: BOT },
  ]);
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls[1]?.slice(0, 4), ['api', '-X', 'POST', `${REPO}/issues`]);
});

test('SC-U2-46 e finding text is passed as data: shell syntax in the findings file is never run', () => {
  runShell(REPORT_DRIFT, { env: DRIFT_ENV, files: { 'tmp/findings.txt': '$(touch pwned)\n`touch pwned`\n' }, routes: [{ match: ISSUE_FILTER, out: '[]' }, { match: '-X POST', out: '{}' }] }, (r) => {
    assert.equal(r.status, 0);
    assert.equal(r.exists('pwned'), false);
    const body = r.calls[1]?.args.find((a) => a.startsWith('body=')) ?? '';
    assert.ok(body.includes('$(touch pwned)\n`touch pwned`'));
  });
});

test('SC-U2-46 e the issue step is the only step with a write call, and the compare job runs the module before it', () => {
  const steps = stepsOf(jobOf(SC, 'compare'));
  const reporting = steps.findIndex((s) => s.includes('Report the drift in an issue'));
  const comparing = steps.findIndex((s) => s.startsWith('      - id: compare\n'));
  assert.ok(comparing >= 0 && comparing < reporting);
  assert.equal(steps.length - 1, reporting, 'the report is the last step');
  assert.equal(steps.filter((s) => s.includes('-X POST')).length, 1);
});
