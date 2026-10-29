// Workflow checker. The set of workflow files is exactly WORKFLOW_FILES, every
// `uses:` line names an approved action at a full commit SHA with a version
// comment, one action carries one SHA across all files, and after the SHA and
// version are replaced by placeholders each file equals its canonical text
// below. Structural rules W5 to W14 run beside the compare, so a change that
// breaks one of them names the rule. No SHA or version is held here, so a
// Dependabot bump keeps passing.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding } from './text.ts';

/** The approved actions. */
export const APPROVED_ACTIONS: readonly string[] = Object.freeze(['actions/checkout', 'actions/create-github-app-token', 'actions/setup-node']);

/** The only workflow files allowed under .github/workflows/. */
export const WORKFLOW_FILES: readonly string[] = Object.freeze(['ci.yml', 'cut-release.yml', 'dependabot-merge.yml', 'labels.yml', 'settings-check.yml']);

/** The workflows that hold a key job, and the name of that job (SC-U2-42 b). */
export const KEY_JOBS: Readonly<Record<string, string>> = Object.freeze({
  'cut-release.yml': 'release',
  'dependabot-merge.yml': 'merge',
  'settings-check.yml': 'read',
});

/** The one line through which a workflow may read a secret. */
export const PRIVATE_KEY_LINE = 'private-key: ${{ secrets.IRCX_BOT_PRIVATE_KEY }}';

const APP_TOKEN_ACTION = 'actions/create-github-app-token';
const USES_LINE = /^( *)(- )?uses: (actions\/checkout|actions\/setup-node|actions\/create-github-app-token)@[0-9a-f]{40} # v[0-9]+\.[0-9]+\.[0-9]+$/;
const USES_ANY = /^\s*(?:- )?uses:/;
const PIN = /@([0-9a-f]{40}) # /;

