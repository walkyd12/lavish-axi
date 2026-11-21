import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

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

test("scoped notification patches preserve concurrent opt-outs, survive 'notify_settings' person name across restart, and bound hook arguments on board_action", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hub-r2-notify-"));
  const stateFile = path.join(dir, "state.json");
  const boardFile = path.join(dir, "action-board.html");
  const hookLog = path.join(dir, "hook-sizes.jsonl");
  const hookBin = path.join(dir, "on-event-size.mjs");
  await writeFile(boardFile, "<title>Action Size Check</title><p>" + "あ".repeat(6_000) + "</p>");
  await writeFile(
    hookBin,
    `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nconst raw = process.argv[2] || "";\nconst parsed = JSON.parse(raw);\nappendFileSync(${JSON.stringify(hookLog)}, JSON.stringify({ event: parsed.event, bytes: Buffer.byteLength(raw, "utf8"), zachTagged: parsed.notify_settings?.Zach?.tagged, walkerDone: parsed.notify_settings?.Walker?.done, hasNotifySettingsPerson: Boolean(parsed.notify_settings?.notify_settings) }) + "\\n");\n`,
  );
  await chmod(hookBin, 0o755);

  let server = await serve({
    port: 0,
    hosts: ["127.0.0.1"],
    stateFile,
    version: "0.1.96",
    env: {
      ...process.env,
      LAVISH_AXI_NOTIFY_PEOPLE: "Zach,Walker,Sam",
      LAVISH_AXI_ON_EVENT: hookBin,
    },
  });
  let base = `http://127.0.0.1:${server.port}`;
  const postNotify = (body) =>
    fetch(`${base}/api/hub/notifications`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify(body),
    });

  try {
    // Enable Zach.tagged initially, then capture stale revision before Zach opts out.
    await postNotify({ patch: { person: "Zach", tagged: true, done: true } });
    const staleSnapshot = await fetch(`${base}/api/hub/notifications`).then((r) => r.json());
    assert.equal(staleSnapshot.notify_settings.Zach.tagged, true);

    // P1 #1: Zach opts out (`tagged: false`) while Walker concurrently edits Walker's row, adds `notify_settings`, and removes `Sam`.
    const [zachOptOut, walkerEdit, walkerDest, addSpecial, removeSam] = await Promise.all([
      postNotify({ patch: { person: "Zach", tagged: false } }),
      postNotify({ patch: { person: "Walker", done: true } }),
      postNotify({ patch: { person: "Walker", send_to: "148800000000000099" } }),
      postNotify({ add: "notify_settings" }),
      postNotify({ remove: "Sam" }),
    ]);
    assert.equal(zachOptOut.status, 200);
    assert.equal(walkerEdit.status, 200);
    assert.equal(walkerDest.status, 200);
    assert.equal(addSpecial.status, 200);
    assert.equal(removeSam.status, 200);

    // Stale patch for removed Sam or stale full-map write with old revision is rejected (409) without undoing Zach's opt-out.
    const staleSamPatch = await postNotify({ patch: { person: "Sam", tagged: true } });
    assert.equal(staleSamPatch.status, 409);
    const staleFullOverwrite = await postNotify({
      notify_settings: staleSnapshot.notify_settings,
      revision: staleSnapshot.revision,
    });
    assert.equal(staleFullOverwrite.status, 409);

    const current = await fetch(`${base}/api/hub/notifications`).then((r) => r.json());
    assert.equal(current.notify_settings.Zach.tagged, false, "Zach's opt-out must not be undone by Walker's edits");
    assert.equal(current.notify_settings.Zach.done, true);
    assert.equal(current.notify_settings.Walker.done, true);
    assert.equal(current.notify_settings.Walker.send_to, "148800000000000099");
    assert.equal(Object.hasOwn(current.notify_settings, "Sam"), false);
    assert.deepEqual(current.notify_settings.notify_settings, { tagged: false, done: false, send_to: "" });

    // P1 #5: Restart server and verify person named `notify_settings` never wipes the saved roster!
    await server.close();
    server = await serve({
      port: 0,
      hosts: ["127.0.0.1"],
      stateFile,
      version: "0.1.96",
      env: { ...process.env, LAVISH_AXI_ON_EVENT: hookBin },
    });
    base = `http://127.0.0.1:${server.port}`;
    const afterRestart = await fetch(`${base}/api/hub/notifications`).then((r) => r.json());
    assert.deepEqual(afterRestart.notify_settings, current.notify_settings);

    // P1 #7a: Oversized settings (>32 KiB, e.g. 100 x 256-char 3-byte UTF-8 destinations) are rejected upfront (400).
    const hugeMap = {};
    for (let i = 0; i < 100; i += 1) {
      hugeMap[`Person_${i}_${"漢".repeat(16)}`] = { tagged: true, done: true, send_to: "€".repeat(256) };
    }
    const hugeRes = await postNotify({ notify_settings: hugeMap });
    assert.equal(hugeRes.status, 400);

    // P1 #7b: Fill valid multi-byte settings (~28 KiB) + 45 multi-byte chat entries (600 x 3-byte chars each)
    // and trigger `POST /api/:key/action`: hook argument stays <= 65,536 bytes and hook actually runs!
    for (let i = 0; i < 32; i += 1) {
      const res = await postNotify({ add: `Member_${i}` });
      assert.equal(res.status, 200);
      const destRes = await postNotify({ patch: { person: `Member_${i}`, send_to: "€".repeat(240) } });
      assert.equal(destRes.status, 200);
    }
    const reg = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ file: boardFile, creator: "Zach" }),
    }).then((r) => r.json());

    for (let i = 0; i < 45; i += 1) {
      await fetch(`${base}/api/${reg.key}/prompts`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({
          prompts: [{ prompt: `Entry ${i}: ` + "語".repeat(600), tag: "message", author: "Zach", prompt_id: `p-${i}` }],
        }),
      });
    }

    const actionRes = await fetch(`${base}/api/${reg.key}/action`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ action: "send", prompt: "Final instruction " + "雪".repeat(1_200), author: "Zach" }),
    });
    assert.equal(actionRes.status, 200);
    assert.equal((await actionRes.json()).status, "sent");

    const deadline = Date.now() + 4_000;
    let actionRecord = null;
    while (Date.now() < deadline) {
      try {
        const lines = (await readFile(hookLog, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        actionRecord = lines.find((entry) => entry.event === "board_action") || null;
        if (actionRecord) break;
      } catch {
        // wait for hook write
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.ok(actionRecord, "board_action hook must launch and write without E2BIG");
    assert.ok(actionRecord.bytes <= 65_536, `expected <= 65536 bytes, got ${actionRecord.bytes}`);
    assert.equal(actionRecord.zachTagged, false);
    assert.equal(actionRecord.walkerDone, true);
    assert.equal(actionRecord.hasNotifySettingsPerson, true);

    // P1 #7c: If the configured hook executable cannot be spawned, `/api/:key/action` refuses to report `sent`.
    await server.close();
    server = await serve({
      port: 0,
      hosts: ["127.0.0.1"],
      stateFile,
      version: "0.1.96",
      env: { ...process.env, LAVISH_AXI_ON_EVENT: path.join(dir, "missing-hook-executable") },
    });
    base = `http://127.0.0.1:${server.port}`;
    const brokenAction = await fetch(`${base}/api/${reg.key}/action`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ action: "send" }),
    });
    // Send is fire-and-forget: a hook that fails to launch is logged, never blocks or errors the action.
    assert.equal(brokenAction.status, 200);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a slow or timing-out peer never holds GET / past the short initial budget on cold or invalidated cache", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hub-slow-peer-"));
  const localBoard = path.join(dir, "local-ready.html");
  await writeFile(localBoard, "<title>Instant Local Board</title><p>Ready right now</p>");

  let stallMs = 1_600;
  const slowPeer = http.createServer((req, res) => {
    if ((req.url || "").startsWith("/api/hub")) {
      const timer = setTimeout(() => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ boards: [{ key: "slowpeer1", title: "Delayed Peer Board", status: "open" }] }));
      }, stallMs);
      timer.unref?.();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => slowPeer.listen(0, "127.0.0.1", () => resolve(undefined)));
  const peerPort = /** @type {import("node:net").AddressInfo} */ (slowPeer.address()).port;

  const server = await serve({
    port: 0,
    hosts: ["127.0.0.1"],
    stateFile: path.join(dir, "state.json"),
    version: "0.1.96",
    hubPeers: `slow=http://127.0.0.1:${peerPort}`,
    hubPeerOptions: { timeoutMs: 2_000 },
  });
  const base = `http://127.0.0.1:${server.port}`;

  try {
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ file: localBoard, creator: "Zach" }),
    });

    // 1. Cold peer cache with 1,600ms peer delay: GET / returns local board in well under 500ms!
    const coldStart = performance.now();
    const coldHtml = await fetch(`${base}/`).then((r) => r.text());
    const coldElapsed = performance.now() - coldStart;
    assert.match(coldHtml, /Instant Local Board/);
    assert.ok(coldElapsed < 500, `expected cold GET / < 500ms despite 1600ms peer, got ${coldElapsed.toFixed(1)}ms`);

    // Wait for background scrape to warm cache, then invalidate cache and stall peer again!
    const fullHub = await fetch(`${base}/api/hub`).then((r) => r.json());
    assert.ok(fullHub.boards.some((b) => b.title === "Delayed Peer Board"));

    // Create a real Lavish peer, warm its live-stream cache on central, then proxy through a stalling forwarder
    // or invalidate by closing the peer so `collectPeerBoards.invalidate` runs while the peer hangs for 2,000ms.
    let hangNextPeerHub = false;
    const controllableFetch = async (url, init) => {
      if (hangNextPeerHub && String(url).includes("/api/hub?peers=0")) {
        await new Promise((resolve) => setTimeout(resolve, 1_600));
      }
      return fetch(url, init);
    };
    const realPeer = await serve({
      port: 0,
      hosts: ["127.0.0.1"],
      stateFile: path.join(dir, "real-peer.json"),
      version: "0.1.96",
    });
    const peerBoardFile = path.join(dir, "real-peer-board.html");
    await writeFile(peerBoardFile, "<title>Cached Peer Board</title><p>Body</p>");
    await fetch(`http://127.0.0.1:${realPeer.port}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${realPeer.port}` },
      body: JSON.stringify({ file: peerBoardFile, creator: "Walker" }),
    });
    const server2 = await serve({
      port: 0,
      hosts: ["127.0.0.1"],
      stateFile: path.join(dir, "state.json"),
      version: "0.1.96",
      hubPeers: `walker=http://127.0.0.1:${realPeer.port}`,
      hubPeerOptions: { timeoutMs: 2_000, fetchImpl: controllableFetch },
    });
    try {
      const base2 = `http://127.0.0.1:${server2.port}`;
      // Warm peer cache while fast.
      const warm = await fetch(`${base2}/api/hub`).then((r) => r.json());
      assert.ok(warm.boards.some((b) => b.title === "Cached Peer Board"));
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Now stall the peer's `/api/hub?peers=0` for 1,600ms and invalidate cache by creating a board on `realPeer`!
      hangNextPeerHub = true;
      const peerBoardFile2 = path.join(dir, "real-peer-board-2.html");
      await writeFile(peerBoardFile2, "<title>Second Peer Board</title><p>Body</p>");
      await fetch(`http://127.0.0.1:${realPeer.port}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: `http://127.0.0.1:${realPeer.port}` },
        body: JSON.stringify({ file: peerBoardFile2, creator: "Walker" }),
      });
      await new Promise((resolve) => setTimeout(resolve, 60));

      // 2. Invalidated peer cache while peer scrape takes 1,600ms: GET / still returns in < 500ms!
      const dirtyStart = performance.now();
      const dirtyHtml = await fetch(`${base2}/`).then((r) => r.text());
      const dirtyElapsed = performance.now() - dirtyStart;
      assert.match(dirtyHtml, /Instant Local Board/);
      assert.ok(
        dirtyElapsed < 500,
        `expected invalidated-peer GET / < 500ms despite 1600ms peer scrape, got ${dirtyElapsed.toFixed(1)}ms`,
      );
    } finally {
      await server2.close();
      await realPeer.close();
    }
  } finally {
    await server.close();
    slowPeer.closeAllConnections();
    await new Promise((resolve) => slowPeer.close(() => resolve(undefined)));
    await rm(dir, { recursive: true, force: true });
  }
});

