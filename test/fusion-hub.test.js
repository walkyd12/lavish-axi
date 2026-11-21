import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { doesAuthorMatchTailscaleWhois, parseApprovalUsers, serve } from "../src/server.js";
import { SessionStore } from "../src/session-store.js";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

test("Fusion metadata survives rewrite, close, reopen and a new store; search includes closed and peer boards", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fusion-hub-"));
  process.env.LAVISH_AXI_STATE_DIR = dir;
  const file = path.join(dir, "plan.html");
  await writeFile(file, "<title>Client roadmap</title><p>Orchid launch schedule</p><script>secretCodeWord</script>");
  const peer = await serve({ port: 0, stateFile: path.join(dir, "peer", "state.json"), version: "0.1.90" });
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
  const peer = await serve({ port: 0, stateFile: path.join(dir, "peer", "state.json"), version: "0.1.96" });
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

    // Peer board lifecycle WITHOUT polling /api/hub between transitions:
    // Walker creates, closes, reopens, and recloses on peerBase with zero visits to central /api/hub,
    // plus central hub one-tap reopen -> cancel -> reopen -> close on the peer board!
    await fetch(`${peerBase}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: peerBase },
      body: JSON.stringify({ file: peerFile, creator: "Walker" }),
    });
    const peerKey = (await fetch(`${peerBase}/api/hub?peers=0`).then((r) => r.json())).boards[0].key;
    await fetch(`${peerBase}/api/hub/${peerKey}/close`, { method: "POST", headers: { origin: peerBase } });
    await fetch(`${peerBase}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: peerBase },
      body: JSON.stringify({ file: peerFile, reopen: true }),
    });
    await fetch(`${peerBase}/api/hub/${peerKey}/close`, { method: "POST", headers: { origin: peerBase } });

    // Central hub can also reopen, cancel, and close the peer board in one tap (while cross-origin is 403).
    const namespacedPeerKey = `peer:walker:${peerKey}`;
    assert.equal(
      (
        await fetch(`${base}/api/hub/${encodeURIComponent(namespacedPeerKey)}/close`, {
          method: "POST",
          headers: { origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    const reopenedPeerRes = await fetch(`${base}/api/hub/${encodeURIComponent(namespacedPeerKey)}/reopen`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ peer_origin: peerBase }),
    });
    assert.equal(reopenedPeerRes.status, 200);
    assert.equal((await reopenedPeerRes.json()).closed, false);

    const cancelledPeerRes = await fetch(`${base}/api/hub/${encodeURIComponent(namespacedPeerKey)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ peer_origin: peerBase }),
    });
    assert.equal(cancelledPeerRes.status, 200);
    assert.equal((await cancelledPeerRes.json()).cancelled, true);

    // Wait for ordered detached hook writes and WebSocket events to flush.
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline && events.length < 18) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
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
      "walker:board_reopened",
      "walker:board_cancelled",
    ]);
    const msgEvent = events.find((entry) => entry.event === "message");
    assert.equal(msgEvent.had_listener, false);
    assert.equal(msgEvent.prompts[0].author, "Zach via runner2");
    assert.equal(msgEvent.prompts[0].via, "cli");
    const actionEvent = events.find((entry) => entry.event === "board_action");
    assert.equal(actionEvent.action, "send");
    assert.equal(actionEvent.action_label, "Dispatch workflow");
    assert.equal(actionEvent.author, "Zach via runner2");
    const firstTagEvent = events.find((entry) => entry.event === "tag_change");
    assert.deepEqual(firstTagEvent.added, ["Zach", "needs-input"]);
    const autoClearTagEvent = events.filter((entry) => entry.event === "tag_change")[1];
    assert.deepEqual(autoClearTagEvent.removed, ["needs-input"]);
    const peerCloseEvents = events.filter((entry) => entry.source === "walker" && entry.event === "board_closed");
    assert.equal(
      peerCloseEvents.length,
      2,
      "reactivate + reclose between hub visits emits both board_closed events over /events/hub",
    );
    assert.equal(peerCloseEvents[0].peer_origin, peerBase);
    assert.equal(peerCloseEvents[0].peer_key, peerKey);

    // Wait briefly for sequential hook invocations to finish appending to hookLog.
    const hookDeadline = Date.now() + 4_000;
    let diskLines = [];
    while (Date.now() < hookDeadline) {
      try {
        const raw = (await readFile(hookLog, "utf8")).trim();
        diskLines = raw ? raw.split("\n").map((line) => JSON.parse(line)) : [];
        if (diskLines.length === events.length) break;
      } catch {
        // file not written yet
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(diskLines.length, events.length);
    assert.deepEqual(
      diskLines.map((entry) => `${entry.source || "local"}:${entry.event}`),
      kinds,
      "LAVISH_AXI_ON_EVENT runs in strict FIFO order",
    );
  } finally {
    await server.close();
    await peer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Peer restart resets /events/hub cursor cleanly, 20x64KiB peer boards stay listed, hub-client has zero polling, and /api/:key/approval gates human chrome gestures", async () => {
  const { WebSocket } = await import("ws");
  const dir = await mkdtemp(path.join(tmpdir(), "fusion-r3-"));
  process.env.LAVISH_AXI_STATE_DIR = dir;
  const localFile = path.join(dir, "local-board.html");
  await writeFile(localFile, "<title>Local approval board</title><p id='draft-body'>Exact draft text</p>");

  let peerFetchCount = 0;
  const countingFetch = async (url, init) => {
    if (String(url).includes("/api/hub?peers=0")) peerFetchCount += 1;
    return fetch(url, init);
  };
  let peer = await serve({ port: 0, stateFile: path.join(dir, "peer-restart", "state.json"), version: "0.1.96" });
  const peerPort = peer.port;
  const peerBase = `http://127.0.0.1:${peerPort}`;
  const events = [];
  let server = await serve({
    port: 0,
    stateFile: path.join(dir, "central.json"),
    version: "0.1.96",
    hubPeers: `walker=${peerBase}`,
    hubPeerOptions: {
      fetchImpl: countingFetch,
    },
    onEvent: (payload) => events.push(payload),
  });
  const base = `http://127.0.0.1:${server.port}`;

  try {
    // 1. P1 #9: hub-client.js has zero 10-second polling timers and subscribes to /events/hub WebSocket.
    const hubClientJs = await fetch(`${base}/hub-client.js`).then((r) => r.text());
    assert.doesNotMatch(hubClientJs, /REFRESH_MS|10_000/);
    assert.match(hubClientJs, /\/events\/hub/);

    // 2. P1 #8: Create 20 boards on the peer, each with >64 KiB of visible text (>1.3 MiB total JSON).
    const peerKeys = [];
    for (let i = 0; i < 20; i += 1) {
      const f = path.join(dir, `peer-big-${i}.html`);
      const pad = `BOARD_${i}_MARKER ` + "word ".repeat(14_000);
      await writeFile(f, `<title>Peer Big ${i}</title><main><p>${pad}</p></main>`);
      const reg = await fetch(`${peerBase}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: peerBase },
        body: JSON.stringify({ file: f, creator: "Walker" }),
      }).then((r) => r.json());
      peerKeys.push(reg.key);
    }
    let aggregated;
    const scrapeDeadline = Date.now() + 4_000;
    do {
      aggregated = await fetch(`${base}/api/hub`).then((r) => r.json());
      if (aggregated.boards.filter((b) => b.source === "walker").length === 20) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    } while (Date.now() < scrapeDeadline);
    assert.equal(aggregated.peers[0].ok, true, "peer with 20x64KiB boards must not fail byte cap");
    assert.equal(aggregated.boards.filter((b) => b.source === "walker").length, 20);
    const searched = await fetch(`${base}/api/hub?q=BOARD_19_MARKER`).then((r) => r.json());
    assert.equal(searched.boards.length, 1);

    // Wait for peer /events/hub WebSocket to settle, then verify repeated /api/hub reads use cached peer state when idle (P1 #9).
    await new Promise((resolve) => setTimeout(resolve, 150));
    await fetch(`${base}/api/hub`).then((r) => r.json());
    const fetchesBeforeIdleReads = peerFetchCount;
    await fetch(`${base}/api/hub`).then((r) => r.json());
    await fetch(`${base}/api/hub`).then((r) => r.json());
    assert.equal(peerFetchCount, fetchesBeforeIdleReads, "idle peer with live WebSocket is not re-fetched");

    // 3. P1 #6: Restart the peer on the SAME port (`seq` restarts at 0 with a new `instance_id`),
    // close a board at seq=1, and verify the central hub receives `walker:board_closed` without dropping!
    events.length = 0;
    await peer.close();
    peer = await serve({
      port: peerPort,
      hosts: ["127.0.0.1"],
      stateFile: path.join(dir, "peer-restart", "state.json"),
      version: "0.1.96",
    });
    // Close the restarted peer's board through the central hub's one-tap peer relay (also verifies UND_ERR_SOCKET resilience!).
    const relayCloseAfterRestart = await fetch(
      `${base}/api/hub/${encodeURIComponent(`peer:walker:${peerKeys[0]}`)}/close`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ peer_origin: peerBase }),
      },
    );
    assert.equal(relayCloseAfterRestart.status, 200);
    const restartDeadline = Date.now() + 4_000;
    while (
      Date.now() < restartDeadline &&
      !events.some((e) => e.source === "walker" && e.event === "board_closed" && e.peer_key === peerKeys[0])
    ) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const postRestartClose = events.find(
      (e) => e.source === "walker" && e.event === "board_closed" && e.peer_key === peerKeys[0],
    );
    assert.ok(postRestartClose, "board closed at low seq right after peer restart must be delivered");
    assert.equal(postRestartClose.peer_seq, 1);
    assert.ok(postRestartClose.peer_instance, "restarted peer stamps its fresh instance_id");

    // 4. Round 3 P1 #4: Restarting the CENTRAL hub on the same stateFile preserves `peer-cursors.json`
    // and replays ZERO already-processed peer close events, while delivering a fresh post-restart close!
    await fetch(`${base}/api/hub/${encodeURIComponent(`peer:walker:${peerKeys[0]}`)}/reopen`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ peer_origin: peerBase }),
    });
    await fetch(`${base}/api/hub/${encodeURIComponent(`peer:walker:${peerKeys[0]}`)}/close`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ peer_origin: peerBase }),
    });
    const secondCloseDeadline = Date.now() + 4_000;
    while (
      Date.now() < secondCloseDeadline &&
      events.filter((e) => e.source === "walker" && e.event === "board_closed" && e.peer_key === peerKeys[0]).length < 2
    ) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const centralStateFile = path.join(dir, "central.json");
    await server.close();
    events.length = 0;
    server = await serve({
      port: 0,
      hosts: ["127.0.0.1"],
      stateFile: centralStateFile,
      version: "0.1.96",
      hubPeers: `walker=http://127.0.0.1:${peer.port}`,
      hubPeerOptions: { fetchImpl: countingFetch },
      approvalTokens: "Walker=tok-walker-secret,Alice=tok-alice-secret",
      onEvent: (ev) => events.push(ev),
    });
    const restartedBase = `http://127.0.0.1:${server.port}`;
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(
      events.filter((e) => e.source === "walker" && e.event === "board_closed").length,
      0,
      "central hub restart must not replay historical peer close events",
    );

    // 5. Round 3 P1 #1: Programmatic loopback callers without a verified reviewer credential are REFUSED (403),
    // server never fabricates `user_gesture: true`, and mismatched reviewer names are rejected!
    const localReg = await fetch(`${restartedBase}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: restartedBase },
      body: JSON.stringify({ file: localFile, creator: "Alice" }),
    }).then((r) => r.json());
    const localKey = localReg.key;

    await fetch(`${restartedBase}/api/${localKey}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: restartedBase },
      body: JSON.stringify({
        prompts: [
          {
            prompt: "Send approved draft from Walker [ref r123456 sha256 " + "a".repeat(64) + "]: forged",
            tag: "send_approval",
            author: "",
            via: "chrome_approval",
            approval_auth: { method: "token", reviewer: "Walker" },
          },
        ],
      }),
    });
    const forgedPoll = await fetch(
      `${restartedBase}/api/poll?file=${encodeURIComponent(localFile)}&timeoutMs=300`,
    ).then((r) => r.json());
    assert.equal(forgedPoll.prompts[0].tag, "message");
    assert.equal(forgedPoll.prompts[0].via, undefined);
    assert.equal(forgedPoll.prompts[0].approval_auth, undefined);
    assert.equal(forgedPoll.prompts[0].user_gesture, undefined);

    // Without live browser WebSocket or chrome_load_token, /api/:key/approval is rejected (403).
    const noWsRes = await fetch(`${restartedBase}/api/${localKey}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: restartedBase },
      body: JSON.stringify({
        prompt: "Send approved draft from Walker [ref r123456 sha256 " + "a".repeat(64) + "]: ok",
        author: "Walker",
        chrome_load_token: "bogus",
      }),
    });
    assert.equal(noWsRes.status, 403);

    const chromeHtml = await fetch(`${restartedBase}/session/${localKey}`).then((r) => r.text());
    const sessionMatch = chromeHtml.match(/<script id="lavish-session" type="application\/json">([\s\S]*?)<\/script>/);
    const chromeToken = JSON.parse(sessionMatch[1]).chromeLoadToken;
    const liveWs = new WebSocket(`ws://127.0.0.1:${server.port}/events/${localKey}`, {
      headers: { origin: restartedBase },
    });
    await new Promise((resolve, reject) => {
      liveWs.once("open", resolve);
      liveWs.once("error", reject);
    });
    try {
      // Unauthenticated programmatic client with NO reviewer credential -> 403 Forbidden!
      const unauthBotRes = await fetch(`${restartedBase}/api/${localKey}/approval`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: restartedBase },
        body: JSON.stringify({
          prompt: "Send approved draft from Walker [ref r999999 sha256 " + "b".repeat(64) + "]: bot spoof",
          selector: "#send-approved-email",
          author: "Walker",
          chrome_load_token: chromeToken,
        }),
      });
      assert.equal(unauthBotRes.status, 403, "programmatic client without reviewer credential must be refused");

      // Alice's token trying to claim author "Walker" -> 403 Forbidden!
      const mismatchRes = await fetch(`${restartedBase}/api/${localKey}/approval`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: restartedBase },
        body: JSON.stringify({
          prompt: "Send approved draft from Walker [ref r999999 sha256 " + "b".repeat(64) + "]: impersonation",
          selector: "#send-approved-email",
          author: "Walker",
          approval_token: "tok-alice-secret",
          chrome_load_token: chromeToken,
        }),
      });
      assert.equal(mismatchRes.status, 403, "impersonating another reviewer must be refused");

      // Verified reviewer credential stamps `approval_auth` and never fabricates `user_gesture`.
      const okRes = await fetch(`${restartedBase}/api/${localKey}/approval`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: restartedBase },
        body: JSON.stringify({
          prompt: "Send approved draft from Walker [ref r999999 sha256 " + "b".repeat(64) + "]: ship it",
          selector: "#send-approved-email",
          author: "Walker",
          approval_token: "tok-walker-secret",
          chrome_load_token: chromeToken,
        }),
      });
      assert.equal(okRes.status, 200);
      const validPoll = await fetch(
        `${restartedBase}/api/poll?file=${encodeURIComponent(localFile)}&timeoutMs=300`,
      ).then((r) => r.json());
      assert.equal(validPoll.prompts[0].tag, "send_approval");
      assert.equal(validPoll.prompts[0].via, "chrome_approval");
      assert.equal(validPoll.prompts[0].user_gesture, undefined);
      assert.equal(validPoll.prompts[0].author, "Walker");
      assert.deepEqual(validPoll.prompts[0].approval_auth, { method: "token", reviewer: "Walker" });

      // Round 3 P1 #2: Uploading an image + >5,000-char instruction preserves full prompt text & resolved
      // attachment path on `/api/poll`, AND carries attachment metadata on `message` + `board_action` events!
      const png1x1 = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      );
      const uploaded = await fetch(`${restartedBase}/api/${localKey}/attachments`, {
        method: "POST",
        headers: { "content-type": "image/png", origin: restartedBase },
        body: png1x1,
      }).then((r) => r.json());
      assert.equal(uploaded.status, "stored");
      const longInstruction = "See the attached screenshot: " + "detail-row-check ".repeat(350);
      assert.ok(longInstruction.length > 5_500);
      events.length = 0;
      await fetch(`${restartedBase}/api/${localKey}/prompts`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: restartedBase },
        body: JSON.stringify({
          prompts: [
            {
              prompt: longInstruction,
              tag: "message",
              author: "Walker",
              prompt_id: "long-with-shot-1",
              attachments: [{ id: uploaded.attachment.id, name: "screen.png" }],
            },
          ],
        }),
      });
      const msgEv = events.find((e) => e.event === "message" && e.key === localKey);
      assert.ok(msgEv, "message event emitted");
      assert.equal(msgEv.prompts[0].attachments?.[0]?.id, uploaded.attachment.id);
      assert.equal(msgEv.prompts[0].attachments?.[0]?.name, "screen.png");
      assert.ok(msgEv.prompts[0].attachments?.[0]?.path, "resolved attachment path included in event");
      const fullPolled = await fetch(
        `${restartedBase}/api/poll?file=${encodeURIComponent(localFile)}&timeoutMs=300`,
      ).then((r) => r.json());
      assert.equal(fullPolled.prompts[0].prompt, longInstruction, "full >4096-char instruction preserved verbatim");
      assert.equal(fullPolled.prompts[0].attachments[0].id, uploaded.attachment.id);
    } finally {
      liveWs.close();
    }
  } finally {
    await server.close();
    await peer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("hub viewer WebSockets and peer subscriptions prevent premature idle shutdown", async () => {
  const { WebSocket } = await import("ws");
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-hub-idle-"));
  const boardFile = path.join(dir, "idle-board.html");
  await writeFile(boardFile, "<!doctype html><title>Idle Check</title><h1>Board</h1>");
  let hub = null;
  let peer = null;
  try {
    // 1. Open hub viewer on `/events/hub` keeps server alive past `idleTimeoutMs` with zero board tabs/polls,
    // and closing the hub viewer allows idle shutdown cleanly.
    hub = await serve({
      port: 0,
      hosts: ["127.0.0.1"],
      stateFile: path.join(dir, "hub-only", "state.json"),
      idleTimeoutMs: 120,
      version: "0.1.96",
    });
    const hubBase = `http://127.0.0.1:${hub.port}`;
    const hubWs = new WebSocket(`ws://127.0.0.1:${hub.port}/events/hub`, { headers: { origin: hubBase } });
    await new Promise((resolve, reject) => {
      hubWs.once("open", resolve);
      hubWs.once("error", reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 260));
    const healthWhileViewing = await fetch(`${hubBase}/health`).then((r) => r.json());
    assert.equal(healthWhileViewing.ok, true, "hub must stay running while a viewer holds /events/hub open");
    hubWs.close();
    await hub.done;
    hub = null;

    // 2. Central hub configured with `hubPeers` stays alive past `idleTimeoutMs` even with zero browser viewers
    // so background peer event collection is never dropped.
    peer = await serve({
      port: 0,
      hosts: ["127.0.0.1"],
      stateFile: path.join(dir, "peer-idle", "state.json"),
      version: "0.1.96",
    });
    hub = await serve({
      port: 0,
      hosts: ["127.0.0.1"],
      stateFile: path.join(dir, "central-idle.json"),
      idleTimeoutMs: 120,
      hubPeers: `walker=http://127.0.0.1:${peer.port}`,
      version: "0.1.96",
    });
    await new Promise((resolve) => setTimeout(resolve, 260));
    const centralHealth = await fetch(`http://127.0.0.1:${hub.port}/health`).then((r) => r.json());
    assert.equal(centralHealth.ok, true, "central hub with peer subscriptions must not idle-shutdown");
  } finally {
    if (hub) await hub.close();
    if (peer) await peer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Tailscale approvals require an exact provisioned login or alias", () => {
  const aliases = parseApprovalUsers("Zach=zachhite22@gmail.com|zachhite22,Walker=walkyd12");
  const matches = (loginName, displayName = "Zach Hite") =>
    doesAuthorMatchTailscaleWhois("Zach", { loginName, displayName }, aliases);
  assert.equal(matches("zach-attacker@example.com"), false);
  assert.equal(matches("other@example.com", "Zach"), false);
  assert.equal(matches("zachhite22@evil.example"), false);
  assert.equal(matches(" ZACHHITE22@GMAIL.COM "), true);
  assert.equal(matches("zachhite22"), true);
  assert.equal(doesAuthorMatchTailscaleWhois("Walker", { loginName: "walkyd12" }, aliases), true);
  assert.equal(doesAuthorMatchTailscaleWhois("Zach", { loginName: "zach@example.com" }, new Map()), false);
});

test("repeated End preserves cancellation and emits no second terminal event", async () => {
  const { WebSocket } = await import("ws");
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-end-once-"));
  const file = path.join(dir, "board.html");
  await writeFile(file, "<title>End once</title>");
  const stateFile = path.join(dir, "state.json");
  const events = [];
  const server = await serve({ port: 0, stateFile, onEvent: (event) => events.push(event) });
  const base = `http://127.0.0.1:${server.port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/events/hub`);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const post = (route, body = {}) =>
    fetch(base + route, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  try {
    const { key } = await post("/api/sessions", { file });
    const store = new SessionStore(stateFile);
    for (const cancelled of [true, false]) {
      if (!cancelled) await post(`/api/hub/${key}/reopen`);
      await post(`/api/hub/${key}/${cancelled ? "cancel" : "close"}`);
      await new Promise((resolve) => setTimeout(resolve, 40));
      const before = await store.findByKey(key);
      const count = events.filter((e) => ["board_closed", "board_cancelled"].includes(e.event)).length;
      assert.equal(count, cancelled ? 1 : 2);
      const result = await post("/api/end", { file });
      assert.equal(result.cancelled, cancelled);
      await Promise.all([
        post("/api/end", { file, cancel: true }),
        post(`/api/${key}/end`),
        post(`/api/hub/${key}/close`),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.deepEqual(await store.findByKey(key), before);
      assert.equal(events.filter((e) => ["board_closed", "board_cancelled"].includes(e.event)).length, count);
    }
  } finally {
    ws.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
