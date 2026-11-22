import "./isolate-hooks.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
test("integration tests discard inherited executable hooks before creating boards", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hook-isolation-"));
  try {
    const marker = path.join(dir, "called");
    const hook = path.join(dir, "sentinel.mjs");
    await writeFile(
      hook,
      `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'called');\n`,
    );
    await chmod(hook, 0o700);
    const env = { ...process.env };
    for (const name of ["ON_EVENT", "ON_ACTION", "ON_END", "APPROVAL_PREVIEW", "NOTIFY_DESTINATIONS"])
      env[`LAVISH_AXI_${name}`] = hook;
    await exec(process.execPath, ["--test", "--test-name-pattern", "^hub and peer cards", "test/hub-review.test.js"], {
      env,
    });
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    const { stdout } = await exec(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import './test/isolate-hooks.js'; console.log(Object.keys(process.env).filter(key => /^LAVISH_AXI_(ON_|APPROVAL_PREVIEW|NOTIFY_DESTINATIONS)/.test(key)));`,
      ],
      { env },
    );
    assert.equal(stdout.trim(), "[]");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shared isolation removes inherited peer and service configuration", async () => {
  const inherited = {
    LAVISH_AXI_HUB_PEERS: "sentinel=http://127.0.0.1:1",
    LAVISH_AXI_UMAMI_HOST: "https://telemetry.invalid",
    LAVISH_AXI_UMAMI_WEBSITE_ID: "sentinel",
    LAVISH_AXI_BUILD_UMAMI_HOST: "https://telemetry.invalid",
    LAVISH_AXI_BUILD_UMAMI_WEBSITE_ID: "sentinel",
    LAVISH_AXI_HTML_APP_API_URL: "https://share.invalid",
    LAVISH_AXI_HTML_APP_TOKEN: "sentinel",
    LAVISH_AXI_HERDR_CHIME: "1",
    LAVISH_AXI_HOST: "service.invalid",
    LAVISH_AXI_LINK_HOST: "service.invalid",
    LAVISH_AXI_PUBLIC_URL: "https://service.invalid",
    LAVISH_AXI_PORT: "1",
  };
  const { stdout } = await exec(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import './test/isolate-hooks.js';
    console.log(JSON.stringify({
      inherited: Object.keys(process.env).filter(key => ${JSON.stringify(Object.keys(inherited))}.includes(key)),
      telemetry: process.env.LAVISH_AXI_TELEMETRY,
    }));
  `,
    ],
    { env: { ...process.env, ...inherited, LAVISH_AXI_TELEMETRY: "1" } },
  );
  assert.deepEqual(JSON.parse(stdout), { inherited: [], telemetry: "0" });
});

test("action attachment server never contacts an inherited peer", async () => {
  let requests = 0;
  const sentinel = createServer((_req, res) => {
    requests++;
    res.end('{"boards":[]}');
  });
  sentinel.on("upgrade", (_req, socket) => {
    requests++;
    socket.destroy();
  });
  await new Promise((resolve) => sentinel.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = sentinel.address();
  assert.ok(address && typeof address !== "string");
  try {
    await exec(process.execPath, ["--test", "test/action-attachments.test.js"], {
      env: { ...process.env, LAVISH_AXI_HUB_PEERS: `sentinel=http://127.0.0.1:${address.port}` },
    });
    assert.equal(requests, 0, "neither peer HTTP requests nor WebSocket upgrades are allowed");
  } finally {
    await new Promise((resolve) => sentinel.close(() => resolve(undefined)));
  }
});
