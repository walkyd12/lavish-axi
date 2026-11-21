import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { serve } from "../src/server.js";
import { createPeerBoardSource } from "../src/hub-peers.js";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

const post = (base, body, origin = base) =>
  fetch(`${base}/api/hub/peers`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("live peer state did not converge");
}

test("connected hubs seed once, validate same-origin writes, apply live and persist removal", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hub-peer-settings-"));
  process.env.LAVISH_AXI_STATE_DIR = dir;
  const events = [];
  const peer = await serve({
    port: 0,
    hosts: ["127.0.0.1"],
    stateFile: path.join(dir, "remote", "state.json"),
    hubPeers: "",
  });
  const peerBase = `http://127.0.0.1:${peer.port}`;
  const stateFile = path.join(dir, "local", "state.json");
  let server = await serve({
    port: 0,
    hosts: ["127.0.0.1"],
    stateFile,
    hubPeers: "",
    onEvent: (event) => events.push(event),
  });
  let base = `http://127.0.0.1:${server.port}`;
  try {
    const html = await fetch(base).then((r) => r.text());
    assert.match(html, /Connected hubs/);
    assert.match(html, /id="peerPanel"[^>]*>/);
    assert.doesNotMatch(html, /id="peerPanel"[^>]*hidden/);
    assert.equal(
      (await post(base, { add: { name: "remote", origin: peerBase } }, "https://foreign.example")).status,
      403,
    );
    assert.equal((await post(base, { add: { name: "remote", origin: peerBase } }, "null")).status, 403);
    for (const origin of [
      "ftp://example.com",
      "http://u:pw@example.com",
      "http://example.com/path",
      "http://example.com/?x=1",
      "http://example.com/#x",
    ]) {
      assert.equal((await post(base, { add: { name: "remote", origin } })).status, 400);
    }
    const additions = await Promise.all([
      post(base, { add: { name: "remote", origin: peerBase } }),
      post(base, { add: { name: "down", origin: "http://127.0.0.1:1" } }),
    ]);
    assert.ok(additions.every((r) => r.ok));
    assert.equal((await post(base, { add: { name: "REMOTE", origin: peerBase } })).status, 400);
    const saved = JSON.parse(await readFile(path.join(dir, "local", "hub-peers.json"), "utf8"));
    assert.equal(saved.length, 2);
    const file = path.join(dir, "board.html");
    await writeFile(file, "<title>Remote board live</title><p>Live peer</p>");
    const reg = await fetch(`${peerBase}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: peerBase },
      body: JSON.stringify({ file }),
    }).then((r) => r.json());
    await until(async () =>
      (await fetch(`${base}/api/hub`).then((r) => r.json())).boards.some((b) => b.key === `peer:remote:${reg.key}`),
    );
    await until(() => events.some((e) => e.source === "remote" && e.key === `peer:remote:${reg.key}`));
    const view = await fetch(`${base}/api/hub`).then((r) => r.json());
    assert.equal(view.peers.find((p) => p.name === "remote").ok, true);
    assert.equal(view.peers.find((p) => p.name === "down").ok, false);
    for (const action of ["close", "reopen", "cancel", "reopen"]) {
      assert.equal(
        (
          await fetch(`${base}/api/hub/${encodeURIComponent(`peer:remote:${reg.key}`)}/${action}`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: base },
            body: JSON.stringify({ peer_origin: peerBase }),
          })
        ).status,
        200,
      );
    }
    assert.equal((await post(base, { remove: "remote" })).status, 200);
    const removed = await fetch(`${base}/api/hub`).then((r) => r.json());
    assert.ok(!removed.boards.some((b) => b.source === "remote"));
    assert.equal(
      (
        await fetch(`${base}/api/hub/${encodeURIComponent(`peer:remote:${reg.key}`)}/close`, {
          method: "POST",
          headers: { origin: base },
        })
      ).status,
      404,
    );
    events.length = 0;
    await fetch(`${peerBase}/api/hub/${reg.key}/close`, { method: "POST", headers: { origin: peerBase } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(!events.some((e) => e.source === "remote"));
    await server.close();
    server = await serve({ port: 0, hosts: ["127.0.0.1"], stateFile, hubPeers: `remote=${peerBase}` });
    base = `http://127.0.0.1:${server.port}`;
    const restarted = await fetch(`${base}/api/hub/peers`).then((r) => r.json());
    assert.deepEqual(
      restarted.peers.map((p) => p.name),
      ["down"],
    );
  } finally {
    await server.close();
    await peer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("changing peers aborts removed scrapes and never adopts their late results", async () => {
  let aborted = false;
  const source = createPeerBoardSource([{ name: "old", origin: "http://old.example" }], {
    fetchImpl: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      }),
  });
  const pending = source({ maxWaitMs: 0 });
  await pending;
  source.setPeers([]);
  assert.equal(aborted, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await source(), { peers: [], boards: [] });
});

test("peer lifecycle actions reject a stale origin after a peer name is reused", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hub-peer-action-origin-"));
  process.env.LAVISH_AXI_STATE_DIR = dir;
  const servers = [];
  const request = (base, route, body) =>
    fetch(base + route, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify(body),
    });
  try {
    for (const name of ["hub", "original", "replacement"]) {
      servers.push(
        await serve({ port: 0, hosts: ["127.0.0.1"], stateFile: path.join(dir, name, "state.json"), hubPeers: "" }),
      );
    }
    const [base, original, replacement] = servers.map((server) => `http://127.0.0.1:${server.port}`);
    const file = path.join(dir, "shared.html");
    await writeFile(file, "<title>Same canonical artifact on two hubs</title>");
    const oldBoard = await request(original, "/api/sessions", { file }).then((r) => r.json());
    const newBoard = await request(replacement, "/api/sessions", { file }).then((r) => r.json());
    assert.equal(oldBoard.key, newBoard.key, "the two hubs serve the same canonical path");
    const route = `/api/hub/${encodeURIComponent(`peer:remote:${oldBoard.key}`)}`;
    const localRoute = `/api/hub/${oldBoard.key}`;
    for (const action of ["close", "cancel", "reopen"]) {
      if (action === "reopen") {
        assert.equal((await request(original, `${localRoute}/close`, {})).status, 200);
        assert.equal((await request(replacement, `${localRoute}/close`, {})).status, 200);
      }
      assert.equal((await post(base, { add: { name: "remote", origin: original } })).status, 200);
      /** @type {{ peer_origin: string } | undefined} */
      let displayed;
      await until(async () => {
        displayed = (await fetch(`${base}/api/hub`).then((r) => r.json())).boards.find((b) => b.source === "remote");
        return displayed?.peer_origin === original;
      });
      assert.ok(displayed);
      assert.equal((await post(base, { remove: "remote" })).status, 200);
      assert.equal((await post(base, { add: { name: "remote", origin: replacement } })).status, 200);
      const before = await readFile(path.join(dir, "replacement", "state.json"), "utf8");
      const originalBefore = await readFile(path.join(dir, "original", "state.json"), "utf8");
      // An omitted peer_origin (older tabs/API callers) is allowed; a sent stale or malformed one fails closed.
      for (const body of [{ peer_origin: displayed.peer_origin }, { peer_origin: null }, { peer_origin: {} }]) {
        assert.equal(
          (await request(base, `${route}/${action}`, body)).status,
          409,
          `${action} must reject ${JSON.stringify(body)}`,
        );
      }
      assert.equal(await readFile(path.join(dir, "replacement", "state.json"), "utf8"), before);
      assert.equal(await readFile(path.join(dir, "original", "state.json"), "utf8"), originalBefore);
      assert.equal((await request(base, `${route}/${action}`, { peer_origin: replacement })).status, 200);
      const fresh = (await fetch(`${replacement}/api/hub?peers=0`).then((r) => r.json())).boards[0];
      assert.equal(fresh.closed, action !== "reopen");
      assert.equal(fresh.cancelled, action === "cancel");
      assert.equal((await post(base, { remove: "remote" })).status, 200);
      assert.equal((await request(replacement, `${localRoute}/reopen`, {})).status, 200);
    }
  } finally {
    for (const server of servers.reverse()) await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("hub peers seed env only when their file is absent", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hub-peer-seed-"));
  process.env.LAVISH_AXI_STATE_DIR = dir;
  let server;
  try {
    server = await serve({
      port: 0,
      hosts: ["127.0.0.1"],
      stateFile: path.join(dir, "state.json"),
      hubPeers: "seed=http://127.0.0.1:1",
    });
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, "hub-peers.json"), "utf8")), [
      { name: "seed", origin: "http://127.0.0.1:1" },
    ]);
  } finally {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("adding and removing another hub preserves existing peer caches and 30-second failure backoff", async () => {
  const calls = [];
  const connected = [
    { name: "up", origin: "http://up.example" },
    { name: "down", origin: "http://down.example" },
  ];
  const source = createPeerBoardSource(connected, {
    isStreamLive: () => true,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes("down.example")) throw new Error("offline");
      return new Response(JSON.stringify({ boards: [{ key: "board", title: "Cached board" }] }));
    },
  });
  await source();
  source.setPeers([...connected.map((peer) => ({ ...peer })), { name: "extra", origin: "http://extra.example" }]);
  const added = await source();
  assert.equal(added.boards.length, 2);
  assert.equal(added.peers.find((peer) => peer.name === "down").ok, false);
  source.setPeers(connected);
  await source();
  assert.equal(calls.filter((url) => url.includes("down.example")).length, 1);
  assert.equal(calls.filter((url) => url.includes("up.example")).length, 1);
});

test("a removed scrape that ignores abort cannot replace a newly connected peer with the same name", async () => {
  /** @type {(response: Response) => void} */
  let resolveOld;
  const source = createPeerBoardSource([{ name: "team", origin: "http://old.example" }], {
    isStreamLive: () => true,
    fetchImpl: async (url) => {
      if (String(url).includes("old.example"))
        return new Promise((resolve) => {
          resolveOld = resolve;
        });
      return new Response(JSON.stringify({ boards: [{ key: "newboard", title: "New board" }] }));
    },
  });
  const oldCollection = source();
  await new Promise((resolve) => setImmediate(resolve));
  source.setPeers([{ name: "team", origin: "http://new.example" }]);
  assert.equal((await source()).boards[0].title, "New board");
  assert.ok(resolveOld);
  resolveOld(new Response(JSON.stringify({ boards: [{ key: "oldboard", title: "Old board" }] })));
  assert.deepEqual(await oldCollection, { boards: [], peers: [] });
  assert.equal((await source()).boards[0].title, "New board");
});