/** Each workflow file with every `uses:` SHA and version replaced by placeholders. */
export const CANONICAL: Readonly<Record<string, string>> = Object.freeze({
  'ci.yml': `name: CI

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
`,
  'cut-release.yml': `name: Cut release

on:
  workflow_dispatch:
    inputs:
      tag:
        description: Release tag, vYYYY.MM.DD in UTC, with .2 to .9 appended for a later release the same day
        required: true
        type: string
      revision:
        description: The full commit SHA of the revision the frontend pins
        required: true
        type: string

permissions: {}

jobs:
  release:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    environment: ircx-bot
    permissions:
      contents: read
    steps:
      - name: Validate the inputs
        env:
          GH_TOKEN: \${{ github.token }}
          TAG: \${{ inputs.tag }}
          REVISION: \${{ inputs.revision }}
        run: |
          set -euo pipefail
          [[ "$TAG" =~ ^v[0-9]{4}\\.[0-9]{2}\\.[0-9]{2}(\\.[2-9])?$ ]] || { echo "the tag must be vYYYY.MM.DD, optionally followed by .2 to .9"; exit 1; }
          [[ "$REVISION" =~ ^[0-9a-f]{40}$ ]] || { echo "the revision must be a full lowercase commit SHA"; exit 1; }
          status="$(gh api "repos/ircx-io/ircx-docs/compare/$REVISION...main" --jq .status)"
          case "$status" in
            ahead | identical) ;;
            *) echo "the revision is not on main"; exit 1 ;;
          esac
          if lookup="$(gh api "repos/ircx-io/ircx-docs/git/ref/tags/$TAG" 2>&1)"; then
            echo "the tag already exists"
            exit 1
          fi
          case "$lookup" in
            *"(HTTP 404)"*) ;;
            *) echo "the tag lookup failed"; exit 1 ;;
          esac
      - id: token
        uses: actions/create-github-app-token@<sha> # <version>
        with:
          client-id: Iv23liAz4GUkls9I3nc2
          private-key: \${{ secrets.IRCX_BOT_PRIVATE_KEY }}
          owner: ircx-io
          repositories: ircx-docs
          permission-contents: write
          permission-workflows: write
      - name: Create the release
        env:
          GH_TOKEN: \${{ steps.token.outputs.token }}
          TAG: \${{ inputs.tag }}
          REVISION: \${{ inputs.revision }}
        run: gh api -X POST repos/ircx-io/ircx-docs/releases -f "tag_name=$TAG" -f "target_commitish=$REVISION" -F generate_release_notes=true -f make_latest=true -F draft=false > /dev/null
`,
  'dependabot-merge.yml': `name: Dependabot merge

on:
  workflow_run:
    workflows: [CI]
    types: [completed]

permissions: {}

jobs:
  decide:
    if: >-
      github.event.workflow_run.conclusion == 'success' &&
      github.event.workflow_run.event == 'pull_request' &&
      github.event.workflow_run.path == '.github/workflows/ci.yml' &&
      github.event.workflow_run.head_repository.full_name == 'ircx-io/ircx-docs'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      pull-requests: read
    outputs:
      merge: \${{ steps.decide.outputs.merge }}
      number: \${{ steps.decide.outputs.number }}
      sha: \${{ steps.decide.outputs.sha }}
      workflows: \${{ steps.decide.outputs.workflows }}
    steps:
      - uses: actions/checkout@<sha> # <version>
        with:
          persist-credentials: false
      - uses: actions/setup-node@<sha> # <version>
        with:
          node-version-file: .nvmrc
          package-manager-cache: false
      - name: Read the pull request
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          set -euo pipefail
          dir="$RUNNER_TEMP/dependabot"
          mkdir -p "$dir"
          printf '{}\\n' > "$dir/pr.json"
          printf '[]\\n' > "$dir/commits.json"
          printf '[]\\n' > "$dir/files.json"
          pr="$(jq -r '.workflow_run.pull_requests[0].number // ""' "$GITHUB_EVENT_PATH")"
          if [[ "$pr" =~ ^[1-9][0-9]{0,9}$ ]]; then
            gh api "repos/ircx-io/ircx-docs/pulls/$pr" > "$dir/pr.json"
            gh api --paginate "repos/ircx-io/ircx-docs/pulls/$pr/commits" | jq -s 'add // []' > "$dir/commits.json"
            gh api --paginate "repos/ircx-io/ircx-docs/pulls/$pr/files" | jq -s 'add // []' > "$dir/files.json"
          fi
      - id: decide
        run: node src/dependabot.ts "$GITHUB_EVENT_PATH" "$RUNNER_TEMP/dependabot/pr.json" "$RUNNER_TEMP/dependabot/commits.json" "$RUNNER_TEMP/dependabot/files.json" >> "$GITHUB_OUTPUT"

  merge:
    needs: decide
    if: needs.decide.outputs.merge == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    environment: ircx-bot
    permissions: {}
    steps:
      - name: Validate the decision
        env:
          NUMBER: \${{ needs.decide.outputs.number }}
          SHA: \${{ needs.decide.outputs.sha }}
          WORKFLOWS: \${{ needs.decide.outputs.workflows }}
        run: |
          set -euo pipefail
          [[ "$NUMBER" =~ ^[1-9][0-9]{0,9}$ ]] || { echo "the pull request number is malformed"; exit 1; }
          [[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "the head SHA is malformed"; exit 1; }
          [[ "$WORKFLOWS" =~ ^(true|false)$ ]] || { echo "the workflows flag is malformed"; exit 1; }
      - id: contents-token
        if: needs.decide.outputs.workflows == 'false'
        uses: actions/create-github-app-token@<sha> # <version>
        with:
          client-id: Iv23liAz4GUkls9I3nc2
          private-key: \${{ secrets.IRCX_BOT_PRIVATE_KEY }}
          owner: ircx-io
          repositories: ircx-docs
          permission-contents: write
      - id: workflows-token
        if: needs.decide.outputs.workflows == 'true'
        uses: actions/create-github-app-token@<sha> # <version>
        with:
          client-id: Iv23liAz4GUkls9I3nc2
          private-key: \${{ secrets.IRCX_BOT_PRIVATE_KEY }}
          owner: ircx-io
          repositories: ircx-docs
          permission-contents: write
          permission-workflows: write
      - name: Squash-merge at the checked head
        env:
          GH_TOKEN: \${{ steps.contents-token.outputs.token || steps.workflows-token.outputs.token }}
          NUMBER: \${{ needs.decide.outputs.number }}
          SHA: \${{ needs.decide.outputs.sha }}
        run: gh api -X PUT repos/ircx-io/ircx-docs/pulls/$NUMBER/merge -f merge_method=squash -f sha=$SHA
`,
  'labels.yml': `name: Labels

on:
  pull_request_target:
    types: [opened, reopened, synchronize, ready_for_review]

permissions: {}

jobs:
  label:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      pull-requests: write
    concurrency:
      group: labels-\${{ github.event.pull_request.number }}
      cancel-in-progress: true
    steps:
      - name: Label the pull request by the paths it changes
        env:
          GH_TOKEN: \${{ github.token }}
          PR: \${{ github.event.pull_request.number }}
          HEAD_REPO: \${{ github.event.pull_request.head.repo.full_name }}
        run: |
          set -uo pipefail
          [[ "$PR" =~ ^[1-9][0-9]{0,9}$ ]] || { echo "the pull request number is malformed"; exit 1; }
          program='.[] | [.filename, (.previous_filename // empty)] | map(if startswith("content/") then "content" elif (startswith(".github/") or startswith("src/") or startswith("test/") or (. as $f | ["package.json", "package-lock.json", "tsconfig.json", ".npmrc", ".nvmrc", ".gitignore"] | index($f) != null)) then "review-as-code" elif (. as $f | ["README.md", "CONTRIBUTING.md", "SECURITY.md", "LICENSE", "LICENSE-CODE"] | index($f) != null) then "repository-files" else "none" end) | join(" ")'
          complete=1
          classes="$(gh api --paginate "repos/ircx-io/ircx-docs/pulls/$PR/files" --jq "$program")" || complete=0
          expected="$(gh api "repos/ircx-io/ircx-docs/pulls/$PR" --jq .changed_files)" || complete=0
          [[ "$expected" =~ ^[0-9]+$ ]] || complete=0
          if [ "$complete" = 1 ] && [ "$(printf '%s\\n' "$classes" | grep -c .)" -lt "$expected" ]; then
            complete=0
          fi
          labels=()
          for name in content review-as-code repository-files; do
            if printf '%s\\n' "$classes" | tr ' ' '\\n' | grep -qx "$name"; then
              labels+=("$name")
            elif [ "$name" = review-as-code ] && [ "$complete" = 0 ]; then
              labels+=("$name")
            fi
          done
          if [ "$HEAD_REPO" != "ircx-io/ircx-docs" ]; then
            labels+=(external)
          fi
          if [ "\${#labels[@]}" -gt 0 ]; then
            args=()
            for name in "\${labels[@]}"; do
              args+=(-f "labels[]=$name")
            done
            gh api -X POST "repos/ircx-io/ircx-docs/issues/$PR/labels" "\${args[@]}" > /dev/null
          fi
`,
  'settings-check.yml': `name: Settings check

on:
  schedule:
    - cron: '17 6 * * 1'
  workflow_dispatch:

permissions: {}

jobs:
  read:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    environment: ircx-bot
    permissions:
      actions: read
      contents: read
    outputs:
      repository: \${{ steps.read.outputs.repository }}
      actions-permissions: \${{ steps.read.outputs.actions-permissions }}
      selected-actions: \${{ steps.read.outputs.selected-actions }}
      workflow-permissions: \${{ steps.read.outputs.workflow-permissions }}
      fork-pr-approval: \${{ steps.read.outputs.fork-pr-approval }}
      vulnerability-alerts: \${{ steps.read.outputs.vulnerability-alerts }}
      private-vulnerability-reporting: \${{ steps.read.outputs.private-vulnerability-reporting }}
      rulesets: \${{ steps.read.outputs.rulesets }}
      actions-secrets: \${{ steps.read.outputs.actions-secrets }}
      dependabot-secrets: \${{ steps.read.outputs.dependabot-secrets }}
      environment-secrets: \${{ steps.read.outputs.environment-secrets }}
      environment-variables: \${{ steps.read.outputs.environment-variables }}
      environments: \${{ steps.read.outputs.environments }}
      branch-policies: \${{ steps.read.outputs.branch-policies }}
      releases: \${{ steps.read.outputs.releases }}
      merge-options: \${{ steps.merge-options.outputs.merge-options }}
    steps:
      - id: token
        uses: actions/create-github-app-token@<sha> # <version>
        with:
          client-id: Iv23liAz4GUkls9I3nc2
          private-key: \${{ secrets.IRCX_BOT_PRIVATE_KEY }}
          owner: ircx-io
          repositories: ircx-docs
          permission-administration: read
          permission-secrets: read
          permission-dependabot-secrets: read
          permission-environments: read
      - id: read
        env:
          APP_TOKEN: \${{ steps.token.outputs.token }}
          JOB_TOKEN: \${{ github.token }}
        run: |
          set -uo pipefail
          repo=repos/ircx-io/ircx-docs
          record() {
            printf '%s=%s\\n' "$1" "$2" >> "$GITHUB_OUTPUT"
          }
          with_app() {
            local value
            if value="$(GH_TOKEN="$APP_TOKEN" gh api "$2" | jq -c .)"; then record "$1" "$value"; else record "$1" ""; fi
          }
          with_job() {
            local value
            if value="$(GH_TOKEN="$JOB_TOKEN" gh api --paginate "$2" | jq -c -s .)"; then record "$1" "$value"; else record "$1" ""; fi
          }
          with_app repository "$repo"
          with_app actions-permissions "$repo/actions/permissions"
          with_app selected-actions "$repo/actions/permissions/selected-actions"
          with_app workflow-permissions "$repo/actions/permissions/workflow"
          with_app fork-pr-approval "$repo/actions/permissions/fork-pr-contributor-approval"
          with_app private-vulnerability-reporting "$repo/private-vulnerability-reporting"
          with_app actions-secrets "$repo/actions/secrets"
          with_app dependabot-secrets "$repo/dependabot/secrets"
          with_app environment-secrets "$repo/environments/ircx-bot/secrets"
          with_app environment-variables "$repo/environments/ircx-bot/variables"
          if alerts="$(GH_TOKEN="$APP_TOKEN" gh api "$repo/vulnerability-alerts" 2>&1)"; then
            record vulnerability-alerts '{"enabled":true}'
          else
            case "$alerts" in
              *"(HTTP 404)"*) record vulnerability-alerts '{"enabled":false}' ;;
              *) record vulnerability-alerts "" ;;
            esac
          fi
          rulesets=""
          if ids="$(GH_TOKEN="$APP_TOKEN" gh api "$repo/rulesets" --jq '.[].id')"; then
            rulesets="[]"
            for id in $ids; do
              [[ "$id" =~ ^[0-9]{1,12}$ ]] || { rulesets=""; break; }
              one="$(GH_TOKEN="$APP_TOKEN" gh api "$repo/rulesets/$id" | jq -c .)" || { rulesets=""; break; }
              rulesets="$(jq -c --argjson one "$one" '. + [$one]' <<< "$rulesets")" || { rulesets=""; break; }
            done
          fi
          record rulesets "$rulesets"
          with_job environments "$repo/environments"
          with_job branch-policies "$repo/environments/ircx-bot/deployment-branch-policies"
          with_job releases "$repo/releases"
      - id: merge-token
        uses: actions/create-github-app-token@<sha> # <version>
        with:
          client-id: Iv23liAz4GUkls9I3nc2
          private-key: \${{ secrets.IRCX_BOT_PRIVATE_KEY }}
          owner: ircx-io
          repositories: ircx-docs
          permission-contents: write
      - id: merge-options
        env:
          GH_TOKEN: \${{ steps.merge-token.outputs.token }}
        run: |
          set -uo pipefail
          if ! value="$(gh api repos/ircx-io/ircx-docs | jq -c '{allow_squash_merge, allow_merge_commit, allow_rebase_merge, allow_auto_merge, delete_branch_on_merge}')"; then
            value=""
          fi
          printf 'merge-options=%s\\n' "$value" >> "$GITHUB_OUTPUT"

  compare:
    needs: read
    if: always()
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      issues: write
    steps:
      - uses: actions/checkout@<sha> # <version>
        with:
          persist-credentials: false
      - uses: actions/setup-node@<sha> # <version>
        with:
          node-version-file: .nvmrc
          package-manager-cache: false
      - name: Write the responses to files
        env:
          REPOSITORY: \${{ needs.read.outputs.repository }}
          ACTIONS_PERMISSIONS: \${{ needs.read.outputs.actions-permissions }}
          SELECTED_ACTIONS: \${{ needs.read.outputs.selected-actions }}
          WORKFLOW_PERMISSIONS: \${{ needs.read.outputs.workflow-permissions }}
          FORK_PR_APPROVAL: \${{ needs.read.outputs.fork-pr-approval }}
          VULNERABILITY_ALERTS: \${{ needs.read.outputs.vulnerability-alerts }}
          PRIVATE_VULNERABILITY_REPORTING: \${{ needs.read.outputs.private-vulnerability-reporting }}
          RULESETS: \${{ needs.read.outputs.rulesets }}
          ACTIONS_SECRETS: \${{ needs.read.outputs.actions-secrets }}
          DEPENDABOT_SECRETS: \${{ needs.read.outputs.dependabot-secrets }}
          ENVIRONMENT_SECRETS: \${{ needs.read.outputs.environment-secrets }}
          ENVIRONMENT_VARIABLES: \${{ needs.read.outputs.environment-variables }}
          ENVIRONMENTS: \${{ needs.read.outputs.environments }}
          BRANCH_POLICIES: \${{ needs.read.outputs.branch-policies }}
          RELEASES: \${{ needs.read.outputs.releases }}
          MERGE_OPTIONS: \${{ needs.read.outputs.merge-options }}
        run: |
          set -euo pipefail
          dir="$RUNNER_TEMP/settings"
          mkdir -p "$dir"
          printf '%s' "$REPOSITORY" > "$dir/repository.json"
          printf '%s' "$ACTIONS_PERMISSIONS" > "$dir/actions-permissions.json"
          printf '%s' "$SELECTED_ACTIONS" > "$dir/selected-actions.json"
          printf '%s' "$WORKFLOW_PERMISSIONS" > "$dir/workflow-permissions.json"
          printf '%s' "$FORK_PR_APPROVAL" > "$dir/fork-pr-approval.json"
          printf '%s' "$VULNERABILITY_ALERTS" > "$dir/vulnerability-alerts.json"
          printf '%s' "$PRIVATE_VULNERABILITY_REPORTING" > "$dir/private-vulnerability-reporting.json"
          printf '%s' "$RULESETS" > "$dir/rulesets.json"
          printf '%s' "$ACTIONS_SECRETS" > "$dir/actions-secrets.json"
          printf '%s' "$DEPENDABOT_SECRETS" > "$dir/dependabot-secrets.json"
          printf '%s' "$ENVIRONMENT_SECRETS" > "$dir/environment-secrets.json"
          printf '%s' "$ENVIRONMENT_VARIABLES" > "$dir/environment-variables.json"
          printf '%s' "$ENVIRONMENTS" > "$dir/environments.json"
          printf '%s' "$BRANCH_POLICIES" > "$dir/branch-policies.json"
          printf '%s' "$RELEASES" > "$dir/releases.json"
          printf '%s' "$MERGE_OPTIONS" > "$dir/merge-options.json"
      - id: compare
        run: |
          set -o pipefail
          node src/settings.ts "$RUNNER_TEMP/settings" | tee "$RUNNER_TEMP/findings.txt"
      - name: Report the drift in an issue
        if: failure() && steps.compare.outcome == 'failure'
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          set -euo pipefail
          run_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
          body="$(printf 'The weekly settings check found drift.\\n\\nFindings:\\n\\n%s\\n\\nRun: %s\\n' "$(cat "$RUNNER_TEMP/findings.txt")" "$run_url")"
          number="$(gh api "repos/ircx-io/ircx-docs/issues?state=open&labels=settings-drift" --jq '[.[] | select(.user.login == "github-actions[bot]" and (.pull_request | not))][0].number // ""')"
          if [[ "$number" =~ ^[1-9][0-9]{0,9}$ ]]; then
            gh api -X POST "repos/ircx-io/ircx-docs/issues/$number/comments" -f "body=$body" > /dev/null
          else
            gh api -X POST repos/ircx-io/ircx-docs/issues -f "title=Weekly settings check found drift" -f "body=$body" -f "labels[]=settings-drift" > /dev/null
          fi
`,
});

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

