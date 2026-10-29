import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compareSettings, FILES } from '../src/settings.ts';
import { ROOT } from './helpers.ts';

type Json = Record<string, unknown>;

/** A ruleset as the read token gets it: GitHub leaves out `bypass_actors` for a token that cannot write the ruleset. */
function ruleset(name: string, target: string, include: string, rules: Json[]): Json {
  return { id: 1, name, target, enforcement: 'active', conditions: { ref_name: { include: [include], exclude: [] } }, rules };
}

/**
 * The responses the App's tokens get when every setting is as it was set up:
 * `repository` from the read token, without the merge fields, and
 * `merge-options` as the read job projects them from the Contents-write read.
 */
function expected(): Record<string, unknown> {
  return {
    repository: {
      has_wiki: false,
      has_projects: false,
      has_issues: true,
      visibility: 'public',
      security_and_analysis: { secret_scanning: { status: 'enabled' }, secret_scanning_push_protection: { status: 'enabled' } },
    },
    'merge-options': { allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false, allow_auto_merge: false, delete_branch_on_merge: true },
    'actions-permissions': { enabled: true, allowed_actions: 'selected', sha_pinning_required: true },
    'selected-actions': { github_owned_allowed: false, verified_allowed: false, patterns_allowed: ['actions/checkout@*', 'actions/create-github-app-token@*', 'actions/setup-node@*'] },
    'workflow-permissions': { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false },
    'fork-pr-approval': { approval_policy: 'all_external_contributors' },
    'vulnerability-alerts': { enabled: true },
    'private-vulnerability-reporting': { enabled: true },
    rulesets: [
      ruleset('main-history', 'branch', '~DEFAULT_BRANCH', [{ type: 'deletion' }, { type: 'non_fast_forward' }]),
      ruleset('main-checks', 'branch', '~DEFAULT_BRANCH', [{ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: 'docs' }] } }]),
      ruleset('tags-create', 'tag', '~ALL', [{ type: 'creation' }]),
      ruleset('tags-locked', 'tag', '~ALL', [{ type: 'update' }, { type: 'deletion' }]),
    ],
    'actions-secrets': { total_count: 0, secrets: [] },
    'dependabot-secrets': { total_count: 0, secrets: [] },
    'environment-secrets': { total_count: 1, secrets: [{ name: 'IRCX_BOT_PRIVATE_KEY' }] },
    'environment-variables': { total_count: 0, variables: [] },
    environments: [{ total_count: 1, environments: [{ name: 'ircx-bot', deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }, protection_rules: [{ type: 'branch_policy' }] }] }],
    'branch-policies': [{ total_count: 1, branch_policies: [{ name: 'main', type: 'branch' }] }],
    releases: [[{ author: { login: 'ircx-io-bot[bot]' }, assets: [], draft: false }]],
  };
}

function findings(mutate: (r: Record<string, any>) => void = () => {}): string[] {
  const r = expected() as Record<string, any>;
  mutate(r);
  return compareSettings(r).map((f) => `${f.rule}: ${f.path}`);
}

test('SC-U2-46 c bypass_actors on a ruleset and merge fields on repository are not read', () => {
  const bypass = [{ actor_id: 1, actor_type: 'User', bypass_mode: 'always' }];
  assert.deepEqual(
    findings((r) => {
      for (const ruleset of r.rulesets) {
        ruleset.bypass_actors = bypass;
      }
    }),
    [],
  );
  assert.deepEqual(
    findings((r) => {
      Object.assign(r.repository, { allow_squash_merge: false, allow_merge_commit: true, allow_rebase_merge: true, allow_auto_merge: true, delete_branch_on_merge: false });
    }),
    [],
  );
});

test('SC-U2-46 the expected settings give no finding', () => {
  assert.deepEqual(findings(), []);
  assert.deepEqual(Object.keys(expected()).sort(), [...FILES].sort());
});

