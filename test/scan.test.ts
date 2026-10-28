import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ALLOWED_REPO_TOKENS, EXCLUDED_FILES, listRepositoryFiles, REFERENCE_WORD_DIGESTS, scanBytes, scanDirectory, scanLine, scanRepository, SCAN_EXTRA_HOSTS } from '../src/scan.ts';
import { cat, ROOT } from './helpers.ts';

/** A 30-character opaque value that is not hex-only, so only the assignment rule reads it. */
const OPAQUE = 'Zq9_'.repeat(8).slice(0, 30);

/** One planted value per class, assembled at run time so this file holds no literal hit. */
const PLANTS: Record<string, string[]> = {
  S1: [
    cat('-----BEGIN ', 'RSA PRIVATE KEY-----'),
    cat('gh', 'p_', 'a'.repeat(36)),
    cat('github_', 'pat_', 'A'.repeat(30)),
    cat('Account', 'Key=abc'),
    cat('?s', 'ig=', 'a'.repeat(20)),
    cat('tok', 'en: ', 'A'.repeat(30)),
    cat('"pass', 'word": "', 'b'.repeat(30), '"'),
    cat('API_TO', 'KEN=', OPAQUE),
    cat('DATABASE_PASS', 'WORD=', OPAQUE),
    cat('AWS_SEC', 'RET_ACCESS_KE', 'Y=', OPAQUE),
    cat('IRC_SESSION_SEC', 'RET=', OPAQUE),
    cat('"api', 'Token": "', OPAQUE, '"'),
    cat('client', "Secret: '", OPAQUE, "'"),
    cat('DB_PASS', 'WD = ', OPAQUE),
    cat('my_ke', 'y : ', OPAQUE),
  ],
  S2: [cat('/Us', 'ers/someone/x'), cat('/ho', 'me/alice/x'), cat('C:', '\\Us', 'ers\\x')],
  S3: [cat('someone', '@', 'b.example'), cat('first.last+tag', '@', 'sub.host.example')],
  S4: [cat('https://evil', '.com/x'), cat('see evil', '.dev now'), cat('https://u', '@', 'ircx.io/'), cat('https:/', '/10.', '0.0.1/'), cat('ftp:', '//files', '.evil', '.org/x'), cat('wss:', '//sock', '.evil', '.net:99/x')],
  S5: [cat('ircx', '-secret'), cat('github.com/', 'ircx-io/', 'other'), cat('github.com/', 'someone/', 'ircx-docs'), cat('ircx-docs', '-private'), cat('Ircx', '-Other')],
  S6: [cat('10.', '0.0.1'), cat('192.168.', '1.1'), cat('8.8.', '8.8')],
  S7: ['0123456789abcdef'.repeat(2), 'ABCDEF0123456789'.repeat(2)],
  S8: [],
};

const WORDS: Array<[string, string]> = [
  ['irc', '7'],
  ['chat', 'svc'],
  ['decom', 'pile'],
  ['decom', 'piled'],
  ['decom', 'piler'],
  ['decom', 'pilation'],
  ['o', 'cx'],
];

function wordsLowerAndUpper(): string[] {
  return WORDS.flatMap(([a, b]) => [cat(a, b), cat(a.toUpperCase(), b.toUpperCase()), cat(a.charAt(0).toUpperCase(), a.slice(1), b)]);
}

test('SC-U2-16 g: the digest set is exactly the digests of the seven reference words', () => {
  const digests = new Set(WORDS.map(([a, b]) => createHash('sha256').update(cat(a, b)).digest('hex')));
  assert.equal(digests.size, 7);
  assert.deepEqual([...REFERENCE_WORD_DIGESTS].sort(), [...digests].sort());
});

