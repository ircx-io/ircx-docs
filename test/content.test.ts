import { strict as assert } from 'node:assert';
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkContent, EMPHASIS_CAP, emphasisChunkOverCap } from '../src/check.ts';
import { loadContent, parseFrontMatter } from '../src/content.ts';
import { formatFinding, safeText } from '../src/text.ts';
import { cat, fixture, pageText, ROOT, runCheckCli } from './helpers.ts';

const FM = (extra: string): string => `---\n${extra}---\nbody\n`;

function rules(findings: readonly { rule: string; message: string; file: string }[]): string[] {
  return findings.map((f) => `${f.rule}:${f.file}`);
}

test('front matter: a missing, unknown, duplicate or empty key is a finding', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['missing title', FM('description: d\n'), /missing key title/],
    ['missing description', FM('title: t\n'), /missing key description/],
    ['unknown key', FM('title: t\ndescription: d\nauthor: x\n'), /unknown key author/],
    ['duplicate key', FM('title: t\ntitle: u\ndescription: d\n'), /duplicate key title/],
    ['empty value', FM('title: \ndescription: d\n'), /empty value for title|expected a "key: value"/],
    ['blank value', FM('title:  \ndescription: d\n'), /empty value for title/],
    ['quoted empty value', FM('title: ""\ndescription: d\n'), /empty value for title/],
    ['backslash', FM('title: a\\nb\ndescription: d\n'), /a backslash in title/],
    ['order 1000', FM('title: t\ndescription: d\norder: 1000\n'), /order must be an integer from 0 to 999/],
    ['order -1', FM('title: t\ndescription: d\norder: -1\n'), /order must be an integer/],
    ['order 01', FM('title: t\ndescription: d\norder: 01\n'), /order must be an integer/],
    ['order 1.5', FM('title: t\ndescription: d\norder: 1.5\n'), /order must be an integer/],
    ['order word', FM('title: t\ndescription: d\norder: abc\n'), /order must be an integer/],
    ['no opening line', 'title: t\n---\nbody\n', /must open with a --- line/],
    ['no closing line', '---\ntitle: t\ndescription: d\n', /no closing --- line/],
    ['nested yaml', FM('title: t\ndescription: d\nlist:\n  - a\n'), /unknown key list|expected a "key: value"/],
  ];
  for (const [name, text, expected] of cases) {
    const r = parseFrontMatter('content/x.md', text);
    assert.ok(r.findings.length > 0, `${name}: no finding`);
    assert.ok(
      r.findings.every((f) => f.rule === 'front-matter') && r.findings.some((f) => expected.test(f.message)),
      `${name}: ${JSON.stringify(r.findings)}`,
    );
  }
});

test('front matter: bounds are exact (order 0..999, title 80, description 200)', () => {
  const ok = (extra: string): void => {
    const r = parseFrontMatter('content/x.md', FM(extra));
    assert.deepEqual(r.findings, [], extra.slice(0, 30));
  };
  ok('title: t\ndescription: d\norder: 0\n');
  ok('title: t\ndescription: d\norder: 999\n');
  ok(`title: ${'t'.repeat(80)}\ndescription: ${'d'.repeat(200)}\n`);
  const long = (extra: string): string[] => parseFrontMatter('content/x.md', FM(extra)).findings.map((f) => f.message);
  assert.match(long(`title: ${'t'.repeat(81)}\ndescription: d\n`).join(), /title is longer than 80/);
  assert.match(long(`title: t\ndescription: ${'d'.repeat(201)}\n`).join(), /description is longer than 200/);
  assert.match(long('title: t\ndescription: d\norder: 1000\n').join(), /0 to 999/);
  const r = parseFrontMatter('content/x.md', FM('title: "Quoted"\ndescription: d\norder: 7\n'));
  assert.equal(r.front.title, 'Quoted');
  assert.equal(r.front.order, 7);
  assert.equal(r.body, 'body\n');
  assert.equal(r.bodyLine, 6);
});

