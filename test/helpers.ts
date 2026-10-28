// Shared fixtures for the test files. Nothing here asserts; it builds temporary
// trees and hostile strings. Hostile hosts and addresses are assembled at run
// time so this tree stays clean under the publication scan.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');

/** Joins parts; used to build strings the scan would flag if written whole. */
export function cat(...parts: string[]): string {
  return parts.join('');
}

export const AT = '@';

export interface Fixture {
  readonly root: string;
  readonly content: string;
  cleanup(): void;
}

/** A page's front matter, valid unless a field is overridden. */
export function pageText(body: string, title = 'A page', description = 'About a page.', extra = ''): string {
  return `---\ntitle: ${title}\ndescription: ${description}\n${extra}---\n${body}`;
}

/** Creates `<tmp>/content/<path>` for each entry, with a root `index.md` unless `withIndex` is false. */
export function fixture(files: Record<string, string | Uint8Array>, withIndex = true): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'docs-fixture-'));
  const content = join(root, 'content');
  mkdirSync(content);
  const all: Record<string, string | Uint8Array> = withIndex ? { 'index.md': pageText('Home.\n'), ...files } : files;
  for (const [rel, data] of Object.entries(all)) {
    const path = join(content, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  }
  return { root, content, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Runs the real `src/check.ts` entry point against a fixture tree's own copy of src/. */
export function runCheckCli(fx: Fixture): SpawnSyncReturns<string> {
  cpSync(join(ROOT, 'src'), join(fx.root, 'src'), { recursive: true });
  return spawnSync(process.execPath, ['src/check.ts'], { cwd: fx.root, encoding: 'utf8', timeout: 60_000 });
}
