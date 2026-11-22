import "./isolate-hooks.js";
import assert from "node:assert/strict";
import { on, once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { serve } from "../src/server.js";

// Real isolated HTTP/store/WebSocket coverage; no default state directory or port.
test("notes append visible attributed chat without settling work or waking a poll", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-note-"));
  const stateFile = path.join(dir, "state.json");
  const artifact = path.join(dir, "board.html");
  await writeFile(artifact, "<!doctype html><title>Note test</title><h1>Before</h1>");
  const hooks = [];
  const server = await serve({
    env: { LAVISH_AXI_STATE_DIR: dir, LAVISH_AXI_HOST: "127.0.0.1" },
    host: "127.0.0.1",
    port: 0,
    stateFile,
    version: "test",
    onEvent: (event) => hooks.push(event),
  });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (url, body, origin = base) =>
    fetch(base + url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: JSON.stringify(body),
    });
  let socket;
  try {
    const { key } = await (await post("/api/sessions", { file: artifact, creator: "Reviewer" })).json();
    socket = new WebSocket(`ws://127.0.0.1:${server.port}/events/${key}`, { origin: base });
    const messages = on(socket, "message", { signal: AbortSignal.timeout(10000) });
    const nextEvent = async (type, predicate = (data) => data !== undefined) => {
      while (true) {
        const message = JSON.parse(String((await messages.next()).value[0]));
        if (message.type === type && predicate(message.data)) return message.data;
      }
    };
    await once(socket, "open");
    await nextEvent("agent-presence");
    await post(`/api/${key}/prompts`, { prompts: [{ prompt: "Existing work", tag: "message", prompt_id: "prior" }] });
    await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`).then((res) => res.json());
    await nextEvent("agent-presence", (data) => data.state === "working");
    await writeFile(artifact, "<!doctype html><title>Note test</title><h1>Working</h1>");
    await nextEvent("chat-sync", (data) => Boolean(data.chat[0]?.working_at));
    await post(`/api/${key}/prompts`, { prompts: [{ prompt: "Still queued", tag: "message", prompt_id: "pending" }] });
    const state = async () => JSON.parse(await readFile(stateFile, "utf8")).sessions[key];
    const before = await state();
    const body = {
      text: "Context [[source%2Fturn]] <script>bad()</script>",
      author: "External reviewer",
      source: "external-context",
    };
    for (const origin of ["http://foreign.example", ""]) {
      assert.equal((await post(`/api/${key}/note`, body, origin)).status, 403);
      assert.deepEqual(await state(), before);
    }
    assert.equal((await post("/api/0000000000000000/note", body)).status, 404);
    assert.equal((await post(`/api/${key}/note`, { text: " " })).status, 400);
    assert.equal((await post(`/api/${key}/note`, body)).status, 200);
    const sync = await nextEvent("chat-sync", (data) => data.chat.at(-1)?.source === body.source);
    assert.equal(sync.chat.at(-1).author, body.author);
    assert.equal(sync.chat.at(-1).text, body.text);
    assert.equal("html" in sync.chat.at(-1), false, "external note text is escaped by the user bubble renderer");
    const after = await state();
    assert.deepEqual(after.chat.slice(0, -1), before.chat, "Seen/Working/Done receipts unchanged");
    const restAfter = { ...after };
    const restBefore = { ...before };
    for (const field of ["chat", "updated_at", "chat_revision"]) {
      delete restAfter[field];
      delete restBefore[field];
    }
    assert.deepEqual(restAfter, restBefore, "pending/delivered feedback, tags and lifecycle unchanged");
    assert.equal(after.chat_revision, before.chat_revision + 1);
    // A new viewer still sees the delivered-feedback Working presence.
    const viewer = new WebSocket(`ws://127.0.0.1:${server.port}/events/${key}`, { origin: base });
    const initial = on(viewer, "message", { signal: AbortSignal.timeout(5000) });
    try {
      await once(viewer, "open");
      await initial.next();
      assert.equal(JSON.parse(String((await initial.next()).value[0])).data.state, "working");
    } finally {
      await initial.return();
      viewer.close();
    }
    // Drain the real queued prompt, then prove an active poll never receives the note.
    const pending = await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`).then((res) =>
      res.json(),
    );
    assert.deepEqual(
      pending.prompts.map((p) => p.prompt),
      ["Still queued"],
    );
    const poll = fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=300`).then((res) => res.json());
    await nextEvent("agent-presence", (data) => data.state === "listening");
    assert.equal((await post(`/api/${key}/note`, body)).status, 200);
    assert.equal((await poll).status, "waiting");
    const chat = await fetch(`${base}/api/${key}/conversation`).then((res) => res.json());
    assert.equal(chat.chat.at(-1).source, body.source);
    assert.ok(hooks.every((event) => ["board_created", "message", "note"].includes(event.event)));
    assert.equal(
      hooks.filter((event) => event.event === "message").length,
      2,
      "only actual prompts emit message hooks",
    );
    await post(`/api/hub/${key}/close`, {});
    const ended = await state();
    assert.equal((await post(`/api/${key}/note`, body)).status, 409);
    assert.deepEqual(await state(), ended, "notes never reopen closed boards");
    await messages.return();
  } finally {
    socket?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
