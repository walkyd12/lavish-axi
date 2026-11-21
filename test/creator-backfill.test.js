import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
