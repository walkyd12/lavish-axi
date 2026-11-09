import assert from "node:assert/strict";
import test from "node:test";

import {
  boardTitle,
  conversationMarkdown,
  createHubHtml,
  hostMark,
  hubBoardState,
  serializeHubBoard,
  sortHubBoards,
} from "../src/hub.js";

const NOW = Date.parse("2026-11-09T21:00:00.000Z");
const open = (extra = {}) => ({ key: "k1", file: "/boards/plan.html", status: "open", chat: [], ...extra });

test("each board gets one state from facts the server holds, most urgent first", () => {
  assert.equal(hubBoardState(open(), { listener: "agent-listener" }).state, "taking-input");
  assert.equal(hubBoardState(open({ pending_prompts: 2 })).state, "unread");
  assert.equal(hubBoardState(open()).state, "nobody");
  assert.equal(hubBoardState(open({ status: "ended", ended_by: "user" })).label, "Closed by you");
  assert.equal(hubBoardState(open({ status: "ended", ended_by: "agent" })).label, "Closed by agent");
  assert.equal(hubBoardState(open({ status: "ended" }), { fileExists: false }).state, "file-gone");
  assert.equal(hubBoardState(open({ pending_prompts: 1 }), { fileExists: false }).state, "file-gone");
});

test("an owner's report decides whether someone is there, until it lapses", () => {
  const owner = (state, extra = {}) => ({ state, label: "task 42", updated_at: "2026-11-09T20:59:00.000Z", ...extra });
  assert.deepEqual(hubBoardState(open({ owner_status: owner("live") }), { now: NOW }), {
    state: "taking-input",
    label: "Taking input",
    tone: "good",
  });
  assert.equal(hubBoardState(open({ owner_status: owner("working") }), { now: NOW }).label, "Working");
  assert.equal(hubBoardState(open({ owner_status: owner("finished") }), { now: NOW }).state, "handed-off");
  assert.equal(hubBoardState(open({ owner_status: owner("gone") }), { now: NOW }).state, "nobody");
  // Unread notes outrank a finished owner: someone still has to read them.
  assert.equal(
    hubBoardState(open({ pending_prompts: 1, owner_status: owner("finished") }), { now: NOW }).state,
    "unread",
  );
  const lapsed = owner("live", { expires_at: "2026-11-09T20:59:30.000Z" });
  assert.equal(hubBoardState(open({ owner_status: lapsed }), { now: NOW }).state, "nobody");
});

test("a board row counts notes, replies, unread, unsent drafts and tabs", () => {
  const board = serializeHubBoard(
    open({
      pending_prompts: 1,
      updated_at: "2026-11-09T10:00:00.000Z",
      chat: [
        { role: "user", text: "a", at: "2026-11-09T11:00:00.000Z" },
        { role: "agent", text: "b", at: "2026-11-09T12:00:00.000Z" },
        { role: "user", text: "c", at: "2026-11-09T13:00:00.000Z" },
      ],
      drafts: {
        tabA: { queue: [{ prompt_id: "d1" }, { prompt_id: "d2" }] },
        tabB: { queue: [{ prompt_id: "d2" }] },
      },
    }),
    { tabs: 2, title: "The plan", now: NOW },
  );
  assert.equal(board.title, "The plan");
  assert.equal(board.url, "/session/k1");
  assert.equal(board.notes, 2);
  assert.equal(board.replies, 1);
  assert.equal(board.pending_prompts, 1);
  assert.equal(board.unsent_drafts, 2, "a draft two tabs both hold counts once");
  assert.equal(board.tabs, 2);
  assert.equal(board.last_activity, "2026-11-09T13:00:00.000Z");
  assert.equal(board.state, "unread");
  assert.equal(boardTitle({ file: "/x/week-13.html" }), "week-13", "untitled boards fall back to the file name");
});

test("open boards sort ahead of closed ones, by urgency, then recency", () => {
  const sorted = sortHubBoards([
    { key: "closed", status: "ended", state: "closed-user", last_activity: "2026-11-09T20:00:00.000Z" },
    { key: "nobody-old", status: "open", state: "nobody", last_activity: "2026-11-01T00:00:00.000Z" },
    { key: "gone", status: "open", state: "file-gone", last_activity: "2026-11-09T20:00:00.000Z" },
    { key: "nobody-new", status: "open", state: "nobody", last_activity: "2026-11-08T00:00:00.000Z" },
    { key: "live", status: "open", state: "taking-input", last_activity: "2026-11-02T00:00:00.000Z" },
    { key: "unread", status: "open", state: "unread", last_activity: "2026-11-03T00:00:00.000Z" },
  ]);
  assert.deepEqual(
    sorted.map((board) => board.key),
    ["live", "unread", "nobody-new", "nobody-old", "gone", "closed"],
  );
});

test("the host mark is the short host name plus a period, its first three letters accented", () => {
  assert.deepEqual(hostMark("schlab"), { accent: "sch", rest: "lab." });
  assert.deepEqual(hostMark("schip.minskin-godzilla.ts.net"), { accent: "sch", rest: "ip." });
  assert.deepEqual(hostMark(""), { accent: "lav", rest: "ish." });
});

test("the conversation exports as Markdown with user words quoted, never interpreted", () => {
  const markdown = conversationMarkdown(
    open({
      status: "ended",
      ended_by: "user",
      updated_at: "2026-11-09T21:00:00.000Z",
      chat: [
        {
          role: "user",
          kind: "annotation",
          text: "# not a heading\nsecond line",
          at: "2026-11-09T20:00:00.000Z",
          anchor: { kind: "element", label: "h1", excerpt: "Plan" },
          delivered_at: "2026-11-09T20:01:00.000Z",
        },
        { role: "agent", text: "Renamed it.", at: "2026-11-09T20:05:00.000Z" },
      ],
    }),
    { title: "The plan" },
  );
  assert.match(markdown, /^# The plan\n/);
  assert.match(markdown, /- Status: ended by the reviewer/);
  assert.match(markdown, /\*\*Reviewer\*\* · 2026-11-09T20:00:00.000Z · on h1 "Plan" · seen/);
  assert.match(markdown, /> # not a heading\n> second line/);
  assert.match(markdown, /\*\*Agent\*\* · 2026-11-09T20:05:00.000Z\n\nRenamed it\./);
  assert.match(conversationMarkdown(open()), /_No messages\._/);
});

test("the hub page escapes board data into its bootstrap", () => {
  const html = createHubHtml({
    boards: [{ key: "k1", title: "</script><script>alert(1)</script>" }],
    hostname: "schlab",
  });
  assert.doesNotMatch(html, /<\/script><script>alert/);
  assert.match(html, /<span class="mk-accent">sch<\/span><span class="mk-rest">lab\.<\/span>/);
  assert.match(html, /<script src="\/hub-client\.js"><\/script>/);
});
