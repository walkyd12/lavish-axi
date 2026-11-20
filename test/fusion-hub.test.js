import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { serve } from "../src/server.js";
import { SessionStore } from "../src/session-store.js";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

test("Fusion metadata survives rewrite, close, reopen and a new store; search includes closed and peer boards", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fusion-hub-"));
  process.env.LAVISH_AXI_STATE_DIR = dir;
  const file = path.join(dir, "plan.html");
  await writeFile(file, "<title>Client roadmap</title><p>Orchid launch schedule</p><script>secretCodeWord</script>");
  const peer = await serve({ port: 0, stateFile: path.join(dir, "peer.json"), version: "0.1.90" });
  const peerBase = `http://127.0.0.1:${peer.port}`;
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "0.1.96",
    hubPeers: `relay=${peerBase}`,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (origin, route, body) =>
    fetch(origin + route, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(body),
    });
  try {
    const registered = await post(base, "/api/sessions", { file, creator: "Cortana" }).then((r) => r.json());
    const key = registered.key;
    assert.equal(registered.creator, "Cortana");
    const update = (body, origin = base) =>
      fetch(`${base}/api/${key}/metadata`, {
        method: "PUT",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify(body),
      });
    assert.equal((await update({ add: ["Walker", "urgent", "walker"] })).status, 200);
    assert.equal((await update({ add: ["blocked"] }, "https://foreign.example")).status, 403);
    assert.equal((await update({ add: ["x".repeat(65)] })).status, 400);
    assert.equal(
      (await update({ creator: "Other" })).status,
      400,
      "creator is set at creation, not by later tag edits",
    );
    await Promise.all([update({ add: ["client"] }), update({ add: ["review"] })]);
    const hub = (query = "") => fetch(base + "/api/hub" + query).then((r) => r.json());
    assert.equal((await hub("?q=Orchid")).boards.length, 1);
    assert.equal((await hub("?q=roadmap")).boards.length, 1);
    assert.equal((await hub("?tag=urgent")).boards.length, 1);
    assert.equal((await hub("?q=secretCodeWord")).boards.length, 0, "scripts aren't board text");
    assert.equal((await post(base, `/api/hub/${key}/close`, {})).status, 200);
    assert.equal((await hub("?q=Orchid")).boards[0].closed, true);
    await writeFile(file, "<title>Revised roadmap</title><p>New content</p>");
    assert.equal((await hub("?q=Orchid")).boards.length, 0, "search reads the current artifact");
    const reopened = await post(base, "/api/sessions", { file, reopen: true, creator: "Zach" }).then((r) => r.json());
    assert.equal(reopened.closed, false);
    assert.equal(reopened.creator, "Cortana");
    const stored = await new SessionStore(path.join(dir, "state.json")).findByKey(key);
    assert.deepEqual(stored.tags, ["Walker", "urgent", "client", "review"]);
    assert.equal(stored.created_version, "0.1.96");
    assert.equal(stored.served_version, "0.1.96");
    assert.equal(await readFile(file, "utf8"), "<title>Revised roadmap</title><p>New content</p>");
    await post(peerBase, "/api/sessions", { file, creator: "Gibson" });
    const peerKey = (await fetch(peerBase + "/api/hub").then((r) => r.json())).boards[0].key;
    await fetch(`${peerBase}/api/${peerKey}/metadata`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: peerBase },
      body: JSON.stringify({ add: ["Roxanne"] }),
    });
    await post(peerBase, `/api/hub/${peerKey}/close`, {});
    const remote = (await hub("?q=Roxanne")).boards[0];
    assert.equal(remote.source, "relay");
    assert.equal(remote.creator, "Gibson");
    assert.deepEqual(remote.tags, ["Roxanne"]);
    assert.equal(remote.closed, true);
    assert.equal(remote.created_version, "0.1.90");
    assert.equal(remote.version_behind, true);
    const state = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    state.sessions[key].served_version = "0.1.89";
    await writeFile(path.join(dir, "state.json"), JSON.stringify(state));
    assert.equal((await hub("?peers=0")).boards[0].version_behind, true);
    await fetch(`${base}/session/${key}`);
    assert.equal((await hub("?peers=0")).boards[0].version_behind, false);
    assert.equal((await hub("?peers=0")).boards[0].created_version, "0.1.96");
  } finally {
    await server.close();
    await peer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI reads and changes tags in TOON, attributes the first creator and preserves metadata on reopen", async () => {
  const { spawn } = await import("node:child_process");
  const dir = await mkdtemp(path.join(tmpdir(), "fusion-cli-"));
  const file = path.join(dir, "board.html");
  await writeFile(file, "<title>CLI board</title><body>CLI test</body>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "0.1.96" });
  const env = {
    ...process.env,
    LAVISH_AXI_STATE_DIR: dir,
    LAVISH_AXI_PORT: String(server.port),
    LAVISH_AXI_TELEMETRY: "0",
    LAVISH_AXI_NO_OPEN: "1",
  };
  const cli = (...args) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["bin/lavish-axi.js", ...args], { env });
      let output = "";
      let errors = "";
      child.stdout.on("data", (data) => (output += data));
      child.stderr.on("data", (data) => (errors += data));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output, errors }));
    });
  try {
    const opened = await cli("open", "--creator", "Cortana", file);
    assert.equal(opened.code, 0, opened.errors);
    assert.match(opened.output, /creator: Cortana/);
    assert.match(opened.output, /closed: false/);
    const tagged = await cli("tag", file, "--add", "Zach", "--add=urgent");
    assert.equal(tagged.code, 0, tagged.output);
    assert.match(tagged.output, /Zach/);
    assert.match(tagged.output, /urgent/);
    assert.match(tagged.output, /served_version: 0.1.96/);
    const changed = await cli("tag", "--remove", "URGENT", "--add", "review", file);
    assert.equal(changed.code, 0, changed.output);
    assert.doesNotMatch(changed.output, /urgent/);
    assert.match(changed.output, /review/);
    const key = (await new SessionStore(path.join(dir, "state.json")).findByFile(file)).key;
    const base = `http://127.0.0.1:${server.port}`;
    await fetch(`${base}/api/hub/${key}/close`, { method: "POST", headers: { origin: base } });
    const closed = await cli("tag", file);
    assert.match(closed.output, /closed: true/);
    const home = await cli();
    assert.match(home.output, /Cortana/);
    assert.match(home.output, /review/);
    const reopened = await cli("open", file, "--reopen", "--creator", "Zach");
    assert.equal(reopened.code, 0, reopened.output);
    assert.match(reopened.output, /creator: Cortana/);
    assert.match(reopened.output, /closed: false/);
    for (const args of [["--add"], ["--remove="], ["--add", "x".repeat(65)]]) {
      const invalid = await cli("tag", file, ...args);
      assert.notEqual(invalid.code, 0);
    }
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