interface Step {
  /** 0-based index of the step's first line. */
  readonly start: number;
  readonly lines: readonly string[];
  /** The action a `uses:` line names, without its pin. */
  readonly uses: string | undefined;
}

interface Job {
  readonly name: string;
  readonly start: number;
  readonly lines: readonly string[];
  readonly steps: readonly Step[];
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Splits the `jobs:` mapping into jobs (two-space keys) and their steps (six-space items). */
function parseJobs(lines: readonly string[]): Job[] {
  const jobs: Job[] = [];
  const top = lines.findIndex((l) => l === 'jobs:');
  if (top < 0) {
    return jobs;
  }
  const starts: Array<{ name: string; start: number }> = [];
  let end = lines.length;
  for (let i = top + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\S/.test(line)) {
      end = i;
      break;
    }
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m !== null) {
      starts.push({ name: m[1] ?? '', start: i });
    }
  }
  starts.forEach((s, n) => {
    const stop = starts[n + 1]?.start ?? end;
    const body = lines.slice(s.start, stop);
    const steps: Step[] = [];
    const stepStarts = body.map((l, i) => (/^ {6}- /.test(l) ? i : -1)).filter((i) => i >= 0);
    stepStarts.forEach((first, k) => {
      let last = stepStarts[k + 1] ?? body.length;
      while (last > first + 1 && !/^ {7,}\S/.test(body[last - 1] ?? '')) {
        last--;
      }
      const stepLines = body.slice(first, last);
      const uses = stepLines.map((l) => /^\s*(?:- )?uses: ([^@\s]+)/.exec(l)?.[1]).find((u) => u !== undefined);
      steps.push({ start: s.start + first, lines: stepLines, uses });
    });
    jobs.push({ name: s.name, start: s.start, lines: body, steps });
  });
  return jobs;
}

