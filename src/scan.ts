// Publication-boundary scan. Run over the tracked tree (or over a plain
// directory with --dir), it checks each file's path and contents and
// reports anything that should not appear in a public repository or site:
// credential shapes, local paths, e-mail addresses, hosts and repositories
// off the allowlists, IPv4 literals, 32-hex identifiers and the clean-room
// reference names. Allowlists only: there is no denylist of private names,
// which would publish them. A finding prints the rule id, path and line,
// never the matched line, because CI logs are public. A finding in a path
// has no line, and the path it prints is the text that matched.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { formatFinding, type Finding } from './text.ts';

/** The hosts content may link to. */
export const EXTERNAL_HOSTS: readonly string[] = Object.freeze([
  'ircx.io',
  'www.rfc-editor.org',
  'datatracker.ietf.org',
  'creativecommons.org',
  'opensource.org',
  'docs.github.com',
  'github.com',
]);

/** The only repository path a `github.com` reference may name. */
export const GITHUB_REPO_PATH = '/ircx-io/ircx-docs';

/** Hosts the scan accepts beyond the link allowlist. */
export const SCAN_EXTRA_HOSTS: readonly string[] = Object.freeze([
  'dir.ircx.io',
  'chat.ircx.io',
  // The CC BY 4.0 legal code in LICENSE links here.
  'wiki.creativecommons.org',
  // Lockfile entries resolve here, and the tests that check the lockfile name it.
  'registry.npmjs.org',
]);

/** Reserved top-level names (RFC 2606, RFC 6761) that cannot name a real host. */
const RESERVED_TLDS: readonly string[] = Object.freeze(['example', 'invalid', 'test', 'localhost']);

/** `ircx-` tokens the scan accepts. */
export const ALLOWED_REPO_TOKENS: readonly string[] = Object.freeze(['ircx-docs', 'ircx-io']);

/** IPv4 literals the scan accepts: loopback and the unspecified address. */
const ALLOWED_IPV4: readonly string[] = Object.freeze(['127.0.0.1', '0.0.0.0']);

/** SHA-256 digests of the clean-room reference words (rule S8). */
export const REFERENCE_WORD_DIGESTS: ReadonlySet<string> = new Set([
  'ae15257be7ca21d3bbfa15e9c59b9d62855172f4009383cb468aef886e8f0ca0',
  '2e7239075fd438b44f548dc6c4765fb1d473c500bf15cfec202ae0537f913342',
  '2d0d38e68843216f183110ca3f4212682e1ccf86371e15fbdc0a3f24e697cfe0',
  '94805aea13420685a2929f6859071e2e12d650c6609c0d91ed602a9bf227af39',
  '6e3fd0b70aa5c52721d996ac6485608b4b1d6a9066541778c2b8bb920742a54f',
  'f6ebf749f9339f44e8a5ff914f8d9f169549d4f65b5c82da2af55f73834f8782',
  '79eb99d1113252a8251e1589f7e0c20fbb4826ff0a96666fb7787133f379b08e',
]);

/** The only tracked file the scan skips; the dependency test covers it. */
export const EXCLUDED_FILES: readonly string[] = Object.freeze(['package-lock.json']);

const RULE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  S0: 'file is unreadable, not valid UTF-8, or contains NUL',
  S1: 'credential-shaped text',
  S2: 'a local filesystem path',
  S3: 'an e-mail address',
  S4: 'a host that is not on the allowlist',
  S5: 'a repository reference that is not on the allowlist',
  S6: 'an IPv4 literal',
  S7: 'a 32-hex identifier',
  S8: 'a clean-room reference name',
});

