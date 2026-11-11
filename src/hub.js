// The Lavish hub: the server's front page lists every board it knows, with a state computed
// from facts the server already holds, and lets the reviewer open, reopen and close boards and
// read a board's conversation. These are pure functions over stored sessions plus the live facts
// the server passes in, so the state rules are unit-testable without a server.

import { serializeOwnerStatus } from "./owner-status.js";
import { hostThemeMarkup } from "./host-theme.js";

/**
 * @typedef {{ listener?: string | null, tabs?: number, fileExists?: boolean, title?: string, now?: number }} HubFacts
 */

// One state per board, most urgent first. Each is something the reviewer can act on:
//   taking-input  someone is there: a poll listener, or an owner reporting live/working
//   unread        notes were sent and nobody has picked them up
//   nobody        open, nobody listening (or the owner says it is gone or has gone quiet)
//   handed-off    the owner says it finished and handed the board on
//   closed-user / closed-agent   ended, by the reviewer or by an agent
//   file-gone     the board's file no longer exists
/**
 * @param {any} session
 * @param {HubFacts} facts
 */
export function hubBoardState(session, facts = {}) {
  const ended = session?.status === "ended";
  if (facts.fileExists === false) return { state: "file-gone", label: "File gone", tone: "bad" };
  if (ended) {
    return session.ended_by === "user"
      ? { state: "closed-user", label: "Closed by you", tone: "muted" }
      : { state: "closed-agent", label: "Closed by agent", tone: "muted" };
  }
  const owner = serializeOwnerStatus(session?.owner_status, { now: facts.now });
  const pending = Number(session?.pending_prompts) || 0;
  if (owner && !owner.stale && owner.state === "working")
    return { state: "taking-input", label: "Working", tone: "good" };
  if ((owner && !owner.stale && owner.state === "live") || facts.listener) {
    return { state: "taking-input", label: "Taking input", tone: "good" };
  }
  if (pending > 0) return { state: "unread", label: "Unread notes", tone: "warn" };
  if (owner && !owner.stale && owner.state === "finished") {
    return { state: "handed-off", label: "Handed off", tone: "muted" };
  }
  return { state: "nobody", label: "Nobody listening", tone: "warn" };
}

function countDraftNotes(session) {
  const ids = new Set();
  const drafts = session?.drafts && typeof session.drafts === "object" ? session.drafts : {};
  for (const record of Object.values(drafts)) {
    for (const prompt of Array.isArray(record?.queue) ? record.queue : []) {
      if (prompt && typeof prompt.prompt_id === "string") ids.add(prompt.prompt_id);
    }
  }
  return ids.size;
}

function lastActivity(session) {
  let latest = Date.parse(session?.updated_at || "") || 0;
  for (const entry of Array.isArray(session?.chat) ? session.chat : []) {
    const at = Date.parse(entry?.at || "");
    if (Number.isFinite(at) && at > latest) latest = at;
  }
  return latest ? new Date(latest).toISOString() : "";
}

export function boardTitle(session, title = "") {
  const clean = String(title || "").trim();
  if (clean) return clean;
  const base =
    String(session?.file || "")
      .split("/")
      .pop() || "Untitled board";
  return base.replace(/\.html?$/i, "");
}

/**
 * The hub's view of one board.
 *
 * @param {any} session
 * @param {HubFacts} facts
 */
export function serializeHubBoard(session, facts = {}) {
  const chat = Array.isArray(session?.chat) ? session.chat : [];
  const state = hubBoardState(session, facts);
  return {
    key: String(session.key),
    file: String(session.file || ""),
    title: boardTitle(session, facts.title),
    url: `/session/${session.key}`,
    status: session.status === "ended" ? "ended" : "open",
    ended_by: session.status === "ended" ? session.ended_by || "agent" : null,
    state: state.state,
    state_label: state.label,
    tone: state.tone,
    last_activity: lastActivity(session),
    notes: chat.filter((entry) => entry?.role === "user").length,
    replies: chat.filter((entry) => entry?.role === "agent").length,
    pending_prompts: Number(session.pending_prompts) || 0,
    unsent_drafts: countDraftNotes(session),
    tabs: Number(facts.tabs) || 0,
    listener: facts.listener || null,
    owner: serializeOwnerStatus(session.owner_status, { now: facts.now }),
    file_exists: facts.fileExists !== false,
  };
}

const STATE_ORDER = ["taking-input", "unread", "nobody", "handed-off", "file-gone", "closed-user", "closed-agent"];

