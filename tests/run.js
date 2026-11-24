// Runs every tests/*.test.js in its own process (they are plain scripts that exit non-zero on failure).
// `npm test` compiles src/lib/trading to .test-build first.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.js")).sort();
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], {
    env: { ...process.env, TZ: "UTC" }, // time-label tests assume UTC
    encoding: "utf8",
    timeout: 120_000,
  });
  if (r.status === 0) {
    console.log(`PASS  ${f.padEnd(22)} ${(r.stdout || "").trim().split("\n").pop()}`);
  } else {
    failed++;
    console.log(`FAIL  ${f}\n${r.stdout}\n${r.stderr}`);
  }
}
console.log(`\n${files.length - failed}/${files.length} suites passed`);
process.exit(failed ? 1 : 0);
