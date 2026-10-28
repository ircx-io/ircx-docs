// Loads and validates the content tree. Every byte under content/ is
// untrusted: names, sizes, encodings, controls and front matter are checked
// here before anything is parsed as Markdown.

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding } from './text.ts';

export const MAX_FILE_BYTES = 64 * 1024;
export const MAX_FILES = 200;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
export const MAX_TITLE = 80;
export const MAX_DESCRIPTION = 200;
export const MAX_ORDER = 999;

const DIR_NAME = /^[a-z0-9-]+$/;
const FILE_NAME = /^[a-z0-9-]+\.md$/;
// Bidi embedding, override and isolate controls (trojan-source).
const BIDI = /[\u202a-\u202e\u2066-\u2069]/;
// C0 controls other than tab and LF, plus DEL.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/** One validated Markdown page. */
export interface Page {
  /** Repository-relative source path, `content/...`. */
  readonly file: string;
  /** Path segments below content/, without `.md` and without a trailing `index`. */
  readonly segments: readonly string[];
  /** Root-relative URL ending in `/`. */
  readonly url: string;
  /** True for a directory's `index.md`. */
  readonly isIndex: boolean;
  readonly title: string;
  readonly description: string;
  readonly order: number | undefined;
  /** Markdown body after the front matter, LF line endings. */
  readonly body: string;
  /** 1-based source line of the body's first line. */
  readonly bodyLine: number;
}

export interface LoadResult {
  readonly pages: readonly Page[];
  readonly findings: readonly Finding[];
}

/** Maps content-relative segments to the page URL. */
export function urlOf(segments: readonly string[]): string {
  return segments.length === 0 ? '/' : `/${segments.join('/')}/`;
}

interface FrontMatter {
  title?: string;
  description?: string;
  order?: number;
}

/** Parses the strict front-matter subset; returns findings for every violation. */
export function parseFrontMatter(
  file: string,
  text: string,
): { front: FrontMatter; body: string; bodyLine: number; findings: Finding[] } {
  const findings: Finding[] = [];
  const front: FrontMatter = {};
  const lines = text.split('\n');
  if (lines[0] !== '---') {
    findings.push({ file, line: 1, rule: 'front-matter', message: 'the file must open with a --- line' });
    return { front, body: '', bodyLine: 1, findings };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close < 0) {
    findings.push({ file, line: 1, rule: 'front-matter', message: 'no closing --- line' });
    return { front, body: '', bodyLine: 1, findings };
  }
  const seen = new Set<string>();
  for (let i = 1; i < close; i++) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;
    const m = /^([a-z]+): (.*)$/.exec(line);
    if (m === null) {
      findings.push({ file, line: lineNo, rule: 'front-matter', message: 'expected a "key: value" line' });
      continue;
    }
    const key = m[1] ?? '';
    let value = m[2] ?? '';
    if (key !== 'title' && key !== 'description' && key !== 'order') {
      findings.push({ file, line: lineNo, rule: 'front-matter', message: `unknown key ${key}` });
      continue;
    }
    if (seen.has(key)) {
      findings.push({ file, line: lineNo, rule: 'front-matter', message: `duplicate key ${key}` });
      continue;
    }
    seen.add(key);
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (value.trim() === '') {
      findings.push({ file, line: lineNo, rule: 'front-matter', message: `empty value for ${key}` });
      continue;
    }
    if (value.includes('\\')) {
      findings.push({ file, line: lineNo, rule: 'front-matter', message: `a backslash in ${key}` });
      continue;
    }
    if (key === 'order') {
      if (!/^(?:0|[1-9][0-9]{0,2})$/.test(value) || Number(value) > MAX_ORDER) {
        findings.push({ file, line: lineNo, rule: 'front-matter', message: `order must be an integer from 0 to ${MAX_ORDER}` });
        continue;
      }
      front.order = Number(value);
    } else {
      const max = key === 'title' ? MAX_TITLE : MAX_DESCRIPTION;
      if ([...value].length > max) {
        findings.push({ file, line: lineNo, rule: 'front-matter', message: `${key} is longer than ${max} characters` });
        continue;
      }
      front[key] = value;
    }
  }
  for (const key of ['title', 'description'] as const) {
    if (!seen.has(key)) {
      findings.push({ file, line: 1, rule: 'front-matter', message: `missing key ${key}` });
    }
  }
  return { front, body: lines.slice(close + 1).join('\n'), bodyLine: close + 2, findings };
}

