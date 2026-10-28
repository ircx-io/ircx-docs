// Workflow checker. The set of workflow files is exactly {ci.yml}, every
// `uses:` line names an approved action at a full commit SHA with a version
// comment, one action carries one SHA, and after the SHA and version are
// replaced by placeholders the file equals the canonical text below. No SHA
// or version is held here, so a Dependabot bump keeps passing.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding } from './text.ts';

/** The approved actions. */
export const APPROVED_ACTIONS: readonly string[] = Object.freeze(['actions/checkout', 'actions/setup-node']);

/** The only workflow files allowed under .github/workflows/. */
export const WORKFLOW_FILES: readonly string[] = Object.freeze(['ci.yml']);

const USES_LINE = /^( *)(- )?uses: (actions\/checkout|actions\/setup-node)@[0-9a-f]{40} # v[0-9]+\.[0-9]+\.[0-9]+$/;
const USES_ANY = /^\s*(?:- )?uses:/;
const PIN = /@([0-9a-f]{40}) # /;

/** ci.yml with each `uses:` SHA and version replaced by placeholders. */
export const CANONICAL_CI = `name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  docs:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@<sha> # <version>
        with:
          persist-credentials: false
      - uses: actions/setup-node@<sha> # <version>
        with:
          node-version-file: .nvmrc
          package-manager-cache: false
      - run: npm ci --ignore-scripts
      - run: npm audit --audit-level=high
      - run: npm run typecheck
      - run: npm test
      - run: npm run check
      - run: npm run scan
`;

/**
 * Replaces the SHA and version of each well-formed `uses:` line with
 * placeholders, recording each action's SHA in `shas`. Returns findings for
 * malformed `uses:` lines and for an action pinned at two SHAs.
 */
export function normalise(file: string, text: string, shas: Map<string, string>): { text: string; findings: Finding[] } {
  const findings: Finding[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = USES_LINE.exec(line);
    if (m === null) {
      if (USES_ANY.test(line)) {
        findings.push({ file, line: i + 1, rule: 'W2', message: 'uses: must name an approved action at a full SHA with a # vX.Y.Z comment' });
      }
      continue;
    }
    const action = m[3] ?? '';
    const sha = PIN.exec(line)?.[1] ?? '';
    const seen = shas.get(action);
    if (seen === undefined) {
      shas.set(action, sha);
    } else if (seen !== sha) {
      findings.push({ file, line: i + 1, rule: 'W3', message: `${action} is pinned at more than one SHA` });
    }
    lines[i] = `${m[1] ?? ''}${m[2] ?? ''}uses: ${action}@<sha> # <version>`;
  }
  return { text: lines.join('\n'), findings };
}

function listFiles(dir: string, prefix: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    if (statSync(join(dir, name)).isDirectory()) {
      out.push(...listFiles(join(dir, name), rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/** Checks `<root>/.github/workflows/`; returns the findings (empty when clean). */
export function checkWorkflows(root: string): Finding[] {
  const dir = join(root, '.github', 'workflows');
  const findings: Finding[] = [];
  let files: string[];
  try {
    files = listFiles(dir, '');
  } catch {
    return [{ file: '.github/workflows', rule: 'W1', message: 'the workflows directory is missing' }];
  }
  if (files.length !== WORKFLOW_FILES.length || files.some((f, i) => f !== WORKFLOW_FILES[i])) {
    findings.push({ file: '.github/workflows', rule: 'W1', message: `the workflow files must be exactly ${WORKFLOW_FILES.join(', ')}` });
  }
  const shas = new Map<string, string>();
  for (const name of WORKFLOW_FILES) {
    const file = `.github/workflows/${name}`;
    let text: string;
    try {
      text = readFileSync(join(dir, name), 'utf8');
    } catch {
      findings.push({ file, rule: 'W1', message: 'missing' });
      continue;
    }
    const normalised = normalise(file, text, shas);
    findings.push(...normalised.findings);
    if (normalised.text !== CANONICAL_CI) {
      const got = normalised.text.split('\n');
      const want = CANONICAL_CI.split('\n');
      let line = 0;
      while (line < got.length && line < want.length && got[line] === want[line]) {
        line++;
      }
      findings.push({ file, line: line + 1, rule: 'W4', message: 'differs from the canonical workflow' });
    }
  }
  return findings;
}