/** The 0-based indices of the lines that hold shell text: a `run:` value and its block. */
function runLines(lines: readonly string[]): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = /^(\s*)(- )?run:(.*)$/.exec(line);
    if (m === null) {
      continue;
    }
    out.add(i);
    const keyIndent = (m[1] ?? '').length + (m[2] ?? '').length;
    if (/^\s*[|>][-+]?\s*$/.test(m[3] ?? '')) {
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j] ?? '';
        if (next.trim() !== '' && indentOf(next) <= keyIndent) {
          break;
        }
        out.add(j);
      }
    }
  }
  return out;
}

/**
 * What can stand right before a command word in the shell: whitespace (a shell
 * line keeps its YAML indentation, so this covers the start of a line), a
 * separator or an opening `(` or `{` (which covers `$(`), a backtick, a quote, a
 * backslash, or the `/` of a path such as `/usr/bin/env`.
 */
const WORD_BEFORE = '[\\s;&|({`\'"\\\\/]';
/** What can end a command word: the end of the line, whitespace, a separator, a closing `)` or `}`, a backtick, a quote or a redirection. */
const WORD_AFTER = '(?=$|[\\s;&|)}`\'"<>])';

/** A command word matching `name` (a regex alternative), at any shell boundary. */
function commandWord(name: string, flags = ''): RegExp {
  return new RegExp(`${WORD_BEFORE}(?:${name})${WORD_AFTER}`, flags);
}

