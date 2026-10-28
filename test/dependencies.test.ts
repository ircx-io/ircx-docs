import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from './helpers.ts';

type Json = Record<string, unknown>;

const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Json;
const LOCK = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as Json;
const NPMRC = readFileSync(join(ROOT, '.npmrc'), 'utf8');

const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack', 'prepublish'];
const BAD_SPEC = /^(?:git\+|git:|file:|link:|http:|https:|github:|ssh:)/;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Problems in a package.json object: the approved set, no lifecycle scripts, no redirecting specs. */
export function packageProblems(pkg: Json): string[] {
  const out: string[] = [];
  if (pkg.private !== true) {
    out.push('not private');
  }
  const deps = Object.keys((pkg.dependencies as Json | undefined) ?? {}).sort();
  if (deps.length !== 0) {
    out.push(`dependencies ${deps.join()}`);
  }
  const dev = Object.keys((pkg.devDependencies as Json | undefined) ?? {}).sort();
  if (JSON.stringify(dev) !== JSON.stringify(['@types/node', 'typescript'])) {
    out.push(`devDependencies ${dev.join()}`);
  }
  const scripts = Object.keys((pkg.scripts as Json | undefined) ?? {});
  for (const name of scripts) {
    if (LIFECYCLE.includes(name)) {
      out.push(`lifecycle script ${name}`);
    }
  }
  for (const key of ['overrides', 'bundleDependencies', 'bundledDependencies', 'resolutions', 'optionalDependencies', 'peerDependencies']) {
    if (key in pkg) {
      out.push(`field ${key}`);
    }
  }
  for (const group of ['dependencies', 'devDependencies'] as const) {
    for (const [name, spec] of Object.entries((pkg[group] as Record<string, string> | undefined) ?? {})) {
      if (BAD_SPEC.test(spec)) {
        out.push(`spec ${name}`);
      }
    }
  }
  return out;
}

export function npmrcProblems(text: string): string[] {
  return text === 'ignore-scripts=true\n' ? [] : ['.npmrc is not exactly ignore-scripts=true'];
}

/** Problems in a package-lock.json object. */
export function lockProblems(lock: Json): string[] {
  const out: string[] = [];
  if (lock.lockfileVersion !== 3) {
    out.push('lockfileVersion');
  }
  const packages = (lock.packages as Record<string, Json> | undefined) ?? {};
  for (const [path, entry] of Object.entries(packages)) {
    if (path === '') {
      continue;
    }
    if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith('https://registry.npmjs.org/')) {
      out.push(`${path}: resolved`);
    }
    if (typeof entry.integrity !== 'string' || !entry.integrity.startsWith('sha512-')) {
      out.push(`${path}: integrity`);
    }
    if (entry.link === true) {
      out.push(`${path}: link`);
    }
  }
  return out;
}

test('the direct dependency set is the approved set', () => {
  assert.deepEqual(packageProblems(PACKAGE), []);
  assert.equal(PACKAGE.private, true);
  assert.deepEqual(Object.keys((PACKAGE.dependencies as Json | undefined) ?? {}), [], 'no runtime dependency');
  assert.deepEqual(Object.keys(PACKAGE.devDependencies as Json).sort(), ['@types/node', 'typescript']);
  assert.deepEqual(
    Object.keys(PACKAGE.scripts as Json).filter((s) => LIFECYCLE.includes(s)),
    [],
  );
});

test('.npmrc is exactly ignore-scripts=true and a newline', () => {
  assert.deepEqual(npmrcProblems(NPMRC), []);
  assert.equal(NPMRC, 'ignore-scripts=true\n');
  assert.ok(!NPMRC.includes('registry'));
});

