import "./isolate-hooks.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { serve } from "../src/server.js";
import { readHubArtifact } from "../src/hub-summary.js";

const KiB = 1024;

test("hub cards and search bound artifact reads while preserving head and tail revisions", async (t) => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "hub-bounded-reads-"));
  const file = path.join(dir, "board.html");
  const registry = '<script data-lavish-revisions>[{"id":"r2","label":"Second review"}]</script>';
  const head = "<title>Bounded board</title><h1>Bounded board</h1><p data-lavish-next-step>Review this</p>";
  await fs.writeFile(
    file,
    head + " ".repeat(80 * KiB) + "<p>searchable evidence</p>" + " ".repeat(4 * 1024 * KiB) + registry,
  );
  const reads = [];
  const originalReadFile = fs.readFile;
  const originalOpen = fs.open;
  t.mock.method(fs, "readFile", async (target, ...args) => {
    assert.notEqual(target, file, "hub must not read the whole artifact");
    return originalReadFile(target, ...args);
  });
  t.mock.method(fs, "open", async (target, ...args) => {
    const handle = await originalOpen(target, ...args);
    if (target === file) {
      const originalRead = handle.read.bind(handle);
      t.mock.method(handle, "read", async (buffer, offset, length, position) => {
        reads.push({ length, position });
        return originalRead(buffer, offset, length, position);
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  let server;
  try {
    server = await serve({
      port: 0,
      hosts: ["127.0.0.1"],
      stateFile: path.join(dir, "state.json"),
      hubPeers: "",
      env: { ...process.env, LAVISH_AXI_STATE_DIR: dir, LAVISH_AXI_HOST: "127.0.0.1" },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const created = await fetch(base + "/api/sessions", {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ file }),
    });
    assert.equal(created.status, 200);
    const cards = await fetch(base + "/api/hub").then((r) => r.json());
    assert.equal(cards.boards[0].title, "Bounded board");
    assert.equal(cards.boards[0].next_step, "Review this");
    assert.equal(cards.boards[0].revision_label, "Second review");
    assert.ok(reads.length > 0);
    assert.ok(reads.every((read) => read.length <= 64 * KiB));
    assert.ok(reads.reduce((sum, read) => sum + read.length, 0) <= 128 * KiB);
    reads.length = 0;
    await fetch(base + "/api/hub");
    assert.equal(reads.length, 0, "unchanged cards use the file-stamp cache");
    const results = await fetch(base + "/api/hub?q=searchable").then((r) => r.json());
    assert.equal(results.boards.length, 1);
    assert.equal(results.boards[0].revision_label, "Second review");
    assert.ok(reads.reduce((sum, read) => sum + read.length, 0) <= 1088 * KiB);
    assert.ok(reads.every((read) => read.length <= 1024 * KiB));
    // A registry hidden in the unread middle must not trigger a whole-file fallback.
    await fs.writeFile(file, head + " ".repeat(80 * KiB) + registry + " ".repeat(4 * 1024 * KiB));
    const middle = await fetch(base + "/api/hub").then((r) => r.json());
    assert.equal(middle.boards[0].revision_label || "", "");
    await fs.writeFile(file, head + registry + " ".repeat(4 * 1024 * KiB));
    const first = await fetch(base + "/api/hub").then((r) => r.json());
    assert.equal(first.boards[0].revision_label, "Second review");
  } finally {
    await server?.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("bounded revision windows support small boards and contiguous boundary registries", async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "hub-revision-windows-"));
  const file = path.join(dir, "board.html");
  const registry = '<script data-lavish-revisions>[{"id":"r1","label":"First review"}]</script>';
  try {
    for (const html of [registry, " ".repeat(64 * KiB - 20) + registry, " ".repeat(70 * KiB) + registry]) {
      await fs.writeFile(file, html);
      for (const includeSearchText of [false, true]) {
        assert.equal((await readHubArtifact(file, { includeSearchText })).revisionLabel, "First review");
      }
    }
    // The tail overlaps the search head but ends beyond it: reuse must not truncate it.
    await fs.writeFile(file, " ".repeat(1024 * KiB - 20) + registry);
    assert.equal((await readHubArtifact(file, { includeSearchText: true })).revisionLabel, "First review");
    // Disjoint fragments cannot be joined into a seemingly valid registry.
    await fs.writeFile(
      file,
      '<script data-lavish-revisions>[{"id":"r1","label":"Fake' + " ".repeat(256 * KiB) + '"}]</script>',
    );
    assert.equal((await readHubArtifact(file)).revisionLabel, "");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