/** Walks `contentDir` (repository-relative name `content`) and validates every file. */
export function loadContent(contentDir: string): LoadResult {
  const findings: Finding[] = [];
  const pages: Page[] = [];
  let root;
  try {
    root = lstatSync(contentDir);
  } catch {
    return { pages, findings: [{ file: 'content', rule: 'content-root', message: 'content/ does not exist' }] };
  }
  if (!root.isDirectory()) {
    return { pages, findings: [{ file: 'content', rule: 'content-root', message: 'content/ must be a real directory, not a symlink or file' }] };
  }
  const state = { files: 0, total: 0 };
  walk(contentDir, [], findings, pages, state);
  if (state.files > MAX_FILES) {
    findings.push({ file: 'content', rule: 'content-size', message: `more than ${MAX_FILES} files` });
  }
  if (state.total > MAX_TOTAL_BYTES) {
    findings.push({ file: 'content', rule: 'content-size', message: `more than ${MAX_TOTAL_BYTES} bytes in total` });
  }
  const byUrl = new Map<string, string>();
  for (const page of pages) {
    const other = byUrl.get(page.url);
    if (other !== undefined) {
      findings.push({ file: page.file, rule: 'duplicate-slug', message: `maps to the same URL as ${other}` });
    } else {
      byUrl.set(page.url, page.file);
    }
  }
  return { pages, findings };
}

function walk(
  dir: string,
  segments: string[],
  findings: Finding[],
  pages: Page[],
  state: { files: number; total: number },
): void {
  const rel = ['content', ...segments].join('/');
  const names = readdirSync(dir).sort();
  if (!names.includes('index.md')) {
    findings.push({ file: rel, rule: 'content-layout', message: 'every directory needs an index.md' });
  }
  for (const name of names) {
    const path = join(dir, name);
    const relPath = `${rel}/${name}`;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      findings.push({ file: relPath, rule: 'content-layout', message: 'symlinks are not allowed' });
      continue;
    }
    if (stat.isDirectory()) {
      if (!DIR_NAME.test(name)) {
        findings.push({ file: relPath, rule: 'content-name', message: 'directory names must match [a-z0-9-]+' });
        continue;
      }
      walk(path, [...segments, name], findings, pages, state);
      continue;
    }
    if (!stat.isFile() || !FILE_NAME.test(name)) {
      findings.push({ file: relPath, rule: 'content-name', message: 'only files named [a-z0-9-]+.md are allowed' });
      continue;
    }
    const stem = name.slice(0, -3);
    state.files++;
    state.total += stat.size;
    if (stat.size > MAX_FILE_BYTES) {
      findings.push({ file: relPath, rule: 'content-size', message: `larger than ${MAX_FILE_BYTES} bytes` });
      continue;
    }
    const page = readPage(path, relPath, segments, stem, findings);
    if (page !== undefined) {
      pages.push(page);
    }
  }
}

function readPage(
  path: string,
  relPath: string,
  segments: readonly string[],
  stem: string,
  findings: Finding[],
): Page | undefined {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
  } catch {
    findings.push({ file: relPath, rule: 'content-encoding', message: 'not valid UTF-8' });
    return undefined;
  }
  text = text.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  let bad = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (BIDI.test(line)) {
      findings.push({ file: relPath, line: i + 1, rule: 'content-control', message: 'a bidirectional control character' });
      bad = true;
    }
    if (CONTROL.test(line)) {
      findings.push({ file: relPath, line: i + 1, rule: 'content-control', message: 'a control character other than tab or LF' });
      bad = true;
    }
  }
  if (bad) {
    return undefined;
  }
  const parsed = parseFrontMatter(relPath, text);
  findings.push(...parsed.findings);
  if (parsed.findings.length > 0) {
    return undefined;
  }
  const isIndex = stem === 'index';
  const pageSegments = isIndex ? [...segments] : [...segments, stem];
  return {
    file: relPath,
    segments: pageSegments,
    url: urlOf(pageSegments),
    isIndex,
    title: parsed.front.title ?? '',
    description: parsed.front.description ?? '',
    order: parsed.front.order,
    body: parsed.body,
    bodyLine: parsed.bodyLine,
  };
}