const S1_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /Account[K]ey=/,
  /[?&]sig=[A-Za-z0-9%]{16,}/,
  /(?:key|secret|password|passwd|token)["']?\s*[:=]\s*["']?[A-Za-z0-9+/_-]{24,}/i,
];
const S2_PATTERN = /\/Users\/|\/home\/[a-z_][a-z0-9_-]*\/|\b[A-Za-z]:\\Users\\/;
const S3_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const SCHEME_HOST = /\b[a-z][a-z0-9+.-]*:\/\/([^\s/?#"'`<>()[\]{}\\]+)/gi;
const BARE_HOST = /(?<![A-Za-z0-9.@-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|dev|app|cloud|ai|nl)(?![A-Za-z0-9-])/gi;
const REPO_TOKEN = /(?<![A-Za-z0-9-])ircx-[a-z0-9-]+/gi;
const GITHUB_REPO = /(?<![A-Za-z0-9.-])github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/gi;
// Every `github.com` host, with what follows it up to the first character no URL carries. A dot
// and a letter after it continue a longer host name, which rule S4 judges.
const GITHUB_HOST_TAIL = /(?<![A-Za-z0-9.-])github\.com(?![A-Za-z0-9-]|\.[A-Za-z0-9])([^\s"'`<>()[\]{}\\]*)/gi;
// The site root, the organisation, or this repository and then the end or a path, query or fragment.
const GITHUB_TAIL_ALLOWED = /^(?:\/(?:ircx-io\/?)?|\/ircx-io\/ircx-docs(?:\.git)?(?:[/?#].*)?)?$/i;
const IPV4 = /(?<![0-9.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![0-9.])/g;
const HEX32 = /\b[0-9a-f]{32}\b/i;

/**
 * True when the text after a `github.com` host names this repository or no repository: no port or
 * scp-style colon, no `%`, no `//`, and no `.` or `..` segment that could walk to another path. One
 * trailing sentence mark is not part of the URL.
 */
function githubTailAllowed(tail: string): boolean {
  const t = /[.,;!]$/.test(tail) ? tail.slice(0, -1) : tail;
  if (t.includes('%') || t.includes('//') || !GITHUB_TAIL_ALLOWED.test(t)) {
    return false;
  }
  const path = t.split(/[?#]/, 1)[0] ?? '';
  return !path.split('/').some((segment) => segment === '.' || segment === '..');
}

function hostAllowed(host: string): boolean {
  const h = host.toLowerCase();
  if (EXTERNAL_HOSTS.includes(h) || SCAN_EXTRA_HOSTS.includes(h) || ALLOWED_IPV4.includes(h)) {
    return true;
  }
  const tld = h.split('.').pop() ?? '';
  return RESERVED_TLDS.includes(tld);
}

/** Returns the rule ids that `line` trips, in rule order. */
export function scanLine(line: string): string[] {
  const rules = new Set<string>();
  if (S1_PATTERNS.some((re) => re.test(line))) {
    rules.add('S1');
  }
  if (S2_PATTERN.test(line)) {
    rules.add('S2');
  }
  if (S3_PATTERN.test(line)) {
    rules.add('S3');
  }
  for (const m of line.matchAll(SCHEME_HOST)) {
    let host = m[1] ?? '';
    if (host.includes('@')) {
      rules.add('S4');
      continue;
    }
    host = host.replace(/:\d*$/, '').replace(/\.$/, '');
    if ((host.includes('.') || /^\d/.test(host)) && !hostAllowed(host)) {
      rules.add('S4');
    }
  }
  for (const m of line.matchAll(BARE_HOST)) {
    if (!hostAllowed(m[0])) {
      rules.add('S4');
    }
  }
  for (const m of line.matchAll(REPO_TOKEN)) {
    if (!ALLOWED_REPO_TOKENS.includes(m[0].toLowerCase())) {
      rules.add('S5');
    }
  }
  for (const m of line.matchAll(GITHUB_REPO)) {
    const path = `/${m[1] ?? ''}/${(m[2] ?? '').replace(/\.git$/, '')}`;
    if (path.toLowerCase() !== GITHUB_REPO_PATH) {
      rules.add('S5');
    }
  }
  for (const m of line.matchAll(GITHUB_HOST_TAIL)) {
    if (!githubTailAllowed(m[1] ?? '')) {
      rules.add('S5');
    }
  }
  for (const m of line.matchAll(IPV4)) {
    const octets = [m[1], m[2], m[3], m[4]].map(Number);
    if (octets.every((o) => o <= 255) && !ALLOWED_IPV4.includes(m[0])) {
      rules.add('S6');
    }
  }
  if (HEX32.test(line)) {
    rules.add('S7');
  }
  for (const token of line.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token !== '' && REFERENCE_WORD_DIGESTS.has(createHash('sha256').update(token).digest('hex'))) {
      rules.add('S8');
      break;
    }
  }
  return [...rules].sort();
}

/** Scans one file's bytes; `file` is the display path. */
export function scanBytes(file: string, bytes: Uint8Array): Finding[] {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return [{ file, rule: 'S0', message: RULE_MESSAGES.S0 ?? '' }];
  }
  if (text.includes('\0')) {
    return [{ file, rule: 'S0', message: RULE_MESSAGES.S0 ?? '' }];
  }
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const rule of scanLine(lines[i] ?? '')) {
      findings.push({ file, line: i + 1, rule, message: RULE_MESSAGES[rule] ?? '' });
    }
  }
  return findings;
}

/** Scans one file: its display path with the line rules, then its bytes. */
function scanPath(display: string, path: string): Finding[] {
  const pathFindings: Finding[] = scanLine(display).map((rule) => ({
    file: display,
    rule,
    message: RULE_MESSAGES[rule] ?? '',
  }));
  let bytes: Uint8Array;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) {
      return [...pathFindings, { file: display, rule: 'S0', message: 'not a regular file' }];
    }
    bytes = readFileSync(path);
  } catch {
    return [...pathFindings, { file: display, rule: 'S0', message: RULE_MESSAGES.S0 ?? '' }];
  }
  return [...pathFindings, ...scanBytes(display, bytes)];
}

function walkDir(dir: string, prefix: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    const path = join(dir, name);
    let isDir = false;
    try {
      const stat = lstatSync(path);
      isDir = stat.isDirectory();
    } catch {
      // Reported as unreadable by scanPath.
    }
    if (isDir) {
      walkDir(path, rel, out);
    } else {
      out.push(rel);
    }
  }
}

/** Lists the repository's files: tracked, plus untracked files git does not ignore. */
export function listRepositoryFiles(root: string): string[] {
  const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(output.split('\0').filter((p) => p !== ''))].sort();
}

/** Scans the repository at `root`: every listed file except the excluded ones. */
export function scanRepository(root: string): Finding[] {
  const findings: Finding[] = [];
  for (const rel of listRepositoryFiles(root)) {
    if (EXCLUDED_FILES.includes(rel)) {
      continue;
    }
    findings.push(...scanPath(rel, join(root, rel)));
  }
  return findings;
}

/** Scans every file under a plain directory, with no git and no exclusions. */
export function scanDirectory(dir: string): Finding[] {
  const files: string[] = [];
  walkDir(dir, '', files);
  return files.flatMap((rel) => scanPath(rel, join(dir, rel)));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let findings: Finding[];
  if (args.length === 2 && args[0] === '--dir' && args[1] !== undefined) {
    findings = scanDirectory(resolve(args[1]));
  } else if (args.length === 0) {
    findings = scanRepository(resolve(import.meta.dirname, '..'));
  } else {
    process.stderr.write('usage: npm run scan [-- --dir <path>]\n');
    process.exit(2);
  }
  for (const f of findings) {
    process.stderr.write(`${formatFinding(f)}\n`);
  }
  if (findings.length > 0) {
    process.stderr.write(`scan: ${findings.length} finding(s)\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('scan: no findings\n');
  }
}
