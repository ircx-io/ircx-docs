// Boundary and adversarial cases for the three pieces of automation logic:
// src/dependabot.ts (SC-U2-43 c), src/settings.ts (SC-U2-46 c, SC-U2-3 b) and
// the label step of labels.yml (SC-U2-44). Each row names the clause it guards.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decide, MERGEABLE_PATHS, MERGEABLE_UPDATE_TYPES, outputLines } from '../src/dependabot.ts';
import { compareSettings, FILES } from '../src/settings.ts';
import { ROOT } from './helpers.ts';
import { jobOf, runOf, runShell, stepNamed, workflow } from './step-harness.ts';

type Json = Record<string, any>;

const HEAD = 'a'.repeat(40);

function message(...types: string[]): string {
  return `Bump dep from 1.2.2 to 1.2.3\n\n---\nupdated-dependencies:\n${types.map((t, i) => `- dependency-name: dep${i}\n  update-type: ${t}\n`).join('')}...\n`;
}

function goodCommit(types: string[] = ['version-update:semver-patch']): Json {
  return { author: { login: 'dependabot[bot]' }, committer: { login: 'web-flow' }, parents: [{ sha: 'b'.repeat(40) }], commit: { message: message(...types), verification: { verified: true } } };
}

function inputs(): { event: Json; pr: Json; commits: Json[]; files: Json[] } {
  return {
    event: { workflow_run: { head_sha: HEAD, pull_requests: [{ number: 7 }] } },
    pr: { number: 7, state: 'open', user: { login: 'dependabot[bot]' }, base: { ref: 'main' }, head: { ref: 'dependabot/npm_and_yarn/dep-1.2.3', sha: HEAD, repo: { full_name: 'ircx-io/ircx-docs' } } },
    commits: [goodCommit()],
    files: [{ filename: 'package.json' }, { filename: 'package-lock.json' }],
  };
}

function run(mutate: (i: ReturnType<typeof inputs>) => void = () => {}): ReturnType<typeof decide> {
  const i = inputs();
  mutate(i);
  return decide(i.event, i.pr, i.commits, i.files);
}

function refused(name: string, mutate: (i: ReturnType<typeof inputs>) => void): void {
  const d = run(mutate);
  assert.equal(d.merge, false, name);
  assert.deepEqual(outputLines(d), ['merge=false', 'number=', 'sha=', 'workflows=false'], name);
}

test('SC-U2-43 c10 the mergeable paths and update types are exactly the ruled lists', () => {
  assert.deepEqual([...MERGEABLE_PATHS], ['package.json', 'package-lock.json', '.github/workflows/ci.yml', '.github/workflows/cut-release.yml', '.github/workflows/dependabot-merge.yml', '.github/workflows/labels.yml', '.github/workflows/settings-check.yml']);
  assert.deepEqual([...MERGEABLE_UPDATE_TYPES], ['version-update:semver-patch', 'version-update:semver-minor']);
});

test('SC-U2-43 c10 c11 each of the seven exact paths merges alone, and workflows is true for the five workflow files only', () => {
  for (const path of MERGEABLE_PATHS) {
    const d = run((i) => (i.files = [{ filename: path }]));
    assert.equal(d.merge, true, path);
    assert.equal(d.workflows, path.startsWith('.github/workflows/'), path);
  }
});

test('SC-U2-43 c10 a path that is not exactly one of the seven is refused, wherever it sits in the list', () => {
  const near = ['.github/workflows/ci.yaml', '.github/workflows/CI.yml', '.github/workflows/ci.yml/', '.github/workflows/ci.yml ', '.github/workflows/sub/ci.yml', '.github/workflows/', '.github/workflows', './package.json', 'Package.json', 'package.json.bak', 'package-lock.json ', 'sub/package.json', 'src/../package.json', 'tsconfig.json', '.npmrc', 'content/index.md', 'package.json\n.github/workflows/ci.yml'];
  for (const bad of near) {
    refused(`alone ${bad}`, (i) => (i.files = [{ filename: bad }]));
    refused(`first ${bad}`, (i) => (i.files = [{ filename: bad }, { filename: 'package.json' }, { filename: 'package-lock.json' }]));
    refused(`middle ${bad}`, (i) => (i.files = [{ filename: 'package.json' }, { filename: bad }, { filename: 'package-lock.json' }]));
    refused(`last ${bad}`, (i) => (i.files = [{ filename: 'package.json' }, { filename: bad }]));
  }
});

test('SC-U2-43 c10 a file entry without a string filename, and a file list that is not a list, are refused', () => {
  for (const entry of [{}, { filename: null }, { filename: 7 }, { filename: ['package.json'] }, null, 'package.json', [], { name: 'package.json' }]) {
    refused(JSON.stringify(entry), (i) => (i.files = [{ filename: 'package.json' }, entry as Json]));
  }
  for (const files of [null, {}, 'package.json', 7, undefined, []]) {
    refused(JSON.stringify(files), (i) => (i.files = files as never));
  }
});

