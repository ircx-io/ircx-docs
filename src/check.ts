// Content check entry (`npm run check`): loads content/ through the tree and
// front-matter rules in content.ts, then applies the emphasis cap. The
// Markdown and link rules are enforced where the pages are rendered.

import { join, resolve } from 'node:path';
import { loadContent } from './content.ts';
import { formatFinding, type Finding } from './text.ts';

/** Most `*`, `_` and `~` characters allowed in one blank-line-separated chunk (marked#4099). */
export const EMPHASIS_CAP = 256;

/**
 * Counts emphasis delimiters per blank-line-separated chunk outside fenced
 * code. Returns the 0-based body line where the first chunk over the cap
 * starts, or `undefined` when every chunk is within it.
 */
export function emphasisChunkOverCap(body: string): number | undefined {
  let fence: string | undefined;
  let count = 0;
  let chunkStart = 0;
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== undefined) {
      if (marker !== null && marker[1]?.[0] === fence[0] && (marker[1]?.length ?? 0) >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (marker !== null) {
      fence = marker[1];
      count = 0;
      continue;
    }
    if (line.trim() === '') {
      count = 0;
      chunkStart = i + 1;
      continue;
    }
    for (const ch of line) {
      if (ch === '*' || ch === '_' || ch === '~') {
        count++;
      }
    }
    if (count > EMPHASIS_CAP) {
      return chunkStart;
    }
  }
  return undefined;
}

/** Checks `<root>/content`; returns the findings (empty when clean). */
export function checkContent(root: string): Finding[] {
  const loaded = loadContent(join(root, 'content'));
  const findings: Finding[] = [...loaded.findings];
  for (const page of loaded.pages) {
    const over = emphasisChunkOverCap(page.body);
    if (over !== undefined) {
      findings.push({
        file: page.file,
        line: page.bodyLine + over,
        rule: 'emphasis-cap',
        message: `more than ${EMPHASIS_CAP} emphasis characters in one paragraph`,
      });
    }
  }
  return findings;
}

if (import.meta.main) {
  const findings = checkContent(resolve(import.meta.dirname, '..'));
  for (const f of findings) {
    process.stderr.write(`${formatFinding(f)}\n`);
  }
  if (findings.length > 0) {
    process.stderr.write(`check failed with ${findings.length} finding(s)\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('check: no findings\n');
  }
}
