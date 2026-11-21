import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { serve } from "../src/server.js";
import { createHubHtml } from "../src/hub.js";
import { hubArtifactSummary } from "../src/hub-summary.js";
import { createNotifyDestinations } from "../src/notify-destinations.js";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

async function clientHarness(board) {
  const elements = new Map();
  const listeners = new Map();
  function element() {
    return {
      value: "",
      dataset: {},
      textContent: "",
      innerHTML: "",
      hidden: false,
      setAttribute() {},
      addEventListener() {},
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
      return { ok: true, json: async () => ({ client: "New" }) };
    },
  });
  vm.runInContext(await readFile(new URL("../src/hub-client.js", import.meta.url), "utf8"), context);
  return {
    elements,
    requests,
    run: (code) => vm.runInContext(code, context),
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
      assert.equal(response.status, 202);
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
      (await post("/api/hub/notifications/test", { person: "Reviewer", send_to: "x".repeat(257) })).status,
      400,
    );
    assert.equal(
      (await post("/api/hub/notifications/test", { person: "Reviewer", send_to: "https://example.invalid/hook" }))
        .status,
      202,
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