test('SC-U2-43 c11 workflows is true when any one changed path is a workflow, in any position', () => {
  const ci = { filename: '.github/workflows/ci.yml' };
  for (const files of [[ci, { filename: 'package.json' }], [{ filename: 'package.json' }, ci], [{ filename: 'package.json' }, ci, { filename: 'package-lock.json' }]]) {
    const d = run((i) => (i.files = files));
    assert.equal(d.merge, true);
    assert.equal(d.workflows, true);
    assert.deepEqual(outputLines(d).at(-1), 'workflows=true');
  }
  assert.equal(run().workflows, false);
});

test('SC-U2-43 c8 every commit is checked, not only the first', () => {
  const bad: Array<[string, (c: Json) => void]> = [
    ['author', (c) => (c.author.login = 'someone')],
    ['author missing', (c) => delete c.author],
    ['committer', (c) => (c.committer.login = 'ricardodevries')],
    ['committer with a trailing space', (c) => (c.committer.login = 'web-flow ')],
    ['committer missing', (c) => (c.committer = null)],
    ['unverified', (c) => (c.commit.verification.verified = false)],
    ['verified as a string', (c) => (c.commit.verification.verified = 'true')],
    ['verification missing', (c) => delete c.commit.verification],
    ['two parents', (c) => (c.parents = [{}, {}])],
    ['no parents', (c) => (c.parents = [])],
    ['parents not a list', (c) => (c.parents = { length: 1 })],
    ['no message', (c) => delete c.commit.message],
  ];
  for (const [name, mutate] of bad) {
    refused(`only commit: ${name}`, (i) => mutate(i.commits[0] ?? {}));
    refused(`second commit: ${name}`, (i) => {
      const second = goodCommit();
      mutate(second);
      i.commits.push(second);
    });
    refused(`middle commit: ${name}`, (i) => {
      const second = goodCommit();
      mutate(second);
      i.commits.push(second, goodCommit());
    });
  }
  const many = run((i) => i.commits.push(goodCommit(), goodCommit()));
  assert.equal(many.merge, true, 'three clean commits merge');
});

test('SC-U2-43 c9 the update types of every commit count, a major in a later commit refuses, and a line must hold exactly one allowed type', () => {
  refused('major in the second commit', (i) => i.commits.push(goodCommit(['version-update:semver-major'])));
  refused('major in the first of two', (i) => {
    i.commits[0] = goodCommit(['version-update:semver-major']);
    i.commits.push(goodCommit());
  });
  refused('the second commit has no type line and the first is a major', (i) => {
    i.commits[0] = goodCommit(['version-update:semver-major']);
    i.commits.push({ ...goodCommit(), commit: { message: 'Bump other\n', verification: { verified: true } } });
  });
  const ok = run((i) => i.commits.push({ ...goodCommit(), commit: { message: 'Merge note without a type\n', verification: { verified: true } } }));
  assert.equal(ok.merge, true, 'one type line anywhere is enough when every line is allowed');
  for (const t of ['version-update:semver-major', 'version-update:semver-patch extra', 'version-update:semver-patchx', 'VERSION-UPDATE:SEMVER-PATCH', 'semver-patch', '', 'version-update:semver-patch,version-update:semver-major', 'version-update:semver-minor;version-update:semver-major']) {
    refused(`type ${JSON.stringify(t)}`, (i) => (i.commits[0] = { ...goodCommit(), commit: { message: `x\n  update-type: ${t}\n`, verification: { verified: true } } }));
  }
  refused('a major beside a patch in one message', (i) => (i.commits[0] = goodCommit(['version-update:semver-patch', 'version-update:semver-major', 'version-update:semver-patch'])));
  const crlf = run((i) => (i.commits[0] = { ...goodCommit(), commit: { message: 'x\r\n  update-type: version-update:semver-patch\r\n', verification: { verified: true } } }));
  assert.equal(crlf.merge, true, 'CRLF line ends');
  refused('CRLF major', (i) => (i.commits[0] = { ...goodCommit(), commit: { message: 'x\r\n  update-type: version-update:semver-major\r\n', verification: { verified: true } } }));
  refused('type only mid-line', (i) => (i.commits[0] = { ...goodCommit(), commit: { message: 'see update-type: version-update:semver-patch\n', verification: { verified: true } } }));
});

