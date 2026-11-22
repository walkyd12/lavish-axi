import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createChromeHtml } from "../src/server.js";

const hub = await readFile(new URL("../src/hub-client.js", import.meta.url), "utf8");
function hubFunctions() {
  const start = hub.indexOf("function isClosed(");
  const end = hub.indexOf("function renderFilters(");
  const context = vm.createContext({
    busy: new Set(),
    serverPeople: ["Reviewer"],
    notifySettings: {},
    viewer: [],
    editingClient: "",
    location: { href: "http://localhost/" },
    URL,
    escapeHtml: (value) => String(value || ""),
    freshnessBadge: () => "",
  });
  vm.runInContext(hub.slice(start, end), context);
  return context;
}

test("hub uses the board workflow vocabulary and keeps status separate from listener presence", () => {
  const ui = hubFunctions();
  assert.equal(ui.displayBadge({ tags: [], state: "nobody", board_state_label: "Working" }).label, "Working");
  assert.equal(ui.displayBadge({ tags: ["needs-input"], board_state_label: "Needs input" }).label, "Needs input");
});

test("missing files in Closed offer Reopen only and plainly explain availability", () => {
  const ui = hubFunctions();
  for (const source of [undefined, "remote"]) {
    const html = ui.boardHtml({ key: "abc", title: "Board", state: "file-gone", status: "open", source });
    assert.doesNotMatch(html, /data-act="(?:close|cancel)"/);
    assert.match(html, /data-act="reopen"/);
    assert.match(html, /file is unavailable/i);
  }
});

test("card tags precede Details and only declared revisions distinguish matching titles", () => {
  const ui = hubFunctions();
  const board = { key: "abc", title: "Board", created_at: "2026-11-21T10:30:00Z", artifact_revision: 3 };
  assert.doesNotMatch(ui.boardHtml(board), /Revision 3/);
  const html = ui.boardHtml({ ...board, revision_label: "Review round 2" });
  assert.ok(html.indexOf("data-board-metadata") < html.indexOf('class="board-details"'));
  assert.match(html, /Created/);
  assert.match(html, /Review round 2/);
  assert.match(html, /No client/);
});

test("closed and cancelled peer cards offer only Reopen even with an available file", () => {
  const ui = hubFunctions();
  for (const cancelled of [false, true]) {
    const html = ui.peerActionsHtml({
      key: "peer:remote:abc",
      source: "remote",
      status: "ended",
      cancelled,
      url: "http://localhost/session/abc",
    });
    assert.match(html, />Reopen</);
    assert.doesNotMatch(html, /<a|data-act="(?:close|cancel)"/);
  }
});

test("notification settings show the exact destination with no internal label picker", () => {
  const context = vm.createContext({
    notifySettings: { Reviewer: {} },
    notifyDestinations: [{ id: "route-id", label: "Reviewer's bot", ready: true }],
    escapeHtml: (value) => String(value),
  });
  vm.runInContext(
    hub.slice(hub.indexOf("function displaySendTo("), hub.indexOf("function renderNotificationsPanel(")),
    context,
  );
  const html = context.notifyRowHtml("Reviewer", { send_to: "https://discord.com/channels/team/channel" });
  assert.match(html, /value="https:\/\/discord.com\/channels\/team\/channel"/);
  assert.match(html, /Paste a Discord webhook or channel link/);
  assert.doesNotMatch(html, /data-notify-pick|Reviewer's bot/);
});

test("board tag entry point is outside the conversation sheet, beside its title", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/board.html" }, { title: "Review board" });
  assert.ok(html.indexOf("data-board-metadata") < html.indexOf('class="layout"'));
  assert.match(html, /id="boardTitle">Review board/);
  assert.match(html, /Message agent/);
  assert.match(html, /Message &amp; end session/);
  assert.match(html, /href="\/">Back to hub</);
  assert.doesNotMatch(html, /Fusion Hub/);
});

