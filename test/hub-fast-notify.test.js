import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { serve } from "../src/server.js";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

test("hub omits search_text on / and /api/hub, paginates Open newest-first with cheap counts, filters server-side, and preserves ?peers=0", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hub-fast-"));
  const peer = await serve({
    port: 0,
    hosts: ["127.0.0.1"],
    stateFile: path.join(dir, "peer.json"),
    version: "0.1.96",
  });
  const peerBase = `http://127.0.0.1:${peer.port}`;
  const server = await serve({
    port: 0,
    hosts: ["127.0.0.1"],
    stateFile: path.join(dir, "state.json"),
    version: "0.1.96",
    hubPeers: `relay=${peerBase}`,
  });
  const base = `http://127.0.0.1:${server.port}`;

  const post = (origin, route, body = {}) =>
    fetch(origin + route, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(body),
    });

  try {
    // Create 55 open boards, 4 closed boards, and 2 cancelled boards locally, plus 1 peer board with body text.
    const openKeys = [];
    for (let i = 0; i < 55; i += 1) {
      const f = path.join(dir, `open-${String(i).padStart(3, "0")}.html`);
      const bodyWord = i === 7 ? "NEEDLE_SEVEN_OPEN" : `open_filler_${i} ` + "alpha ".repeat(200);
      await writeFile(f, `<title>Open Board ${i}</title><main><p>${bodyWord}</p></main>`);
      const reg = await post(base, "/api/sessions", { file: f, creator: "Alice" }).then((r) => r.json());
      openKeys.push(reg.key);
      if (i === 54) {
        await fetch(`${base}/api/${reg.key}/metadata`, {
          method: "PUT",
          headers: { "content-type": "application/json", origin: base },
          body: JSON.stringify({ add: ["needs-input", "Alice"] }),
        });
      }
    }

    for (let i = 0; i < 4; i += 1) {
      const f = path.join(dir, `closed-${i}.html`);
      const marker = i === 2 ? "ARCHIVED_QUARTZ_MARKER" : "closed filler text";
      await writeFile(f, `<title>Closed Board ${i}</title><p>${marker}</p>`);
      const reg = await post(base, "/api/sessions", { file: f, creator: "Bob" }).then((r) => r.json());
      await post(base, `/api/hub/${reg.key}/close`);
    }

    for (let i = 0; i < 2; i += 1) {
      const f = path.join(dir, `cancelled-${i}.html`);
      await writeFile(f, `<title>Cancelled Board ${i}</title><p>scratch_${i}</p>`);
      const reg = await post(base, "/api/sessions", { file: f, creator: "Bob" }).then((r) => r.json());
      await post(base, `/api/hub/${reg.key}/cancel`);
    }

    const peerFile = path.join(dir, "peer-board.html");
    await writeFile(peerFile, "<title>Peer Horizon</title><p>PEER_GALAXY_TOKEN</p>");
    await post(peerBase, "/api/sessions", { file: peerFile, creator: "Sam" });

    // 1. Server-rendered GET / loads only Open tab (limit 50), omits search_text, and carries exact counts.
    const rootHtml = await fetch(`${base}/`).then((r) => r.text());
    assert.doesNotMatch(rootHtml, /search_text/);
    assert.doesNotMatch(rootHtml, /NEEDLE_SEVEN_OPEN|ARCHIVED_QUARTZ_MARKER|PEER_GALAXY_TOKEN/);
    const match = rootHtml.match(/<script id="hub-data" type="application\/json">([\s\S]*?)<\/script>/);
    assert.ok(match);
    const boot = JSON.parse(match[1]);
    assert.equal(boot.boards.length, 50);
    assert.equal(boot.total, 56, "55 local open + 1 peer open");
    assert.equal(boot.has_more, true);
    assert.deepEqual(boot.counts, { open: 56, needs_input: 1, closed: 4, cancelled: 2 });
    assert.ok(boot.boards.every((b) => b.status === "open" && !Object.hasOwn(b, "search_text")));
    // Newest open boards appear ahead of oldest open boards.
    assert.ok(
      boot.boards.some((b) => b.title === "Open Board 54"),
      "newest board is on page 1",
    );

    // 2. Pagination via offset + limit returns the remaining 6 open boards with has_more=false.
    const page2 = await fetch(`${base}/api/hub?state=open&limit=50&offset=50`).then((r) => r.json());
    assert.equal(page2.boards.length, 6);
    assert.equal(page2.has_more, false);
    assert.ok(page2.boards.every((b) => !Object.hasOwn(b, "search_text")));

    // 3. Server-side search finds open, closed, and peer boards by body text without shipping search_text.
    const qClosed = await fetch(`${base}/api/hub?q=ARCHIVED_QUARTZ_MARKER`).then((r) => r.json());
    assert.equal(qClosed.boards.length, 1);
    assert.equal(qClosed.boards[0].title, "Closed Board 2");
    assert.equal(Object.hasOwn(qClosed.boards[0], "search_text"), false);

    const qPeer = await fetch(`${base}/api/hub?q=PEER_GALAXY_TOKEN`).then((r) => r.json());
    assert.equal(qPeer.boards.length, 1);
    assert.equal(qPeer.boards[0].source, "relay");
    assert.equal(Object.hasOwn(qPeer.boards[0], "search_text"), false);

    const qFilteredState = await fetch(`${base}/api/hub?q=ARCHIVED_QUARTZ_MARKER&state=open`).then((r) => r.json());
    assert.equal(qFilteredState.boards.length, 0);

    // 4. Peer contract (?peers=0) still returns search_text for peer hub indexing.
    const peerScrape = await fetch(`${peerBase}/api/hub?peers=0`).then((r) => r.json());
    assert.equal(peerScrape.boards.length, 1);
    assert.match(peerScrape.boards[0].search_text, /PEER_GALAXY_TOKEN/);
  } finally {
    await server.close();
    await peer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("notification settings seed once from LAVISH_AXI_NOTIFY_PEOPLE, enforce same-origin POST, persist to one JSON file, and flow into LAVISH_AXI_ON_EVENT", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hub-notify-"));
  const stateFile = path.join(dir, "state.json");
  const settingsFile = path.join(dir, "notify-settings.json");
  const boardFile = path.join(dir, "board.html");
  const hookLog = path.join(dir, "events.jsonl");
  const hookBin = path.join(dir, "on-event.mjs");
  await writeFile(boardFile, "<title>Notify Check</title><p>Body</p>");
  await writeFile(
    hookBin,
    `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(hookLog)}, process.argv[2] + "\\n");\n`,
  );
  await chmod(hookBin, 0o755);

  const events = [];
  let server = await serve({
    port: 0,
    hosts: ["127.0.0.1"],
    stateFile,
    version: "0.1.96",
    env: {
      ...process.env,
      LAVISH_AXI_NOTIFY_PEOPLE: "Alice, Bob , alice, Sam",
      LAVISH_AXI_ON_EVENT: hookBin,
    },
    onEvent: (ev) => events.push(ev),
  });
  let base = `http://127.0.0.1:${server.port}`;

  try {
    // 1. Seeded once with all defaults off.
    const initial = await fetch(`${base}/api/hub/notifications`).then((r) => r.json());
    assert.deepEqual(initial.notify_settings, {
      Alice: { tagged: false, done: false, send_to: "" },
      Bob: { tagged: false, done: false, send_to: "" },
      Sam: { tagged: false, done: false, send_to: "" },
    });

    // 2. Cross-origin and header-less POSTs are rejected with 403.
    const crossOrigin = await fetch(`${base}/api/hub/notifications`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: JSON.stringify({ notify_settings: { Malloy: { tagged: true, done: true, send_to: "123" } } }),
    });
    assert.equal(crossOrigin.status, 403);

    const noOrigin = await fetch(`${base}/api/hub/notifications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notify_settings: { Malloy: { tagged: true, done: true, send_to: "123" } } }),
    });
    assert.equal(noOrigin.status, 403);

    // 3. Same-origin POST updates checkboxes, send_to, adds Jordan, removes Bob, and persists to notify-settings.json.
    const updatedPayload = {
      Alice: { tagged: true, done: false, send_to: "" },
      Sam: { tagged: false, done: true, send_to: "9876543210" },
      Jordan: { tagged: true, done: true, send_to: "1122334455" },
    };
    const saveRes = await fetch(`${base}/api/hub/notifications`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ notify_settings: updatedPayload }),
    });
    assert.equal(saveRes.status, 200);
    assert.deepEqual((await saveRes.json()).notify_settings, updatedPayload);
    assert.deepEqual(JSON.parse(await readFile(settingsFile, "utf8")), updatedPayload);

    // 4. Restarting with a different LAVISH_AXI_NOTIFY_PEOPLE keeps the file as truth (Bob stays removed, Jordan stays).
    await server.close();
    server = await serve({
      port: 0,
      hosts: ["127.0.0.1"],
      stateFile,
      version: "0.1.96",
      env: {
        ...process.env,
        LAVISH_AXI_NOTIFY_PEOPLE: "Alice,Bob,Sam,Reintroduced",
        LAVISH_AXI_ON_EVENT: hookBin,
      },
      onEvent: (ev) => events.push(ev),
    });
    base = `http://127.0.0.1:${server.port}`;
    const afterRestart = await fetch(`${base}/api/hub/notifications`).then((r) => r.json());
    assert.deepEqual(afterRestart.notify_settings, updatedPayload);

    // 5. Events dynamically carry the latest notify_settings without restart.
    events.length = 0;
    const reg = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ file: boardFile, creator: "Alice" }),
    }).then((r) => r.json());

    await fetch(`${base}/api/${reg.key}/metadata`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ add: ["Jordan"] }),
    });
    await fetch(`${base}/api/hub/${reg.key}/close`, {
      method: "POST",
      headers: { origin: base },
    });

    const deadline = Date.now() + 4_000;
    let hookEntries = [];
    while (Date.now() < deadline) {
      try {
        const raw = (await readFile(hookLog, "utf8")).trim();
        hookEntries = raw ? raw.split("\n").map((line) => JSON.parse(line)) : [];
        if (hookEntries.some((e) => e.event === "board_closed")) break;
      } catch {
        // wait for hook flush
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const tagEv = hookEntries.find((e) => e.event === "tag_change");
    const closeEv = hookEntries.find((e) => e.event === "board_closed");
    assert.ok(tagEv);
    assert.ok(closeEv);
    assert.deepEqual(tagEv.notify_settings, updatedPayload);
    assert.deepEqual(closeEv.notify_settings, updatedPayload);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
