import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import { VERSION } from "../src/cli.js";
import { serve } from "../src/server.js";
import { canonicalFile, sessionKey } from "../src/session-store.js";

const CLI = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));

/** @param {string[]} args @param {NodeJS.ProcessEnv} env */
function runCli(args, env) {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve) => child.on("close", (status) => resolve({ status, stdout, stderr })));
}

test("lavish-axi owner sets, validates, and clears the board's owner status", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-owner-"));
  const stateDir = path.join(dir, "state");
  await mkdir(stateDir);
  const artifact = path.join(dir, "artifact.html");
  const unopened = path.join(dir, "unopened.html");
  await writeFile(artifact, "<!doctype html><html><body>ok</body></html>");
  await writeFile(unopened, "<!doctype html><html><body>ok</body></html>");
  const stateFile = path.join(stateDir, "state.json");
  const server = await serve({ port: 0, host: "127.0.0.1", stateFile, version: VERSION });
  const env = {
    ...process.env,
    LAVISH_AXI_STATE_DIR: stateDir,
    LAVISH_AXI_PORT: String(server.port),
    LAVISH_AXI_HOST: "127.0.0.1",
    LAVISH_AXI_LINK_HOST: "127.0.0.1",
    LAVISH_AXI_TELEMETRY: "0",
    LAVISH_AXI_NO_OPEN: "1",
  };
  const stored = async () => {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    return state.sessions[sessionKey(await canonicalFile(artifact))].owner_status;
  };
  try {
    const opened = await runCli([artifact, "--no-open"], env);
    assert.equal(opened.status, 0, opened.stderr || opened.stdout);

    const set = await runCli(
      ["owner", artifact, "--state", "live", "--label", "task 42", "--detail", "relayed", "--ttl", "120"],
      env,
    );
    assert.equal(set.status, 0, set.stderr || set.stdout);
    assert.match(set.stdout, /live/);
    const record = await stored();
    assert.equal(record.state, "live");
    assert.equal(record.label, "task 42");
    assert.equal(record.detail, "relayed");
    assert.ok(record.expires_at);

    const invalid = await runCli(["owner", artifact, "--state", "online"], env);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stdout + invalid.stderr, /VALIDATION_ERROR/);
    assert.equal((await stored()).state, "live", "a rejected write changes nothing");

    const missing = await runCli(["owner", unopened, "--state", "live"], env);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stdout + missing.stderr, /No Lavish session for this file/);

    const cleared = await runCli(["owner", artifact, "--clear"], env);
    assert.equal(cleared.status, 0, cleared.stderr || cleared.stdout);
    assert.equal(await stored(), undefined);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