test('SC-U2-16 g: S8 flags each reference word in any case, and not the word inside a longer token', () => {
  for (const w of wordsLowerAndUpper()) {
    assert.deepEqual(scanLine(`see ${w} here`), ['S8'], w);
    assert.deepEqual(scanLine(w), ['S8'], w);
    assert.deepEqual(scanLine(`a-${w}_b`), ['S8'], w);
  }
  for (const [a, b] of WORDS) {
    const w = cat(a, b);
    assert.deepEqual(scanLine(`x${w}y`), [], `inside a longer token: ${w}`);
    assert.deepEqual(scanLine(`${w}s`), [], w);
    assert.deepEqual(scanLine(`${w}2`), [], w);
  }
  assert.deepEqual(scanLine(cat('x', 'o', 'cx', 'y')), []);
  assert.deepEqual(scanLine(cat('irc', '7', ' ', 'chat', 'svc')), ['S8']);
});

test('scanLine: each class is reported by its own rule id', () => {
  for (const [rule, plants] of Object.entries(PLANTS)) {
    for (const p of plants) {
      const got = scanLine(`line ${p} end`);
      assert.ok(got.includes(rule), `${rule}: ${p.length} chars -> ${got.join()}`);
    }
  }
});

test('scanLine: the allowlists pass and near misses are findings', () => {
  const clean = [
    'Connect to chat.ircx.io port 6697',
    'See https://ircx.io/help/connect and https://dir.ircx.io/',
    'https://github.com/ircx-io/ircx-docs and github.com/ircx-io/ircx-docs/blob/main/x',
    'https://registry.npmjs.org/marked/-/marked-1.tgz',
    'https://wiki.creativecommons.org/wiki/x',
    'https://www.rfc-editor.org/rfc/rfc1459.html#section-2.3',
    'listening on 127.0.0.1 and 0.0.0.0',
    'https://evil.example/x and a.test and b.invalid and c.localhost',
    'repo ircx-io and ircx-docs and IRCX-DOCS',
    'version 1.2.3 and 300.1.1.1 and 1.2.3.4.5',
    `plain words, ${'12345678'.repeat(4)} is 32 digits but hex-only counts`,
  ];
  for (const line of clean) {
    const got = scanLine(line);
    // The 32-digit run is hex, so only that last line trips S7.
    assert.deepEqual(got, line.startsWith('plain words') ? ['S7'] : [], line);
  }
  assert.deepEqual(ALLOWED_REPO_TOKENS, ['ircx-bot', 'ircx-docs', 'ircx-io', 'ircx-io-bot']);
  assert.ok(scanLine(cat('ircx', '-other')).includes('S5'));
  assert.ok(scanLine(cat('ircx-docs', 'x')).includes('S5'));
  assert.ok(SCAN_EXTRA_HOSTS.includes('wiki.creativecommons.org'));
  assert.ok(!scanLine(cat('https://', 'wiki.creativecommons.org/x')).includes('S4'));
  assert.ok(scanLine(cat('https://other.', 'creativecommons.org/x')).includes('S4'));
});

test('SC-U2-16 S1: a credential name with any prefix, case or quoting is read; short values and non-assignments are not', () => {
  const names = [
    cat('to', 'ken'),
    cat('TO', 'KEN'),
    cat('API_TO', 'KEN'),
    cat('apiTo', 'ken'),
    cat('ke', 'y'),
    cat('MY_KE', 'Y'),
    cat('sec', 'ret'),
    cat('clientSec', 'ret'),
    cat('pass', 'word'),
    cat('DATABASE_PASS', 'WORD'),
    cat('pass', 'wd'),
    cat('DB_PASS', 'WD'),
  ];
  for (const name of names) {
    for (const [pre, mid, post] of [['', '=', ''], ['', ': ', ''], ['', ' = ', ''], ['"', '": "', '"'], ["'", "': '", "'"]] as const) {
      const line = `x ${pre}${name}${mid}${OPAQUE}${post}`;
      assert.deepEqual(scanLine(line), ['S1'], line.replace(OPAQUE, '<v>'));
    }
    // The value floor is 24 characters: 24 is read, 23 is not.
    assert.deepEqual(scanLine(`${name}=${'Zq9_'.repeat(6)}`), ['S1'], `${name} with 24`);
    assert.deepEqual(scanLine(`${name}=${'Zq9_'.repeat(6).slice(0, 23)}`), [], `${name} with 23`);
    assert.deepEqual(scanLine(`${name}=abc`), [], `${name} with a short value`);
    assert.deepEqual(scanLine(`${name} ${OPAQUE}`), [], `${name} with no separator`);
  }
  // Value characters: letters, digits and + / _ -.
  assert.deepEqual(scanLine(cat('to', 'ken=', 'aB3+/_-'.repeat(4))), ['S1']);
  assert.deepEqual(scanLine(cat('to', 'ken=', '!'.repeat(30))), []);
  assert.deepEqual(scanLine(cat('const to', 'kenize = 1;')), []);
  assert.deepEqual(scanLine(cat('the to', 'ken is rotated daily')), []);
});

