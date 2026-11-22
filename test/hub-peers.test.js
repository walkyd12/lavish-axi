import "./isolate-hooks.js";
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  createPeerBoardSource,
  fetchPeerBoards,
  isPeerKey,
  parseHubPeers,
  serializePeerBoard,
} from "../src/hub-peers.js";

const walkmate = { name: "walkmate", origin: "http://peer.example:4388" };

test("peers parse from comma-separated name=url pairs; unset means none", () => {
  assert.deepEqual(parseHubPeers(undefined), { peers: [], errors: [] });
  assert.deepEqual(parseHubPeers(""), { peers: [], errors: [] });
  assert.deepEqual(parseHubPeers(" walkmate=http://schlab.example.ts.net:4388 , other=https://boards.example.com/ "), {
    peers: [
      { name: "walkmate", origin: "http://schlab.example.ts.net:4388" },
      { name: "other", origin: "https://boards.example.com" },
    ],
    errors: [],
  });
});

test("bad peer entries are reported and dropped, never fatal", () => {
  const { peers, errors } = parseHubPeers(
    [
      "ok=http://a.example:1",
      "nourl",
      "=http://b.example",
      "bad name=http://c.example",
      "ftp=ftp://d.example",
      "creds=http://user:pw@e.example",
      "path=http://f.example/hub",
      "query=http://g.example/?x=1",
      "broken=not a url",
      "OK=http://dup.example",
    ].join(","),
  );
  assert.deepEqual(peers, [{ name: "ok", origin: "http://a.example:1" }]);
  assert.equal(errors.length, 9);
  assert.ok(errors.some((error) => /credentials/.test(error)));
  assert.ok(errors.some((error) => /http or https/.test(error)));
  assert.ok(errors.some((error) => /listed twice/.test(error)));
  assert.ok(
    errors.every((error) => !error.includes("pw@")),
    "an error never echoes a credential back into the log",
  );
});

test("a peer board is namespaced, links to the peer, and carries no file path", () => {
  const board = serializePeerBoard(walkmate, {
    key: "abc123",
    file: "/home/walkmate/secret/board.html",
    title: "Plan <b>",
    url: "https://evil.example/phish",
    status: "open",
    state: "taking-input",
    state_label: "Taking input",
    tone: "good",
    notes: 2,
    replies: "3",
    pending_prompts: -4,
    last_activity: "2026-11-17T10:00:00.000Z",
    owner: { state: "live", label: "task\u0007 7", stale: false },
  });
  assert.equal(board?.key, "peer:walkmate:abc123");
  assert.equal(board?.peer_key, "abc123");
  assert.equal(board?.source, "walkmate");
  assert.equal(board?.file, "");
  assert.equal(
    board?.url,
    "http://peer.example:4388/session/abc123",
    "the link is built here, never taken from the peer",
  );
  assert.equal(board?.title, "Plan <b>", "the string is kept as text; the client escapes it");
  assert.equal(board?.replies, 3);
  assert.equal(board?.pending_prompts, 0);
  assert.equal(board?.owner?.label, "task  7");
  assert.equal(isPeerKey(board?.key || ""), true);
  assert.equal(isPeerKey("abc123"), false);
});

test("a peer board with an unsafe key or unknown fields is dropped or normalized", () => {
  assert.equal(serializePeerBoard(walkmate, { key: "../../x" }), null);
  assert.equal(serializePeerBoard(walkmate, { key: "peer:other:abc" }), null, "a peer's own peers are not relayed");
  assert.equal(serializePeerBoard(walkmate, null), null);
  const odd = serializePeerBoard(walkmate, {
    key: "k",
    state: "<script>",
    tone: "x onmouseover=1",
    last_activity: "soon",
  });
  assert.equal(odd?.state, "nobody");
  assert.equal(odd?.tone, "muted");
  assert.equal(odd?.last_activity, "");
});

/** @param {(req: http.IncomingMessage, res: http.ServerResponse) => void} handler */
async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  try {
    return await run({ name: "peer", origin: `http://127.0.0.1:${address.port}` });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

test("fetching a peer asks for its own boards only and forwards nothing from the viewer", async () => {
  /** @type {http.IncomingHttpHeaders} */
  let seenHeaders = {};
  let seenUrl = "";
  await withServer(
    (req, res) => {
      seenHeaders = req.headers;
      seenUrl = req.url || "";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ boards: [{ key: "k1", title: "One", status: "open" }, { key: "bad key" }] }));
    },
    async (peer) => {
      const result = await fetchPeerBoards(peer);
      assert.equal(result.ok, true);
      assert.deepEqual(
        result.boards.map((board) => board.key),
        ["peer:peer:k1"],
      );
    },
  );
  assert.equal(seenUrl, "/api/hub?peers=0");
  assert.equal(seenHeaders.cookie, undefined);
  assert.equal(seenHeaders.authorization, undefined);
});

test("a slow peer times out quickly and is then skipped without a request", async () => {
  let requests = 0;
  await withServer(
    () => {
      requests += 1; // never answers
    },
    async (peer) => {
      let clock = 1000;
      const collect = createPeerBoardSource([peer], { timeoutMs: 150, retryAfterMs: 30_000, now: () => clock });
      const started = Date.now();
      const first = await collect();
      assert.ok(Date.now() - started < 1500, "the hub waits only the short timeout");
      assert.deepEqual(first.boards, []);
      assert.deepEqual(first.peers, [{ name: "peer", url: peer.origin, ok: false, error: "timed out" }]);
      const second = await collect();
      assert.equal(second.peers[0].ok, false);
      assert.equal(requests, 1, "a peer that just failed is not asked again during its back-off");
      clock += 31_000;
      await collect();
      assert.equal(requests, 2, "after the back-off it is tried again");
    },
  );
});

test("a peer that answers badly is skipped and the others still show", async () => {
  const answers = [
    (res) => res.writeHead(500).end("{}"),
    (res) => res.end("not json"),
    (res) => res.end(JSON.stringify({ nope: true })),
    (res) => res.writeHead(302, { location: "http://127.0.0.1:1/" }).end(),
    (res) => res.end(JSON.stringify({ boards: [{ key: "x".repeat(10), title: "pad".repeat(1000) }] })),
  ];
  for (const [index, answer] of answers.entries()) {
    await withServer(
      (_req, res) => answer(res),
      async (peer) => {
        const result = await fetchPeerBoards(peer, { timeoutMs: 1000, maxBytes: 2048 });
        assert.equal(result.ok, false, `answer ${index} is refused`);
        assert.deepEqual(result.boards, []);
      },
    );
  }
  const collect = createPeerBoardSource(
    [
      { name: "down", origin: "http://127.0.0.1:9" },
      { name: "up", origin: "http://up.example" },
    ],
    {
      fetchImpl: async (url) => {
        if (String(url).startsWith("http://127.0.0.1:9")) throw new TypeError("fetch failed");
        return new Response(JSON.stringify({ boards: [{ key: "k", title: "Up board" }] }));
      },
    },
  );
  const view = await collect();
  assert.deepEqual(
    view.boards.map((board) => [board.source, board.title]),
    [["up", "Up board"]],
  );
  assert.deepEqual(
    view.peers.map((peer) => [peer.name, peer.ok]),
    [
      ["down", false],
      ["up", true],
    ],
  );
});