test('a valid tree loads with folder-derived URLs and no findings', () => {
  const fx = fixture({
    'a/index.md': pageText('A.\n', 'Section A', 'Section A.', 'order: 2\n'),
    'a/b.md': pageText('B.\n'),
    'c.md': pageText('C.\n'),
  });
  try {
    const r = loadContent(fx.content);
    assert.deepEqual(r.findings, []);
    assert.deepEqual(
      r.pages.map((p) => p.url).sort(),
      ['/', '/a/', '/a/b/', '/c/'],
    );
    const a = r.pages.find((p) => p.url === '/a/');
    assert.equal(a?.order, 2);
    assert.equal(a?.isIndex, true);
  } finally {
    fx.cleanup();
  }
});

test('a directory without index.md is a content-layout finding', () => {
  const fx = fixture({ 'sub/page.md': pageText('x\n') });
  try {
    const r = loadContent(fx.content);
    assert.ok(rules(r.findings).includes('content-layout:content/sub'), JSON.stringify(r.findings));
  } finally {
    fx.cleanup();
  }
});

test('a.md beside a/index.md is a duplicate slug', () => {
  const fx = fixture({ 'a.md': pageText('x\n'), 'a/index.md': pageText('y\n') });
  try {
    const r = loadContent(fx.content);
    const dup = r.findings.filter((f) => f.rule === 'duplicate-slug');
    assert.equal(dup.length, 1);
    assert.match(dup[0]?.message ?? '', /same URL as content\/a/);
  } finally {
    fx.cleanup();
  }
});

test('bad names are refused: uppercase, underscore, space, dotfile, wrong extension', () => {
  const bad: Record<string, string> = {
    'Bad.md': pageText('x\n'),
    'bad_name.md': pageText('x\n'),
    'bad name.md': pageText('x\n'),
    '.hidden.md': pageText('x\n'),
    'notes.txt': 'text',
    'page.markdown': pageText('x\n'),
    '.md': pageText('x\n'),
    'Dir/index.md': pageText('x\n'),
    'dir_x/index.md': pageText('x\n'),
  };
  for (const [name, text] of Object.entries(bad)) {
    const fx = fixture({ [name]: text });
    try {
      const r = loadContent(fx.content);
      assert.ok(
        r.findings.some((f) => f.rule === 'content-name'),
        `${name}: ${JSON.stringify(r.findings)}`,
      );
    } finally {
      fx.cleanup();
    }
  }
});

test('a symlinked file and a symlinked directory are refused and not followed', () => {
  const fx = fixture({ 'real.md': pageText('x\n') });
  try {
    symlinkSync(join(fx.content, 'real.md'), join(fx.content, 'link.md'));
    mkdirSync(join(fx.root, 'outside'));
    writeFileSync(join(fx.root, 'outside', 'index.md'), pageText('x\n'));
    symlinkSync(join(fx.root, 'outside'), join(fx.content, 'linkdir'));
    const r = loadContent(fx.content);
    const syms = r.findings.filter((f) => f.message === 'symlinks are not allowed').map((f) => f.file);
    assert.deepEqual(syms.sort(), ['content/link.md', 'content/linkdir']);
    assert.ok(!r.pages.some((p) => p.url === '/link/' || p.url === '/linkdir/'));
  } finally {
    fx.cleanup();
  }
});

test('SC-U2-5 a: a content root that is a symlink is refused', () => {
  const fx = fixture({});
  try {
    const target = join(fx.root, 'elsewhere');
    mkdirSync(target);
    writeFileSync(join(target, 'index.md'), pageText('x\n'));
    const link = join(fx.root, 'content-link');
    symlinkSync(target, link);
    const r = loadContent(link);
    assert.equal(r.pages.length, 0);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0]?.rule, 'content-root');
    assert.match(r.findings[0]?.message ?? '', /not a symlink or file/);
    assert.equal(loadContent(join(fx.root, 'missing')).findings[0]?.rule, 'content-root');
    const file = join(fx.root, 'plainfile');
    writeFileSync(file, 'x');
    assert.equal(loadContent(file).findings[0]?.rule, 'content-root');
  } finally {
    fx.cleanup();
  }
});