test('SC-U2-46 c one finding per checked field', () => {
  const rs = (r: Record<string, any>, name: string): Record<string, any> => r.rulesets.find((x: Json) => x.name === name);
  const cases: Array<[string, (r: Record<string, any>) => void, string]> = [
    ['main-history target', (r) => (rs(r, 'main-history').target = 'tag'), 'rulesets: rulesets.main-history.target'],
    ['main-history include', (r) => (rs(r, 'main-history').conditions.ref_name.include = ['~ALL']), 'rulesets: rulesets.main-history.conditions'],
    ['main-history rules', (r) => (rs(r, 'main-history').rules = [{ type: 'deletion' }]), 'rulesets: rulesets.main-history.rules'],
    ['main-checks target', (r) => (rs(r, 'main-checks').target = 'tag'), 'rulesets: rulesets.main-checks.target'],
    ['main-checks include', (r) => (rs(r, 'main-checks').conditions.ref_name.include = ['refs/heads/x']), 'rulesets: rulesets.main-checks.conditions'],
    ['main-checks rules', (r) => (rs(r, 'main-checks').rules[0].parameters.required_status_checks = [{ context: 'other' }]), 'rulesets: rulesets.main-checks.rules.required_status_checks'],
    ['main-checks strict', (r) => (rs(r, 'main-checks').rules[0].parameters.strict_required_status_checks_policy = true), 'rulesets: rulesets.main-checks.rules.required_status_checks'],
    ['tags-create target', (r) => (rs(r, 'tags-create').target = 'branch'), 'rulesets: rulesets.tags-create.target'],
    ['tags-create include', (r) => (rs(r, 'tags-create').conditions.ref_name.include = ['v*']), 'rulesets: rulesets.tags-create.conditions'],
    ['tags-create rules', (r) => rs(r, 'tags-create').rules.push({ type: 'update' }), 'rulesets: rulesets.tags-create.rules'],
    ['tags-locked target', (r) => (rs(r, 'tags-locked').target = 'branch'), 'rulesets: rulesets.tags-locked.target'],
    ['tags-locked include', (r) => (rs(r, 'tags-locked').conditions.ref_name.exclude = ['v1']), 'rulesets: rulesets.tags-locked.conditions'],
    ['tags-locked rules', (r) => (rs(r, 'tags-locked').rules = [{ type: 'update' }]), 'rulesets: rulesets.tags-locked.rules'],
    ['a ruleset disabled', (r) => (rs(r, 'main-history').enforcement = 'evaluate'), 'rulesets: rulesets.main-history.enforcement'],
    ['a ruleset missing', (r) => (r.rulesets = r.rulesets.slice(1)), 'rulesets: rulesets.main-history'],
    ['a fifth ruleset', (r) => r.rulesets.push(ruleset('extra', 'branch', '~ALL', [])), 'rulesets: rulesets.count'],
    ['patterns_allowed with a fourth entry', (r) => r['selected-actions'].patterns_allowed.push('evil/x@*'), 'settings: selected-actions.patterns_allowed'],
    ['patterns_allowed with two', (r) => r['selected-actions'].patterns_allowed.pop(), 'settings: selected-actions.patterns_allowed'],
    ['sha_pinning_required: false', (r) => (r['actions-permissions'].sha_pinning_required = false), 'settings: actions-permissions.sha_pinning_required'],
    ['default_workflow_permissions: write', (r) => (r['workflow-permissions'].default_workflow_permissions = 'write'), 'settings: workflow-permissions.default_workflow_permissions'],
    ['can_approve_pull_request_reviews: true', (r) => (r['workflow-permissions'].can_approve_pull_request_reviews = true), 'settings: workflow-permissions.can_approve_pull_request_reviews'],
    ['approval_policy changed', (r) => (r['fork-pr-approval'].approval_policy = 'first_time_contributors'), 'settings: fork-pr-approval.approval_policy'],
    ['has_issues: false', (r) => (r.repository.has_issues = false), 'settings: repository.has_issues'],
    ['allow_squash_merge: false', (r) => (r['merge-options'].allow_squash_merge = false), 'settings: merge-options.allow_squash_merge'],
    ['allow_merge_commit: true', (r) => (r['merge-options'].allow_merge_commit = true), 'settings: merge-options.allow_merge_commit'],
    ['allow_rebase_merge: true', (r) => (r['merge-options'].allow_rebase_merge = true), 'settings: merge-options.allow_rebase_merge'],
    ['allow_auto_merge: true', (r) => (r['merge-options'].allow_auto_merge = true), 'settings: merge-options.allow_auto_merge'],
    ['delete_branch_on_merge: false', (r) => (r['merge-options'].delete_branch_on_merge = false), 'settings: merge-options.delete_branch_on_merge'],
    ['a merge field read as null', (r) => (r['merge-options'].allow_squash_merge = null), 'settings: merge-options.allow_squash_merge'],
    ['an empty merge-options file', (r) => (r['merge-options'] = undefined), 'read: merge-options'],
    ['push protection off', (r) => (r.repository.security_and_analysis.secret_scanning_push_protection.status = 'disabled'), 'settings: repository.security_and_analysis.secret_scanning_push_protection.status'],
    ['vulnerability alerts off', (r) => (r['vulnerability-alerts'].enabled = false), 'settings: vulnerability-alerts.enabled'],
    ['a repository Actions secret', (r) => (r['actions-secrets'] = { total_count: 1, secrets: [{ name: 'X' }] }), 'settings: actions-secrets.total_count'],
    ['a repository Dependabot secret', (r) => (r['dependabot-secrets'] = { total_count: 1, secrets: [{ name: 'X' }] }), 'settings: dependabot-secrets.total_count'],
    ['a second environment', (r) => r.environments[0].environments.push({ name: 'other' }), 'environment: environments.names'],
    ['a branch policy *', (r) => (r['branch-policies'][0].branch_policies[0].name = '*'), 'environment: branch-policies'],
    ['a branch policy of type tag', (r) => (r['branch-policies'][0].branch_policies[0].type = 'tag'), 'environment: branch-policies'],
    ['a second branch policy', (r) => r['branch-policies'][0].branch_policies.push({ name: 'dev', type: 'branch' }), 'environment: branch-policies'],
    ['protected branches on', (r) => (r.environments[0].environments[0].deployment_branch_policy.protected_branches = true), 'environment: environments.ircx-bot.deployment_branch_policy'],
    ['a required reviewer rule', (r) => r.environments[0].environments[0].protection_rules.push({ type: 'required_reviewers' }), 'environment: environments.ircx-bot.protection_rules'],
    ['an environment variable', (r) => (r['environment-variables'] = { total_count: 1, variables: [{ name: 'X' }] }), 'settings: environment-variables.total_count'],
    ['a second environment secret', (r) => (r['environment-secrets'] = { total_count: 2, secrets: [{ name: 'IRCX_BOT_PRIVATE_KEY' }, { name: 'X' }] }), 'environment: environment-secrets.secrets'],
    ['a release with one asset', (r) => r.releases[0][0].assets.push({ name: 'x' }), 'releases: releases.assets'],
    ['a release by ricardodevries', (r) => (r.releases[0][0].author.login = 'ricardodevries'), 'releases: releases.author'],
    ['a draft release', (r) => (r.releases[0][0].draft = true), 'releases: releases.draft'],
    ['an empty output file', (r) => (r['workflow-permissions'] = undefined), 'read: workflow-permissions'],
    ['a missing field', (r) => delete r.repository.has_wiki, 'settings: repository.has_wiki'],
  ];
  for (const [name, mutate, want] of cases) {
    const got = findings(mutate);
    assert.ok(got.includes(want), `${name}: ${JSON.stringify(got)}`);
  }
});