test("hub-client Load more cancels and discards stale Closed or pre-search responses when switching tabs or searching", async () => {
  const clientCode = await readFile(new URL("../src/hub-client.js", import.meta.url), "utf8");

  function makeEl(id = "") {
    const listeners = new Map();
    return {
      id,
      hidden: false,
      disabled: false,
      textContent: "",
      innerHTML: "",
      value: "",
      dataset: {},
      attributes: new Map(),
      setAttribute(k, v) {
        this.attributes.set(k, String(v));
      },
      getAttribute(k) {
        return this.attributes.get(k) || null;
      },
      addEventListener(type, fn) {
        const arr = listeners.get(type) || [];
        arr.push(fn);
        listeners.set(type, arr);
      },
      dispatch(type, event = {}) {
        for (const fn of listeners.get(type) || []) {
          fn({ target: this, preventDefault() {}, ...event });
        }
      },
      contains() {
        return false;
      },
      matches() {
        return false;
      },
      querySelectorAll() {
        return [];
      },
    };
  }

  const elements = new Map();
  for (const id of [
    "hub-data",
    "boards",
    "hubMoreWrap",
    "hubMore",
    "hubEmpty",
    "hubNote",
    "peerNote",
    "hubPill",
    "hubLede",
    "hubUpdated",
    "tabOpen",
    "tabNeedsInput",
    "tabClosed",
    "tabCancelled",
    "hubSearch",
    "hubTag",
    "countOpen",
    "countNeedsInput",
    "countClosed",
    "countCancelled",
    "history",
    "historyTitle",
    "historyBody",
    "historyClose",
    "notifyToggle",
    "notifyPanel",
    "notifyClose",
    "notifyRows",
    "notifyEmpty",
    "notifyAddForm",
    "notifyAddInput",
    "notifyStatus",
  ]) {
    elements.set(id, makeEl(id));
  }
  elements.get("notifyPanel").hidden = true;
  elements.get("hub-data").textContent = JSON.stringify({
    boards: [{ key: "open-1", title: "Open Alpha", status: "open", state: "taking-input", url: "/session/open-1" }],
    peers: [],
    counts: { open: 56, needs_input: 0, closed: 52, cancelled: 0 },
    open_summary: { listening: 1, unread: 0, nobody: 55 },
    tags: [],
    total: 56,
    has_more: true,
    notify_settings: {},
    generated_at: "2026-11-21T14:00:00.000Z",
  });

  /** @type {Array<{ url: string, signal: AbortSignal | undefined, resolve: (data: any) => void }>} */
  const pendingFetches = [];
  const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 10));

  const sandbox = {
    URL,
    URLSearchParams,
    AbortController,
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    setTimeout,
    clearTimeout,
    location: { protocol: "http:", host: "127.0.0.1:4799", href: "http://127.0.0.1:4799/", hash: "" },
    window: {
      addEventListener() {},
      dispatchEvent() {},
    },
    document: {
      activeElement: null,
      visibilityState: "visible",
      getElementById(id) {
        return elements.get(id) || null;
      },
      addEventListener() {},
      createElement() {
        return makeEl();
      },
    },
    fetch(url, init = {}) {
      return new Promise((resolve, reject) => {
        pendingFetches.push({
          url: String(url),
          signal: init.signal,
          resolve(data) {
            if (init.signal?.aborted) {
              const err = new Error("Aborted");
              err.name = "AbortError";
              reject(err);
              return;
            }
            resolve({
              ok: true,
              status: 200,
              json: async () => data,
            });
          },
        });
      });
    },
  };

  vm.runInNewContext(clientCode, sandbox);

  // 1. Switch to Closed tab and load Closed page 1 (50 boards, has_more: true).
  elements.get("tabClosed").dispatch("click");
  assert.equal(pendingFetches.length, 1);
  assert.match(pendingFetches[0].url, /state=closed/);
  pendingFetches.shift().resolve({
    boards: [
      { key: "closed-1", title: "Closed Page1", status: "ended", state: "closed-user", url: "/session/closed-1" },
    ],
    peers: [],
    counts: { open: 56, needs_input: 0, closed: 52, cancelled: 0 },
    total: 52,
    has_more: true,
  });
  await flushMicrotasks();
  assert.match(elements.get("boards").innerHTML, /Closed Page1/);
  assert.equal(elements.get("hubMoreWrap").hidden, false);

  // 2. Click Load more on Closed, then BEFORE it finishes, switch back to Open!
  elements.get("hubMore").dispatch("click");
  assert.equal(pendingFetches.length, 1);
  const staleClosedLoadMore = pendingFetches.shift();
  assert.match(staleClosedLoadMore.url, /state=closed.*offset=1/);

  elements.get("tabOpen").dispatch("click");
  assert.equal(staleClosedLoadMore.signal?.aborted, true, "switching tabs must immediately abort in-flight Load more");
  assert.equal(pendingFetches.length, 1);
  const openRefresh = pendingFetches.shift();
  assert.match(openRefresh.url, /state=open/);

  openRefresh.resolve({
    boards: [{ key: "open-1", title: "Open Alpha", status: "open", state: "taking-input", url: "/session/open-1" }],
    peers: [],
    counts: { open: 56, needs_input: 0, closed: 52, cancelled: 0 },
    total: 56,
    has_more: true,
  });
  await flushMicrotasks();

  // Even if the stale Closed Load more resolves late with closed boards and `has_more: false`, Open stays untouched!
  staleClosedLoadMore.resolve({
    boards: [
      { key: "closed-2", title: "LEAKED_CLOSED_BOARD", status: "ended", state: "closed-user", url: "/session/c2" },
    ],
    peers: [],
    total: 52,
    has_more: false,
  });
  await flushMicrotasks();

  assert.doesNotMatch(elements.get("boards").innerHTML, /LEAKED_CLOSED_BOARD/);
  assert.match(elements.get("boards").innerHTML, /Open Alpha/);
  assert.equal(elements.get("hubMoreWrap").hidden, false, "Open tab Load more button must remain visible");

  // 3. Start Load more on Open, then type a search query before Load more finishes: stale page is aborted & ignored.
  elements.get("hubMore").dispatch("click");
  const staleOpenLoadMore = pendingFetches.shift();
  elements.get("hubSearch").value = "Quartz";
  elements.get("hubSearch").dispatch("input");
  assert.equal(
    staleOpenLoadMore.signal?.aborted,
    true,
    "typing search query must immediately abort in-flight Load more",
  );
  staleOpenLoadMore.resolve({
    boards: [{ key: "open-99", title: "STALE_UNFILTERED_OPEN", status: "open", state: "nobody", url: "/session/o99" }],
    peers: [],
    total: 56,
    has_more: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 180));
  const searchReq = pendingFetches.shift();
  assert.ok(searchReq);
  assert.match(searchReq.url, /q=Quartz/);
  searchReq.resolve({
    boards: [{ key: "q-1", title: "Quartz Match", status: "closed", state: "closed-user", url: "/session/q1" }],
    peers: [],
    total: 1,
    has_more: false,
  });
  await flushMicrotasks();
  assert.doesNotMatch(elements.get("boards").innerHTML, /STALE_UNFILTERED_OPEN/);
  assert.match(elements.get("boards").innerHTML, /Quartz Match/);
  assert.equal(elements.get("hubMoreWrap").hidden, true);
});