test('SC-U2-5 b: invalid UTF-8 is refused', () => {
  const cases: Array<[string, Uint8Array]> = [
    ['lone continuation byte', Buffer.concat([Buffer.from(pageText('x ')), Buffer.from([0x80]), Buffer.from('\n')])],
    ['overlong encoding', Buffer.concat([Buffer.from(pageText('x ')), Buffer.from([0xc0, 0xaf]), Buffer.from('\n')])],
  ];
  for (const [name, bytes] of cases) {
    const fx = fixture({ 'bad.md': bytes });
    try {
      const r = loadContent(fx.content);
      const hit = r.findings.filter((f) => f.rule === 'content-encoding' && f.file === 'content/bad.md');
      assert.equal(hit.length, 1, `${name}: ${JSON.stringify(r.findings)}`);
      assert.ok(!r.pages.some((p) => p.url === '/bad/'));
    } finally {
      fx.cleanup();
    }
  }
});

test('a leading byte order mark is stripped by the decoder and never reaches the page', () => {
  // The loader's TextDecoder strips a leading BOM before any check sees it.
  const fx = fixture({ 'bom.md': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(pageText('x\n'))]) });
  try {
    const r = loadContent(fx.content);
    assert.deepEqual(r.findings, []);
    const p = r.pages.find((x) => x.url === '/bom/');
    assert.equal(p?.title, 'A page');
    assert.ok(!p?.body.includes(String.fromCharCode(0xfeff)));
  } finally {
    fx.cleanup();
  }
});

test('SC-U2-5 b: a UTF-16LE file is refused (its NUL bytes are controls)', () => {
  const fx = fixture({ 'wide.md': Buffer.from(pageText('x\n'), 'utf16le') });
  try {
    const r = loadContent(fx.content);
    assert.ok(r.findings.some((f) => f.file === 'content/wide.md' && f.rule === 'content-control'));
    assert.ok(!r.pages.some((p) => p.url === '/wide/'));
  } finally {
    fx.cleanup();
  }
});

function sizedPage(totalBytes: number): string {
  const head = pageText('');
  return head + 'x'.repeat(totalBytes - Buffer.byteLength(head));
}

test('size caps: 65536 bytes per file passes, 65537 fails (literal bound)', () => {
  const fx = fixture({ 'exact.md': sizedPage(65536), 'over.md': sizedPage(65537) });
  try {
    const r = loadContent(fx.content);
    const over = r.findings.filter((f) => f.rule === 'content-size');
    assert.deepEqual(
      over.map((f) => f.file),
      ['content/over.md'],
    );
    assert.match(over[0]?.message ?? '', /larger than 65536 bytes/);
    assert.ok(r.pages.some((p) => p.url === '/exact/'));
  } finally {
    fx.cleanup();
  }
});

test('file cap: 200 files pass, 201 fail (literal bound)', () => {
  const make = (n: number): Record<string, string> => {
    const files: Record<string, string> = {};
    for (let i = 1; i < n; i++) {
      files[`p${i}.md`] = pageText('x\n');
    }
    return files;
  };
  const ok = fixture(make(200));
  const over = fixture(make(201));
  try {
    assert.deepEqual(loadContent(ok.content).findings, []);
    const f = loadContent(over.content).findings;
    assert.equal(f.length, 1);
    assert.equal(f[0]?.rule, 'content-size');
    assert.match(f[0]?.message ?? '', /more than 200 files/);
  } finally {
    ok.cleanup();
    over.cleanup();
  }
});

test('total cap: 2097152 bytes pass, one more byte fails (literal bound)', () => {
  // Thirty-one 65536-byte pages plus index.md and a filler page sum to the cap.
  const files: Record<string, string> = {};
  for (let i = 0; i < 31; i++) {
    files[`big${i}.md`] = sizedPage(65536);
  }
  const indexLen = Buffer.byteLength(pageText('Home.\n'));
  const fillerLen = 2097152 - 31 * 65536 - indexLen;
  assert.ok(fillerLen > 0 && fillerLen <= 65536, String(fillerLen));
  const okFiles = { ...files, 'filler.md': sizedPage(fillerLen) };
  const overFiles = { ...files, 'filler.md': sizedPage(fillerLen + 1) };
  const ok = fixture(okFiles);
  const over = fixture(overFiles);
  try {
    assert.deepEqual(loadContent(ok.content).findings, []);
    const f = loadContent(over.content).findings;
    assert.equal(f.length, 1);
    assert.match(f[0]?.message ?? '', /more than 2097152 bytes in total/);
  } finally {
    ok.cleanup();
    over.cleanup();
  }
});

