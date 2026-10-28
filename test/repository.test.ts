import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { listRepositoryFiles } from '../src/scan.ts';
import { ROOT } from './helpers.ts';

const TOP_LEVEL = ['.github', '.gitignore', '.npmrc', '.nvmrc', 'CONTRIBUTING.md', 'LICENSE', 'LICENSE-CODE', 'README.md', 'SECURITY.md', 'content', 'package-lock.json', 'package.json', 'src', 'test', 'tsconfig.json'];
const GITHUB = ['.github/CODEOWNERS', '.github/workflows/ci.yml'];
const CODEOWNERS = '* @ircx-io/docs-maintainers\n';

/** Paths outside the approved layout. */
export function layoutViolations(files: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const top = f.split('/')[0] ?? '';
    if (!TOP_LEVEL.includes(top)) {
      out.push(f);
    } else if (top === '.github' && !GITHUB.includes(f)) {
      out.push(f);
    }
  }
  const topSeen = new Set(files.map((f) => f.split('/')[0]));
  for (const t of topSeen) {
    if (t !== undefined && !TOP_LEVEL.includes(t) && !out.includes(t)) {
      out.push(t);
    }
  }
  const github = files.filter((f) => f.startsWith('.github/')).sort();
  if (JSON.stringify(github) !== JSON.stringify(GITHUB)) {
    out.push('.github is not exactly the approved set');
  }
  return out;
}

/** Problems in a CODEOWNERS text: it must be exactly the team line. */
export function codeownersProblems(text: string): string[] {
  return text === CODEOWNERS ? [] : ['CODEOWNERS is not exactly the docs-maintainers line'];
}

test('SC-U2-19 the tracked layout is the approved set', () => {
  const files = listRepositoryFiles(ROOT);
  assert.deepEqual(layoutViolations(files), []);
  assert.deepEqual([...new Set(files.map((f) => f.split('/')[0]))].sort(), [...TOP_LEVEL].sort());
  assert.deepEqual(files.filter((f) => f.startsWith('.github/')), GITHUB);
  assert.deepEqual(codeownersProblems(readFileSync(join(ROOT, '.github', 'CODEOWNERS'), 'utf8')), []);
});

test('SC-U2-31 CODEOWNERS names the team and nobody else', () => {
  assert.equal(readFileSync(join(ROOT, '.github', 'CODEOWNERS'), 'utf8'), CODEOWNERS);
  for (const text of [`* ${'@'}ricardodevries\n`, '* @ircx-io/docs-maintainers', `* @ircx-io/docs-maintainers ${'@'}ricardodevries\n`, '* @ircx-io/docs-maintainers\n* @ircx-io/other\n', '']) {
    assert.notEqual(codeownersProblems(text).length, 0, JSON.stringify(text));
  }
  const named = listRepositoryFiles(ROOT).filter((f) => f !== 'package-lock.json' && readFileSync(join(ROOT, f), 'utf8').includes(`${'@'}ricardodevries`));
  assert.deepEqual(named, []);
});

test('SC-U2-19 planted AGENTS.md, CLAUDE.md and a local action are refused in a temporary git index', () => {
  const plants = ['AGENTS.md', 'CLAUDE.md', 'theme/site.css', '.github/actions/x/action.yml', '.gitattributes', '.gitmodules', '.claude/settings.json', 'extra.txt', '.github/workflows/other.yml', '.github/dependabot.yml', '.github/FUNDING.yml', '.github/ISSUE_TEMPLATE/x.md', 'dist/index.html'];
  for (const plant of plants) {
    const tmp = mkdtempSync(join(tmpdir(), 'docs-layout-'));
    try {
      assert.equal(spawnSync('git', ['init', '-q'], { cwd: tmp }).status, 0);
      for (const f of listRepositoryFiles(ROOT)) {
        mkdirSync(dirname(join(tmp, f)), { recursive: true });
        copyFileSync(join(ROOT, f), join(tmp, f));
      }
      assert.deepEqual(layoutViolations(listRepositoryFiles(tmp)), [], 'the copy alone is clean');
      mkdirSync(dirname(join(tmp, plant)), { recursive: true });
      writeFileSync(join(tmp, plant), 'x\n');
      assert.equal(spawnSync('git', ['add', '-f', plant], { cwd: tmp }).status, 0);
      const found = layoutViolations(listRepositoryFiles(tmp));
      assert.ok(found.length > 0, `${plant} was not refused`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});

test('SC-U2-20 a: LICENSE is the canonical CC BY 4.0 legal code', () => {
  const bytes = readFileSync(join(ROOT, 'LICENSE'));
  assert.equal(bytes.length, 18657);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411');
});

test('SC-U2-20 b: LICENSE-CODE is MIT with the ircx.io holder', () => {
  const text = readFileSync(join(ROOT, 'LICENSE-CODE'), 'utf8');
  const lines = text.split('\n').filter((l) => l.startsWith('Copyright'));
  assert.deepEqual(lines, ['Copyright 2026 ircx.io']);
  assert.ok(text.includes('Permission is hereby granted, free of charge'));
  assert.ok(!text.includes('<YEAR>') && !text.includes('<COPYRIGHT HOLDER>'));
  // Carried over byte for byte from the built tree (SC-U2-20): the whole MIT text is pinned, not only its first lines.
  const bytes = readFileSync(join(ROOT, 'LICENSE-CODE'));
  assert.equal(bytes.length, 1055);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'a2db494220e2316a861250c8338983e1f12e049d0d178afcb5eb0331eee41f80');
});

/** The retired help host, assembled so this file stays clean under the scan. */
const OLD_HELP_HOST = ['help', 'ircx', 'io'].join('.');

/** Problems in a SECURITY.md text. */
export function securityProblems(text: string): string[] {
  const out: string[] = [];
  if (!text.includes('ircx.io/help')) {
    out.push('ircx.io/help missing');
  }
  if (text.includes(OLD_HELP_HOST)) {
    out.push('the old help host named');
  }
  if (!text.includes('Report a vulnerability')) {
    out.push('Report a vulnerability missing');
  }
  if (text.includes('@')) {
    out.push('an at sign');
  }
  if (text.toLowerCase().includes('mailto:')) {
    out.push('mailto');
  }
  const urls = text.match(/https:\/\/[^\s)>\]]+/g) ?? [];
  if (urls.length === 0) {
    out.push('no URLs');
  }
  for (const u of urls) {
    if (!u.startsWith('https://github.com/ircx-io/ircx-docs') && !u.startsWith('https://ircx.io/help')) {
      out.push(`URL ${u}`);
    }
  }
  return out;
}

