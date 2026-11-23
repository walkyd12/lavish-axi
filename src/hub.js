// The Lavish hub: the server's front page lists every board it knows, with a state computed
// from facts the server already holds, and lets the reviewer open, reopen and close boards and
// read a board's conversation. These are pure functions over stored sessions plus the live facts
// the server passes in, so the state rules are unit-testable without a server.

import { serializeBoardMetadata, boardVersionBehind } from "./board-metadata.js";
import { serializeOwnerStatus } from "./owner-status.js";
import { hostThemeCss, hostThemeMarkup } from "./host-theme.js";

/**
 * @typedef {{ listener?: string | null, tabs?: number, fileExists?: boolean, title?: string, nextStep?: string, revisionLabel?: string, fileModifiedAt?: string, searchText?: string, includeSearchText?: boolean, version?: string, now?: number }} HubFacts
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
 * The hub's view of one board. `search_text` is included only when requested for server-side
 * search or peer indexing (`includeSearchText: true`), never shipped to browsers.
 *
 * @param {any} session
 * @param {HubFacts} facts
 */
export function serializeHubBoard(session, facts = {}) {
  const chat = Array.isArray(session?.chat) ? session.chat : [];
  const state = hubBoardState(session, facts);
  const includeSearch = facts.includeSearchText === true || facts.searchText !== undefined;
  return {
    ...serializeBoardMetadata(session),
    version_behind: boardVersionBehind(session, facts.version),
    ...(includeSearch ? { search_text: facts.searchText || "" } : {}),
    artifact_revision: Number(session.artifact_revision) || 0,
    revision_label: facts.revisionLabel || "",
    created_at: session.created_at || facts.fileModifiedAt || "",
    created_at_source: session.created_at ? "session" : facts.fileModifiedAt ? "file" : "unknown",
    key: String(session.key),
    file: String(session.file || ""),
    title: boardTitle(session, facts.title),
    next_step: facts.nextStep || "",
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

// Personalization only: these names never grant approval authority.
export function hubViewerNames(whois, approvalUsers) {
  const login = String(whois?.loginName || "")
    .trim()
    .toLowerCase();
  if (!login) return [];
  return [...new Set([login, ...[...approvalUsers].filter(([, aliases]) => aliases.has(login)).map(([name]) => name)])];
}

export function boardNeedsYou(board, viewer = []) {
  if (board.status === "ended" || board.state === "file-gone" || board.cancelled) return false;
  const names = new Set(viewer.map((name) => String(name).toLowerCase()));
  return (board.tags || []).some(
    (tag) => String(tag).toLowerCase() === "needs-input" || names.has(String(tag).toLowerCase()),
  );
}

function stateSortRank(state) {
  if (state === "taking-input") return 0;
  if (state === "unread") return 1;
  if (state === "nobody") return 2;
  if (state === "handed-off") return 3;
  if (state === "file-gone") return 4;
  return 5;
}

/** Most urgent first among open boards, then newest activity first. */
export function sortHubBoards(boards) {
  return boards.slice().sort((a, b) => {
    const open = (board) => (board.status === "open" && board.state !== "file-gone" ? 0 : 1);
    if (open(a) !== open(b)) return open(a) - open(b);
    const rank = stateSortRank(a.state) - stateSortRank(b.state);
    if (rank) return rank;
    return String(b.last_activity).localeCompare(String(a.last_activity));
  });
}

/**
 * Cheap tab counts, open-board summary, and deduplicated tag list across all boards.
 *
 * @param {any[]} boards
 */
export function summarizeHubBoards(boards) {
  let open = 0;
  let needsInput = 0;
  let closed = 0;
  let cancelled = 0;
  let listening = 0;
  let unread = 0;
  let nobody = 0;
  const tagMap = new Map();
  for (const board of Array.isArray(boards) ? boards : []) {
    const tags = Array.isArray(board.tags) ? board.tags : [];
    for (const tag of tags) {
      const folded = String(tag).toLowerCase();
      if (!tagMap.has(folded)) tagMap.set(folded, tag);
    }
    const isClosed = board.status === "ended" || board.state === "file-gone" || board.closed === true;
    const isCancelled = Boolean(board.cancelled);
    if (isCancelled) {
      cancelled += 1;
    } else if (isClosed) {
      closed += 1;
    } else {
      open += 1;
      if (board.board_state === "needs-input" || tags.some((tag) => String(tag).toLowerCase() === "needs-input")) {
        needsInput += 1;
      }
      if (board.state === "taking-input") listening += 1;
      else if (board.state === "unread") unread += 1;
      else if (board.state === "nobody") nobody += 1;
    }
  }
  return {
    counts: { open, needs_input: needsInput, closed, cancelled },
    open_summary: { listening, unread, nobody },
    clients: [...new Set(boards.map((board) => String(board.client || "")).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b),
    ),
    tags: [...tagMap.values()].sort((a, b) => a.localeCompare(b)),
  };
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
    session.status === "ended"
      ? `${session.ended_reason === "cancelled" ? "cancelled" : "ended"} by ${session.ended_by === "user" ? "the reviewer" : "an agent"}`
      : "open";
  lines.push(`- Status: ${status}`);
  if (session.creator) lines.push(`- Creator: ${session.creator}`);
  if (Array.isArray(session.tags) && session.tags.length) lines.push(`- Tags: ${session.tags.join(", ")}`);
  if (session.updated_at) lines.push(`- Last update: ${session.updated_at}`);
  lines.push("", "## Conversation", "");
  const chat = Array.isArray(session.chat) ? session.chat : [];
  if (!chat.length) lines.push("_No messages._", "");
  for (const entry of chat) {
    const who = entry?.role === "agent" ? "Agent" : String(entry?.author || "").trim() || "Reviewer";
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

const GEAR_ICON = `<svg class="notify-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

const HUB_FONTS =
  '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,800;9..144,900&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">';

function markHtml(mark) {
  return `<h1 class="mark" aria-label="${escapeHtml(mark.accent + mark.rest)}"><span class="mk-accent">${escapeHtml(mark.accent)}</span><span class="mk-rest">${escapeHtml(mark.rest)}</span></h1>`;
}

/**
 * The hub page. It renders from `/api/hub`, carrying only the initial Open slice and counts.
 *
 * @param {{
 *   boards: any[],
 *   peers?: any[],
 *   counts?: { open: number, needs_input: number, closed: number, cancelled: number },
 *   openSummary?: { listening: number, unread: number, nobody: number },
 *   tags?: string[],
 *   total?: number,
 *   limit?: number,
 *   offset?: number,
 *   hasMore?: boolean,
 *   notifySettings?: Record<string, { tagged: boolean, done: boolean, send_to: string }>,
 *   hostname: string,
 *   title?: string,
 *   needsYou?: any[],
 *   needsYouTotal?: number,
 *   needsYouCount?: number,
 *   clients?: string[],
 *   people?: string[],
 *   viewer?: string[],
 *   identifyViewer?: boolean,
 *   generatedAt?: string,
 *   theme?: string,
 * }} data
 */
export function createHubHtml({
  boards,
  peers = [],
  counts = undefined,
  openSummary = undefined,
  tags = undefined,
  total = undefined,
  limit = undefined,
  offset = 0,
  hasMore = false,
  notifySettings = undefined,
  hostname,
  title = "",
  needsYou = [],
  needsYouTotal = 0,
  needsYouCount = 0,
  clients = [],
  people = [],
  viewer = [],
  identifyViewer = false,
  generatedAt = new Date().toISOString(),
  theme = "",
}) {
  const mark = hostMark(hostname);
  const themed = hostThemeMarkup(theme, "hub");
  const bootstrap = jsonScript({
    boards,
    needs_you: needsYou,
    needs_you_total: needsYouTotal,
    needs_you_count: needsYouCount,
    clients,
    people,
    viewer,
    identify_viewer: identifyViewer,
    peers,
    ...(counts ? { counts } : {}),
    ...(openSummary ? { open_summary: openSummary } : {}),
    ...(Array.isArray(tags) ? { tags } : {}),
    ...(typeof total === "number" ? { total } : {}),
    ...(typeof limit === "number" ? { limit } : {}),
    offset,
    has_more: Boolean(hasMore),
    ...(notifySettings ? { notify_settings: notifySettings } : {}),
    state: "open",
    generated_at: generatedAt,
  });
  return `<!doctype html>
<html lang="en"${themed.htmlAttribute}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(title || mark.accent + mark.rest)} boards · Lavish</title>
${theme === "minimal" ? '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" media="print" onload="this.media=\'all\'">' : HUB_FONTS}
<link rel="stylesheet" href="/board-metadata.css">
<link rel="stylesheet" href="/hub.css">
${themed.style}
<style id="lavish-dark-toggle">${hostThemeCss("night", "hub", 'html[data-user-theme="dark"]')}</style>
<script>try{if(localStorage.getItem("lavish-hub-theme")==="dark")document.documentElement.dataset.userTheme="dark"}catch(e){}</script>
</head>
<body>
<header class="hero"><div class="wrap inner"><div class="topline">${title ? `<h1 class="mark">${escapeHtml(title)}</h1>` : markHtml(mark)}<button type="button" class="notify-toggle theme-toggle" id="themeToggle" aria-pressed="false" aria-label="Dark mode">Dark</button><button type="button" class="notify-toggle" id="settingsToggle" aria-label="Settings" aria-haspopup="dialog" aria-expanded="false" aria-controls="hubSettings">${GEAR_ICON}<span>Settings</span></button></div><p class="lede" id="hubLede" hidden>Open a board to review it or send a message.</p><span class="pill" id="hubPill" role="status" hidden></span></div></header>
<div class="ctaband"><div class="wrap"><nav class="tabs" aria-label="Boards"><button type="button" class="tab" id="tabOpen" aria-pressed="true">Open <span id="countOpen">0</span></button><button type="button" class="tab" id="tabNeedsInput" aria-pressed="false">Needs you <span id="countNeedsInput">0</span></button><button type="button" class="tab" id="tabClosed" aria-pressed="false">Closed</button><button type="button" class="tab" id="tabCancelled" aria-pressed="false">Cancelled</button></nav></div></div>
<main class="wrap">
<div class="hub-search"><label>Search boards<input id="hubSearch" type="search" placeholder="Search titles, clients, tags or text" aria-describedby="searchHint"></label><label class="include-closed"><input id="includeClosed" type="checkbox">Also search closed &amp; cancelled</label></div>
<div class="filter-chips" id="hubFilters" aria-label="Filter boards"></div>
<details class="more-filters"><summary>More filters</summary><label>Filter by tag<select id="hubTag"><option value="">All tags</option></select></label></details>
<p class="meta needs-you-explanation">Needs you shows open boards tagged Needs input or with your recognized reviewer name.</p>
<p class="meta" id="searchHint" role="status" aria-live="polite"></p>
<p class="note" id="hubNote" role="status" hidden></p>
<p class="note" id="peerNote" data-tone="offline" role="status" hidden></p>
<section id="needsYouSection" aria-labelledby="needsYouHeading" hidden><div class="section-head"><h2 id="needsYouHeading">Needs you</h2><span class="meta" id="needsYouHint"></span></div><ol class="boards" id="needsYouBoards"></ol><button type="button" class="act primary" id="needsYouMore" hidden>See all that need you</button></section>
<h2 class="list-heading" id="boardListHeading">Open boards</h2>
<ol class="boards" id="boards" aria-live="polite"></ol>
<div class="load-more-wrap" id="hubMoreWrap" hidden><button type="button" class="act primary" id="hubMore">Load more</button></div>
<p class="empty" id="hubEmpty" hidden></p>
<p class="empty" id="hubLoadError" role="alert" hidden>Could not load boards. <button type="button" class="act" id="hubRetry">Retry</button></p>
<button type="button" class="act" id="showOlder" hidden>Show older boards</button>
<datalist id="clientSuggestions"></datalist>
<p class="foot">Updated <span id="hubUpdated"></span>. Close keeps the board's file and its conversation; Reopen brings it back. Lavish Editor</p>
</main>
<dialog class="settings-drawer" id="hubSettings" aria-labelledby="settingsHeading"><div class="history-head"><h2 id="settingsHeading">Settings</h2><button type="button" class="close-x" id="settingsClose" aria-label="Close settings">×</button></div><nav class="settings-tabs" aria-label="Settings sections"><button type="button" id="settingsNotifications" aria-pressed="true" aria-controls="notifyPanel">Notifications</button><button type="button" id="settingsPeers" aria-pressed="false" aria-controls="peerPanel">Connected hubs</button></nav><div class="hub-settings">
<section class="notify-panel" id="notifyPanel" aria-labelledby="notifyHeading"><div class="notify-head"><div><h2 id="notifyHeading">Notifications</h2></div></div><p class="meta notify-copy">Pings go to the destination you pick. Unchecked = no ping.</p><div class="notify-rows" id="notifyRows"></div><p class="meta" id="notifyEmpty" hidden>No people added yet.</p><form class="notify-add" id="notifyAddForm"><input id="notifyAddInput" name="person" type="text" placeholder="Add person" aria-label="Add person" maxlength="64" required><button type="submit" class="act primary">Add person</button></form><p class="meta notify-status" id="notifyStatus" role="status" hidden></p></section>
<section class="notify-panel" id="peerPanel" aria-labelledby="peerHeading" hidden><div class="notify-head"><h2 id="peerHeading">Connected hubs</h2></div><p class="meta notify-copy">Bring boards from other Lavish hubs into this list.</p><div class="notify-rows" id="peerRows"></div><form class="notify-add peer-add" id="peerAddForm"><label>Hub name<input id="peerName" name="name" type="text" placeholder="team-hub" maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,31}" required></label><label>Hub URL<input id="peerOrigin" name="origin" type="url" placeholder="http://host:4388" maxlength="2048" required></label><button type="submit" class="act primary" id="peerAdd">Add hub</button></form><p class="meta notify-status" id="peerStatus" role="status" hidden></p></section>
</div>
</dialog>
<dialog class="history" id="history" aria-labelledby="historyTitle"><div class="history-head"><div><p class="eyebrow">Conversation</p><h2 id="historyTitle"></h2></div><button type="button" class="close-x" id="historyClose" aria-label="Close conversation">×</button></div><div class="history-body" id="historyBody"></div></dialog>
<script id="hub-data" type="application/json">${bootstrap}</script>
<script src="/board-metadata-client.js"></script>
<script src="/hub-client.js"></script>
</body>
</html>`;
}
