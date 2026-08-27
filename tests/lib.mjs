/* Shared harness for the FORM Cycling test suites.
 *
 * Every suite drives the real app in a real browser: there is no build step
 * and no framework, so the honest way to test a page is to load it. Suites are
 * plain modules — run one directly with `node tests/<name>.test.mjs`, or all of
 * them with `node tests/run.mjs`. */

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

// Playwright may be installed locally or globally; take whichever answers.
export async function browser() {
  try { return (await import("playwright")).chromium; }
  catch {
    for (const root of ["/opt/node22/lib/node_modules/", "/usr/lib/node_modules/"]) {
      try { return createRequire(root)("playwright").chromium; } catch { /* try the next */ }
    }
    throw new Error("playwright not found — npm i -D playwright");
  }
}

export const BASE = process.env.FORM_TEST_URL ?? "http://127.0.0.1:8099";

export const OUT = new URL("./.out/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const results = [];

/* Assert, and say what was actually seen either way — a passing test that
   prints its measurement is documentation; one that prints "ok" is not. */
export function T(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` :: ${detail}` : ""}`);
  return ok;
}

export function finish() {
  const failed = results.filter((r) => !r.ok).length;
  if (failed) console.log(`\n${failed} of ${results.length} checks failed`);
  process.exitCode = failed ? 1 : 0;
  return failed;
}

// Fails the suite loudly rather than letting a thrown page error look like a pass.
export function watchErrors(page, ignore = [/fonts\.googleapis/]) {
  const errs = [];
  page.on("pageerror", (e) => errs.push(`PAGEERROR: ${e.message}`));
  page.on("requestfailed", (r) => {
    const url = r.url();
    if (!ignore.some((re) => re.test(url))) errs.push(`REQFAIL: ${url}`);
  });
  return errs;
}