test('bidi controls, NUL, C0 controls and DEL are refused with their line', () => {
  const bad: Array<[string, string]> = [
    ['RLO', cat('x', String.fromCharCode(0x202e), 'y')],
    ['LRE', cat('x', String.fromCharCode(0x202a), 'y')],
    ['RLI', cat('x', String.fromCharCode(0x2066), 'y')],
    ['PDI', cat('x', String.fromCharCode(0x2069), 'y')],
    ['LRO/RLE/PDF', cat('x', String.fromCharCode(0x202b, 0x202c, 0x202d), 'y')],
    ['LRI/FSI', cat('x', String.fromCharCode(0x2067, 0x2068), 'y')],
    ['NUL', cat('x', String.fromCharCode(0), 'y')],
    ['ESC', cat('x', String.fromCharCode(0x1b), 'y')],
    ['DEL', cat('x', String.fromCharCode(0x7f), 'y')],
    ['lone CR', cat('x', String.fromCharCode(13), 'y')],
    ['vertical tab', cat('x', String.fromCharCode(11), 'y')],
  ];
  for (const [name, line] of bad) {
    const fx = fixture({ 'bad.md': pageText(`first\n${line}\n`) });
    try {
      const r = loadContent(fx.content);
      const hit = r.findings.filter((f) => f.rule === 'content-control');
      assert.ok(hit.length >= 1, `${name}: ${JSON.stringify(r.findings)}`);
      assert.equal(hit[0]?.line, 6, name);
      assert.ok(!r.pages.some((p) => p.url === '/bad/'));
    } finally {
      fx.cleanup();
    }
  }
  // Tab and LF stay legal.
  const fx = fixture({ 'ok.md': pageText('a\tb\n\nc\n') });
  try {
    assert.deepEqual(loadContent(fx.content).findings, []);
  } finally {
    fx.cleanup();
  }
});

test('CR LF line endings are normalised to LF', () => {
  const crlf = pageText('line one\nline two\n').replace(/\n/g, '\r\n');
  assert.ok(crlf.includes('\r\n'));
  const fx = fixture({ 'crlf.md': crlf });
  try {
    const r = loadContent(fx.content);
    assert.deepEqual(r.findings, []);
    const p = r.pages.find((x) => x.url === '/crlf/');
    assert.equal(p?.body, 'line one\nline two\n');
    assert.equal(p?.title, 'A page');
    assert.ok(!p?.body.includes('\r'));
  } finally {
    fx.cleanup();
  }
});

test('SC-U2-5 the emphasis cap: 256 delimiters pass, 257 are refused, fences are skipped', () => {
  assert.equal(EMPHASIS_CAP, 256);
  assert.equal(emphasisChunkOverCap('*'.repeat(256)), undefined);
  assert.equal(emphasisChunkOverCap('*'.repeat(257)), 0);
  assert.equal(emphasisChunkOverCap(`${'_'.repeat(200)}\nx${'~'.repeat(57)}`), 0);
  // The count restarts at each blank line.
  assert.equal(emphasisChunkOverCap(`${'*'.repeat(256)}\n\n${'*'.repeat(257)}`), 2);
  assert.equal(emphasisChunkOverCap(`${'*'.repeat(256)}\n\n${'*'.repeat(256)}`), undefined);
  // Fenced code does not count, with either fence character.
  assert.equal(emphasisChunkOverCap(`\`\`\`\n${'*'.repeat(1000)}\n\`\`\`\n`), undefined);
  assert.equal(emphasisChunkOverCap(`~~~\n${'*'.repeat(1000)}\n~~~\n`), undefined);
  assert.equal(emphasisChunkOverCap(`\`\`\`\nx\n\`\`\`\n${'*'.repeat(300)}`), 0);
  // A shorter fence does not close a longer one.
  assert.equal(emphasisChunkOverCap(`\`\`\`\`\n\`\`\`\n${'*'.repeat(1000)}\n\`\`\`\`\n`), undefined);
});

