#!/usr/bin/env node
// a stand-in for the hub's bin/grant-check: reads one wire request on stdin, answers from
// fixture.json next to this file, and appends the request to requests.log beside it. a test
// copies this file into its own temp dir, so each test has its own fixture and log.
//   fixture.sequence[n]  -- the answer for the nth call (0-based), when present
//   fixture.byPhase[p]   -- else the answer for phase p
//   fixture.decision     -- else this
// exit 0 allowed, 2 denied, as the real checker does; fixture.exit overrides (e.g. 3).
//   fixture.exitWith  -- print the decision but exit with this code (a contract violation)
//   fixture.rawStdout -- print this text instead of a decision, exit 0
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  const request = JSON.parse(raw);
  const logPath = join(dir, "requests.log");
  const n = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).length : 0;
  appendFileSync(logPath, `${JSON.stringify(request)}\n`);
  const fixture = JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8"));
  if (fixture.exit !== undefined) { if (fixture.exit === 3) process.stderr.write('unscoped test server'); process.exit(fixture.exit); }
  if (fixture.rawStdout !== undefined) {
    process.stdout.write(fixture.rawStdout);
    process.exit(0);
  }
  const decision = fixture.sequence?.[n] ?? fixture.byPhase?.[request.phase] ?? fixture.decision;
  process.stdout.write(`${JSON.stringify(decision)}\n`);
  process.exit(fixture.exitWith ?? (decision.allowed ? 0 : 2));
});
