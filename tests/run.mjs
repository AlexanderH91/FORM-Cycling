#!/usr/bin/env node
/* Runs every suite against a freshly served copy of the app.
 *
 *   node tests/run.mjs            all suites
 *   node tests/run.mjs nav gate   only those
 *
 * Serves the repo itself — no build, so what the browser loads is what ships. */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { spawn } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const HERE = new URL(".", import.meta.url).pathname;
const CONCURRENCY = Number(process.env.FORM_TEST_JOBS ?? 3);

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".wasm": "application/wasm", ".task": "application/octet-stream", ".webmanifest": "application/manifest+json",
};

const server = createServer(async (req, res) => {
  try {
    const path = normalize(decodeURIComponent(req.url.split("?")[0]));
    if (path.includes("..")) { res.writeHead(403).end(); return; }
    const file = join(ROOT, path === "/" ? "index.html" : path);
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404).end("not found"); }
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const wanted = process.argv.slice(2);
const suites = readdirSync(HERE)
  .filter((f) => f.endsWith(".test.mjs"))
  .filter((f) => !wanted.length || wanted.some((w) => f.includes(w)))
  .sort();

if (!suites.length) { console.error("no suites matched"); server.close(); process.exit(1); }

const run = (file) => new Promise((resolve) => {
  const child = spawn(process.execPath, [join(HERE, file)], {
    env: { ...process.env, FORM_TEST_URL: base },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  child.on("close", (code) => resolve({ file, code, out }));
});

const queue = [...suites];
const done = [];
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
  while (queue.length) done.push(await run(queue.shift()));
}));

let pass = 0, fail = 0;
for (const r of done.sort((a, b) => a.file.localeCompare(b.file))) {
  const lines = r.out.split("\n").filter((l) => l.startsWith("PASS") || l.startsWith("FAIL"));
  pass += lines.filter((l) => l.startsWith("PASS")).length;
  fail += lines.filter((l) => l.startsWith("FAIL")).length;
  console.log(`\n── ${r.file.replace(".test.mjs", "")}`);
  for (const l of lines) console.log("   " + l);
  if (r.code !== 0 && !lines.some((l) => l.startsWith("FAIL"))) {
    console.log("   suite crashed:\n" + r.out.split("\n").slice(-12).map((l) => "   " + l).join("\n"));
    fail++;
  }
}

console.log(`\n${pass} passed, ${fail} failed, ${done.length} suites`);
server.close();
process.exit(fail ? 1 : 0);