test('SC-U2-5 repeated unmatched emphasis is a check finding with its line, in under 1 s', () => {
  const fx = fixture({ 'slow.md': pageText(`intro\n\n${'*a '.repeat(20000)}\n`) });
  try {
    const start = performance.now();
    const findings = checkContent(fx.root);
    assert.ok(performance.now() - start < 1000);
    assert.deepEqual(
      findings.map((f) => [f.file, f.line, f.rule]),
      [['content/slow.md', 7, 'emphasis-cap']],
    );
  } finally {
    fx.cleanup();
  }
});

test('the real content passes the check', () => {
  assert.deepEqual(checkContent(ROOT), []);
});

test('SC-U2-15 a hostile front-matter key cannot start a workflow command line', () => {
  const fx = fixture({ 'page.md': '---\ntitle: t\ndescription: d\nx\n::error::pwned: v\n---\nbody\n' });
  try {
    const run = runCheckCli(fx);
    assert.equal(run.status, 1, run.stderr);
    const lines = run.stderr.split('\n').filter((l) => l !== '');
    assert.ok(lines.length >= 2, run.stderr);
    for (const line of lines.slice(0, -1)) {
      assert.ok(line.startsWith('content/page.md:'), line);
    }
    for (const line of lines) {
      assert.ok(!line.startsWith('::'), line);
    }
  } finally {
    fx.cleanup();
  }
  // A file name is content-derived too: its line break prints escaped.
  const named = fixture({ 'x\n::error::pwned.md': pageText('x\n') });
  try {
    const run = runCheckCli(named);
    assert.equal(run.status, 1, run.stderr);
    const lines = run.stderr.split('\n').filter((l) => l !== '');
    assert.ok(lines.includes('content/x\\x0a::error::pwned.md: content-name: only files named [a-z0-9-]+.md are allowed'), run.stderr);
    for (const line of lines) {
      assert.ok(!line.startsWith('::'), line);
    }
  } finally {
    named.cleanup();
  }
});

// SC-U2-24: the plaintext port's warning, over the real content.

/** Blank-line-separated chunks of a Markdown text. */
function blocks(text: string): string[] {
  return text.split(/\n[ \t]*\n/);
}

function blocksWith6667(text: string): string[] {
  return blocks(text).filter((b) => b.includes('6667'));
}

function realPlaintextBlocks(): Array<{ file: string; block: string }> {
  const out: Array<{ file: string; block: string }> = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSyncSorted(dir)) {
      const full = join(dir, name);
      const relName = rel === '' ? name : `${rel}/${name}`;
      if (name.endsWith('.md')) {
        for (const block of blocksWith6667(readFileSync(full, 'utf8'))) {
          out.push({ file: relName, block });
        }
      } else {
        walk(full, relName);
      }
    }
  };
  walk(join(ROOT, 'content'), '');
  return out;
}

function readdirSyncSorted(dir: string): string[] {
  return readdirSync(dir).sort();
}

test('SC-U2-24 the plaintext port always carries the unencrypted warning', () => {
  const found = realPlaintextBlocks();
  assert.deepEqual(found.map((f) => f.file).sort(), ['connect/irc-client.md', 'protocol/directory-redirect.md']);
  for (const { file, block } of found) {
    assert.match(block.toLowerCase(), /unencrypted/, `${file} (b)`);
    assert.doesNotMatch(block.toLowerCase(), /recommend/, `${file} (c)`);
  }
});

test('SC-U2-24 the block finder splits on blank lines and sees fenced code', () => {
  // Non-vacuity for the finder itself: a warning in the next block does not count.
  const text = 'Port 6667 is open.\n\nIt is unencrypted.\n\n```\nCONNECT 6667\n```\n';
  const got = blocksWith6667(text);
  assert.equal(got.length, 2);
  assert.doesNotMatch(got[0] ?? '', /unencrypted/);
  assert.match(got[1] ?? '', /CONNECT 6667/);
});

test('SC-U2-24 the client guide gives the TLS port first', () => {
  const text = readFileSync(join(ROOT, 'content/connect/irc-client.md'), 'utf8');
  const tls = text.indexOf('6697');
  const plain = text.indexOf('6667');
  assert.ok(tls >= 0 && plain >= 0, 'both ports appear');
  assert.ok(tls < plain, 'the first 6697 comes before the first 6667');
  assert.match(text, /leave certificate verification on/);
});

