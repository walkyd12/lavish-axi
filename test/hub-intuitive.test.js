import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { serve } from "../src/server.js";
import { relayPeerBoardClient, sanitizePeerHubEvent } from "../src/hub-peers.js";
import { SessionStore } from "../src/session-store.js";
import { boardNeedsYou, hubViewerNames, createHubHtml } from "../src/hub.js";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

test("hub title is configurable and settings and technical metadata start tucked away", () => {
  const html = createHubHtml({ boards: [], hostname: "machine", title: "Team <Hub>" });
  assert.match(html, /Team &lt;Hub&gt;/);
  assert.doesNotMatch(html, /Fusion/);
  assert.match(html, /<dialog[^>]*id="hubSettings"/);
  assert.match(html, /Also search closed &amp; cancelled/);
  assert.doesNotMatch(html, /Closed <span/);
  assert.doesNotMatch(html, /Cancelled <span/);
});

test("client metadata persists, emits changes, scopes search, filters and recent history, and relays safely", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hub-intuitive-"));
  process.env.LAVISH_AXI_STATE_DIR = dir;
  const hookEvents = [];
  const peer = await serve({
    port: 0,
    hosts: ["127.0.0.1"],
    stateFile: path.join(dir, "peer", "state.json"),
    hubPeers: "",
  });
  const peerBase = `http://127.0.0.1:${peer.port}`;
  const server = await serve({
    port: 0,
    hosts: ["127.0.0.1"],
    stateFile: path.join(dir, "state.json"),
    hubPeers: `remote=${peerBase}`,
    onEvent: (event) => hookEvents.push(event),
  });
  const base = `http://127.0.0.1:${server.port}`;
  const put = (host, key, patch, origin = host) =>
    fetch(`${host}/api/${encodeURIComponent(key)}/metadata`, {
      method: "PUT",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
  const register = async (host, name) => {
    const file = path.join(dir, name + ".html");
    await writeFile(file, `<title>${name}</title><p>spindle</p>`);
    return fetch(`${host}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file, creator: "Reviewer" }),
    }).then((r) => r.json());
  };
  try {
    const local = await register(base, "Open spindle");
    assert.equal((await put(base, local.key, { client: "Acme" }, "https://foreign.example")).status, 403);
    for (const client of [null, 42, "x".repeat(65), "a\nb"])
      assert.equal((await put(base, local.key, { client })).status, 400);
    assert.equal((await put(base, local.key, { client: "Acme", creator: "replacement" })).status, 400);
    const edits = await Promise.all([
      put(base, local.key, { client: "Acme" }),
      put(base, local.key, { add: ["needs-input", "Reviewer"] }),
    ]);
    assert.ok(edits.every((r) => r.ok));
    const store = new SessionStore(path.join(dir, "state.json"));
    let saved = await store.findByKey(local.key);
    assert.equal(saved.client, "Acme");
    assert.deepEqual(saved.tags, ["needs-input", "Reviewer"]);
    await store.upsertSession(saved.file, saved.url, { version: "0.1.96" });
    assert.equal((await store.findByKey(local.key)).client, "Acme");
    assert.ok(hookEvents.some((e) => e.event === "tag_change" && e.client === "Acme" && e.previous_client === ""));
    const closed = await register(base, "Old spindle");
    await fetch(`${base}/api/hub/${closed.key}/close`, { method: "POST", headers: { origin: base } });
    const state = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    state.sessions[closed.key].updated_at = "2020-01-01T00:00:00.000Z";
    state.sessions[closed.key].chat = [];
    await writeFile(path.join(dir, "state.json"), JSON.stringify(state));
    const hub = (query) => fetch(`${base}/api/hub?${query}`).then((r) => r.json());
    const open = await hub("state=open&q=spindle&client=Acme&person=Reviewer&needs_input=1");
    assert.deepEqual(
      open.boards.map((b) => b.key),
      [local.key],
    );
    assert.equal(open.total, 1);
    assert.deepEqual(open.clients, ["Acme"]);
    assert.equal(open.needs_you[0].key, local.key);
    assert.equal((await hub("state=open&client=Missing")).total, 0);
    assert.equal((await hub("state=closed&recent=1")).total, 0);
    assert.equal((await hub("state=closed")).total, 1);
    assert.equal((await hub("q=spindle")).total, 2);
    const remote = await register(peerBase, "Remote spindle");
    const peerKey = `peer:remote:${remote.key}`;
    assert.equal((await put(base, peerKey, { client: "Partner" })).status, 409);
    assert.equal((await put(base, peerKey, { client: "Partner", peer_origin: "http://wrong.example" })).status, 409);
    assert.equal(
      (await put(base, peerKey, { client: "Partner", peer_origin: peerBase }, "https://foreign.example")).status,
      403,
    );
    const relayed = await put(base, peerKey, { client: "Partner", peer_origin: peerBase });
    assert.equal(relayed.status, 200);
    assert.equal((await relayed.json()).client, "Partner");
    assert.equal(
      (await new SessionStore(path.join(dir, "peer", "state.json")).findByKey(remote.key)).client,
      "Partner",
    );
    assert.equal((await put(base, local.key, { client: "" })).status, 200);
    assert.equal((await store.findByKey(local.key)).client, "");
  } finally {
    await server.close();
    await peer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Needs you uses exact provisioned login aliases, has an unknown-viewer fallback and excludes ended boards", () => {
  const users = new Map([["reviewer", new Set(["person@example.com"])]]);
  const viewer = hubViewerNames({ loginName: "PERSON@example.com", displayName: "Someone else" }, users);
  assert.deepEqual(viewer, ["person@example.com", "reviewer"]);
  assert.deepEqual(hubViewerNames(null, users), []);
  assert.deepEqual(hubViewerNames({ loginName: "person@other.example", displayName: "Reviewer" }, users), [
    "person@other.example",
  ]);
  assert.equal(boardNeedsYou({ tags: ["Reviewer"], status: "open" }, viewer), true);
  assert.equal(boardNeedsYou({ tags: ["Reviewer"], status: "open" }), false);
  assert.equal(boardNeedsYou({ tags: ["needs-input"], status: "open" }), true);
  assert.equal(boardNeedsYou({ tags: ["needs-input"], status: "ended" }, viewer), false);
  assert.equal(boardNeedsYou({ tags: ["needs-input"], state: "file-gone" }, viewer), false);
});

test("Needs you finds and hydrates attention boards beyond the first Open page without reading body text", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hub-attention-"));
  process.env.LAVISH_AXI_STATE_DIR = dir;
  const file = path.join(dir, "board.html");
  await writeFile(file, "<title>Attention board</title><p>body token</p>");
  const sessions = {};
  for (let i = 0; i < 52; i++) {
    const key = i.toString(16).padStart(24, "0");
    sessions[key] = {
      key,
      file,
      status: "open",
      updated_at: new Date(Date.now() - i * 60000).toISOString(),
      tags: i === 51 ? ["needs-input"] : [],
      chat: [],
    };
  }
  const stateFile = path.join(dir, "state.json");
  await writeFile(stateFile, JSON.stringify({ sessions }));
  const server = await serve({
    port: 0,
    hosts: ["127.0.0.1"],
    stateFile,
    hubPeers: "",
    env: { ...process.env, LAVISH_AXI_HUB_TITLE: "Review room" },
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const response = await fetch(base).then((r) => r.text());
    assert.match(response, /Review room/);
    const data = JSON.parse(response.match(/<script id="hub-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
    assert.equal(data.boards.length, 50);
    assert.equal(data.needs_you.length, 1);
    assert.equal(data.needs_you[0].title, "Attention board");
    assert.ok(!data.boards.some((b) => b.key === data.needs_you[0].key));
    assert.doesNotMatch(response, /body token|search_text/);
    assert.deepEqual(await fetch(`${base}/api/hub/viewer`).then((r) => r.json()), { viewer: [] });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("client relay rebuilds bounded peer replies and hook fields without forwarding viewer credentials", async () => {
  const peer = { name: "remote", origin: "https://hub.example" };
  const key = "0123456789abcdef";
  const requests = [];
  const result = await relayPeerBoardClient(peer, key, "Acme", {
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(
        JSON.stringify({ client: "x".repeat(200), file: "/private/path", url: "https://foreign.example" }),
        { status: 200 },
      );
    },
  });
  const sent = requests[0];
  assert.ok(sent, "relay sends a request");
  assert.equal(sent.url, `https://hub.example/api/${key}/metadata`);
  assert.equal(sent.init.method, "PUT");
  assert.equal(sent.init.credentials, "omit");
  assert.equal(sent.init.redirect, "error");
  assert.deepEqual(sent.init.headers, {
    accept: "application/json",
    "content-type": "application/json",
    origin: peer.origin,
  });
  assert.deepEqual(JSON.parse(sent.init.body), { client: "Acme" });
  assert.deepEqual(result.payload, { client: "x".repeat(64) });
  const event = sanitizePeerHubEvent(peer, {
    event: "tag_change",
    key,
    client: "Acme",
    previous_client: "Old",
    added: [],
    removed: [],
    file: "/private/path",
  });
  assert.equal(event.client, "Acme");
  assert.equal(event.previous_client, "Old");
  assert.equal(event.key, `peer:remote:${key}`);
  assert.equal(Object.hasOwn(event, "file"), false);
});