/** Text in a key job's shell that runs repository code or a script (rule W10). */
const KEY_JOB_FORBIDDEN: readonly RegExp[] = [
  commandWord('node|npm|npx|source'),
  new RegExp(`${WORD_BEFORE}(?:bash|sh)\\s+[^-\\s]`),
  /(?:^\s*|[;&|({`]\s*)\.\s+\S/,
  /(?:^|[\s"'=(])(?:\.\/|src\/|test\/|content\/|\.github\/)/,
];

/** The `secrets` context inside an expression; a name such as `outputs.actions-secrets` is not it. */
const SECRETS_CONTEXT = /\$\{\{.*(?<![\w.-])secrets(?![\w-])/;

/** Applies the structural rules W5 to W14 to one workflow file. */
export function structuralFindings(name: string, text: string): Finding[] {
  const file = `.github/workflows/${name}`;
  const findings: Finding[] = [];
  const push = (line: number | undefined, rule: string, message: string): void => {
    findings.push(line === undefined ? { file, rule, message } : { file, line: line + 1, rule, message });
  };
  const lines = text.split('\n');
  const shell = runLines(lines);
  const jobs = parseJobs(lines);
  const stepAt = (i: number): Step | undefined => {
    for (const job of jobs) {
      for (const step of job.steps) {
        if (i >= step.start && i < step.start + step.lines.length) {
          return step;
        }
      }
    }
    return undefined;
  };
  const keyJob = KEY_JOBS[name];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    // W5: shell text never interpolates an expression.
    if (shell.has(i) && line.includes('${{')) {
      push(i, 'W5', 'an expression inside a run: block');
    }
    // W6: secrets reach a workflow only through the private-key input of an App token step in a key workflow.
    const readsSecrets = SECRETS_CONTEXT.test(line) || /(?<![\w.-])secrets\s*:\s*inherit\b/.test(line);
    if (readsSecrets) {
      const ok = line.trim() === PRIVATE_KEY_LINE && keyJob !== undefined && stepAt(i)?.uses === APP_TOKEN_ACTION;
      if (!ok) {
        push(i, 'W6', 'secrets are read outside the private-key input of an App token step');
      }
    }
    // W8: pull_request_target only in labels.yml.
    if (line.includes('pull_request_target') && name !== 'labels.yml') {
      push(i, 'W8', 'pull_request_target outside labels.yml');
    }
    if (name === 'labels.yml' && USES_ANY.test(line)) {
      push(i, 'W8', 'labels.yml runs no action');
    }
    // W9: no broad or write token grant.
    if (/id-token|write-all|(?<![\w-])actions:\s*write|(?<![\w-])contents:\s*write/.test(line)) {
      push(i, 'W9', 'a broad or write token permission');
    }
    // W12: no github.actor and no debug switch.
    if (/github\.actor|set -x|GH_DEBUG|ACTIONS_STEP_DEBUG/.test(line)) {
      push(i, 'W12', 'github.actor or a debug switch');
    }
  }

  // W7: exactly one environment, ircx-bot, on the key job of a key workflow; none elsewhere.
  const envLines = lines.map((l, i) => (/^\s*environment:/.test(l) ? i : -1)).filter((i) => i >= 0);
  if (keyJob === undefined) {
    for (const i of envLines) {
      push(i, 'W7', 'an environment outside a key workflow');
    }
  } else {
    const owner = jobs.find((j) => j.name === keyJob);
    const good = envLines.filter((i) => lines[i] === '    environment: ircx-bot' && owner !== undefined && i > owner.start && i < owner.start + owner.lines.length);
    if (envLines.length !== 1 || good.length !== 1) {
      push(envLines[0], 'W7', `exactly one environment: ircx-bot, on job ${keyJob}`);
    }
  }

  // W9: top-level permissions.
  if (name === 'ci.yml') {
    if (!text.includes('\npermissions:\n  contents: read\n')) {
      push(undefined, 'W9', 'ci.yml keeps top-level permissions: contents: read');
    }
  } else if (!lines.includes('permissions: {}')) {
    push(undefined, 'W9', 'top-level permissions: {}');
  }

  // W10: a job that names an environment runs only App token steps and its own shell text.
  for (const job of jobs) {
    if (!job.lines.some((l) => /^\s*environment:/.test(l))) {
      continue;
    }
    for (const step of job.steps) {
      if (step.uses !== undefined) {
        if (step.uses !== APP_TOKEN_ACTION) {
          push(step.start, 'W10', `job ${job.name} runs an action other than the App token`);
        }
        continue;
      }
      step.lines.forEach((l, k) => {
        if (shell.has(step.start + k)) {
          const body = l.replace(/^\s*(- )?run:\s*/, ' ');
          if (KEY_JOB_FORBIDDEN.some((re) => re.test(body))) {
            push(step.start + k, 'W10', `job ${job.name} runs repository code or a script`);
          }
        }
      });
    }
  }

  // W11: every App token step names this App, this owner and this repository, and asks for something.
  // In settings-check.yml every permission is read, except on the merge-token step, which W14 governs.
  for (const job of jobs) {
    for (const step of job.steps) {
      if (step.uses !== APP_TOKEN_ACTION) {
        continue;
      }
      const inputs = step.lines.map((l) => l.trim());
      const permissions = inputs.filter((l) => l.startsWith('permission-'));
      const problems: string[] = [];
      if (!inputs.some((l) => /^client-id: [A-Za-z0-9]+$/.test(l))) {
        problems.push('a literal client-id');
      }
      if (!inputs.includes('owner: ircx-io')) {
        problems.push('owner: ircx-io');
      }
      if (!inputs.includes('repositories: ircx-docs')) {
        problems.push('repositories: ircx-docs');
      }
      if (permissions.length === 0) {
        problems.push('at least one permission- input');
      }
      if (inputs.some((l) => l.startsWith('skip-token-revoke'))) {
        problems.push('no skip-token-revoke');
      }
      if (name === 'settings-check.yml' && stepId(step) !== MERGE_TOKEN && permissions.some((l) => !/^permission-[a-z-]+: read$/.test(l))) {
        problems.push('read permissions only');
      }
      if (problems.length > 0) {
        push(step.start, 'W11', `the App token step needs ${problems.join(', ')}`);
      }
    }
  }

  // W13: only ci.yml is named CI, because the merge workflow and the required check key on it.
  if (name !== 'ci.yml' && lines.includes('name: CI')) {
    push(undefined, 'W13', 'only ci.yml is named CI');
  }

  if (name === 'settings-check.yml') {
    mergeTokenFindings(lines, jobs, shell, push);
  }
  return findings;
}

const MERGE_TOKEN = 'merge-token';
const MERGE_OPTIONS = 'merge-options';
const MERGE_TOKEN_ENV = 'GH_TOKEN: ${{ steps.merge-token.outputs.token }}';
/** The one line of the merge-options shell that writes `GITHUB_OUTPUT`. */
const MERGE_OPTIONS_OUTPUT = `printf 'merge-options=%s\\n' "$value" >> "$GITHUB_OUTPUT"`;

/** The step's id, from a `- id:` first line or an `id:` key at step level. */
function stepId(step: Step): string | undefined {
  for (const line of step.lines) {
    const m = /^ {6}- id: (\S+)$|^ {8}id: (\S+)$/.exec(line);
    if (m !== null) {
      return m[1] ?? m[2];
    }
  }
  return undefined;
}

/** A `gh` command word; the match ends with the word. */
const GH_WORD = commandWord('gh', 'g');
/** An `env` command word, a path ending `/env` included. */
const ENV_WORD = commandWord('env');
/** A `set` command word not followed by an option. Bare `set` lists every variable. */
const BARE_SET = new RegExp(`${WORD_BEFORE}set${WORD_AFTER}(?!\\s+[-+])`);
/** The merge-options line that reads the repository's merge fields. */
const MERGE_OPTIONS_READ = `if ! value="$(gh api repos/ircx-io/ircx-docs | jq -c '{allow_squash_merge, allow_merge_commit, allow_rebase_merge, allow_auto_merge, delete_branch_on_merge}')"; then`;
/** The merge-options `run:` text from its `|` on, trimmed and without blank lines: the one form W14 accepts. */
const MERGE_OPTIONS_RUN: readonly string[] = ['|', 'set -uo pipefail', MERGE_OPTIONS_READ, 'value=""', 'fi', MERGE_OPTIONS_OUTPUT];
/** The merge-token step, line for line, with its `uses:` pin normalised as W4 normalises it. */
const MERGE_TOKEN_STEP: readonly string[] = [
  `      - id: ${MERGE_TOKEN}`,
  `        uses: ${APP_TOKEN_ACTION}@<sha> # <version>`,
  '        with:',
  '          client-id: Iv23liAz4GUkls9I3nc2',
  `          ${PRIVATE_KEY_LINE}`,
  '          owner: ircx-io',
  '          repositories: ircx-docs',
  '          permission-contents: write',
];
/** The merge-options step, line for line. */
const MERGE_OPTIONS_STEP: readonly string[] = [
  `      - id: ${MERGE_OPTIONS}`,
  '        env:',
  `          ${MERGE_TOKEN_ENV}`,
  '        run: |',
  '          set -uo pipefail',
  `          ${MERGE_OPTIONS_READ}`,
  '            value=""',
  '          fi',
  `          ${MERGE_OPTIONS_OUTPUT}`,
];
/**
 * Job read, line for line, with both `uses:` pins normalised as W4 normalises them.
 * It is written out rather than read from `CANONICAL`, so W14 does not depend on W4's canonical text.
 */
const READ_JOB: readonly string[] = [
  ...`  read:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    environment: ircx-bot
    permissions:
      actions: read
      contents: read
    outputs:
      repository: \${{ steps.read.outputs.repository }}
      actions-permissions: \${{ steps.read.outputs.actions-permissions }}
      selected-actions: \${{ steps.read.outputs.selected-actions }}
      workflow-permissions: \${{ steps.read.outputs.workflow-permissions }}
      fork-pr-approval: \${{ steps.read.outputs.fork-pr-approval }}
      vulnerability-alerts: \${{ steps.read.outputs.vulnerability-alerts }}
      private-vulnerability-reporting: \${{ steps.read.outputs.private-vulnerability-reporting }}
      rulesets: \${{ steps.read.outputs.rulesets }}
      actions-secrets: \${{ steps.read.outputs.actions-secrets }}
      dependabot-secrets: \${{ steps.read.outputs.dependabot-secrets }}
      environment-secrets: \${{ steps.read.outputs.environment-secrets }}
      environment-variables: \${{ steps.read.outputs.environment-variables }}
      environments: \${{ steps.read.outputs.environments }}
      branch-policies: \${{ steps.read.outputs.branch-policies }}
      releases: \${{ steps.read.outputs.releases }}
      merge-options: \${{ steps.merge-options.outputs.merge-options }}
    steps:
      - id: token
        uses: actions/create-github-app-token@<sha> # <version>
        with:
          client-id: Iv23liAz4GUkls9I3nc2
          private-key: \${{ secrets.IRCX_BOT_PRIVATE_KEY }}
          owner: ircx-io
          repositories: ircx-docs
          permission-administration: read
          permission-secrets: read
          permission-dependabot-secrets: read
          permission-environments: read
      - id: read
        env:
          APP_TOKEN: \${{ steps.token.outputs.token }}
          JOB_TOKEN: \${{ github.token }}
        run: |
          set -uo pipefail
          repo=repos/ircx-io/ircx-docs
          record() {
            printf '%s=%s\\n' "$1" "$2" >> "$GITHUB_OUTPUT"
          }
          with_app() {
            local value
            if value="$(GH_TOKEN="$APP_TOKEN" gh api "$2" | jq -c .)"; then record "$1" "$value"; else record "$1" ""; fi
          }
          with_job() {
            local value
            if value="$(GH_TOKEN="$JOB_TOKEN" gh api --paginate "$2" | jq -c -s .)"; then record "$1" "$value"; else record "$1" ""; fi
          }
          with_app repository "$repo"
          with_app actions-permissions "$repo/actions/permissions"
          with_app selected-actions "$repo/actions/permissions/selected-actions"
          with_app workflow-permissions "$repo/actions/permissions/workflow"
          with_app fork-pr-approval "$repo/actions/permissions/fork-pr-contributor-approval"
          with_app private-vulnerability-reporting "$repo/private-vulnerability-reporting"
          with_app actions-secrets "$repo/actions/secrets"
          with_app dependabot-secrets "$repo/dependabot/secrets"
          with_app environment-secrets "$repo/environments/ircx-bot/secrets"
          with_app environment-variables "$repo/environments/ircx-bot/variables"
          if alerts="$(GH_TOKEN="$APP_TOKEN" gh api "$repo/vulnerability-alerts" 2>&1)"; then
            record vulnerability-alerts '{"enabled":true}'
          else
            case "$alerts" in
              *"(HTTP 404)"*) record vulnerability-alerts '{"enabled":false}' ;;
              *) record vulnerability-alerts "" ;;
            esac
          fi
          rulesets=""
          if ids="$(GH_TOKEN="$APP_TOKEN" gh api "$repo/rulesets" --jq '.[].id')"; then
            rulesets="[]"
            for id in $ids; do
              [[ "$id" =~ ^[0-9]{1,12}$ ]] || { rulesets=""; break; }
              one="$(GH_TOKEN="$APP_TOKEN" gh api "$repo/rulesets/$id" | jq -c .)" || { rulesets=""; break; }
              rulesets="$(jq -c --argjson one "$one" '. + [$one]' <<< "$rulesets")" || { rulesets=""; break; }
            done
          fi
          record rulesets "$rulesets"
          with_job environments "$repo/environments"
          with_job branch-policies "$repo/environments/ircx-bot/deployment-branch-policies"
          with_job releases "$repo/releases"`.split('\n'),
  ...MERGE_TOKEN_STEP,
  ...MERGE_OPTIONS_STEP,
];
/** The word `steps` in any case, outside a longer name. The caller strips a `steps:` key first. */
const STEPS_WORD = /(?<![\w-])steps(?![\w-])/gi;
/** The one shape a `steps` reference may take: one step's named output, or its outcome. */
const STEPS_REFERENCE = /^steps\.[a-z][a-z0-9-]*\.(?:outputs\.[a-z][a-z0-9-]*|outcome)(?![\w.[])/;
/** Text the merge-options shell never holds: a verb or field flag, another endpoint kind, the token's name, or an environment dump. */
const MERGE_OPTIONS_FORBIDDEN: readonly string[] = ['-X', '--method', '-f ', '-F ', '--field', '--raw-field', '--input', '--paginate', 'graphql', 'GH_TOKEN', 'printenv', 'declare', 'export', '/proc/'];
const FILE_COMMANDS: readonly string[] = ['GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_STEP_SUMMARY', 'GITHUB_STATE'];

/**
 * W14 (settings-check.yml): the Contents-write token is minted only as the
 * second-to-last step of the read job and reaches only the last step,
 * `merge-options`, through one env key; that step makes one GET of the
 * repository and writes only its own output. The pins cover the lines
 * `parseJobs` sees and the `defaults:` and `env:` spellings clause 1 matches;
 * a column-0 comment inside job read or a workflow-level complex key escapes
 * them, and W4 alone catches those.
 */
function mergeTokenFindings(lines: readonly string[], jobs: readonly Job[], shell: ReadonlySet<number>, push: (line: number | undefined, rule: string, message: string) => void): void {
  // No default shell or working directory, and no env that every step of a job inherits.
  lines.forEach((line, i) => {
    if (/^\s*(?:- )?["']?defaults["']?\s*:/.test(line)) {
      push(i, 'W14', 'no defaults: key');
    }
    const env = /^(\s*)(- )?["']?env["']?\s*:/.exec(line);
    if (env !== null && (env[1] ?? '').length + (env[2] ?? '').length < 8) {
      push(i, 'W14', 'no env: key at workflow or job level');
    }
  });

  // (a) Exactly two App token steps, both in read; merge-token asks for Contents write alone.
  const mints = jobs.flatMap((job) => job.steps.filter((s) => s.uses === APP_TOKEN_ACTION).map((step) => ({ job: job.name, step })));
  if (mints.length !== 2 || mints.some((m) => m.job !== 'read')) {
    push(mints[0]?.step.start, 'W14', 'exactly two App token steps, both in job read');
  }
  const mint = mints.find((m) => m.job === 'read' && stepId(m.step) === MERGE_TOKEN)?.step;
  const permissions = mint?.lines.map((l) => l.trim()).filter((l) => l.startsWith('permission-')) ?? [];
  if (mint === undefined || permissions.length !== 1 || permissions[0] !== 'permission-contents: write') {
    push(mint?.start, 'W14', 'the merge-token step asks for permission-contents: write alone');
  }

  // (b) In read, merge-token follows the step read, and merge-options follows merge-token as the last step.
  const steps = jobs.find((j) => j.name === 'read')?.steps ?? [];
  const ids = steps.map(stepId);
  if (!ids.slice(0, -2).includes('read') || ids.slice(-2).join(' ') !== `${MERGE_TOKEN} ${MERGE_OPTIONS}`) {
    push(steps[0]?.start, 'W14', 'job read ends with merge-token and then merge-options, after the step read');
  }

  // (c) The token is named once, as the only env key of merge-options.
  const step = steps.find((s) => stepId(s) === MERGE_OPTIONS);
  const uses = lines.filter((l) => l.includes('steps.merge-token.outputs')).length;
  const envAt = step?.lines.findIndex((l) => l === '        env:') ?? -1;
  const env: string[] = [];
  if (step !== undefined && envAt >= 0) {
    for (const line of step.lines.slice(envAt + 1)) {
      if (line.trim() !== '' && indentOf(line) <= 8) {
        break;
      }
      if (line.trim() !== '') {
        env.push(line.trim());
      }
    }
  }
  if (uses !== 1 || env.length !== 1 || env[0] !== MERGE_TOKEN_ENV) {
    push(step?.start, 'W14', `the merge-token output is read once, as the only env key of merge-options: ${MERGE_TOKEN_ENV}`);
  }
  // Every steps reference names one step's output or outcome, so no index, wildcard or whole-context form reaches the token.
  lines.forEach((line, i) => {
    const text = line.replace(/^\s*steps\s*:/, '');
    for (const m of text.matchAll(STEPS_WORD)) {
      if (!STEPS_REFERENCE.test(text.slice(m.index))) {
        push(i, 'W14', 'every steps reference has the form steps.<id>.outputs.<name> or steps.<id>.outcome');
      }
    }
  });
  if (lines.filter((l) => /merge-token/i.test(l)).length !== 2) {
    push(undefined, 'W14', `merge-token is named on exactly two lines: - id: ${MERGE_TOKEN} and ${MERGE_TOKEN_ENV}`);
  }
  // No line of job read outside merge-options names GITHUB_ENV or GITHUB_PATH. The job pin below holds the rest of the lines `parseJobs` sees; a column-0 comment ends that view, and W4 alone stands there.
  const read = jobs.find((j) => j.name === 'read');
  read?.lines.forEach((line, k) => {
    const i = read.start + k;
    const inOptions = step !== undefined && i >= step.start && i < step.start + step.lines.length;
    if (!inOptions && /GITHUB_ENV|GITHUB_PATH/.test(line)) {
      push(i, 'W14', 'no GITHUB_ENV or GITHUB_PATH in job read');
    }
  });
  // The whole merge-token step is pinned, so no added input (github-api-url, enterprise) or step key changes the mint.
  const mintStep = steps.find((s) => stepId(s) === MERGE_TOKEN);
  const mintLines = mintStep === undefined ? [] : normalise('', mintStep.lines.join('\n'), new Map()).text.split('\n');
  if (!sameLines(mintLines, MERGE_TOKEN_STEP)) {
    push(mintStep?.start, 'W14', 'the merge-token step is exactly its canonical lines, its uses: pin aside');
  }

  // (d) The shell makes one GET of the repository and writes only its own output line.
  // Each problem is its own finding, so one line that breaks two clauses names both.
  const body = step === undefined ? [] : step.lines.filter((_, k) => shell.has(step.start + k)).map((l) => l.replace(/^\s*(- )?run:\s*/, ' '));
  const words = body.flatMap((l) => [...l.matchAll(GH_WORD)].map((m) => l.slice((m.index ?? 0) + m[0].length - 2)));
  const problems: string[] = [];
  if (words.length !== 1 || !/^gh api repos\/ircx-io\/ircx-docs\s+\|/.test(words[0] ?? '')) {
    problems.push('exactly one gh command, gh api repos/ircx-io/ircx-docs into a pipe');
  }
  const text = body.join('\n');
  for (const word of MERGE_OPTIONS_FORBIDDEN) {
    if (text.includes(word)) {
      problems.push(`no ${word.trim()}`);
    }
  }
  if (body.some((l) => ENV_WORD.test(l))) {
    problems.push('no env command');
  }
  if (body.some((l) => BARE_SET.test(l))) {
    problems.push('no set without an option');
  }
  for (const name of FILE_COMMANDS) {
    if (text.includes(name)) {
      problems.push(`no ${name}`);
    }
  }
  if (body.some((l) => l.includes('GITHUB_OUTPUT') && l.trim() !== MERGE_OPTIONS_OUTPUT)) {
    problems.push(`GITHUB_OUTPUT written only by ${MERGE_OPTIONS_OUTPUT}`);
  }
  const run = body.map((l) => l.trim()).filter((l) => l !== '');
  if (run.length !== MERGE_OPTIONS_RUN.length || run.some((l, k) => l !== MERGE_OPTIONS_RUN[k])) {
    problems.push('its run text to be exactly the lines of its canonical form');
  }
  for (const problem of problems) {
    push(step?.start, 'W14', `the merge-options step needs ${problem}`);
  }
  // The whole merge-options step is pinned, so no shell:, working-directory: or other step key changes how its run text runs.
  if (step === undefined || !sameLines(step.lines, MERGE_OPTIONS_STEP)) {
    push(step?.start, 'W14', 'the merge-options step is exactly its canonical lines');
  }
  // Job read as `parseJobs` sees it is pinned, so a changed job key (container, runs-on) or added shell in the step read fails W14. `parseJobs` stops at a column-0 line, a comment included, so lines after one are not compared here.
  const readLines = read === undefined ? [] : normalise('', read.lines.join('\n'), new Map()).text.split('\n');
  while (readLines.length > 0 && (readLines.at(-1) ?? '').trim() === '') {
    readLines.pop();
  }
  if (!sameLines(readLines, READ_JOB)) {
    push(read?.start, 'W14', 'job read is exactly its canonical lines, its uses: pins aside');
  }
}

function sameLines(got: readonly string[], want: readonly string[]): boolean {
  return got.length === want.length && got.every((l, k) => l === want[k]);
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
    findings.push(...structuralFindings(name, text));
    const canonical = CANONICAL[name] ?? '';
    if (normalised.text !== canonical) {
      const got = normalised.text.split('\n');
      const want = canonical.split('\n');
      let line = 0;
      while (line < got.length && line < want.length && got[line] === want[line]) {
        line++;
      }
      findings.push({ file, line: line + 1, rule: 'W4', message: 'differs from the canonical workflow' });
    }
  }
  return findings;
}
