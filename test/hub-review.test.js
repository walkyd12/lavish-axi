import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { serve } from "../src/server.js";
import { createHubHtml } from "../src/hub.js";
import { hubArtifactSummary, hubArtifactRevision } from "../src/hub-summary.js";
import { createNotifyDestinations } from "../src/notify-destinations.js";
import { serializePeerBoard } from "../src/hub-peers.js";

test("notification test waits for hook completion and reports nonzero exit honestly", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "notify-completion-"));
  process.env.LAVISH_AXI_STATE_DIR = dir;
  const hook = path.join(dir, "notify.mjs");
  await writeFile(
    hook,
    '#!/usr/bin/env node\nconst event = JSON.parse(process.argv[2]); setTimeout(() => process.exit(event.send_to.endsWith("failure") ? 7 : 0), 100);\n',
  );
  await chmod(hook, 0o700);
  const server = await serve({
    port: 0,
    hosts: ["127.0.0.1"],
    stateFile: path.join(dir, "state.json"),
    hubPeers: "",
    env: { ...process.env, LAVISH_AXI_NOTIFY_PEOPLE: "Reviewer", LAVISH_AXI_ON_EVENT: hook },
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    for (const outcome of ["failure", "success"]) {
      const response = await fetch(base + "/api/hub/notifications/test", {
        method: "POST",
        headers: { origin: base, "content-type": "application/json" },
        body: JSON.stringify({ person: "Reviewer", send_to: "https://example.invalid/" + outcome }),
      });
      const body = await response.json();
      assert.equal(response.status, outcome === "failure" ? 503 : 200);
      assert.match(body.error || body.message, outcome === "failure" ? /exit.*7|failed/i : /hook completed/i);
      assert.doesNotMatch(body.error || body.message, /queued/i);
    }
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

test("hub revision labels come from the declared registry and ignore template and malformed registries", () => {
  const registry =
    '<script type="application/json" data-lavish-revisions>[{"id":"r1","label":"First review"},{"id":"r2","label":"Second review"}]</script>';
  assert.equal(hubArtifactRevision(registry), "Second review");
  assert.equal(hubArtifactRevision("<template>" + registry + "</template>"), "");
  assert.equal(hubArtifactRevision("<script data-lavish-revisions>invalid</script>"), "");
  assert.equal(hubArtifactRevision("<p>Unchanged board</p>"), "");
});

test("hub and peer cards keep declared revision labels when unchanged boards reload", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hub-revision-label-"));
  process.env.LAVISH_AXI_STATE_DIR = dir;
  const file = path.join(dir, "board.html");
  await writeFile(
    file,
    '<title>Review</title><script type="application/json" data-lavish-revisions>[{"id":"r2","label":"Second review"}]</script>',
  );
  const server = await serve({ port: 0, hosts: ["127.0.0.1"], stateFile: path.join(dir, "state.json"), hubPeers: "" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const response = await fetch(base + "/api/sessions", {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ file }),
    });
    const { key } = await response.json();
    for (let i = 0; i < 3; i++) {
      await fetch(base + "/session/" + key);
      const { boards } = await fetch(base + "/api/hub").then((r) => r.json());
      assert.equal(boards[0].revision_label, "Second review");
      assert.equal(serializePeerBoard({ name: "remote", origin: base }, boards[0]).revision_label, "Second review");
    }
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function clientHarness(board) {
  const elements = new Map();
  const listeners = new Map();
  function element() {
    const handlers = new Map();
    return {
      handlers,
      value: "",
      dataset: {},
      textContent: "",
      innerHTML: "",
      hidden: false,
      setAttribute() {},
      addEventListener(type, fn) {
        handlers.set(type, fn);
      },
      contains: () => false,
      matches: () => false,
      querySelectorAll: () => [],
      focus() {},
      select() {},
    };
  }
  const initial = { boards: [board], total: 1, notify_settings: {}, people: [], clients: [] };
  const document = {
    activeElement: null,
    visibilityState: "visible",
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      if (id === "hub-data") elements.get(id).textContent = JSON.stringify(initial);
      return elements.get(id);
    },
    addEventListener(type, fn) {
      const rows = listeners.get(type) || [];
      rows.push(fn);
      listeners.set(type, rows);
    },
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const requests = [];
  const context = vm.createContext({
    document,
    URL,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    location: { href: "http://localhost/", protocol: "http:", host: "localhost", hash: "" },
    window: { addEventListener() {}, dispatchEvent() {} },
    CustomEvent: class {},
    fetch: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        json: async () =>
          url === "/api/hub/notifications/test"
            ? { message: "Notification hook completed successfully." }
            : { client: "New" },
      };
    },
  });
  vm.runInContext(await readFile(new URL("../src/hub-client.js", import.meta.url), "utf8"), context);
  return {
    document,
    elements,
    requests,
    run: (code) => vm.runInContext(code, context),
    async emit(id, type, target) {
      await elements.get(id).handlers.get(type)?.({ target, preventDefault() {} });
    },
    async dispatch(type, target) {
      for (const fn of listeners.get(type) || []) await fn({ target, preventDefault() {} });
    },
    async edit() {
      await this.dispatch("click", {
        closest: (selector) =>
          selector.includes("data-client-edit")
            ? { dataset: { clientEdit: board.key }, hasAttribute: () => false }
            : null,
      });
    },
  };
}

test("client editing is cancelled on navigation and old cards disappear while loading", async () => {
  const h = await clientHarness({ key: "a", title: "Open board", url: "/session/a", status: "open" });
  await h.edit();
  h.run('showing = "closed"; beginFilterTransition()');
  assert.equal(h.run("editingClient"), "");
  assert.doesNotMatch(h.elements.get("boards").innerHTML, /Open board/);
  h.run('boards = [{key:"b",title:"Closed board",status:"ended"}]; filterPending = false; render()');
  assert.match(h.elements.get("boards").innerHTML, /Closed board/);
});

test("client save submits the peer origin captured before a background replacement", async () => {
  const h = await clientHarness({
    key: "peer:team:abc",
    title: "Peer board",
    source: "team",
    peer_origin: "https://original.example",
    status: "open",
  });
  await h.edit();
  h.run(
    'boards = [{key:"peer:team:abc",title:"Replacement",source:"team",peer_origin:"https://replacement.example"}]; clientDraft="New"',
  );
  await h.dispatch("submit", { matches: () => true, dataset: { clientKey: "peer:team:abc" } });
  const request = h.requests.find((r) => r.init?.method === "PUT");
  assert.equal(JSON.parse(request.init.body).peer_origin, "https://original.example");
});

for (const action of ["close", "cancel", "reopen"]) {
  test(`${action} uses the rendered card's peer origin after a background replacement`, async () => {
    const h = await clientHarness({
      key: "peer:team:abc",
      title: "Original board",
      source: "team",
      peer_origin: "https://original.example",
      status: action === "reopen" ? "ended" : "open",
    });
    await h.edit();
    h.run(`fetch = async (url, init) => {
      if (!init?.method) return {ok:true,json:async()=>({boards:[{key:"peer:team:abc",title:"Replacement",source:"team",peer_origin:"https://replacement.example"}]})};
      return {ok:false,status:409,json:async()=>({})};
    }`);
    await h.run("refresh()");
    assert.match(h.elements.get("boards").innerHTML, /Original board/);
    h.run(
      "globalThis.actionBodies = []; const previousFetch = fetch; fetch = async (url, init) => { if (init?.method) actionBodies.push(JSON.parse(init.body)); return previousFetch(url, init); }",
    );
    // Close and Cancel need two taps (the first only arms the button); Reopen acts on one.
    const button = {
      disabled: false,
      dataset: { act: action, key: "peer:team:abc" },
      textContent: action,
      classList: { add() {}, remove() {} },
    };
    const taps = action === "reopen" ? 1 : 2;
    for (let i = 0; i < taps; i += 1) await h.emit("boards", "click", { closest: () => button });
    assert.equal(h.run("actionBodies[0].peer_origin"), "https://original.example");
  });
}

test("explicit tab selection resets Include closed and keeps the search within the new tab", async () => {
  const h = await clientHarness({ key: "a", title: "Open board", status: "open" });
  h.elements.get("hubSearch").value = "spindle";
  h.elements.get("includeClosed").checked = true;
  await h.emit("tabCancelled", "click");
  const query = new URL(h.requests.at(-1).url, "http://localhost").searchParams;
  assert.equal(query.get("state"), "cancelled");
  assert.equal(query.get("q"), "spindle");
  assert.equal(h.elements.get("includeClosed").checked, false);
});

test("failed tab navigation stays empty with Retry and recovers within the selected tab", async () => {
  const h = await clientHarness({ key: "a", title: "Open board", status: "open" });
  h.run('showing = "closed"; beginFilterTransition(); fetch = async () => ({ok:false,status:503})');
  await h.run("refresh({resetLimit:true})");
  assert.doesNotMatch(h.elements.get("boards").innerHTML, /Open board|data-act=/);
  assert.equal(h.elements.get("hubLoadError").hidden, false);
  assert.equal(h.elements.get("hubEmpty").hidden, true);
  h.run(
    'fetch = async (url) => { globalThis.retryUrl = url; return {ok:true,json:async()=>({boards:[{key:"b",title:"Closed board",status:"ended"}]})}; }',
  );
  await h.emit("hubRetry", "click");
  assert.equal(new URL(h.run("retryUrl"), "http://localhost").searchParams.get("state"), "closed");
  assert.match(h.elements.get("boards").innerHTML, /Closed board/);
  assert.equal(h.elements.get("hubLoadError").hidden, true);
});

test("notification URL saves literally and Send test uses the focused visible field", async () => {
  const h = await clientHarness({ key: "a", status: "open" });
  const field = {
    value: "Legacy destination",
    dataset: { notifyPerson: "Reviewer", notifyField: "send_to" },
    matches: () => true,
  };
  const status = { setAttribute() {} };
  const result = { dataset: {}, hidden: true, textContent: "" };
  const row = {
    dataset: { notifyRow: "Reviewer" },
    querySelector: (selector) =>
      selector === "[data-notify-test-result]" ? result : selector.includes("input") ? field : status,
    querySelectorAll: () => [field],
  };
  field.closest = () => row;
  const rows = h.elements.get("notifyRows");
  rows.contains = () => true;
  rows.querySelectorAll = () => [row];
  h.run('notifySettings = {Reviewer:{tagged:false,done:false,send_to:"Legacy destination"}}');
  h.document.activeElement = field;
  field.value = "https://hooks.example/visible";
  await h.emit("notifyRows", "change", field);
  await h.run("notifySaveChain");
  const saved = h.requests.find((r) => r.url === "/api/hub/notifications" && r.init?.body);
  assert.equal(JSON.parse(saved.init.body).patch.send_to, field.value);
  const button = { dataset: { notifyTest: "Reviewer" }, closest: () => row };
  await h.emit("notifyRows", "click", { closest: () => button });
  const request = h.requests.find((r) => r.url === "/api/hub/notifications/test");
  assert.equal(JSON.parse(request.init.body).send_to, field.value);
  assert.match(result.textContent, /hook completed successfully/);
  assert.equal(result.hidden, false);
  h.run('fetch = async () => ({ok:false,json:async()=>({error:"Notification hook failed (exit 7)."})})');
  await h.emit("notifyRows", "click", { closest: () => button });
  assert.match(result.textContent, /exit 7/);
  assert.equal(result.dataset.tone, "error");
});

test("compact hub omits decoration and offers a plain theme", () => {
  const html = createHubHtml({ boards: [], hostname: "host", theme: "minimal" });
  assert.doesNotMatch(html, /Your boards\.|class="scape"/);
  assert.match(html, /Poppins/);
  assert.match(html, /data-lavish-theme="minimal"/);
});

test("notification destinations are server supplied and test notifications use the private hook path", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hub-review-"));
  process.env.LAVISH_AXI_STATE_DIR = dir;
  const provider = path.join(dir, "destinations");
  await writeFile(
    provider,
    '#!/usr/bin/env node\nconsole.log(JSON.stringify([{id:"dm",label:"Reviewer DM",kind:"chat",ready:true},{id:"offline",label:"Team channel",kind:"chat",ready:false}]))\n',
  );
  await chmod(provider, 0o700);
  const events = [];
  const server = await serve({
    port: 0,
    hosts: ["127.0.0.1"],
    stateFile: path.join(dir, "state.json"),
    hubPeers: "",
    env: { ...process.env, LAVISH_AXI_NOTIFY_DESTINATIONS: provider },
    onEvent: (e) => events.push(e),
  });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (route, body, origin = base) =>
    fetch(base + route, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const destinations = await fetch(base + "/api/hub/notification-destinations");
    assert.equal(destinations.status, 200);
    const data = await destinations.json();
    assert.deepEqual(
      data.destinations.map((d) => [d.id, d.ready]),
      [
        ["dm", true],
        ["offline", false],
      ],
    );
    await post("/api/hub/notifications", { add: "Reviewer" });
    const testRoute = "/api/hub/notifications/test";
    assert.equal((await post(testRoute, { person: "Reviewer", send_to: "dm" }, "https://foreign.example")).status, 403);
    assert.equal((await post(testRoute, { person: "Missing", send_to: "dm" })).status, 400);
    for (const send_to of ["dm", "https://hooks.example/secret?token=a", "legacy custom"]) {
      const response = await post(testRoute, { person: "Reviewer", send_to });
      assert.equal(response.status, 200);
      const event = events.at(-1);
      assert.equal(event.event, "notify_test");
      assert.equal(event.person, "Reviewer");
      assert.equal(event.send_to, send_to);
      assert.equal(event.notify_settings.Reviewer.send_to, send_to);
      assert.equal(event.seq, undefined, "test destination secrets never enter peer history");
    }
    const saved = await fetch(base + "/api/hub/notifications").then((r) => r.json());
    assert.equal(saved.notify_settings.Reviewer.send_to, "");
    assert.match(
      await fetch(base).then((r) => r.text()),
      /Pings go to the destination you pick\. Unchecked = no ping\./,
    );
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact cards use the headline and explicit next steps without script or style text", () => {
  assert.deepEqual(
    hubArtifactSummary(
      `<title>RE: Old subject &amp; followup</title><style>h1{color:red}</style><script>const template='<h1>Fake</h1>'</script><h1>Actual &amp; useful headline</h1><div>Reviewer’s next step</div><h2>Review the recommendation</h2>`,
    ),
    { title: "Actual & useful headline", nextStep: "Review the recommendation" },
  );
  assert.deepEqual(hubArtifactSummary(`<title>Fallback title</title><p data-lavish-next-step>Call the team</p>`), {
    title: "Fallback title",
    nextStep: "Call the team",
  });
});
test("destination provider failures fail open and valid results are bounded and cached", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hub-destinations-"));
  const file = path.join(dir, "provider");
  try {
    await writeFile(
      file,
      '#!/usr/bin/env node\nconsole.log(JSON.stringify([{id:"dm",label:"Private message",kind:"chat",ready:true,secret:"omitted"}]))',
    );
    await chmod(file, 0o700);
    const get = createNotifyDestinations(file);
    assert.deepEqual((await get()).destinations, [{ id: "dm", label: "Private message", kind: "chat", ready: true }]);
    await writeFile(file, '#!/usr/bin/env node\nconsole.log("bad JSON")');
    assert.equal((await get()).destinations.length, 1, "cached reads do not execute again");
    const failed = await createNotifyDestinations(file)();
    assert.deepEqual(failed.destinations, []);
    assert.ok(failed.error);
    await writeFile(file, "#!/usr/bin/env node\nsetTimeout(()=>{},10000)");
    const start = Date.now();
    assert.ok((await createNotifyDestinations(file)()).error);
    assert.ok(Date.now() - start < 5000, "provider is bounded by timeout");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Send test reports an unconnected hook and launches a configured executable exactly once", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hub-notify-hook-"));
  process.env.LAVISH_AXI_STATE_DIR = dir;
  const output = path.join(dir, "events.jsonl");
  const hook = path.join(dir, "hook");
  await writeFile(
    hook,
    `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(output)}, process.argv[2]+'\\n');\n`,
  );
  await chmod(hook, 0o700);
  const env = { ...process.env, LAVISH_AXI_ON_EVENT: "", LAVISH_AXI_ON_ACTION: "" };
  let server = await serve({
    port: 0,
    hosts: ["127.0.0.1"],
    stateFile: path.join(dir, "state.json"),
    hubPeers: "",
    env,
  });
  const post = (route, body) => {
    const base = `http://127.0.0.1:${server.port}`;
    return fetch(base + route, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  };
  try {
    await post("/api/hub/notifications", { add: "Reviewer" });
    assert.equal(
      (await post("/api/hub/notifications/test", { person: "Reviewer", send_to: "https://example.invalid/hook" }))
        .status,
      503,
    );
    await server.close();
    server = await serve({
      port: 0,
      hosts: ["127.0.0.1"],
      stateFile: path.join(dir, "state.json"),
      hubPeers: "",
      env: { ...env, LAVISH_AXI_ON_EVENT: hook },
    });
    assert.equal(
      (await post("/api/hub/notifications/test", { person: "Reviewer", send_to: "x".repeat(2049) })).status,
      400,
    );
    assert.equal(
      (await post("/api/hub/notifications/test", { person: "Reviewer", send_to: "https://example.invalid/hook" }))
        .status,
      200,
    );
    let rows = [];
    for (let i = 0; i < 100; i++) {
      try {
        rows = (await readFile(output, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        if (rows.length) break;
      } catch {
        /* detached hook has not written yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event, "notify_test");
    assert.equal(rows[0].notify_settings.Reviewer.send_to, "https://example.invalid/hook");
    assert.equal(rows[0].notify_settings.Reviewer.tagged, false, "tests work even when automatic pings are off");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
