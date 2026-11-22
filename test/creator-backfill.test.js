import "./isolate-hooks.js";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { serve } from "../src/server.js";
import { SessionStore } from "../src/session-store.js";

test("opening an existing unattributed session fills creator once without losing its work", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-creator-"));
  process.env.LAVISH_AXI_STATE_DIR = dir;
  const file = path.join(dir, "board.html");
  await writeFile(file, "<title>Board</title><p>Existing work</p>");
  const stateFile = path.join(dir, "state.json");
  const store = new SessionStore(stateFile);
  const legacy = await store.upsertSession(file, "http://localhost/session/legacy");
  await store.updateBoardTags(legacy.key, { add: ["pool"] });
  await store.queuePrompts(legacy.key, { prompts: [{ prompt: "Keep this conversation" }] });
  const before = await store.findByKey(legacy.key);
  const server = await serve({ port: 0, stateFile, version: "0.1.96" });
  const base = `http://127.0.0.1:${server.port}`;
  const open = async (creator) => {
    const response = await fetch(base + "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ file, ...(creator ? { creator } : {}) }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    assert.equal((await open()).creator, "", "no attribution is invented");
    assert.equal((await open("Alice")).creator, "Alice");
    assert.equal((await open("Bob")).creator, "Alice", "a non-empty creator is never overwritten");
    const after = await new SessionStore(stateFile).findByKey(legacy.key);
    for (const field of ["tags", "prompts", "chat", "pending_prompts", "status", "created_version"]) {
      assert.deepEqual(after[field], before[field], field);
    }
    const hub = await fetch(base + "/api/hub").then((r) => r.json());
    assert.equal(hub.boards[0].creator, "Alice");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("conditional creator metadata stays on the existing open session across close and path races", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-creator-conditional-"));
  process.env.LAVISH_AXI_STATE_DIR = dir;
  const file = path.join(dir, "board.html");
  const otherFile = path.join(dir, "outside.html");
  await writeFile(file, "<p>Board</p>");
  await writeFile(otherFile, "<p>Other board</p>");
  const stateFile = path.join(dir, "state.json");
  const store = new SessionStore(stateFile);
  const board = await store.upsertSession(file, "http://localhost/session/board");
  const other = await store.upsertSession(otherFile, "http://localhost/session/other");
  await store.updateBoardTags(board.key, { add: ["pool"] });
  await store.queuePrompts(board.key, { prompts: [{ prompt: "Keep this work" }] });
  const before = await store.findByKey(board.key);
  const server = await serve({ port: 0, stateFile, version: "0.1.96" });
  const base = `http://127.0.0.1:${server.port}`;
  /** @param {string} [key] @param {object} [body] @param {string} [origin] */
  const stamp = (key = board.key, body = { creator: "Alice", expected_file: file }, origin = base) =>
    fetch(`${base}/api/${key}/metadata`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await stamp(board.key, undefined, "https://foreign.invalid")).status, 403);
    assert.equal((await stamp(`peer:other:${board.key}`)).status, 400);
    assert.equal((await stamp("0000000000000000")).status, 404);
    assert.equal((await stamp(board.key, { creator: "Alice" })).status, 400);
    assert.equal((await stamp(board.key, { creator: "Alice", expected_file: otherFile })).status, 409);
    // Replace the path after the caller's eligibility read: never follow it to stamp another key.
    await unlink(file);
    await symlink(otherFile, file);
    assert.equal((await stamp()).status, 409);
    assert.deepEqual(await store.findByKey(board.key), before);
    assert.equal((await store.findByKey(other.key)).creator, "");
    await unlink(file);
    await writeFile(file, "<p>Board restored</p>");
    const success = await stamp();
    assert.equal(success.status, 200);
    assert.equal((await success.json()).creator, "Alice");
    const after = await store.findByKey(board.key);
    const beforeRest = { ...before };
    const afterRest = { ...after };
    for (const record of [beforeRest, afterRest]) {
      delete record.creator;
      delete record.updated_at;
    }
    assert.deepEqual(afterRest, beforeRest, "only attribution and updated_at change");
    assert.equal((await stamp(board.key, { creator: "Bob", expected_file: file })).status, 409);
    assert.equal((await store.findByKey(board.key)).creator, "Alice");
    for (const endedBy of ["agent", "user"]) {
      // A close between listing and PUT wins; this operation has no reopen path.
      await store.upsertSession(otherFile, "http://localhost/session/other");
      await store.endSession(other.key, endedBy);
      const closed = await store.findByKey(other.key);
      assert.equal((await stamp(other.key, { creator: "Alice", expected_file: otherFile })).status, 409);
      assert.deepEqual(await store.findByKey(other.key), closed);
    }
    // Queue the close under the same mutex ahead of the conditional fill.
    const racingFile = path.join(dir, "racing.html");
    await writeFile(racingFile, "<p>Race</p>");
    const racing = await store.upsertSession(racingFile, "http://localhost/session/race");
    const [closed, result] = await Promise.all([
      store.endSession(racing.key, "agent"),
      store.fillEmptyCreator(racing.key, { creator: "Alice", expected_file: racingFile }),
    ]);
    assert.equal(result.conflict, true);
    const persistedClosed = { ...closed };
    delete persistedClosed.end_changed;
    assert.deepEqual(await store.findByKey(racing.key), persistedClosed);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
