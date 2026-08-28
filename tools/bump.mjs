#!/usr/bin/env node
/* Bump the app version everywhere it is written, in one go.
 *
 *   node tools/bump.mjs            v2 -> v3
 *   node tools/bump.mjs v7         set it outright
 *
 * The version lives in five places on purpose — two of them so that a stale
 * module can be caught disagreeing with the page that loaded it — and keeping
 * five copies in step by hand is a promise that gets broken. Several deploys
 * went out with a bumped build string and the pill still reading v2, which
 * from the phone made every update look identical to the last. */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const file = (rel) => fileURLToPath(new URL(rel, ROOT));

const read = (rel) => readFileSync(file(rel), "utf8");
const write = (rel, s) => writeFileSync(file(rel), s);

const config = read("js/config.js");
const current = config.match(/VERSION = "v(\d+)"/)?.[1];
if (!current) throw new Error("could not find VERSION in js/config.js");

const asked = process.argv[2];
const next = asked ? `v${String(asked).replace(/^v/, "")}` : `v${Number(current) + 1}`;
if (!/^v\d+$/.test(next)) throw new Error(`not a version: ${asked}`);

const date = new Date().toISOString().slice(0, 10);
const build = `${date}-${next}`;

// Replace exactly what is expected, and fail loudly if a file has drifted out
// of the shape this knows how to edit — a silent no-op is the failure mode
// this script exists to prevent.
function swap(rel, pairs) {
  let s = read(rel);
  for (const [re, to] of pairs) {
    if (!re.test(s)) throw new Error(`${rel}: no match for ${re}`);
    s = s.replace(re, to);
  }
  write(rel, s);
}

swap("js/config.js", [
  [/VERSION = "v\d+"/, `VERSION = "${next}"`],
  [/BUILD = "[^"]+"/, `BUILD = "${build}"`],
]);

swap("index.html", [
  [/content="v\d+ · [^"]+"/, `content="${next} · ${build}"`],
  [/data-build="[^"]+"/, `data-build="${build}"`],
  [/data-version="v\d+"/, `data-version="${next}"`],
  [/(id="vertag"[^>]*>\s*)v\d+/, `$1${next}`],
  [/js\/main\.js\?v=[^"]+/, `js/main.js?v=${build}`],
]);

// Renaming the cache is also a purge: activate() drops every other one.
swap("sw.js", [[/CACHE = "form-cycling-v\d+"/, `CACHE = "form-cycling-${next}"`]]);

console.log(`v${current} -> ${next}   build ${build}`);