test('SC-U2-43 c1 to c7 each pull request field must be exactly the ruled value', () => {
  const cases: Array<[string, (i: ReturnType<typeof inputs>) => void]> = [
    ['pull_requests null', (i) => (i.event.workflow_run.pull_requests = null)],
    ['pull_requests an object', (i) => (i.event.workflow_run.pull_requests = { 0: { number: 7 }, length: 1 })],
    ['run names the number as a string', (i) => (i.event.workflow_run.pull_requests = [{ number: '7' }])],
    ['read number as a string', (i) => (i.pr.number = '7')],
    ['number zero in both', (i) => { i.pr.number = 0; i.event.workflow_run.pull_requests = [{ number: 0 }]; }],
    ['negative number in both', (i) => { i.pr.number = -1; i.event.workflow_run.pull_requests = [{ number: -1 }]; }],
    ['fractional number in both', (i) => { i.pr.number = 7.5; i.event.workflow_run.pull_requests = [{ number: 7.5 }]; }],
    ['unsafe integer in both', (i) => { i.pr.number = 2 ** 60; i.event.workflow_run.pull_requests = [{ number: 2 ** 60 }]; }],
    ['state merged', (i) => (i.pr.state = 'merged')],
    ['state OPEN', (i) => (i.pr.state = 'OPEN')],
    ['state missing', (i) => delete i.pr.state],
    ['author Dependabot[bot]', (i) => (i.pr.user.login = 'Dependabot[bot]')],
    ['author dependabot', (i) => (i.pr.user.login = 'dependabot')],
    ['author dependabot[bot] with a space', (i) => (i.pr.user.login = 'dependabot[bot] ')],
    ['user missing', (i) => (i.pr.user = null)],
    ['base main2', (i) => (i.pr.base.ref = 'main2')],
    ['base refs/heads/main', (i) => (i.pr.base.ref = 'refs/heads/main')],
    ['head repository deleted', (i) => (i.pr.head.repo = null)],
    ['head repository IRCX-IO', (i) => (i.pr.head.repo.full_name = 'IRCX-IO/ircx-docs')],
    ['head repository prefix', (i) => (i.pr.head.repo.full_name = ['ircx-io/ircx-docs', 'fork'].join('-'))],
    ['head ref dependabot without slash', (i) => (i.pr.head.ref = 'dependabot')],
    ['head ref Dependabot/x', (i) => (i.pr.head.ref = 'Dependabot/x')],
    ['head ref with a leading space', (i) => (i.pr.head.ref = ' dependabot/x')],
    ['head ref refs/heads/dependabot/x', (i) => (i.pr.head.ref = 'refs/heads/dependabot/x')],
    ['head ref not a string', (i) => (i.pr.head.ref = ['dependabot/x'])],
    ['head sha short in both', (i) => { i.pr.head.sha = 'a'.repeat(39); i.event.workflow_run.head_sha = 'a'.repeat(39); }],
    ['head sha missing in the run', (i) => delete i.event.workflow_run.head_sha],
    ['head sha missing in both', (i) => { delete i.pr.head.sha; delete i.event.workflow_run.head_sha; }],
    ['head sha not a string in both', (i) => { i.pr.head.sha = 7; i.event.workflow_run.head_sha = 7; }],
  ];
  for (const [name, mutate] of cases) {
    refused(name, mutate);
  }
});

test('SC-U2-43 decide never throws on input of the wrong shape, and refuses it', () => {
  const shapes: unknown[] = [undefined, null, 0, 'x', true, [], {}, [[]], { workflow_run: null }, { workflow_run: [] }];
  for (const a of shapes) {
    for (const b of shapes) {
      const d = decide(a, b, b, a);
      assert.equal(d.merge, false);
      assert.deepEqual(outputLines(d), ['merge=false', 'number=', 'sha=', 'workflows=false']);
    }
  }
});

/** Runs src/dependabot.ts with the given argument vector. */
function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [join(ROOT, 'src', 'dependabot.ts'), ...args], { encoding: 'utf8', env: {} });
}

test('SC-U2-43 c the entry point fails closed: wrong argument count, a missing file and invalid JSON all leave the pull request alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-dep-'));
  try {
    const good = inputs();
    const names = ['event', 'pr', 'commits', 'files'].map((n) => join(dir, `${n}.json`));
    [good.event, good.pr, good.commits, good.files].forEach((v, k) => writeFileSync(names[k] ?? '', JSON.stringify(v)));
    const ok = cli(names);
    assert.equal(ok.stdout, `merge=true\nnumber=7\nsha=${HEAD}\nworkflows=false\n`);
    const none = 'merge=false\nnumber=\nsha=\nworkflows=false\n';
    for (const args of [[], names.slice(0, 3), [...names, names[0] ?? '']]) {
      const r = cli(args);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, none, JSON.stringify(args.length));
      assert.match(r.stderr, /usage/);
    }
    for (let k = 0; k < 4; k++) {
      const missing = names.map((n, j) => (j === k ? join(dir, 'absent.json') : n));
      const m = cli(missing);
      assert.equal(m.status, 0, `file ${k} missing`);
      assert.equal(m.stdout, none, `file ${k} missing`);
      writeFileSync(join(dir, 'broken.json'), '{"a":');
      const b = cli(names.map((n, j) => (j === k ? join(dir, 'broken.json') : n)));
      assert.equal(b.stdout, none, `file ${k} invalid`);
      writeFileSync(join(dir, 'empty.json'), '');
      const e = cli(names.map((n, j) => (j === k ? join(dir, 'empty.json') : n)));
      assert.equal(e.stdout, none, `file ${k} empty`);
    }
    assert.ok(!ok.stderr.includes('Error'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SC-U2-46 c and SC-U2-3 b: settings.ts.

const APP = { actor_id: 5512599, actor_type: 'Integration', bypass_mode: 'always' };

function ruleset(name: string, target: string, include: string, rules: Json[], bypass: Json[]): Json {
  return { id: 1, name, target, enforcement: 'active', conditions: { ref_name: { include: [include], exclude: [] } }, rules, bypass_actors: bypass };
}

function clean(): Record<string, any> {
  return {
    repository: { allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false, allow_auto_merge: false, delete_branch_on_merge: true, has_wiki: false, has_projects: false, has_issues: true, visibility: 'public', security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } } },
    'actions-permissions': { enabled: true, allowed_actions: 'selected', sha_pinning_required: true },
    'selected-actions': { github_owned_allowed: false, verified_allowed: false, patterns_allowed: ['actions/checkout@*', 'actions/create-github-app-token@*', 'actions/setup-node@*'] },
    'workflow-permissions': { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false },
    'fork-pr-approval': { approval_policy: 'all_external_contributors' },
    'vulnerability-alerts': { enabled: true },
    'private-vulnerability-reporting': { enabled: true },
    rulesets: [
      ruleset('main-history', 'branch', '~DEFAULT_BRANCH', [{ type: 'deletion' }, { type: 'non_fast_forward' }], []),
      ruleset('main-checks', 'branch', '~DEFAULT_BRANCH', [{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: 'docs' }] } }], [{ ...APP }]),
      ruleset('tags-create', 'tag', '~ALL', [{ type: 'creation' }], [{ ...APP }]),
      ruleset('tags-locked', 'tag', '~ALL', [{ type: 'update' }, { type: 'deletion' }], []),
    ],
    'actions-secrets': { total_count: 0 },
    'dependabot-secrets': { total_count: 0 },
    'environment-secrets': { total_count: 1, secrets: [{ name: 'IRCX_BOT_PRIVATE_KEY' }] },
    'environment-variables': { total_count: 0 },
    environments: [{ total_count: 1, environments: [{ name: 'ircx-bot', deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }, protection_rules: [{ type: 'branch_policy' }] }] }],
    'branch-policies': [{ total_count: 1, branch_policies: [{ name: 'main', type: 'branch' }] }],
    releases: [[{ author: { login: 'ircx-io-bot[bot]' }, assets: [], draft: false }]],
  };
}

