// The weekly settings check (AUT-5). The read job saves each settings response
// as one JSON file in a directory; this module compares them with the values
// the repository was set up with and prints one line per difference. A line
// names a rule id and a field path taken from the constants below, never a key
// or value from a response, because the drift issue is public. An empty or
// unparsable file is a finding. It reads only that directory: no network, no
// child process, no environment.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The commit identity every release is authored by. */
export const RELEASE_AUTHOR = 'ircx-io-bot[bot]';

export const PATTERNS_ALLOWED: readonly string[] = Object.freeze(['actions/checkout@*', 'actions/create-github-app-token@*', 'actions/setup-node@*']);

/** One expected field: its path in the response and its value. */
type Expect = readonly [path: readonly string[], value: string | number | boolean];

/** The scalar settings, by response file (SC-U2-3 a and b). */
export const SCALARS: Readonly<Record<string, readonly Expect[]>> = Object.freeze({
  repository: [
    [['has_wiki'], false],
    [['has_projects'], false],
    [['has_issues'], true],
    [['visibility'], 'public'],
    [['security_and_analysis', 'secret_scanning', 'status'], 'enabled'],
    [['security_and_analysis', 'secret_scanning_push_protection', 'status'], 'enabled'],
  ],
  // The read job reads these with a Contents-write token, because GitHub returns them only to one.
  'merge-options': [
    [['allow_squash_merge'], true],
    [['allow_merge_commit'], false],
    [['allow_rebase_merge'], false],
    [['allow_auto_merge'], false],
    [['delete_branch_on_merge'], true],
  ],
  'actions-permissions': [
    [['enabled'], true],
    [['allowed_actions'], 'selected'],
    [['sha_pinning_required'], true],
  ],
  'selected-actions': [
    [['github_owned_allowed'], false],
    [['verified_allowed'], false],
  ],
  'workflow-permissions': [
    [['default_workflow_permissions'], 'read'],
    [['can_approve_pull_request_reviews'], false],
  ],
  'fork-pr-approval': [[['approval_policy'], 'all_external_contributors']],
  'vulnerability-alerts': [[['enabled'], true]],
  'private-vulnerability-reporting': [[['enabled'], true]],
  'actions-secrets': [[['total_count'], 0]],
  'dependabot-secrets': [[['total_count'], 0]],
  'environment-variables': [[['total_count'], 0]],
});

/** The files the read job writes, one per response. */
export const FILES: readonly string[] = Object.freeze([
  'repository',
  'actions-permissions',
  'selected-actions',
  'workflow-permissions',
  'fork-pr-approval',
  'vulnerability-alerts',
  'private-vulnerability-reporting',
  'rulesets',
  'actions-secrets',
  'dependabot-secrets',
  'environment-secrets',
  'environment-variables',
  'environments',
  'branch-policies',
  'releases',
  'merge-options',
]);

interface RulesetShape {
  readonly name: string;
  readonly target: string;
  readonly include: string;
  readonly rules: readonly string[];
}

/** The four rulesets (SC-U2-3 b). Their bypass lists are not read here: GitHub returns them only to a token that can write the ruleset. */
export const RULESETS: readonly RulesetShape[] = Object.freeze([
  { name: 'main-history', target: 'branch', include: '~DEFAULT_BRANCH', rules: ['deletion', 'non_fast_forward'] },
  { name: 'main-checks', target: 'branch', include: '~DEFAULT_BRANCH', rules: ['required_status_checks'] },
  { name: 'tags-create', target: 'tag', include: '~ALL', rules: ['creation'] },
  { name: 'tags-locked', target: 'tag', include: '~ALL', rules: ['deletion', 'update'] },
]);

/** One difference: a rule id and a field path, both from this module's constants. */
export interface SettingsFinding {
  readonly rule: string;
  readonly path: string;
}

type Json = unknown;

function get(value: Json, path: readonly string[]): Json {
  let v = value;
  for (const key of path) {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      return undefined;
    }
    v = (v as Record<string, Json>)[key];
  }
  return v;
}

function sameStrings(value: Json, want: readonly string[]): boolean {
  return Array.isArray(value) && value.length === want.length && [...value].sort().every((v, i) => v === [...want].sort()[i]);
}

/** Flattens the pages `gh api --paginate | jq -s` writes, taking `key` from each page when given. */
function pages(value: Json, key?: string): Json[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: Json[] = [];
  for (const page of value) {
    const items = key === undefined ? page : get(page, [key]);
    if (!Array.isArray(items)) {
      return undefined;
    }
    out.push(...items);
  }
  return out;
}

function checkRuleset(found: Json, want: RulesetShape, out: SettingsFinding[]): void {
  const at = `rulesets.${want.name}`;
  if (get(found, ['target']) !== want.target) {
    out.push({ rule: 'rulesets', path: `${at}.target` });
  }
  if (get(found, ['enforcement']) !== 'active') {
    out.push({ rule: 'rulesets', path: `${at}.enforcement` });
  }
  if (!sameStrings(get(found, ['conditions', 'ref_name', 'include']), [want.include]) || !sameStrings(get(found, ['conditions', 'ref_name', 'exclude']), [])) {
    out.push({ rule: 'rulesets', path: `${at}.conditions` });
  }
  const rules = get(found, ['rules']);
  if (!Array.isArray(rules) || !sameStrings(rules.map((r) => get(r, ['type'])), want.rules)) {
    out.push({ rule: 'rulesets', path: `${at}.rules` });
  } else if (want.name === 'main-checks') {
    const params = get(rules[0], ['parameters']);
    const checks = get(params, ['required_status_checks']);
    const contexts = Array.isArray(checks) ? checks.map((c) => get(c, ['context'])) : undefined;
    if (get(params, ['strict_required_status_checks_policy']) !== false || contexts === undefined || !sameStrings(contexts, ['docs'])) {
      out.push({ rule: 'rulesets', path: `${at}.rules.required_status_checks` });
    }
  }
}