test('package.json mutants are each refused', () => {
  const mutants: Array<[string, (p: Json) => void]> = [
    ['marked added to dependencies', (p) => (p.dependencies = { marked: '^18.0.0' })],
    ['another runtime dependency added', (p) => (p.dependencies = { 'left-pad': '^1.0.0' })],
    ['an added dev dependency', (p) => ((p.devDependencies as Json).eslint = '^9.0.0')],
    ['a removed dev dependency', (p) => delete (p.devDependencies as Json).typescript],
    ['not private', (p) => (p.private = false)],
    ['private missing', (p) => delete p.private],
    ['a postinstall script', (p) => ((p.scripts as Json).postinstall = 'node x.js')],
    ['a preinstall script', (p) => ((p.scripts as Json).preinstall = 'node x.js')],
    ['an install script', (p) => ((p.scripts as Json).install = 'node x.js')],
    ['a prepare script', (p) => ((p.scripts as Json).prepare = 'node x.js')],
    ['a prepack script', (p) => ((p.scripts as Json).prepack = 'node x.js')],
    ['a postpack script', (p) => ((p.scripts as Json).postpack = 'node x.js')],
    ['a prepublish script', (p) => ((p.scripts as Json).prepublish = 'node x.js')],
    ['overrides', (p) => (p.overrides = { marked: '1.0.0' })],
    ['bundleDependencies', (p) => (p.bundleDependencies = ['marked'])],
    ['a git+https spec', (p) => ((p.devDependencies as Json).typescript = 'git+https://host.example/x.git')],
    ['a file: spec', (p) => ((p.devDependencies as Json)['@types/node'] = 'file:../types')],
    ['a link: spec', (p) => ((p.devDependencies as Json).typescript = 'link:../ts')],
    ['an http: spec', (p) => ((p.devDependencies as Json)['@types/node'] = 'http://host.example/x.tgz')],
  ];
  for (const [name, mutate] of mutants) {
    const p = clone(PACKAGE);
    mutate(p);
    assert.notEqual(packageProblems(p).length, 0, name);
  }
});

test('.npmrc mutants are each refused', () => {
  for (const text of ['', 'ignore-scripts=true', 'ignore-scripts=false\n', 'ignore-scripts=true\nregistry=https://registry.example/\n', 'registry=https://registry.example/\nignore-scripts=true\n', ' ignore-scripts=true\n', 'ignore-scripts=true\n\n']) {
    assert.notEqual(npmrcProblems(text).length, 0, JSON.stringify(text));
  }
});

test('every lockfile package resolves to the npm registry with sha512 integrity', () => {
  assert.deepEqual(lockProblems(LOCK), []);
  assert.equal(LOCK.lockfileVersion, 3);
  const packages = LOCK.packages as Record<string, Json>;
  const entries = Object.entries(packages).filter(([k]) => k !== '');
  assert.ok(entries.length >= 2, `${entries.length} entries`);
  for (const [path, e] of entries) {
    assert.match(String(e.resolved), /^https:\/\/registry\.npmjs\.org\//, path);
    assert.match(String(e.integrity), /^sha512-/, path);
    assert.notEqual(e.link, true, path);
  }
  // Both dev dependencies are present in the lock.
  for (const name of ['typescript', '@types/node']) {
    assert.ok(`node_modules/${name}` in packages, name);
  }
});

test('lockfile mutants are each refused', () => {
  const first = Object.keys(LOCK.packages as Json).find((k) => k !== '') ?? '';
  const mutants: Array<[string, (e: Json, l: Json) => void]> = [
    ['a resolved on another registry', (e) => (e.resolved = 'https://registry.example/x/-/x-1.0.0.tgz')],
    ['a resolved on a lookalike host', (e) => (e.resolved = 'https://registry.npmjs.org.evil.example/x.tgz')],
    ['an http resolved', (e) => (e.resolved = 'http://registry.npmjs.org/x/-/x-1.0.0.tgz')],
    ['a git+https resolved', (e) => (e.resolved = 'git+https://host.example/x.git#abc')],
    ['a missing resolved', (e) => delete e.resolved],
    ['a missing integrity', (e) => delete e.integrity],
    ['a sha1 integrity', (e) => (e.integrity = 'sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=')],
    ['a sha256 integrity', (e) => (e.integrity = 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAA=')],
    ['a link entry', (e) => (e.link = true)],
    ['lockfileVersion 2', (_e, l) => (l.lockfileVersion = 2)],
  ];
  for (const [name, mutate] of mutants) {
    const lock = clone(LOCK);
    mutate((lock.packages as Record<string, Json>)[first] as Json, lock);
    assert.notEqual(lockProblems(lock).length, 0, name);
  }
  const added = clone(LOCK);
  (added.packages as Record<string, Json>)['node_modules/extra'] = { version: '1.0.0', resolved: 'https://registry.example/e.tgz', integrity: 'sha512-AAAA' };
  assert.notEqual(lockProblems(added).length, 0);
});

test('a Dependabot npm bump still passes', () => {
  const bumped = clone(LOCK);
  const packages = bumped.packages as Record<string, Json>;
  const key = Object.keys(packages).find((k) => k === 'node_modules/typescript') ?? '';
  const e = packages[key] as Json;
  assert.ok(e !== undefined, 'the lock holds typescript');
  const before = JSON.stringify(e);
  e.version = '99.1.0';
  e.resolved = 'https://registry.npmjs.org/typescript/-/typescript-99.1.0.tgz';
  e.integrity = `sha512-${'B'.repeat(86)}==`;
  assert.notEqual(JSON.stringify(e), before);
  assert.deepEqual(lockProblems(bumped), []);
});