/** Runs the real entry point over a directory of response files. */
function cli(responses: Record<string, unknown>, raw: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'docs-settings-'));
  try {
    for (const [name, value] of Object.entries(responses)) {
      writeFileSync(join(dir, `${name}.json`), value === undefined ? '' : JSON.stringify(value));
    }
    for (const [name, text] of Object.entries(raw)) {
      writeFileSync(join(dir, `${name}.json`), text);
    }
    return spawnSync(process.execPath, [join(ROOT, 'src', 'settings.ts'), dir], { encoding: 'utf8', env: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('SC-U2-46 b the entry point passes clean responses and fails on an empty or unparsable file', () => {
  const clean = cli(expected());
  assert.equal(clean.status, 0, clean.stdout);
  assert.equal(clean.stdout, 'settings: no drift\n');
  const empty = cli(expected(), { rulesets: '' });
  assert.equal(empty.status, 1);
  assert.equal(empty.stdout, 'read: rulesets\n');
  const broken = cli(expected(), { releases: '[{' });
  assert.equal(broken.status, 1);
  assert.equal(broken.stdout, 'read: releases\n');
  const noMerge = cli(expected(), { 'merge-options': '' });
  assert.equal(noMerge.status, 1);
  assert.equal(noMerge.stdout, 'read: merge-options\n');
});

test('SC-U2-46 c no response key or value reaches the output', () => {
  const plant = 'PLANTED_SECRET_NAME_7f3a';
  const r = expected() as Record<string, any>;
  r['actions-secrets'] = { total_count: 1, secrets: [{ name: plant }] };
  r['environment-variables'] = { total_count: 1, variables: [{ name: 'X', value: plant }] };
  r.rulesets.push({ ...ruleset(plant, 'branch', plant, [{ type: plant }]), bypass_actors: [{ actor_id: plant }] });
  r.repository[plant] = plant;
  r.repository.visibility = plant;
  const run = cli(r);
  assert.equal(run.status, 1);
  assert.ok(run.stdout.split('\n').filter((l) => l !== '').length >= 3, run.stdout);
  assert.ok(!`${run.stdout}${run.stderr}`.includes('PLANTED'), run.stdout);
});

test('SC-U2-46 c the module imports only node:fs, node:path and relative modules', () => {
  const source = readFileSync(join(ROOT, 'src', 'settings.ts'), 'utf8');
  const specifiers = [...source.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? '');
  assert.ok(specifiers.length > 0);
  for (const s of specifiers) {
    assert.ok(s === 'node:fs' || s === 'node:path' || s.startsWith('./'), s);
  }
  assert.ok(!/process\.env|fetch\(|child_process|import\(/.test(source));
});
