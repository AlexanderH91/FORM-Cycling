/* Parse every shipped script the way the browser will.
 *
 * `node --check file.js` parses a .js file as a CommonJS script, so it happily
 * accepts things that are errors in a module — a duplicate top-level `const`
 * among them, which is exactly what slipped through during this change and
 * would have been a blank screen on the phone. Modules must be checked as
 * modules. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { T, finish } from './lib.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const SKIP = new Set(['vendor', 'node_modules', '.git', 'assets', '.out']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.m?js$/.test(name)) out.push(full);
  }
  return out;
}

const files = walk(join(ROOT, 'js')).concat([join(ROOT, 'sw.js')]);
T('there are scripts to check', files.length > 5, `${files.length} files`);

const bad = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  // the service worker is a classic script; everything under js/ is a module
  const asModule = !f.endsWith('sw.js');
  try {
    execFileSync(process.execPath,
      asModule ? ['--input-type=module', '--check'] : ['--input-type=commonjs', '--check'],
      { input: src, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    bad.push(`${relative(ROOT, f)}: ${String(e.stderr).split('\n').find((l) => /Error/.test(l)) ?? 'parse failed'}`);
  }
}
T('every shipped script parses in the mode it is loaded in', bad.length === 0, bad.join(' | ') || `${files.length} files clean`);

// The inline bootstrap in index.html is a classic script and never gets bundled.
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
T('the page has an inline bootstrap to check', inline.length >= 1, `${inline.length} block(s)`);
let inlineBad = null;
for (const code of inline) {
  try { execFileSync(process.execPath, ['--input-type=commonjs', '--check'], { input: code, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (e) { inlineBad = String(e.stderr).split('\n').find((l) => /Error/.test(l)); }
}
T('the inline bootstrap parses', !inlineBad, inlineBad ?? 'clean');
finish();
