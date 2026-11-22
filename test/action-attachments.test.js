import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { serve } from "../src/server.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("action attachments reach the detached event hook and poll through the chat resolver", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "action-attachments-"));
  const file = path.join(dir, "board.html");
  const hookLog = path.join(dir, "events.jsonl");
  const hook = path.join(dir, "hook.mjs");
  await writeFile(file, "<title>Attachment review</title>");
  await writeFile(
    hook,
    `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(hookLog)}, process.argv[2] + "\\n");\n`,
  );
  await chmod(hook, 0o755);
  const events = [];
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    env: { ...process.env, LAVISH_AXI_STATE_DIR: dir, LAVISH_AXI_HOST: "127.0.0.1", LAVISH_AXI_ON_EVENT: hook },
    onEvent: (event) => events.push(event),
  });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (route, body) =>
    fetch(base + route, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify(body),
    });
  try {
    const { key } = await (await post("/api/sessions", { file })).json();
    const uploaded = await fetch(`${base}/api/${key}/attachments`, {
      method: "POST",
      headers: { "content-type": "image/png", origin: base },
      body: png,
    }).then((r) => r.json());
    const attachment = { id: uploaded.attachment.id, name: "review.png", path: "/forged/path" };
    for (const prompt of ["Fix this row", ""]) {
      // An earlier chat turn may still be pending when the reviewer presses the action.
      const earlier = await post(`/api/${key}/prompts`, {
        prompts: [{ prompt: "Earlier chat instruction", tag: "message", prompt_id: `earlier-${prompt}` }],
      });
      assert.equal(earlier.status, 200);
      const response = await post(`/api/${key}/action`, { prompt, attachments: [attachment] });
      assert.equal(response.status, 200);
      const action = events.filter((e) => e.event === "board_action").at(-1);
      assert.equal(action.prompts.length, 1);
      assert.equal(action.prompts[0].prompt, prompt);
      const resolved = action.prompts[0].attachments?.[0];
      assert.equal(resolved?.id, attachment.id);
      assert.equal(resolved.name, attachment.name);
      assert.notEqual(resolved.path, attachment.path);
      assert.deepEqual(await readFile(resolved.path), png);
      const polled = await fetch(`${base}/api/poll?file=${encodeURIComponent(file)}&timeoutMs=100`).then((r) =>
        r.json(),
      );
      assert.equal(polled.prompts.length, 2);
      assert.equal(polled.prompts[0].prompt, "Earlier chat instruction");
      assert.deepEqual(polled.prompts[1].attachments[0], { ...resolved, type: "image" });
    }
    const count = events.filter((e) => e.event === "board_action").length;
    const rejected = await post(`/api/${key}/action`, {
      prompt: "Keep this draft",
      attachments: [{ id: "0".repeat(64) + ".png" }],
    });
    assert.equal(rejected.status, 400);
    assert.equal(events.filter((e) => e.event === "board_action").length, count);
    assert.equal((await rejected.json()).rejected[0].reason, "not-found");

    let hookEvents = [];
    for (let i = 0; i < 100; i++) {
      try {
        hookEvents = (await readFile(hookLog, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
      } catch {
        /* detached hook has not written yet */
      }
      if (hookEvents.filter((e) => e.event === "board_action").length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const actions = hookEvents.filter((e) => e.event === "board_action");
    assert.equal(actions.length, 2);
    assert.equal(actions[0].prompts[0].attachments[0].id, attachment.id);
    assert.equal(actions[1].prompts[0].attachments[0].name, attachment.name);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const outcome of ["success", "edited", "failure", "uploading", "error"]) {
  test(`workflow button uses composer attachment ids and preserves unsent chips: ${outcome}`, async () => {
    let click = async (_event) => {
      throw new Error("click handler not registered");
    };
    let resets = 0;
    const requests = [];
    const notice = { textContent: "", hidden: true };
    const chatInput = { value: "Review screenshot" };
    const root = {
      dataset: { boardMetadata: "abc", metadata: "{}" },
      querySelector: () => notice,
    };
    const button = {
      dataset: {},
      disabled: false,
      hasAttribute: (name) => name === "data-workflow-action",
      closest: () => root,
    };
    const controller = {
      hasPending: () => outcome === "uploading",
      hasErrors: () => outcome === "error",
      noteSendBlocked() {},
      collectReady: () => [{ id: "image-id.png", name: "review.png" }],
      reset(sent) {
        assert.deepEqual(JSON.parse(JSON.stringify(sent)), this.collectReady());
        resets++;
      },
    };
    const source = await readFile(new URL("../src/board-metadata-client.js", import.meta.url), "utf8");
    vm.runInNewContext(source, {
      document: {
        querySelectorAll: () => [],
        getElementById: () => chatInput,
        addEventListener(type, handler) {
          if (type === "click") click = handler;
        },
      },
      window: { lavishChatAttachments: controller, addEventListener() {} },
      fetch: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        if (outcome === "edited") chatInput.value = "Next message";
        return { ok: outcome === "success" || outcome === "edited", json: async () => ({ error: "Try again" }) };
      },
    });
    assert.ok(click);
    await click({ target: { closest: (selector) => (selector === "[data-board-metadata] button" ? button : null) } });
    if (outcome === "uploading" || outcome === "error") {
      assert.equal(requests.length, 0);
    } else {
      assert.deepEqual(requests[0].attachments, controller.collectReady());
    }
    assert.equal(resets, outcome === "success" || outcome === "edited" ? 1 : 0);
    assert.equal(
      chatInput.value,
      outcome === "success" ? "" : outcome === "edited" ? "Next message" : "Review screenshot",
    );
  });
}
