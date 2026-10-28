// Decides whether a Dependabot pull request merges without review (AUT-2).
// The input is four JSON files the workflow wrote: the workflow_run event,
// the pull request, its commits and its changed files. This module reads
// nothing else: no network, no child process, no environment. It prints
// exactly the four output lines the merge job reads, and one fixed reason
// line on stderr.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { safeText } from './text.ts';

/** The paths a Dependabot update may change and still merge (D-A1: npm and GitHub Actions). */
export const MERGEABLE_PATHS: readonly string[] = Object.freeze([
  'package.json',
  'package-lock.json',
  '.github/workflows/ci.yml',
  '.github/workflows/cut-release.yml',
  '.github/workflows/dependabot-merge.yml',
  '.github/workflows/labels.yml',
  '.github/workflows/settings-check.yml',
]);

/** The update types that merge; a major, or no update type at all, waits for a maintainer. */
export const MERGEABLE_UPDATE_TYPES: readonly string[] = Object.freeze(['version-update:semver-patch', 'version-update:semver-minor']);

const REPOSITORY = 'ircx-io/ircx-docs';
const DEPENDABOT = 'dependabot[bot]';
const WEB_FLOW = 'web-flow';
const SHA = /^[0-9a-f]{40}$/;

export interface Decision {
  readonly merge: boolean;
  /** The pull request number, set only when `merge` is true. */
  readonly number: number | undefined;
  /** The checked head SHA, set only when `merge` is true. */
  readonly sha: string | undefined;
  /** True when a changed path is under `.github/workflows/`. */
  readonly workflows: boolean;
  /** A fixed sentence naming the first rule that failed, or why it merges. */
  readonly reason: string;
}

type Json = unknown;

function field(value: Json, ...path: string[]): Json {
  let v = value;
  for (const key of path) {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      return undefined;
    }
    v = (v as Record<string, Json>)[key];
  }
  return v;
}

function refuse(reason: string): Decision {
  return { merge: false, number: undefined, sha: undefined, workflows: false, reason };
}

/** Applies the merge rules (SC-U2-43 c) to the four parsed inputs. */
export function decide(event: Json, pr: Json, commits: Json, files: Json): Decision {
  const runPrs = field(event, 'workflow_run', 'pull_requests');
  const number = field(pr, 'number');
  if (!Array.isArray(runPrs) || runPrs.length === 0) {
    return refuse('the run names no pull request');
  }
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || field(runPrs[0], 'number') !== number) {
    return refuse('the pull request read is not the one the run names');
  }
  if (field(pr, 'state') !== 'open') {
    return refuse('the pull request is not open');
  }
  if (field(pr, 'user', 'login') !== DEPENDABOT) {
    return refuse('the pull request is not opened by Dependabot');
  }
  if (field(pr, 'base', 'ref') !== 'main') {
    return refuse('the pull request does not target main');
  }
  if (field(pr, 'head', 'repo', 'full_name') !== REPOSITORY) {
    return refuse('the head branch is not in this repository');
  }
  const ref = field(pr, 'head', 'ref');
  if (typeof ref !== 'string' || !ref.startsWith('dependabot/')) {
    return refuse('the head branch is not a Dependabot branch');
  }
  const sha = field(pr, 'head', 'sha');
  if (typeof sha !== 'string' || !SHA.test(sha) || field(event, 'workflow_run', 'head_sha') !== sha) {
    return refuse('the head SHA is not the one CI ran on');
  }
  if (!Array.isArray(commits) || commits.length === 0) {
    return refuse('the pull request has no commits');
  }
  const updateTypes: string[] = [];
  for (const c of commits) {
    if (field(c, 'author', 'login') !== DEPENDABOT || field(c, 'committer', 'login') !== WEB_FLOW) {
      return refuse('a commit is not authored by Dependabot and committed by GitHub');
    }
    if (field(c, 'commit', 'verification', 'verified') !== true) {
      return refuse('a commit is not verified');
    }
    const parents = field(c, 'parents');
    if (!Array.isArray(parents) || parents.length !== 1) {
      return refuse('a commit does not have exactly one parent');
    }
    const message = field(c, 'commit', 'message');
    if (typeof message !== 'string') {
      return refuse('a commit has no message');
    }
    for (const m of message.matchAll(/^\s*update-type:\s*(.*?)\s*$/gm)) {
      updateTypes.push(m[1] ?? '');
    }
  }
  if (updateTypes.length === 0) {
    return refuse('no commit states an update type');
  }
  if (!updateTypes.every((t) => MERGEABLE_UPDATE_TYPES.includes(t))) {
    return refuse('an update is not a patch or minor version update');
  }
  if (!Array.isArray(files) || files.length === 0) {
    return refuse('the pull request changes no file');
  }
  const paths: string[] = [];
  for (const f of files) {
    const name = field(f, 'filename');
    if (typeof name !== 'string' || !MERGEABLE_PATHS.includes(name)) {
      return refuse('a changed file is outside the paths an update may change');
    }
    paths.push(name);
  }
  const workflows = paths.some((p) => p.startsWith('.github/workflows/'));
  return { merge: true, number, sha, workflows, reason: 'a Dependabot patch or minor update that CI passed' };
}

/** The output lines, in the `key=value` form `$GITHUB_OUTPUT` reads. */
export function outputLines(d: Decision): string[] {
  return [`merge=${d.merge}`, `number=${d.merge ? String(d.number) : ''}`, `sha=${d.merge ? (d.sha ?? '') : ''}`, `workflows=${d.workflows}`];
}

function readJson(path: string): Json {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Json;
  } catch {
    return undefined;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let d: Decision;
  if (args.length !== 4) {
    d = refuse('usage: dependabot.ts <event> <pull request> <commits> <files>');
  } else {
    const [event, pr, commits, files] = args.map((a) => readJson(resolve(a)));
    d = decide(event, pr, commits, files);
  }
  process.stdout.write(`${outputLines(d).join('\n')}\n`);
  process.stderr.write(`dependabot: ${d.merge ? 'merge' : 'leave for a maintainer'}: ${safeText(d.reason)}\n`);
}