/** Compares the parsed responses (`undefined` for an empty or unreadable file) with the constants. */
export function compareSettings(responses: Readonly<Record<string, Json>>): SettingsFinding[] {
  const out: SettingsFinding[] = [];
  for (const name of FILES) {
    if (responses[name] === undefined) {
      out.push({ rule: 'read', path: name });
    }
  }
  for (const [name, expects] of Object.entries(SCALARS)) {
    const response = responses[name];
    if (response === undefined) {
      continue;
    }
    for (const [path, value] of expects) {
      if (get(response, path) !== value) {
        out.push({ rule: 'settings', path: `${name}.${path.join('.')}` });
      }
    }
  }
  const selected = responses['selected-actions'];
  if (selected !== undefined && !sameStrings(get(selected, ['patterns_allowed']), PATTERNS_ALLOWED)) {
    out.push({ rule: 'settings', path: 'selected-actions.patterns_allowed' });
  }

  const rulesets = responses.rulesets;
  if (rulesets !== undefined) {
    if (!Array.isArray(rulesets)) {
      out.push({ rule: 'rulesets', path: 'rulesets' });
    } else {
      for (const want of RULESETS) {
        const matches = rulesets.filter((r) => get(r, ['name']) === want.name);
        if (matches.length !== 1) {
          out.push({ rule: 'rulesets', path: `rulesets.${want.name}` });
        } else {
          checkRuleset(matches[0], want, out);
        }
      }
      if (rulesets.length !== RULESETS.length) {
        out.push({ rule: 'rulesets', path: 'rulesets.count' });
      }
    }
  }

  const envSecrets = responses['environment-secrets'];
  if (envSecrets !== undefined) {
    const list = get(envSecrets, ['secrets']);
    if (!Array.isArray(list) || !sameStrings(list.map((s) => get(s, ['name'])), ['IRCX_BOT_PRIVATE_KEY']) || get(envSecrets, ['total_count']) !== 1) {
      out.push({ rule: 'environment', path: 'environment-secrets.secrets' });
    }
  }
  if (responses.environments !== undefined) {
    const envs = pages(responses.environments, 'environments');
    if (envs === undefined || envs.length !== 1 || get(envs[0], ['name']) !== 'ircx-bot') {
      out.push({ rule: 'environment', path: 'environments.names' });
    } else {
      const env = envs[0];
      if (get(env, ['deployment_branch_policy', 'protected_branches']) !== false || get(env, ['deployment_branch_policy', 'custom_branch_policies']) !== true) {
        out.push({ rule: 'environment', path: 'environments.ircx-bot.deployment_branch_policy' });
      }
      const rules = get(env, ['protection_rules']);
      if (!Array.isArray(rules) || !sameStrings(rules.map((r) => get(r, ['type'])), ['branch_policy'])) {
        out.push({ rule: 'environment', path: 'environments.ircx-bot.protection_rules' });
      }
    }
  }
  if (responses['branch-policies'] !== undefined) {
    const policies = pages(responses['branch-policies'], 'branch_policies');
    if (policies === undefined || policies.length !== 1 || get(policies[0], ['name']) !== 'main' || get(policies[0], ['type']) !== 'branch') {
      out.push({ rule: 'environment', path: 'branch-policies' });
    }
  }
  if (responses.releases !== undefined) {
    const releases = pages(responses.releases);
    if (releases === undefined) {
      out.push({ rule: 'releases', path: 'releases' });
    } else {
      if (releases.some((r) => get(r, ['author', 'login']) !== RELEASE_AUTHOR)) {
        out.push({ rule: 'releases', path: 'releases.author' });
      }
      if (releases.some((r) => { const a = get(r, ['assets']); return !Array.isArray(a) || a.length !== 0; })) {
        out.push({ rule: 'releases', path: 'releases.assets' });
      }
      if (releases.some((r) => get(r, ['draft']) !== false)) {
        out.push({ rule: 'releases', path: 'releases.draft' });
      }
    }
  }
  return out;
}

/** Reads `<dir>/<name>.json` for each expected file; an empty or unparsable file reads as `undefined`. */
export function readResponses(dir: string): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const name of FILES) {
    try {
      const text = readFileSync(join(dir, `${name}.json`), 'utf8');
      out[name] = text.trim() === '' ? undefined : (JSON.parse(text) as Json);
    } catch {
      out[name] = undefined;
    }
  }
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === undefined) {
    process.stderr.write('usage: settings.ts <directory>\n');
    process.exit(2);
  }
  const findings = compareSettings(readResponses(resolve(args[0])));
  for (const f of findings) {
    process.stdout.write(`${f.rule}: ${f.path}\n`);
  }
  if (findings.length > 0) {
    process.exitCode = 1;
  } else {
    process.stdout.write('settings: no drift\n');
  }
}