/** Problems a page's text has under SC-U2-24 (b) and (c), block by block. */
function plaintextPortProblems(text: string): string[] {
  const out: string[] = [];
  for (const block of blocksWith6667(text)) {
    const lower = block.toLowerCase();
    if (!lower.includes('unencrypted')) {
      out.push('no unencrypted');
    }
    if (!/\bnickname\b/.test(lower) || !/\bmessages\b/.test(lower)) {
      out.push('does not say nickname and messages are exposed');
    }
    if (!/\bread\b|\breadable\b/.test(lower) || !/network path/.test(lower)) {
      out.push('does not say they are readable on the network path');
    }
    if (lower.includes('recommend')) {
      out.push('recommends 6667');
    }
    if (/\b(tls|certificate|handshake|verification)\b[^.\n]*\b(error|errors|fail|fails|failed|failing|problem|problems|refused|expired)\b|\b(error|errors|fail|fails|failed|failing|problem|problems|refused|expired)\b[^.\n]*\b(tls|certificate|handshake|verification)\b/.test(lower)) {
      out.push('offers 6667 as a remedy for a TLS or certificate problem');
    }
  }
  return out;
}

/** Problems any page has with turning certificate verification off. */
function verificationOffProblems(text: string): string[] {
  const lower = text.toLowerCase();
  const patterns = [/\b(turn|switch|set|put)\b[^.\n]*\b(off|disabled?)\b[^.\n]*\b(verif\w*|certificate)/, /\b(disable|disables|disabling|skip|skips|skipping|ignore|ignores|ignoring|bypass|trust all)\b[^.\n]*\b(verif\w*|certificate)/, /\b(verif\w*|certificate checks?)\b[^.\n]*\b(off|disabled|optional|unnecessary)\b/, /\b(accept|accepting)\b[^.\n]*\b(any|invalid|untrusted|expired|self-signed)\b[^.\n]*\bcertificate/, /\binsecure\b[^.\n]*\b(flag|option|mode|setting)\b/];
  return patterns.filter((re) => re.test(lower)).map((re) => re.source.slice(0, 40));
}

function realPages(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSyncSorted(dir)) {
      const relName = rel === '' ? name : `${rel}/${name}`;
      if (name.endsWith('.md')) {
        out.push({ file: relName, text: readFileSync(join(dir, name), 'utf8') });
      } else {
        walk(join(dir, name), relName);
      }
    }
  };
  walk(join(ROOT, 'content'), '');
  return out;
}

test('SC-U2-24 b c: each 6667 block says the nickname and messages are readable on the network path and never recommends it', () => {
  const pages = realPages();
  assert.ok(pages.length >= 8, `${pages.length} pages read`);
  for (const { file, text } of pages) {
    assert.deepEqual(plaintextPortProblems(text), [], file);
  }
});

test('SC-U2-24 c: no page turns certificate verification off', () => {
  for (const { file, text } of realPages()) {
    assert.deepEqual(verificationOffProblems(text), [], file);
  }
});

test('SC-U2-24 the problem predicates refuse each hostile variant and accept the shipped wording', () => {
  const good = 'Port 6667 accepts unencrypted connections. Anyone on the network path can read everything your client sends there, your nickname and your messages included.';
  assert.deepEqual(plaintextPortProblems(good), []);
  const bad: Array<[string, string]> = [
    ['no unencrypted', good.replace('unencrypted', 'plain')],
    ['no nickname', good.replace('your nickname and ', '')],
    ['no messages', good.replace('your messages', 'the rest')],
    ['not readable', good.replace('can read', 'can see').replace('network path', 'wire')],
    ['no network path', good.replace('network path', 'wire')],
    ['recommended', `${good} This is recommended.`],
    ['a TLS remedy', `${good} If TLS fails, use it.`],
    ['a certificate error remedy', `${good} Use it when you see a certificate error.`],
    ['a fenced block without the warning', `${good}\n\n\`\`\`\nCONNECT chat.ircx.io 6667\n\`\`\`\n`],
    ['a table row without the warning', `${good}\n\n| Port | 6667 |\n`],
  ];
  for (const [name, text] of bad) {
    assert.notEqual(plaintextPortProblems(text).length, 0, name);
  }
  for (const text of ['Leave certificate verification on.', 'Keep verification on in your client.']) {
    assert.deepEqual(verificationOffProblems(text), [], text);
  }
  for (const text of ['Turn certificate verification off.', 'Turn off certificate verification.', 'Disable certificate checking.', 'Skip verification if it fails.', 'Ignore the certificate warning.', 'Certificate verification is optional.', 'Set verification to off.', 'Accept any certificate.', 'Use the insecure flag.']) {
    assert.notEqual(verificationOffProblems(text).length, 0, text);
  }
});