// A throwaway git repository for the file-list tests.

interface Repo {
  readonly dir: string;
  git(...args: string[]): void;
  put(rel: string, data: string | Uint8Array): void;
  cleanup(): void;
}

function repo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'docs-scan-'));
  const git = (...args: string[]): void => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q');
  const put = (rel: string, data: string | Uint8Array): void => {
    const path = join(dir, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, data);
  };
  return { dir, git, put, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function plantFile(plant: string): string {
  return `first\nsecond\n${plant}\nfourth\n`;
}

test('SC-U2-16 each class is planted in a source tree and reported by rule id and location', () => {
  for (const rule of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']) {
    const plants = rule === 'S8' ? wordsLowerAndUpper() : (PLANTS[rule] ?? []);
    for (const plant of plants) {
      const r = repo();
      try {
        r.put('src.txt', plantFile(plant));
        r.put('clean.txt', 'nothing here\n');
        const got = scanRepository(r.dir);
        const at = (file: string): boolean => got.some((f) => f.file === file && f.line === 3 && f.rule === rule);
        assert.ok(at('src.txt'), `${rule} in the tree: ${JSON.stringify(got.map((f) => [f.file, f.line, f.rule]))}`);
        assert.ok(!got.some((f) => f.file === 'clean.txt'));
        assert.ok(got.every((f) => f.line === 3 || f.line === undefined), 'no finding on the other lines');
      } finally {
        r.cleanup();
      }
    }
  }
});

test('SC-U2-16 --dir reports each class planted, as the repository mode does', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-plain-'));
  try {
    const cases: Array<[string, string]> = [];
    for (const rule of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']) {
      for (const plant of rule === 'S8' ? wordsLowerAndUpper() : (PLANTS[rule] ?? [])) {
        cases.push([rule, plant]);
      }
    }
    const names = cases.map(([rule], i) => `${rule.toLowerCase()}-${i}.txt`);
    cases.forEach(([, plant], i) => {
      writeFileSync(join(dir, names[i] ?? ''), plantFile(plant));
    });
    writeFileSync(join(dir, 'clean.txt'), 'nothing here\n');
    const got = scanDirectory(dir);
    cases.forEach(([rule], i) => {
      assert.ok(
        got.some((f) => f.file === names[i] && f.line === 3 && f.rule === rule),
        `${names[i]} should carry ${rule} on line 3`,
      );
    });
    assert.ok(!got.some((f) => f.file === 'clean.txt'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SC-U2-15 output never contains the planted value', () => {
  const r = repo();
  const stage = repo();
  try {
    const all = Object.values(PLANTS).flat().concat(wordsLowerAndUpper());
    r.put('plain/p.txt', all.map((p) => `x ${p} y`).join('\n'));
    // Directory mode.
    const dirRun = spawnSync(process.execPath, [join(ROOT, 'src', 'scan.ts'), '--dir', join(r.dir, 'plain')], { encoding: 'utf8' });
    assert.equal(dirRun.status, 1);
    const out = dirRun.stdout + dirRun.stderr;
    for (const p of all) {
      assert.ok(!out.includes(p), `output holds a planted value: ${p.slice(0, 8)}`);
    }
    assert.match(dirRun.stderr, /^p\.txt:1: S\d: /m);
    assert.match(dirRun.stderr, /scan: \d+ finding\(s\)\n$/);
    // Repository mode, through the real entry point in a staged copy.
    cpSync(join(ROOT, 'src'), join(stage.dir, 'src'), { recursive: true });
    copyFileSync(join(ROOT, 'package.json'), join(stage.dir, 'package.json'));
    symlinkSync(join(ROOT, 'node_modules'), join(stage.dir, 'node_modules'));
    stage.put('.gitignore', 'node_modules\n');
    stage.put('notes.txt', all.map((p) => `x ${p} y`).join('\n'));
    const repoRun = spawnSync(process.execPath, ['src/scan.ts'], { cwd: stage.dir, encoding: 'utf8' });
    assert.equal(repoRun.status, 1);
    for (const p of all) {
      assert.ok(!(repoRun.stdout + repoRun.stderr).includes(p), `repository mode output holds ${p.slice(0, 8)}`);
    }
    assert.match(repoRun.stderr, /^notes\.txt:1: S\d: /m);
  } finally {
    r.cleanup();
    stage.cleanup();
  }
});

test('SC-U2-16 a: a file with a newline and a non-ASCII name is scanned, and its name is printed safely', () => {
  const r = repo();
  try {
    const plant = cat('/Us', 'ers/x');
    r.put('a\nb.txt', `${plant}\n`);
    r.put('café.txt', `${plant}\n`);
    r.git('add', '-A');
    assert.deepEqual(listRepositoryFiles(r.dir), ['a\nb.txt', 'café.txt']);
    const found = scanRepository(r.dir);
    assert.deepEqual(found.map((f) => f.file).sort(), ['a\nb.txt', 'café.txt']);
    assert.ok(found.every((f) => f.rule === 'S2' && f.line === 1));
    const plain = mkdtempSync(join(tmpdir(), 'docs-plain-'));
    writeFileSync(join(plain, 'a\nb.txt'), `${plant}\n`);
    writeFileSync(join(plain, 'caf\u00e9.txt'), `${plant}\n`);
    const run = spawnSync(process.execPath, [join(ROOT, 'src', 'scan.ts'), '--dir', plain], { encoding: 'utf8' });
    rmSync(plain, { recursive: true, force: true });
    assert.ok(run.stderr.includes('a\\x0ab.txt:1: S2: '), run.stderr);
    assert.ok(run.stderr.includes('caf\\xe9.txt:1: S2: '), run.stderr);
    for (const line of run.stderr.split('\n').filter((l) => l !== '')) {
      assert.match(line, /^(a\\x0ab\.txt|caf\\xe9\.txt):1: S2: |^scan: 2 finding\(s\)$/, line);
    }
  } finally {
    r.cleanup();
  }
});

test('SC-U2-16 a: the file list is tracked files plus untracked files git does not ignore', () => {
  const r = repo();
  try {
    r.put('.gitignore', 'ignored.txt\n');
    r.put('tracked.txt', 'x\n');
    r.put('untracked.txt', 'x\n');
    r.put('ignored.txt', 'x\n');
    r.git('add', 'tracked.txt');
    assert.deepEqual(listRepositoryFiles(r.dir), ['.gitignore', 'tracked.txt', 'untracked.txt']);
  } finally {
    r.cleanup();
  }
});

test('SC-U2-16 b: an unreadable or non-regular path is a finding', () => {
  const r = repo();
  try {
    r.put('gone.txt', 'x\n');
    r.put('locked.txt', 'x\n');
    r.put('real.txt', 'x\n');
    symlinkSync(join(r.dir, 'real.txt'), join(r.dir, 'link.txt'));
    r.git('add', '-A');
    unlinkSync(join(r.dir, 'gone.txt'));
    const canLock = process.getuid?.() !== 0;
    if (canLock) {
      chmodSync(join(r.dir, 'locked.txt'), 0o000);
    }
    const got = scanRepository(r.dir);
    const byFile = new Map(got.map((f) => [f.file, f.rule] as const));
    assert.equal(byFile.get('gone.txt'), 'S0');
    assert.equal(byFile.get('link.txt'), 'S0');
    if (canLock) {
      assert.equal(byFile.get('locked.txt'), 'S0');
      chmodSync(join(r.dir, 'locked.txt'), 0o644);
    }
    assert.equal(byFile.get('real.txt'), undefined);
  } finally {
    r.cleanup();
  }
});

/** The path findings of a scan: those with no line, other than the S0 read failures. */
function pathFindings(found: ReturnType<typeof scanDirectory>): Array<[string, string]> {
  return found.filter((f) => f.line === undefined && f.rule !== 'S0').map((f) => [f.file, f.rule] as [string, string]).sort();
}

test('SC-U2-16 a: a path that names a reference word or another ircx repository is a finding in the repository scan', () => {
  const word = cat('o', 'cx');
  const other = cat('ircx', '-other');
  const home = cat('x/ho', 'me/alice/f.txt');
  const r = repo();
  try {
    r.put(`test/${word}.txt`, 'empty of hits\n');
    r.put(`${word}/a.txt`, 'empty of hits\n');
    r.put(`${other}.txt`, 'empty of hits\n');
    r.put(`${other}/a.txt`, 'empty of hits\n');
    r.put(home, 'empty of hits\n');
    r.put('clean/a.txt', 'empty of hits\n');
    // Near misses: the word inside a longer token, and the two allowed repository names.
    r.put(`test/x${word}y.txt`, 'empty of hits\n');
    r.put('ircx-docs/a.txt', 'empty of hits\n');
    r.put('ircx-io.txt', 'empty of hits\n');
    r.git('add', '-A');
    assert.deepEqual(pathFindings(scanRepository(r.dir)), [
      [`${other}.txt`, 'S5'],
      [`${other}/a.txt`, 'S5'],
      [`${word}/a.txt`, 'S8'],
      [home, 'S2'],
      [`test/${word}.txt`, 'S8'],
    ].sort());
  } finally {
    r.cleanup();
  }
});

test('SC-U2-16 a: the same path spellings are findings in --dir mode, in file and directory names', () => {
  const word = cat('o', 'cx');
  const other = cat('ircx', '-other');
  const home = cat('x/ho', 'me/alice/f.txt');
  const dir = mkdtempSync(join(tmpdir(), 'docs-plain-'));
  try {
    for (const rel of [`test/${word}.txt`, `${word}/a.txt`, `${other}.txt`, `${other}/a.txt`, home, 'clean/a.txt', `test/x${word}y.txt`, 'ircx-docs/a.txt', 'ircx-io.txt']) {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), 'empty of hits\n');
    }
    assert.deepEqual(pathFindings(scanDirectory(dir)), [
      [`${other}.txt`, 'S5'],
      [`${other}/a.txt`, 'S5'],
      [`${word}/a.txt`, 'S8'],
      [home, 'S2'],
      [`test/${word}.txt`, 'S8'],
    ].sort());
    const run = spawnSync(process.execPath, [join(ROOT, 'src', 'scan.ts'), '--dir', dir], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, new RegExp(`^test/${word}\\.txt: S8: `, 'm'));
    assert.match(run.stderr, /scan: 5 finding\(s\)\n$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SC-U2-16 a b: a path finding is also reported for a symlink, a deleted file and an unreadable file', () => {
  const word = cat('o', 'cx');
  const r = repo();
  const dir = mkdtempSync(join(tmpdir(), 'docs-plain-'));
  try {
    r.put('real.txt', 'x\n');
    r.put(`gone-${word}.txt`, 'x\n');
    r.put(`locked-${word}.txt`, 'x\n');
    symlinkSync(join(r.dir, 'real.txt'), join(r.dir, `${word}-link`));
    symlinkSync(join(dir, 'missing'), join(dir, `${word}-dangling`));
    r.git('add', '-A');
    unlinkSync(join(r.dir, `gone-${word}.txt`));
    const canLock = process.getuid?.() !== 0;
    if (canLock) {
      chmodSync(join(r.dir, `locked-${word}.txt`), 0o000);
    }
    const names = [`${word}-link`, `gone-${word}.txt`, ...(canLock ? [`locked-${word}.txt`] : [])];
    const pairs = (found: ReturnType<typeof scanDirectory>): Array<[string, string]> => found.map((f) => [f.file, f.rule] as [string, string]).sort();
    const expected: Array<[string, string]> = names.flatMap((n): Array<[string, string]> => [[n, 'S0'], [n, 'S8']]).sort();
    assert.deepEqual(pairs(scanRepository(r.dir)), expected);
    assert.deepEqual(pairs(scanDirectory(dir)), [[`${word}-dangling`, 'S0'], [`${word}-dangling`, 'S8']]);
    if (canLock) {
      chmodSync(join(r.dir, `locked-${word}.txt`), 0o644);
    }
  } finally {
    r.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SC-U2-15 --dir prints a path finding for a newline-bearing file name and dangling symlink with the control byte escaped', () => {
  const word = cat('o', 'cx');
  const dir = mkdtempSync(join(tmpdir(), 'docs-plain-'));
  try {
    const fileName = `a\n::error::${word}.txt`;
    const linkName = `b\n::error::${word}-link`;
    writeFileSync(join(dir, fileName), 'empty of hits\n');
    symlinkSync(join(dir, 'missing'), join(dir, linkName));
    // The file really carries a newline, so the escape below is not vacuous.
    assert.ok(fileName.includes('\n') && linkName.includes('\n'));
    const run = spawnSync(process.execPath, [join(ROOT, 'src', 'scan.ts'), '--dir', dir], { encoding: 'utf8' });
    assert.equal(run.status, 1, run.stderr);
    const lines = run.stderr.split('\n').filter((l) => l !== '');
    // Exact lines: the S8 rule fired on the regular file, S0 and S8 on the dangling symlink.
    assert.ok(lines.includes(`a\\x0a::error::${word}.txt: S8: a clean-room reference name`), run.stderr);
    assert.ok(lines.includes(`b\\x0a::error::${word}-link: S0: not a regular file`), run.stderr);
    assert.ok(lines.includes(`b\\x0a::error::${word}-link: S8: a clean-room reference name`), run.stderr);
    // The walk reached both entries and nothing else.
    assert.equal(lines.at(-1), 'scan: 3 finding(s)', run.stderr);
    assert.equal(lines.length, 4, run.stderr);
    // No stderr line can start a workflow command, and every byte is printable ASCII.
    assert.ok(lines.every((l) => !l.startsWith('::')), run.stderr);
    assert.ok(!/[^\x20-\x7e\n]/.test(run.stderr), run.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SC-U2-16 c: invalid UTF-8, NUL and UTF-16LE are S0 findings', () => {
  const cases: Array<[string, Uint8Array]> = [
    ['invalid', Buffer.from([0x61, 0xff, 0x62])],
    ['nul', Buffer.from('ab\0cd')],
    ['utf16', Buffer.from('hello there\n', 'utf16le')],
  ];
  for (const [name, bytes] of cases) {
    const got = scanBytes(`${name}.txt`, bytes);
    assert.deepEqual(got.map((f) => f.rule), ['S0'], name);
    assert.equal(got[0]?.line, undefined);
  }
  assert.deepEqual(scanBytes('ok.txt', Buffer.from('plain text\n')), []);
  const r = repo();
  try {
    r.put('wide.txt', Buffer.from('hello there\n', 'utf16le'));
    assert.deepEqual(scanRepository(r.dir).map((f) => [f.file, f.rule]), [['wide.txt', 'S0']]);
  } finally {
    r.cleanup();
  }
});

test('SC-U2-16 d: only package-lock.json is excluded; LICENSE is scanned and passes', () => {
  assert.deepEqual([...EXCLUDED_FILES], ['package-lock.json']);
  assert.deepEqual(scanBytes('LICENSE', readFileSync(join(ROOT, 'LICENSE'))), []);
  assert.deepEqual(scanBytes('LICENSE-CODE', readFileSync(join(ROOT, 'LICENSE-CODE'))), []);
  const plant = cat('/Us', 'ers/x');
  const r = repo();
  try {
    r.put('package-lock.json', `${plant}\n`);
    r.put('LICENSE', `${plant}\n`);
    r.put('other.json', `${plant}\n`);
    r.put('sub/package-lock.json', `${plant}\n`);
    assert.deepEqual(scanRepository(r.dir).map((f) => f.file).sort(), ['LICENSE', 'other.json', 'sub/package-lock.json']);
  } finally {
    r.cleanup();
  }
});

test('SC-U2-16 e: ircx-io and ircx-docs pass S5 and another ircx token is a finding', () => {
  const r = repo();
  try {
    r.put('ok.md', 'Source: https://github.com/ircx-io/ircx-docs\nOrg: ircx-io\nRepo: ircx-docs\n');
    r.put('bad.md', `${cat('ircx', '-other')}\n`);
    assert.deepEqual(scanRepository(r.dir).map((f) => [f.file, f.line, f.rule]), [['bad.md', 1, 'S5']]);
  } finally {
    r.cleanup();
  }
});

test('SC-U2-16 e: the environment name and the App slug pass S5; their plurals are findings', () => {
  assert.deepEqual(scanLine(`environment: ${cat('ircx', '-bot')}`), []);
  assert.deepEqual(scanLine(`the slug ${cat('ircx', '-io-bot')} and its user ${cat('ircx', '-io-bot')}[bot]`), []);
  assert.deepEqual(scanLine(cat('ircx', '-bots')), ['S5']);
  assert.deepEqual(scanLine(cat('ircx', '-io-bots')), ['S5']);
  assert.deepEqual(scanLine(cat('ircx', '-bot-x')), ['S5']);
});

test('SC-U2-16 f: --dir scans a plain directory with no git and no exclusions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-plain-'));
  try {
    writeFileSync(join(dir, 'clean.txt'), 'nothing\n');
    writeFileSync(join(dir, 'package-lock.json'), `${cat('/Us', 'ers/x')}\n`);
    mkdirSync(join(dir, 'deep', 'er'), { recursive: true });
    writeFileSync(join(dir, 'deep', 'er', 'f.txt'), `${cat('/ho', 'me/bob/x')}\n`);
    assert.deepEqual(scanDirectory(dir).map((f) => [f.file, f.line, f.rule]), [
      ['deep/er/f.txt', 1, 'S2'],
      ['package-lock.json', 1, 'S2'],
    ]);
    const run = spawnSync(process.execPath, [join(ROOT, 'src', 'scan.ts'), '--dir', dir], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /deep\/er\/f\.txt:1: S2: /);
    unlinkSync(join(dir, 'deep', 'er', 'f.txt'));
    unlinkSync(join(dir, 'package-lock.json'));
    const clean = spawnSync(process.execPath, [join(ROOT, 'src', 'scan.ts'), '--dir', dir], { encoding: 'utf8' });
    assert.equal(clean.status, 0);
    assert.equal(clean.stdout, 'scan: no findings\n');
    assert.equal(clean.stderr, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SC-U2-16 the command line refuses unknown arguments with status 2', () => {
  for (const args of [['--dir'], ['--dir', 'a', 'b'], ['--bogus'], ['x']]) {
    const run = spawnSync(process.execPath, [join(ROOT, 'src', 'scan.ts'), ...args], { encoding: 'utf8' });
    assert.equal(run.status, 2, args.join(' '));
    assert.match(run.stderr, /usage: npm run scan/);
  }
});

test('SC-U2-16 h: the old help host is an S4 finding, and an ignored dist/ is not walked', () => {
  assert.ok(!SCAN_EXTRA_HOSTS.includes(cat('help', '.ircx.io')));
  assert.deepEqual(scanLine(cat('https://help', '.ircx.io/connect/')), ['S4']);
  assert.deepEqual(scanLine(cat('see help', '.ircx.io for more')), ['S4']);
  assert.deepEqual(scanLine('https://ircx.io/help/connect'), []);
  const r = repo();
  try {
    r.put('.gitignore', 'dist/\n');
    r.put('dist/page.html', plantFile(cat('https://evil', '.com/x')));
    r.put('clean.txt', 'nothing here\n');
    assert.deepEqual(scanRepository(r.dir), []);
  } finally {
    r.cleanup();
  }
});

test('SC-U2-16 g: the real tree is clean', () => {
  assert.deepEqual(scanRepository(ROOT), []);
  const run = spawnSync(process.execPath, [join(ROOT, 'src', 'scan.ts')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'scan: no findings\n');
});

test('S5: a github.com reference spelled any other way than this repository is a finding', () => {
  // Each string is split so this file's own lines stay clean under the scan.
  const findings = [
    cat('https://github.com', ':443/someone/other'),
    cat('https://GitHub.com', ':443/someone/other'),
    cat('https://github.com', ':/ircx-io/ircx-docs'),
    cat('https://github.com/ircx-io/ircx-docs', '/../../someone/other'),
    cat('github.com/ircx-io/ircx-docs', '/../../someone/other'),
    cat('https://github.com/ircx-io/ircx-docs', '/..'),
    cat('https://github.com/ircx-io/ircx-docs', '/./x'),
    cat('https://github.com', '//someone/other'),
    cat('https://github.com', '/%73omeone/other'),
    cat('https://github.com', '/someone%2Fother'),
    cat('https://github.com/ircx-io/ircx-docs', '/blob/%2E%2E/x'),
    cat('github.com', ':someone/other.git'),
    cat('git', '@github.com', ':someone/other.git'),
    cat('https://github.com/ircx-io/ircx-docs', '-private'),
    cat('https://github.com/ircx-io/ircx-docs', '~other'),
    cat('https://github.com/ircx-io/ircx-docs', '//someone/other'),
    cat('github.com/ircx-io/ircx-docs', '.git.evil'),
    cat('https://github.com', './someone/other'),
    cat('see github.com', '/someone/other.'),
  ];
  for (const line of findings) {
    assert.ok(scanLine(line).includes('S5'), line);
  }
  const clean = [
    cat('https://github.com/ircx-io/ircx-docs'),
    cat('https://github.com/ircx-io/ircx-docs', '.git'),
    cat('github.com/ircx-io/ircx-docs', '/blob/main/CONTRIBUTING.md'),
    cat('https://github.com/ircx-io/ircx-docs', '/issues?q=is:open#top'),
    cat('https://GitHub.com/IRCX-IO/ircx-docs'),
    cat('see github.com/ircx-io/ircx-docs', '/security.'),
    'the `github.com` host',
    cat('https://github.com', '/'),
    cat('https://github.com/ircx-io', '/'),
    cat('https://github.com', '.evil.example/x'),
  ];
  for (const line of clean) {
    assert.deepEqual(scanLine(line), [], line);
  }
});
