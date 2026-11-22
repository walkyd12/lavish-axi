import "./isolate-hooks.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