/** Most urgent first, then most recently active. */
export function sortHubBoards(boards) {
  return boards.slice().sort((a, b) => {
    const open = (board) => (board.status === "open" && board.state !== "file-gone" ? 0 : 1);
    if (open(a) !== open(b)) return open(a) - open(b);
    const rank = STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state);
    if (rank) return rank;
    return String(b.last_activity).localeCompare(String(a.last_activity));
  });
}

/**
 * The host mark in the hub header: the machine's short name plus a period, the first three
 * letters in the accent (schlab -> "sch" + "lab."). Any hostname works; nothing is configured.
 *
 * @param {string} hostname
 */
export function hostMark(hostname) {
  const short =
    String(hostname || "lavish")
      .split(".")[0]
      .toLowerCase() || "lavish";
  return { accent: short.slice(0, 3), rest: short.slice(3) + "." };
}

function anchorText(entry) {
  const anchor = entry?.anchor;
  if (!anchor || typeof anchor !== "object") return "";
  const label = String(anchor.label || "").trim();
  const text = String(anchor.excerpt || "").trim();
  if (label && text) return `${label} "${text}"`;
  return label || (text ? `"${text}"` : "");
}

function receiptText(entry) {
  if (entry?.role !== "user" || entry.receipt === "none") return "";
  if (entry.done_at) return "done";
  if (entry.working_at) return "working";
  if (entry.delivered_at) return "seen";
  return "not yet seen";
}

/**
 * The conversation as Markdown, for saving a closed board's record. User text is quoted as text;
 * nothing in it is interpreted.
 *
 * @param {any} session
 * @param {{ title?: string }} [options]
 */
export function conversationMarkdown(session, { title = "" } = {}) {
  const lines = [`# ${boardTitle(session, title)}`, ""];
  lines.push(`- Board file: \`${session.file}\``);
  const status =
    session.status === "ended" ? `ended by ${session.ended_by === "user" ? "the reviewer" : "an agent"}` : "open";
  lines.push(`- Status: ${status}`);
  if (session.updated_at) lines.push(`- Last update: ${session.updated_at}`);
  lines.push("", "## Conversation", "");
  const chat = Array.isArray(session.chat) ? session.chat : [];
  if (!chat.length) lines.push("_No messages._", "");
  for (const entry of chat) {
    const who = entry?.role === "agent" ? "Agent" : "Reviewer";
    const meta = [entry?.at, anchorText(entry) && `on ${anchorText(entry)}`, receiptText(entry)].filter(Boolean);
    lines.push(`**${who}**${meta.length ? ` · ${meta.join(" · ")}` : ""}`, "");
    const text = String(entry?.text || "").trim() || "_(no text)_";
    if (entry?.role === "agent") lines.push(text, "");
    else lines.push(...text.split("\n").map((line) => `> ${line}`), "");
    const attachments = Array.isArray(entry?.attachments) ? entry.attachments : [];
    if (attachments.length) lines.push(`_${attachments.length} image(s) attached_`, "");
  }
  return lines.join("\n");
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );
}

function jsonScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// The beach-and-mountains header from the captain's default style, as one inline SVG anchored to
// the bottom so a phone shows the middle of the range and a desktop the whole of it.
const HUB_SCAPE = `<svg class="scape" viewBox="0 0 1200 600" preserveAspectRatio="xMidYMax slice" aria-hidden="true"><defs><linearGradient id="hubsky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--sky-0)"/><stop offset="0.45" style="stop-color:var(--sky-1)"/><stop offset="0.7" style="stop-color:var(--sky-2)"/><stop offset="0.86" style="stop-color:var(--sky-3)"/></linearGradient><linearGradient id="hubsun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--sun-0)"/><stop offset="1" style="stop-color:var(--sun-1)"/></linearGradient><mask id="hubstripes"><rect width="1200" height="600" fill="#fff"/><rect x="740" y="196" width="280" height="5" fill="#000"/><rect x="740" y="214" width="280" height="7" fill="#000"/><rect x="740" y="234" width="280" height="9" fill="#000"/><rect x="740" y="256" width="280" height="12" fill="#000"/></mask></defs><rect width="1200" height="600" fill="url(#hubsky)"/><circle cx="880" cy="190" r="128" style="fill:var(--glow)" opacity="0.12"/><circle cx="880" cy="190" r="104" fill="url(#hubsun)" mask="url(#hubstripes)"/><path d="M0 330 L120 250 L230 300 L360 210 L470 290 L600 230 L720 300 L840 240 L960 300 L1080 220 L1200 280 L1200 600 L0 600 Z" style="fill:var(--ridge)" opacity="0.85"/><polygon points="60,240 -100,430 40,430" style="fill:var(--peak-lit)"/><polygon points="60,240 40,430 220,430" style="fill:var(--peak-shade)"/><polygon points="330,120 120,430 300,430" style="fill:var(--peak-lit-2)"/><polygon points="330,120 300,430 560,430" style="fill:var(--peak-shade-2)"/><polygon points="760,170 560,430 720,430" style="fill:var(--peak-lit-3)"/><polygon points="760,170 720,430 1000,430" style="fill:var(--peak-shade-3)"/><polygon points="1060,230 900,430 1020,430" style="fill:var(--peak-lit)"/><polygon points="1060,230 1020,430 1260,430" style="fill:var(--peak-shade)"/><path d="M0 360 C150 330 260 380 400 350 C540 320 660 380 800 355 C940 330 1060 370 1200 345 L1200 600 L0 600 Z" style="fill:var(--shore)"/><path d="M0 470 C200 455 400 485 600 468 C800 452 1000 482 1200 466 L1200 600 L0 600 Z" style="fill:var(--sea)"/><path d="M40 492 C140 484 220 498 320 490 M470 500 C560 492 650 506 740 498 M860 488 C950 480 1040 494 1140 486" fill="none" style="stroke:var(--surf)" stroke-width="2.5" stroke-linecap="round" opacity="0.6"/><path d="M0 540 C250 520 450 560 700 538 C900 520 1050 548 1200 532 L1200 600 L0 600 Z" style="fill:var(--sand)"/><path d="M0 540 C250 520 450 560 700 538 C900 520 1050 548 1200 532" fill="none" style="stroke:var(--sand-edge)" stroke-width="5"/></svg>`;

const HUB_FONTS =
  '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,800;9..144,900&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">';

function markHtml(mark) {
  return `<span class="mark" aria-label="${escapeHtml(mark.accent + mark.rest)}"><span class="mk-accent">${escapeHtml(mark.accent)}</span><span class="mk-rest">${escapeHtml(mark.rest)}</span></span>`;
}

/**
 * The hub page. It renders from `/api/hub`, so the shell carries only the bootstrap.
 *
 * @param {{ boards: any[], hostname: string, generatedAt?: string, theme?: string }} data
 */
export function createHubHtml({ boards, hostname, generatedAt = new Date().toISOString(), theme = "" }) {
  const mark = hostMark(hostname);
  const themed = hostThemeMarkup(theme, "hub");
  const bootstrap = jsonScript({ boards, generated_at: generatedAt });
  return `<!doctype html>
<html lang="en"${themed.htmlAttribute}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(mark.accent + mark.rest)} boards · Lavish</title>
${HUB_FONTS}
<link rel="stylesheet" href="/hub.css">
${themed.style}
</head>
<body>
<header class="hero">${HUB_SCAPE}<div class="wrap inner"><div class="topline">${markHtml(mark)}<span class="pill" id="hubPill" role="status">Loading…</span></div><p class="kicker">Lavish hub</p><h1>Your boards.</h1><p class="lede" id="hubLede">Every review this server knows, and who is there to read what you send.</p></div></header>
<div class="ctaband"><div class="wrap"><nav class="tabs" aria-label="Boards"><button type="button" class="tab" id="tabOpen" aria-pressed="true">Open <span id="countOpen">0</span></button><button type="button" class="tab" id="tabClosed" aria-pressed="false">Closed <span id="countClosed">0</span></button></nav></div></div>
<main class="wrap">
<p class="note" id="hubNote" role="status" hidden></p>
<ol class="boards" id="boards" aria-live="polite"></ol>
<p class="empty" id="hubEmpty" hidden></p>
<p class="foot">Updated <span id="hubUpdated"></span>. Close keeps the board's file and its conversation; Reopen brings it back. Lavish Editor</p>
</main>
<dialog class="history" id="history" aria-labelledby="historyTitle"><div class="history-head"><div><p class="eyebrow">Conversation</p><h2 id="historyTitle"></h2></div><button type="button" class="close-x" id="historyClose" aria-label="Close conversation">×</button></div><div class="history-body" id="historyBody"></div></dialog>
<script id="hub-data" type="application/json">${bootstrap}</script>
<script src="/hub-client.js"></script>
</body>
</html>`;
}
