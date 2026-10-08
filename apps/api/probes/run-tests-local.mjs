// Local gate runner for this sandbox: clears the B2 credential variables so
// the default storage driver is local disk — the environment CI and a plain
// checkout run in. Needed here because the workspace injects B2 credentials
// whose regional endpoint does not resolve in the sandbox, which is a network
// property of this sandbox, not a property of the code under test.
//
//   node apps/api/probes/run-tests-local.mjs apps/api/test/cancel.test.js ...
import { spawnSync } from "node:child_process";

for (const k of [
  "B2_KEY_ID",
  "B2_APPLICATION_KEY",
  "B2_BUCKET_NAME",
  "B2_PREFIX",
  "B2_ENDPOINT",
]) {
  delete process.env[k];
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node run-tests-local.mjs <test files...>");
  process.exit(2);
}
const r = spawnSync("node", ["--test", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