test('SC-U2-24 a: the client guide recommends 6697 with TLS before 6667 appears, and 6667 is not in the settings table', () => {
  const text = readFileSync(join(ROOT, 'content/connect/irc-client.md'), 'utf8');
  const [first] = blocks(text.slice(text.indexOf('6697') - 200)).filter((b) => b.includes('6697'));
  assert.ok(first !== undefined && /\|\s*Port\s*\|\s*`6697`\s*\|/.test(first), 'the 6697 row is in the settings table');
  assert.match(first, /\|\s*TLS\s*\|\s*On\s*\|/);
  assert.ok(!first.includes('6667'));
  const before = text.slice(0, text.indexOf('6697'));
  assert.match(before, /recommended/i, 'the settings are called recommended before the table');
  assert.ok(!before.includes('6667'));
});

test('SC-U2-5 every C0 control but tab and LF is refused, one control at a time, and the neighbours 0x09, 0x0a and 0x20 are legal', () => {
  for (let code = 0; code < 0x20; code++) {
    if (code === 0x09 || code === 0x0a) {
      continue;
    }
    const fx = fixture({ 'bad.md': pageText(`first\n${cat('x', String.fromCharCode(code), 'y')}\n`) });
    try {
      const hit = loadContent(fx.content).findings.filter((f) => f.rule === 'content-control');
      assert.equal(hit.length, 1, `0x${code.toString(16)}`);
      assert.equal(hit[0]?.line, 6, `0x${code.toString(16)}`);
    } finally {
      fx.cleanup();
    }
  }
  const fx = fixture({ 'ok.md': pageText('a\tb c\n') });
  try {
    assert.deepEqual(loadContent(fx.content).findings, []);
  } finally {
    fx.cleanup();
  }
});

test('SC-U2-5 a name must match whole: a longer extension or a trailing character is refused', () => {
  const bad = ['page.mdx', 'page.md.bak', 'page.md~', 'page.md ', 'page.mdd', 'page-.md.md'];
  for (const name of bad) {
    const fx = fixture({ [name]: pageText('x\n') });
    try {
      const r = loadContent(fx.content);
      assert.ok(r.findings.some((f) => f.rule === 'content-name'), `${name}: ${JSON.stringify(r.findings)}`);
    } finally {
      fx.cleanup();
    }
  }
  for (const dir of ['dir.x', 'dir x', 'dir\u00e9', 'dir_', 'DIR']) {
    const fx = fixture({ [`${dir}/index.md`]: pageText('x\n') });
    try {
      assert.ok(loadContent(fx.content).findings.some((f) => f.rule === 'content-name'), dir);
    } finally {
      fx.cleanup();
    }
  }
});

test('SC-U2-5 title and description lengths count characters, not UTF-16 units', () => {
  const astral = String.fromCodePoint(0x1f600);
  const front = (extra: string): string[] => parseFrontMatter('content/x.md', `---\n${extra}---\nbody\n`).findings.map((f) => f.message);
  assert.deepEqual(front(`title: ${astral.repeat(80)}\ndescription: ${astral.repeat(200)}\n`), []);
  assert.match(front(`title: ${astral.repeat(81)}\ndescription: d\n`).join(), /title is longer than 80/);
  assert.match(front(`title: t\ndescription: ${astral.repeat(201)}\n`).join(), /description is longer than 200/);
});