function drift(mutate: (r: Record<string, any>) => void): string[] {
  const r = clean();
  mutate(r);
  return compareSettings(r).map((f) => `${f.rule}: ${f.path}`);
}

const byName = (r: Record<string, any>, name: string): Json => (r.rulesets as Json[]).find((x) => x.name === name) as Json;

test('SC-U2-3 b the clean fixture is clean, and the fifteen files are the ones the read job writes', () => {
  assert.deepEqual(drift(() => {}), []);
  assert.deepEqual([...FILES].sort(), ['actions-permissions', 'actions-secrets', 'branch-policies', 'dependabot-secrets', 'environment-secrets', 'environment-variables', 'environments', 'fork-pr-approval', 'private-vulnerability-reporting', 'releases', 'repository', 'rulesets', 'selected-actions', 'vulnerability-alerts', 'workflow-permissions']);
});

test('SC-U2-3 b the app bypass entry must match on actor type, id and mode, and be the only entry', () => {
  const at = 'rulesets: rulesets.main-checks.bypass_actors';
  for (const [name, entry] of [
    ['actor type Team', { ...APP, actor_type: 'Team' }],
    ['actor type OrganizationAdmin', { ...APP, actor_type: 'OrganizationAdmin' }],
    ['actor id as a string', { ...APP, actor_id: '5512599' }],
    ['actor id off by one', { ...APP, actor_id: 5512598 }],
    ['mode exempt', { ...APP, bypass_mode: 'exempt' }],
    ['mode pull_request', { ...APP, bypass_mode: 'pull_request' }],
    ['mode missing', { actor_id: APP.actor_id, actor_type: APP.actor_type }],
  ] as const) {
    assert.ok(drift((r) => (byName(r, 'main-checks').bypass_actors = [entry])).includes(at), name);
    assert.ok(drift((r) => (byName(r, 'tags-create').bypass_actors = [entry])).includes('rulesets: rulesets.tags-create.bypass_actors'), `tags-create ${name}`);
  }
  assert.ok(drift((r) => (byName(r, 'main-checks').bypass_actors = [])).includes(at), 'empty');
  assert.ok(drift((r) => (byName(r, 'main-checks').bypass_actors = [{ ...APP }, { ...APP }])).includes(at), 'twice');
  assert.ok(drift((r) => delete byName(r, 'main-checks').bypass_actors).includes(at), 'absent');
  assert.ok(drift((r) => (byName(r, 'main-checks').bypass_actors = null)).includes(at), 'null');
  for (const name of ['main-history', 'tags-locked']) {
    assert.ok(drift((r) => delete byName(r, name).bypass_actors).includes(`rulesets: rulesets.${name}.bypass_actors`), `${name} absent`);
    assert.ok(drift((r) => (byName(r, name).bypass_actors = [{ ...APP }])).includes(`rulesets: rulesets.${name}.bypass_actors`), `${name} with the app`);
    assert.ok(drift((r) => (byName(r, name).bypass_actors = [{ actor_id: 1, actor_type: 'RepositoryRole', bypass_mode: 'always' }])).includes(`rulesets: rulesets.${name}.bypass_actors`), `${name} with a role`);
  }
  for (const name of ['main-history', 'main-checks', 'tags-create', 'tags-locked']) {
    const other = byName(clean(), name).target === 'tag' ? 'branch' : 'tag';
    assert.ok(drift((r) => (byName(r, name).target = other)).includes(`rulesets: rulesets.${name}.target`), `${name} target`);
  }
});

