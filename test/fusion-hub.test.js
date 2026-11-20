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

test("LAVISH_AXI_ON_EVENT emits board lifecycle, message attribution, tag diffs and peer close/reopen without polling", async () => {
  const { spawn } = await import("node:child_process");
  const { chmod } = await import("node:fs/promises");
  const dir = await mkdtemp(path.join(tmpdir(), "fusion-events-"));
  const file = path.join(dir, "zach-board.html");
  const peerFile = path.join(dir, "walker-board.html");
  const hookLog = path.join(dir, "hook.jsonl");
  const hookBin = path.join(dir, "on-event.mjs");
  await writeFile(file, "<title>Zach board</title><p>Initial answer</p>");
  await writeFile(peerFile, "<title>Walker board</title><p>Greenside Settings</p>");
  await writeFile(
    hookBin,
    `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(hookLog)}, process.argv[2] + "\\n");\n`,
  );
  await chmod(hookBin, 0o755);

  const events = [];
  const peer = await serve({ port: 0, stateFile: path.join(dir, "peer.json"), version: "0.1.96" });
  const peerBase = `http://127.0.0.1:${peer.port}`;
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "0.1.96",
    hubPeers: `walker=${peerBase}`,
    actionLabel: "Dispatch workflow",
    env: { ...process.env, LAVISH_AXI_ON_EVENT: hookBin },
    onEvent: (payload) => events.push(payload),
  });
  const base = `http://127.0.0.1:${server.port}`;
  const cliEnv = {
    ...process.env,
    LAVISH_AXI_STATE_DIR: dir,
    LAVISH_AXI_PORT: String(server.port),
    LAVISH_AXI_TELEMETRY: "0",
    LAVISH_AXI_NO_OPEN: "1",
  };
  const cli = (...args) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["bin/lavish-axi.js", ...args], { env: cliEnv });
      let output = "";
      let errors = "";
      child.stdout.on("data", (data) => (output += data));
      child.stderr.on("data", (data) => (errors += data));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output, errors }));
    });
  try {
    const opened = await cli("open", "--creator", "Zach", file);
    assert.equal(opened.code, 0, opened.errors);
    const key = (await new SessionStore(path.join(dir, "state.json")).findByFile(file)).key;

    // Mark board needs-input + person tag; verify Hub Needs input filter sees it, then answering clears needs-input automatically.
    await cli("tag", file, "--needs-input", "--add", "Zach");
    const needsInputHub = await fetch(`${base}/api/hub?state=needs-input`).then((r) => r.json());
    assert.equal(needsInputHub.boards.length, 1);
    assert.equal(needsInputHub.boards[0].board_state, "needs-input");
    assert.equal(needsInputHub.action_label, "Dispatch workflow");

    // Side bot posts normal free-chat message (no --send): clears needs-input, emits message (NOT board_action).
    const msgRes = await cli(
      "message",
      file,
      "--message",
      "Check <b>TEST</b> customer code",
      "--author",
      "Zach via runner2",
    );
    assert.equal(msgRes.code, 0, msgRes.errors);
    assert.match(msgRes.output, /Zach via runner2/);
    assert.equal((await fetch(`${base}/api/hub?state=needs-input`).then((r) => r.json())).boards.length, 0);
    assert.equal((await fetch(`${base}/api/hub?state=working`).then((r) => r.json())).boards[0].board_state, "working");

    // Explicit workflow Send (--send) fires board_action with configurable action_label.
    const sendRes = await cli(
      "message",
      file,
      "--message",
      "Run full verification",
      "--author",
      "Zach via runner2",
      "--send",
    );
    assert.equal(sendRes.code, 0, sendRes.errors);
    assert.match(sendRes.output, /Dispatch workflow/);

    // Poll delivers the prompts with author intact, and conversation Markdown escapes/quotes user text.
    const polled = await fetch(`${base}/api/poll?file=${encodeURIComponent(file)}&timeoutMs=500`).then((r) => r.json());
    assert.equal(polled.status, "feedback");
    assert.equal(polled.prompts[0].author, "Zach via runner2");
    assert.equal(polled.prompts[0].prompt, "Check <b>TEST</b> customer code");

    const convJson = await fetch(`${base}/api/${key}/conversation`).then((r) => r.json());
    assert.equal(convJson.creator, "Zach");
    assert.equal(convJson.chat[0].author, "Zach via runner2");
    assert.equal(convJson.chat[0].html, undefined, "user messages never carry raw HTML");

    const convMd = await fetch(`${base}/api/${key}/conversation?format=markdown`).then((r) => r.text());
    assert.match(convMd, /- Creator: Zach/);
    assert.match(convMd, /\*\*Zach via runner2\*\*/);
    assert.match(convMd, /> Check <b>TEST<\/b> customer code/);

    // Person tag addition emits tag_change with added/removed.
    await cli("tag", file, "--add", "Walker", "--add", "Gibson");
    await cli("tag", file, "--remove", "Gibson");

    // Cancel board -> emits board_cancelled (NOT board_closed), appears under state=cancelled, then reopen + close -> emits board_closed.
    assert.equal(
      (await fetch(`${base}/api/hub/${key}/cancel`, { method: "POST", headers: { origin: "https://evil.example" } }))
        .status,
      403,
    );
    await fetch(`${base}/api/hub/${key}/cancel`, { method: "POST", headers: { origin: base } });
    assert.equal((await fetch(`${base}/api/hub?state=cancelled`).then((r) => r.json())).boards.length, 1);
    assert.equal((await fetch(`${base}/api/hub?state=closed`).then((r) => r.json())).boards.length, 0);
    await cli("open", "--reopen", file);
    await fetch(`${base}/api/hub/${key}/close`, { method: "POST", headers: { origin: base } });
    assert.equal((await fetch(`${base}/api/hub?state=closed`).then((r) => r.json())).boards.length, 1);
    await cli("open", "--reopen", file);

    // Peer board lifecycle: open -> closed -> reopened -> closed again.
    await fetch(`${peerBase}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: peerBase },
      body: JSON.stringify({ file: peerFile, creator: "Walker" }),
    });
    const peerKey = (await fetch(`${peerBase}/api/hub?peers=0`).then((r) => r.json())).boards[0].key;
    await fetch(`${base}/api/hub`);
    await fetch(`${peerBase}/api/hub/${peerKey}/close`, { method: "POST", headers: { origin: peerBase } });
    await fetch(`${base}/api/hub`);
    await fetch(`${peerBase}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: peerBase },
      body: JSON.stringify({ file: peerFile, reopen: true }),
    });
    await fetch(`${base}/api/hub`);
    await fetch(`${peerBase}/api/hub/${peerKey}/close`, { method: "POST", headers: { origin: peerBase } });
    await fetch(`${base}/api/hub`);

    // Allow async onEvent / detached hook writes to flush.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const kinds = events.map((entry) => `${entry.source || "local"}:${entry.event}`);
    assert.deepEqual(kinds, [
      "local:board_created",
      "local:tag_change",
      "local:tag_change",
      "local:message",
      "local:message",
      "local:board_action",
      "local:tag_change",
      "local:tag_change",
      "local:board_cancelled",
      "local:board_reopened",
      "local:board_closed",
      "local:board_reopened",
      "walker:board_created",
      "walker:board_closed",
      "walker:board_reopened",
      "walker:board_closed",
    ]);
    const msgEvent = events.find((entry) => entry.event === "message");
    assert.equal(msgEvent.had_listener, false);
    assert.equal(msgEvent.prompts[0].author, "Zach via runner2");
    const actionEvent = events.find((entry) => entry.event === "board_action");
    assert.equal(actionEvent.action, "send");
    assert.equal(actionEvent.action_label, "Dispatch workflow");
    assert.equal(actionEvent.author, "Zach via runner2");
    const firstTagEvent = events.find((entry) => entry.event === "tag_change");
    assert.deepEqual(firstTagEvent.added, ["Zach", "needs-input"]);
    const autoClearTagEvent = events.filter((entry) => entry.event === "tag_change")[1];
    assert.deepEqual(autoClearTagEvent.removed, ["needs-input"]);
    const peerCloseEvents = events.filter((entry) => entry.source === "walker" && entry.event === "board_closed");
    assert.equal(peerCloseEvents.length, 2, "reactivate + reclose emits a second board_closed for new brain revision");
    assert.equal(peerCloseEvents[0].peer_origin, peerBase);
    assert.equal(peerCloseEvents[0].peer_key, peerKey);

    const diskLines = (await readFile(hookLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(diskLines.length, events.length);
  } finally {
    await server.close();
    await peer.close();
    await rm(dir, { recursive: true, force: true });
  }
});