test('SC-U2-5 a file over the cap is reported as too large and is not parsed further', () => {
  const garbage = 'x'.repeat(65537);
  const fx = fixture({ 'huge.md': garbage });
  try {
    const r = loadContent(fx.content);
    assert.deepEqual(r.findings.map((f) => [f.file, f.rule]), [['content/huge.md', 'content-size']]);
  } finally {
    fx.cleanup();
  }
});

test('SC-U2-5 two refusals in one tree are both reported, so one bad file does not hide another', () => {
  const fx = fixture({ 'one.md': 'no front matter\n', 'two.md': pageText(cat('x', String.fromCharCode(0x202e), 'y\n')), 'Three.md': pageText('x\n') });
  try {
    const r = loadContent(fx.content);
    assert.deepEqual(r.findings.map((f) => f.file).sort(), ['content/Three.md', 'content/one.md', 'content/two.md']);
  } finally {
    fx.cleanup();
  }
});

test('SC-U2-15 safeText maps every unit outside 0x20-0x7e, and only those', () => {
  const at = (code: number): string => safeText(String.fromCharCode(code));
  assert.equal(at(0x1f), '\\x1f');
  assert.equal(at(0x20), ' ');
  assert.equal(at(0x7e), '~');
  assert.equal(at(0x7f), '\\x7f');
  assert.equal(at(0x80), '\\x80');
  assert.equal(at(0xff), '\\xff');
  assert.equal(at(0x100), '\\u0100');
  assert.equal(at(0x0a), '\\x0a');
  assert.equal(at(0), '\\x00');
  assert.equal(at(0x202e), '\\u202e');
  assert.equal(at(0xfffd), '\\ufffd');
  assert.equal(safeText(String.fromCodePoint(0x1f600)), '\\ud83d\\ude00');
  assert.equal(safeText('::error::x\n::y'), '::error::x\\x0a::y', 'a printable :: stays; the line break cannot start a new line');
  assert.equal(safeText(''), '');
});

test('SC-U2-15 formatFinding escapes the path, the line form of the path and the message', () => {
  const hostile = 'a\n::error::b';
  assert.equal(formatFinding({ file: hostile, rule: 'R', message: 'm' }), 'a\\x0a::error::b: R: m');
  assert.equal(formatFinding({ file: hostile, line: 3, rule: 'R', message: 'm' }), 'a\\x0a::error::b:3: R: m');
  assert.equal(formatFinding({ file: 'f', line: 3, rule: 'R', message: 'x\n::error::y' }), 'f:3: R: x\\x0a::error::y');
  assert.equal(formatFinding({ file: 'f', line: 0, rule: 'R', message: 'm' }), 'f:0: R: m', 'line 0 is a line');
});

test('DoD 5 a: the client guide no longer restates the two removed passages', () => {
  const text = readFileSync(join(ROOT, 'content/connect/irc-client.md'), 'utf8');
  assert.ok(!text.includes('without TLS. It is unencrypted'), 'the fragment pair "without TLS. It is unencrypted"');
  assert.ok(!/We recommend port 6697 with TLS/.test(text), 'the sentence that repeats the table row');
  assert.ok(!/\bwith TLS\b[^.\n]*\.\s+The server's certificate/.test(text));
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 20 && !s.startsWith('|'));
  assert.equal(new Set(sentences).size, sentences.length, 'no sentence appears twice on the page');
  const parsed = parseFrontMatter('content/connect/irc-client.md', text);
  assert.deepEqual(parsed.findings, []);
  assert.equal(parsed.front.order, 2);
});

test('DoD 6: the guide keeps the \\0 escape as the seventh, beside the draft table that lists six', () => {
  const text = readFileSync(join(ROOT, 'content/protocol/lines-and-escaping.md'), 'utf8');
  assert.ok(text.includes('| `\\0` | NUL |'), 'the table has the \\0 row');
  assert.ok(text.includes('decodes these seven'), 'the lead counts seven escapes');
  assert.match(
    text,
    /Table 1 in \[section 3\]\(https:\/\/datatracker\.ietf\.org\/doc\/html\/draft-pfenning-irc-extensions-04#section-3\), lists only the first six\./,
    'the note names the draft table and the six it lists',
  );
});