test('SC-U2-3 b a ruleset name that appears twice, or not at all, is a finding by name', () => {
  assert.ok(drift((r) => r.rulesets.push(ruleset('main-history', 'branch', '~DEFAULT_BRANCH', [], []))).includes('rulesets: rulesets.main-history'));
  assert.ok(drift((r) => (byName(r, 'main-checks').name = 'main-checks-2')).includes('rulesets: rulesets.main-checks'));
  assert.ok(drift((r) => (r.rulesets = {})).includes('rulesets: rulesets'));
  assert.ok(drift((r) => r.rulesets.push(ruleset('extra', 'branch', '~ALL', [], []))).includes('rulesets: rulesets.count'));
  assert.ok(drift((r) => (r.rulesets = [])).includes('rulesets: rulesets.main-history'));
});

test('SC-U2-3 b the status check ruleset names the docs context, no strict policy, one check, and an active enforcement', () => {
  const at = 'rulesets: rulesets.main-checks.rules.required_status_checks';
  const params = (r: Record<string, any>): Json => byName(r, 'main-checks').rules[0].parameters;
  assert.ok(drift((r) => (params(r).required_status_checks = [{ context: 'docs' }, { context: 'extra' }])).includes(at));
  assert.ok(drift((r) => (params(r).required_status_checks = [])).includes(at));
  assert.ok(drift((r) => (params(r).required_status_checks = [{ context: 'Docs' }])).includes(at));
  assert.ok(drift((r) => (params(r).required_status_checks = null)).includes(at));
  assert.ok(drift((r) => delete params(r).strict_required_status_checks_policy).includes(at));
  assert.ok(drift((r) => (params(r).strict_required_status_checks_policy = 'false')).includes(at));
  assert.ok(drift((r) => delete byName(r, 'main-checks').rules[0].parameters).includes(at));
  for (const name of ['main-history', 'main-checks', 'tags-create', 'tags-locked']) {
    for (const enforcement of ['disabled', 'evaluate', 'Active', undefined]) {
      assert.ok(drift((r) => (byName(r, name).enforcement = enforcement)).includes(`rulesets: rulesets.${name}.enforcement`), `${name} ${String(enforcement)}`);
    }
  }
});

test('SC-U2-3 b conditions and rules: an extra include, a populated exclude, a duplicate rule and a rule of the wrong type are each findings', () => {
  for (const name of ['main-history', 'main-checks', 'tags-create', 'tags-locked']) {
    const cond = `rulesets: rulesets.${name}.conditions`;
    const rules = `rulesets: rulesets.${name}.rules`;
    assert.ok(drift((r) => byName(r, name).conditions.ref_name.include.push('refs/heads/x')).includes(cond), `${name} extra include`);
    assert.ok(drift((r) => (byName(r, name).conditions.ref_name.include = [])).includes(cond), `${name} empty include`);
    assert.ok(drift((r) => (byName(r, name).conditions.ref_name.exclude = ['refs/heads/x'])).includes(cond), `${name} exclude`);
    assert.ok(drift((r) => delete byName(r, name).conditions).includes(cond), `${name} no conditions`);
    assert.ok(drift((r) => byName(r, name).rules.push({ type: 'deletion' })).includes(rules), `${name} extra rule`);
    assert.ok(drift((r) => (byName(r, name).rules = [])).includes(rules), `${name} no rules`);
    assert.ok(drift((r) => (byName(r, name).rules = null)).includes(rules), `${name} null rules`);
  }
  assert.ok(drift((r) => (byName(r, 'main-history').rules = [{ type: 'deletion' }, { type: 'deletion' }])).includes('rulesets: rulesets.main-history.rules'));
  assert.ok(drift((r) => (byName(r, 'tags-locked').rules = [{ type: 'update' }, { type: 'non_fast_forward' }])).includes('rulesets: rulesets.tags-locked.rules'));
});