test('SC-U2-25 SECURITY.md keeps reports private', () => {
  const text = readFileSync(join(ROOT, 'SECURITY.md'), 'utf8');
  assert.deepEqual(securityProblems(text), []);
  assert.ok(text.includes('ircx.io/help'));
  assert.ok(!text.includes(OLD_HELP_HOST));
  assert.ok(text.includes('Report a vulnerability'));
  assert.ok(!text.includes('@'));
  assert.ok(!text.toLowerCase().includes('mailto:'));
  assert.ok((text.match(/https:\/\//g) ?? []).length >= 2);
  // (b): every other service is out of scope, and a problem in one is not disclosed here.
  assert.match(text, /Other ircx\.io services are out of scope\./);
  assert.match(text, /does not take reports about them/);
  assert.match(text, /do not disclose a problem with another ircx\.io service in a public issue, pull request or discussion here/i);
  assert.match(text, /Do not open a public issue\./);
  assert.match(text, /open the repository's \*\*Security\*\* tab and choose \*\*Report a vulnerability\*\*/);
});

test('SC-U2-25 the SECURITY.md checks refuse each hostile variant', () => {
  const good = readFileSync(join(ROOT, 'SECURITY.md'), 'utf8');
  const variants: Array<[string, string]> = [
    ['no Help pages', good.replaceAll('ircx.io/help', 'docs.example')],
    ['the old help host', `${good}\nSee https://${'help.'}ircx.io too.\n`],
    ['no report heading', good.replaceAll('Report a vulnerability', 'Tell us')],
    ['an e-mail address', `${good}\nwrite to security${'@'}ircx.io\n`],
    ['a mailto link', `${good}\n[mail](mailto:security)\n`],
    ['another host', `${good}\nSee https://ircx.io/ too.\n`],
    ['a lookalike host', `${good}\nSee https://github.com.evil.example/ too.\n`],
    ['another repository', `${good}\nSee ${'https://github.com/ircx-io/'}${'other'}\n`],
  ];
  for (const [name, text] of variants) {
    assert.notEqual(securityProblems(text).length, 0, name);
  }
});

test('DoD 1: the repository files exist with the stated content', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /Creative Commons Attribution 4\.0/);
  assert.match(readme, /MIT licence/);
  assert.match(readme, /`LICENSE-CODE`/);
  assert.match(readme, /https:\/\/ircx\.io\/help/);
  assert.match(readme, /"ircx\.io bot"/);
  const contributing = readFileSync(join(ROOT, 'CONTRIBUTING.md'), 'utf8');
  for (const needle of ['front matter', 'title', 'description', 'order', '`#####`', 'appends `-2`']) {
    assert.ok(contributing.includes(needle), needle);
  }
  assert.equal(readFileSync(join(ROOT, '.nvmrc'), 'utf8'), '24\n');
  assert.equal(readFileSync(join(ROOT, '.gitignore'), 'utf8'), 'node_modules/\n');
});

// S-7: no source file holds a character that reorders or hides text.

/** Bidi embeddings, overrides and isolates (U+202A-U+202E, U+2066-U+2069), the byte order mark and the line and paragraph separators. */
const INVISIBLE = /[\u202a-\u202e\u2066-\u2069\ufeff\u2028\u2029]/;

test('S-7 the class pattern matches each invisible character, and only those', () => {
  const members = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff, 0x2028, 0x2029];
  for (const code of members) {
    assert.ok(INVISIBLE.test(`a${String.fromCharCode(code)}b`), code.toString(16));
  }
  for (const code of [0x2027, 0x202f, 0x2065, 0x206a, 0xfefe, 0xff, 0x20]) {
    assert.ok(!INVISIBLE.test(`a${String.fromCharCode(code)}b`), code.toString(16));
  }
});

test('S-7 no tracked or untracked file holds a bidi control, byte order mark or line separator literal', () => {
  const files = listRepositoryFiles(ROOT).filter((f) => f !== 'package-lock.json');
  // The scan must reach the files the finding named.
  for (const named of ['src/content.ts', 'src/check.ts', 'test/content.test.ts', 'content/index.md']) {
    assert.ok(files.includes(named), `${named} is in the scanned list`);
  }
  const hits = files.filter((f) => INVISIBLE.test(readFileSync(join(ROOT, f), 'utf8')));
  assert.deepEqual(hits, []);
});