test("shared editor distinguishes applied tags and people and preserves disclosure after saving", async () => {
  const source = await readFile(new URL("../src/board-metadata-client.js", import.meta.url), "utf8");
  const listeners = {};
  const editor = { open: false };
  const notice = { textContent: "", hidden: true };
  const root = {
    dataset: { boardMetadata: "abc", metadata: '{"tags":[]}', people: '["Reviewer"]' },
    innerHTML: "",
    contains: () => false,
    querySelector: (selector) =>
      selector === ".metadata-notice" ? notice : selector === ".tag-editor" ? editor : null,
  };
  const context = vm.createContext({
    document: {
      querySelectorAll: () => [root],
      addEventListener: (name, fn) => {
        listeners[name] = fn;
      },
    },
    window: { addEventListener: () => {}, dispatchEvent: () => {} },
    CustomEvent: class {},
    fetch: async () => ({ ok: true, json: async () => ({ tags: ["Reviewer"] }) }),
  });
  vm.runInContext(source, context);
  assert.match(root.innerHTML, /Edit tags/);
  assert.match(root.innerHTML, /Tags on this board/);
  assert.match(root.innerHTML, /No tags yet/);
  assert.match(root.innerHTML, /Add a person/);
  assert.match(root.innerHTML, /\+ Reviewer/);
  editor.open = true;
  const button = { closest: () => root, dataset: { person: "Reviewer" }, hasAttribute: () => false };
  await listeners.click({
    target: { closest: (selector) => (selector === "[data-board-metadata] button" ? button : null) },
  });
  assert.equal(editor.open, true);
  assert.match(root.innerHTML, /class="tag-editor" open/);
  assert.match(root.innerHTML, /Added/);
  assert.match(root.innerHTML, /✓ Reviewer/);
});

test("shared board End session delegates to chrome and rerenders retain terminal reservation state", async () => {
  const source = await readFile(new URL("../src/board-metadata-client.js", import.meta.url), "utf8");
  const listeners = {};
  const events = [];
  const button = { disabled: false, dataset: {}, hasAttribute: (name) => name === "data-lifecycle-close" };
  const lifecycle = { dataset: { endDisabled: "true" }, innerHTML: "", querySelectorAll: () => [button] };
  const root = {
    dataset: { boardMetadata: "abc", chrome: "true", metadata: '{"tags":[]}' },
    innerHTML: "",
    querySelector: () => null,
  };
  const context = vm.createContext({
    document: {
      querySelectorAll: () => [root],
      querySelector: () => root,
      getElementById: () => lifecycle,
      addEventListener: (name, fn) => {
        listeners[name] = fn;
      },
    },
    window: { addEventListener() {}, dispatchEvent: (event) => events.push(event.type) },
    CustomEvent: class {
      constructor(type) {
        this.type = type;
      }
    },
    fetch: () => {
      throw new Error("End session must use the chrome's guarded operation");
    },
  });
  vm.runInContext(source, context);
  assert.equal(button.disabled, true);
  context.window.lavishBoardMetadata.update({ key: "abc", tags: ["review"] });
  assert.equal(button.disabled, true);
  button.disabled = false;
  await listeners.click({ target: { closest: (selector) => (selector === "[data-reactivate]" ? null : button) } });
  assert.deepEqual(events, ["lavish:end-session-request"]);
});

test("creation time survives opening and reopening and remains distinct from last viewed time", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { SessionStore } = await import("../src/session-store.js");
  const { serializeHubBoard } = await import("../src/hub.js");
  const dir = await mkdtemp(path.join(tmpdir(), "hub-created-"));
  try {
    const file = path.join(dir, "board.html");
    await writeFile(file, "<title>Same title</title>");
    const store = new SessionStore(path.join(dir, "state.json"));
    const first = await store.upsertSession(file, "http://localhost/session/test");
    assert.ok(Number.isFinite(Date.parse(first.created_at)));
    await store.markBoardOpened(first.key);
    const reopened = await store.upsertSession(file, first.url);
    assert.equal(reopened.created_at, first.created_at);
    assert.equal(serializeHubBoard(reopened).created_at, first.created_at);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