test('SC-U2-46 c releases, environments and branch policies: absent keys, nulls and a second entry are each findings', () => {
  assert.ok(drift((r) => (r.releases[0][0].author = null)).includes('releases: releases.author'));
  assert.ok(drift((r) => delete r.releases[0][0].assets).includes('releases: releases.assets'));
  assert.ok(drift((r) => delete r.releases[0][0].draft).includes('releases: releases.draft'));
  assert.ok(drift((r) => r.releases[0].push({ author: { login: 'ricardodevries' }, assets: [], draft: false })).includes('releases: releases.author'));
  assert.ok(drift((r) => r.releases.push([{ author: { login: 'ircx-io-bot[bot]' }, assets: [{}], draft: false }])).includes('releases: releases.assets'));
  assert.ok(drift((r) => (r.releases = {})).includes('releases: releases'));
  assert.ok(drift((r) => (r.releases = [{}])).includes('releases: releases'));
  assert.deepEqual(drift((r) => (r.releases = [[]])), [], 'no release yet is clean');
  assert.deepEqual(drift((r) => (r.releases = [])), [], 'an empty page list is clean');
  assert.ok(drift((r) => (r.environments = [{ total_count: 0, environments: [] }])).includes('environment: environments.names'));
  assert.ok(drift((r) => (r.environments[0].environments[0].name = 'ircx-bot ')).includes('environment: environments.names'));
  assert.ok(drift((r) => (r.environments[0].environments[0].deployment_branch_policy = null)).includes('environment: environments.ircx-bot.deployment_branch_policy'));
  assert.ok(drift((r) => (r.environments[0].environments[0].deployment_branch_policy.protected_branches = true)).includes('environment: environments.ircx-bot.deployment_branch_policy'));
  assert.ok(drift((r) => r['branch-policies'][0].branch_policies.push({ name: 'dev', type: 'branch' })).includes('environment: branch-policies'));
  assert.ok(drift((r) => (r['branch-policies'][0].branch_policies[0].name = '*')).includes('environment: branch-policies'));
  assert.ok(drift((r) => (r['branch-policies'][0].branch_policies[0].type = 'tag')).includes('environment: branch-policies'));
  assert.ok(drift((r) => (r.environments[0].environments[0].deployment_branch_policy.custom_branch_policies = false)).includes('environment: environments.ircx-bot.deployment_branch_policy'));
  assert.ok(drift((r) => delete r.environments[0].environments[0].protection_rules).includes('environment: environments.ircx-bot.protection_rules'));
  assert.ok(drift((r) => (r.environments[0].environments[0].protection_rules = [])).includes('environment: environments.ircx-bot.protection_rules'));
  assert.ok(drift((r) => r.environments.push({ total_count: 1, environments: [{ name: 'staging' }] })).includes('environment: environments.names'), 'a second page');
  assert.ok(drift((r) => (r['branch-policies'] = [{ total_count: 0, branch_policies: [] }])).includes('environment: branch-policies'));
  assert.ok(drift((r) => delete r['branch-policies'][0].branch_policies).includes('environment: branch-policies'));
  assert.ok(drift((r) => (r['environment-secrets'].total_count = 2)).includes('environment: environment-secrets.secrets'));
  assert.ok(drift((r) => (r['environment-secrets'].secrets = [{ name: 'OTHER' }])).includes('environment: environment-secrets.secrets'));
  assert.ok(drift((r) => (r['environment-secrets'] = { total_count: 0, secrets: [] })).includes('environment: environment-secrets.secrets'));
});

test('SC-U2-46 c patterns, counts and flags are compared strictly', () => {
  assert.ok(drift((r) => (r['selected-actions'].patterns_allowed = ['actions/checkout@*', 'actions/create-github-app-token@*', 'actions/setup-node@*', 'actions/setup-node@*'])).includes('settings: selected-actions.patterns_allowed'));
  assert.ok(drift((r) => (r['selected-actions'].patterns_allowed = ['actions/checkout@*', 'actions/create-github-app-token@*', 'actions/checkout@*'])).includes('settings: selected-actions.patterns_allowed'));
  assert.ok(drift((r) => (r['selected-actions'].patterns_allowed = ['actions/*', 'actions/create-github-app-token@*', 'actions/setup-node@*'])).includes('settings: selected-actions.patterns_allowed'));
  assert.ok(drift((r) => delete r['selected-actions'].patterns_allowed).includes('settings: selected-actions.patterns_allowed'));
  assert.ok(drift((r) => (r['selected-actions'].github_owned_allowed = true)).includes('settings: selected-actions.github_owned_allowed'));
  assert.ok(drift((r) => (r['selected-actions'].verified_allowed = true)).includes('settings: selected-actions.verified_allowed'));
  assert.ok(drift((r) => (r['actions-permissions'].allowed_actions = 'all')).includes('settings: actions-permissions.allowed_actions'));
  assert.ok(drift((r) => (r['actions-permissions'].enabled = false)).includes('settings: actions-permissions.enabled'));
  assert.ok(drift((r) => (r['actions-secrets'].total_count = '0')).includes('settings: actions-secrets.total_count'));
  assert.ok(drift((r) => (r['environment-variables'].total_count = 1)).includes('settings: environment-variables.total_count'));
  assert.ok(drift((r) => (r['private-vulnerability-reporting'].enabled = false)).includes('settings: private-vulnerability-reporting.enabled'));
  assert.ok(drift((r) => (r.repository.visibility = 'private')).includes('settings: repository.visibility'));
  for (const key of ['allow_merge_commit', 'allow_rebase_merge', 'has_wiki', 'has_projects']) {
    assert.ok(drift((r) => (r.repository[key] = true)).includes(`settings: repository.${key}`), key);
  }
  for (const key of ['allow_squash_merge', 'delete_branch_on_merge', 'has_issues']) {
    assert.ok(drift((r) => (r.repository[key] = false)).includes(`settings: repository.${key}`), key);
  }
  assert.ok(drift((r) => (r.repository.security_and_analysis.secret_scanning.status = 'disabled')).includes('settings: repository.security_and_analysis.secret_scanning.status'));
  assert.ok(drift((r) => delete r.repository.security_and_analysis).includes('settings: repository.security_and_analysis.secret_scanning.status'));
});

