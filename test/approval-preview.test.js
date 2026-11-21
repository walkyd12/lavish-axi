import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runApprovalPreview } from "../src/approval-preview.js";
import { serve } from "../src/server.js";

test("approval preview executes only the configured program with canonical session arguments and bounded output/time", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-preview-"));
  const executable = path.join(dir, "preview.mjs");
  const session = { key: "abc", file: path.join(dir, "board ; echo NO.html") };
  const program = async (source) => {
    await writeFile(executable, `#!/usr/bin/env node\n${source}\n`);
    await chmod(executable, 0o755);
  };
  try {
    assert.equal(await runApprovalPreview(undefined, session), "Preview unavailable");
    await program("process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    assert.equal(await runApprovalPreview(executable, session), JSON.stringify([session.key, session.file]));
    await program('process.stdout.write("secret partial"); process.exit(1)');
    assert.equal(await runApprovalPreview(executable, session), "Preview unavailable");
    await program('process.stdout.write("x".repeat(131073))');
    assert.equal(await runApprovalPreview(executable, session), "Preview unavailable");
    await program("setInterval(() => {}, 1000)");
    const start = Date.now();
    assert.equal(await runApprovalPreview(executable, session, { timeoutMs: 100 }), "Preview unavailable");
    assert.ok(Date.now() - start < 2000);
    assert.equal(await runApprovalPreview(path.join(dir, "missing"), session), "Preview unavailable");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("preview route reads server session file, refuses iframe requests, and never trusts board preview text", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-preview-route-"));
  const file = path.join(dir, "board.html");
  const executable = path.join(dir, "preview.mjs");
  await writeFile(file, "<!doctype html><h1>Untrusted board</h1>");
  await writeFile(
    executable,
    '#!/usr/bin/env node\nprocess.stdout.write("Pinned <script>body</script>\\n" + process.argv[3]);\n',
  );
  await chmod(executable, 0o755);
  const server = await serve({
    host: "127.0.0.1",
    port: 0,
    stateFile: path.join(dir, "state.json"),
    env: { LAVISH_AXI_STATE_DIR: dir, LAVISH_AXI_HOST: "127.0.0.1", LAVISH_AXI_APPROVAL_PREVIEW: executable },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (url, body, origin = base) =>
    fetch(base + url, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(body),
    });
  try {
    const { key } = await (await post("/api/sessions", { file })).json();
    const html = await (await fetch(`${base}/session/${key}`)).text();
    const data = JSON.parse(html.match(/<script id="lavish-session" type="application\/json">([\s\S]*?)<\/script>/)[1]);
    assert.ok(data.chromeLoadToken);
    const body = { chrome_load_token: data.chromeLoadToken, file: "/etc/passwd", preview: "FAKE" };
    assert.equal((await post(`/api/${key}/approval-preview`, body, "null")).status, 403);
    assert.equal((await post(`/api/${key}/approval-preview`, { ...body, chrome_load_token: "fake" })).status, 409);
    const response = await post(`/api/${key}/approval-preview`, body);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { preview: `Pinned <script>body</script>\n${file}` });
    await writeFile(executable, "#!/usr/bin/env node\nprocess.exit(1);\n");
    assert.deepEqual(await (await post(`/api/${key}/approval-preview`, body)).json(), {
      preview: "Preview unavailable",
    });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