test('SC-U2-46 c a file of the wrong JSON type is a finding and never a crash', () => {
  const wrong: unknown[] = [null, [], {}, 'x', 0, 1, true, false, [[]], [null], [{}]];
  for (const name of FILES) {
    for (const value of wrong) {
      const r = clean();
      r[name] = value;
      const got = compareSettings(r);
      const clean0 = compareSettings(clean());
      assert.deepEqual(clean0, []);
      const expectEmptyOk = (name === 'releases' && Array.isArray(value) && value.length === 0) || (name === 'releases' && Array.isArray(value) && value.every((p) => Array.isArray(p) && p.length === 0));
      if (!expectEmptyOk) {
        assert.ok(got.length > 0, `${name} = ${JSON.stringify(value)} gave no finding`);
      }
    }
  }
});

test('SC-U2-46 b the entry point on a missing directory prints one read finding per file, exits 1 and prints no stack', () => {
  const dir = join(tmpdir(), 'docs-no-such-directory-1b7e');
  const r = spawnSync(process.execPath, [join(ROOT, 'src', 'settings.ts'), dir], { encoding: 'utf8', env: {} });
  assert.equal(r.status, 1);
  assert.deepEqual(r.stdout.trim().split('\n').sort(), [...FILES].map((f) => `read: ${f}`).sort());
  assert.equal(r.stderr, '');
  const usage = spawnSync(process.execPath, [join(ROOT, 'src', 'settings.ts')], { encoding: 'utf8', env: {} });
  assert.equal(usage.status, 2);
  assert.equal(usage.stdout, '');
  const two = spawnSync(process.execPath, [join(ROOT, 'src', 'settings.ts'), dir, dir], { encoding: 'utf8', env: {} });
  assert.equal(two.status, 2);
});

// ---------------------------------------------------------------------------
// SC-U2-44: the label step, run under bash -e.

const LABEL_RUN = runOf(stepNamed(jobOf(workflow('labels.yml'), 'label'), 'Label the pull request by the paths it changes'));
const SELF = 'ircx-io/ircx-docs';
const REPO = 'repos/ircx-io/ircx-docs';

interface Labelled {
  readonly status: number | null;
  readonly labels: string[];
  readonly calls: string[][];
  readonly pwned: boolean;
}

/** A file entry of the listing: a name, or a rename with the name it had before. */
type Entry = string | { readonly filename: string; readonly previous_filename: string };

function label(files: readonly Entry[], options: { pr?: string; head?: string; changed?: string | { rc: number }; listing?: { rc: number } } = {}): Labelled {
  const changed = options.changed ?? String(files.length);
  const routes = [
    { match: '/pulls/12/files', out: options.listing === undefined ? JSON.stringify(files.map((f) => (typeof f === 'string' ? { filename: f } : { status: 'renamed', ...f }))) : '', rc: options.listing?.rc ?? 0 },
    typeof changed === 'string' ? { match: '=api repos/ircx-io/ircx-docs/pulls/12 --jq .changed_files', out: JSON.stringify({ changed_files: changed }) } : { match: '=api repos/ircx-io/ircx-docs/pulls/12 --jq .changed_files', rc: changed.rc },
    { match: '-X POST', out: '[]' },
  ];
  return runShell(LABEL_RUN, { env: { GH_TOKEN: 'job-token', PR: options.pr ?? '12', HEAD_REPO: options.head ?? SELF }, routes }, (r) => {
    const post = r.calls.find((c) => c.args.includes('POST'));
    return {
      status: r.status,
      labels: post === undefined ? [] : post.args.filter((a) => a.startsWith('labels[]=')).map((a) => a.slice('labels[]='.length)),
      calls: r.calls.map((c) => c.args),
      pwned: r.exists('pwned'),
    };
  });
}

test('SC-U2-44 b the jq classifier labels by exact prefix or exact name, and nothing else', () => {
  const table: Array<[string, string[]]> = [
    ['content/a.md', ['content']],
    ['content/x/y/z.md', ['content']],
    ['content', []],
    ['contents/a.md', []],
    ['Content/a.md', []],
    ['x/content/a.md', []],
    ['.github/workflows/ci.yml', ['review-as-code']],
    ['.github/CODEOWNERS', ['review-as-code']],
    ['.github', []],
    ['.githubx/a', []],
    ['src/scan.ts', ['review-as-code']],
    ['srcx/a.ts', []],
    ['src', []],
    ['test/a.test.ts', ['review-as-code']],
    ['tests/a.ts', []],
    ['package.json', ['review-as-code']],
    ['package-lock.json', ['review-as-code']],
    ['tsconfig.json', ['review-as-code']],
    ['.npmrc', ['review-as-code']],
    ['.nvmrc', ['review-as-code']],
    ['.gitignore', ['review-as-code']],
    ['package.json.bak', []],
    ['Package.json', []],
    ['sub/package.json', []],
    ['.gitignore2', []],
    ['README.md', ['repository-files']],
    ['CONTRIBUTING.md', ['repository-files']],
    ['SECURITY.md', ['repository-files']],
    ['LICENSE', ['repository-files']],
    ['LICENSE-CODE', ['repository-files']],
    ['readme.md', []],
    ['docs/src/a.ts', []],
    ['docs/test/a.ts', []],
    ['docs/.github/workflows/x.yml', []],
    ['docs/README.md', []],
    ['LICENSE.txt', []],
    ['LICENSE-CODE.md', []],
    ['other.txt', []],
    ['', []],
  ];
  for (const [file, want] of table) {
    const r = label([file]);
    assert.equal(r.status, 0, file);
    assert.deepEqual(r.labels, want, JSON.stringify(file));
  }
});

test('SC-U2-44 b a rename is classified by its old name and its new name', () => {
  const rename = (previous_filename: string, filename: string): Entry => ({ filename, previous_filename });
  const table: Array<[Entry[], string[]]> = [
    [[rename('src/check.ts', 'content/x.md')], ['content', 'review-as-code']],
    [[rename('content/x.md', 'src/check.ts')], ['content', 'review-as-code']],
    [[rename('.github/workflows/ci.yml', 'other.txt')], ['review-as-code']],
    [[rename('test/a.test.ts', 'docs/a.ts')], ['review-as-code']],
    [[rename('package.json', 'content/p.md')], ['content', 'review-as-code']],
    [[rename('README.md', 'content/readme.md')], ['content', 'repository-files']],
    [[rename('content/a.md', 'content/b.md')], ['content']],
    [[rename('other.txt', 'notes.txt')], []],
    [[rename('src/a.ts', 'src/b.ts'), 'content/c.md'], ['content', 'review-as-code']],
  ];
  for (const [files, want] of table) {
    const r = label(files);
    assert.equal(r.status, 0, JSON.stringify(files));
    assert.deepEqual(r.labels, want, JSON.stringify(files));
  }
  assert.deepEqual(label([rename('content/a.md', 'content/b.md'), rename('content/c.md', 'content/d.md')], { changed: '2' }).labels, ['content'], 'two renames are two entries, a complete listing for changed_files 2');
  assert.deepEqual(label([rename('content/a.md', 'content/b.md'), rename('content/c.md', 'content/d.md')], { changed: '3' }).labels, ['content', 'review-as-code'], 'two renames are still short of changed_files 3');
  assert.deepEqual(label([rename('content/a.md', 'content/b.md')], { changed: '2' }).labels, ['content', 'review-as-code'], 'one rename counts as one entry, not two');
  const nameless = label([{ filename: 'content/a.md', previous_filename: null } as unknown as Entry]);
  assert.deepEqual(nameless.labels, ['content'], 'a null previous_filename adds nothing');
});

test('SC-U2-44 b the labels come out in a fixed order, each once, with external last', () => {
  const r = label(['README.md', 'src/a.ts', 'content/a.md', 'content/b.md', 'src/b.ts', 'LICENSE'], { head: 'fork/ircx-docs' });
  assert.deepEqual(r.labels, ['content', 'review-as-code', 'repository-files', 'external']);
});

test('SC-U2-44 e a pull request number outside the grammar stops the step before any API call', () => {
  for (const pr of ['', '0', '012', '-1', '1;id', '12345678901', '1 2', '$(touch pwned)']) {
    const r = label(['content/a.md'], { pr });
    assert.equal(r.status, 1, JSON.stringify(pr));
    assert.deepEqual(r.calls, [], JSON.stringify(pr));
    assert.equal(r.pwned, false);
  }
});

test('SC-U2-44 d an unreadable or non-numeric changed_files count adds review-as-code beside the classes the listing gave', () => {
  assert.deepEqual(label(['content/a.md'], { changed: { rc: 1 } }).labels, ['content', 'review-as-code']);
  for (const changed of ['abc', '', '-1', '3.5', '1 ', '0x1']) {
    assert.deepEqual(label(['content/a.md'], { changed }).labels, ['content', 'review-as-code'], JSON.stringify(changed));
  }
  assert.deepEqual(label(['content/a.md'], { changed: '1' }).labels, ['content'], 'the listing matches the count');
  assert.deepEqual(label(['content/a.md', 'content/b.md'], { changed: '1' }).labels, ['content'], 'more entries than the count is not a truncation');
  assert.deepEqual(label([], { changed: '0' }).labels, [], 'an empty pull request has nothing to label');
  assert.deepEqual(label(['content/a.md'], { listing: { rc: 1 }, changed: '1' }).labels, ['review-as-code'], 'a failed listing');
  assert.deepEqual(label([], { listing: { rc: 1 }, changed: '0' }).labels, ['review-as-code'], 'a failed listing for a pull request that reports no file');
});

test('SC-U2-44 b an unusual head repository value is external and is never run', () => {
  for (const head of ['', 'ircx-io/ircx-docs ', ' ircx-io/ircx-docs', 'IRCX-IO/ircx-docs', ['ircx-io/ircx-docs', 'fork'].join('-'), '$(touch pwned)', '`touch pwned`', 'a\nb']) {
    const r = label(['content/a.md'], { head });
    assert.deepEqual(r.labels, ['content', 'external'], JSON.stringify(head));
    assert.equal(r.pwned, false);
  }
  assert.ok(label(['content/a.md']).calls.every((c) => c[0] === 'api'));
  assert.ok(label(['content/a.md']).calls.some((c) => c.includes(`${REPO}/issues/12/labels`)));
});
