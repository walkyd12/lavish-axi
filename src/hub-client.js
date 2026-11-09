/* global document, location, window */
// The Lavish hub page (src/hub.js renders the shell). It lists every board from /api/hub, refreshes
// on a short interval, and drives Open, Close, Reopen, and the conversation view. Served as a raw
// file, like chrome-client.js, so it imports nothing.

const REFRESH_MS = 10_000;
const dataElement = document.getElementById("hub-data");
const initial = JSON.parse(dataElement?.textContent || "{}");
let boards = Array.isArray(initial.boards) ? initial.boards : [];
let generatedAt = String(initial.generated_at || "");
let showing = "open";
/** @type {Set<string>} */
const busy = new Set();
/** @type {ReturnType<typeof setTimeout> | undefined} */
let refreshTimer;

const list = /** @type {HTMLOListElement} */ (document.getElementById("boards"));
const empty = /** @type {HTMLParagraphElement} */ (document.getElementById("hubEmpty"));
const note = /** @type {HTMLParagraphElement} */ (document.getElementById("hubNote"));
const pill = /** @type {HTMLSpanElement} */ (document.getElementById("hubPill"));
const lede = /** @type {HTMLParagraphElement} */ (document.getElementById("hubLede"));
const updated = /** @type {HTMLSpanElement} */ (document.getElementById("hubUpdated"));
const tabOpen = /** @type {HTMLButtonElement} */ (document.getElementById("tabOpen"));
const tabClosed = /** @type {HTMLButtonElement} */ (document.getElementById("tabClosed"));
const countOpen = /** @type {HTMLSpanElement} */ (document.getElementById("countOpen"));
const countClosed = /** @type {HTMLSpanElement} */ (document.getElementById("countClosed"));
const history = /** @type {HTMLDialogElement} */ (document.getElementById("history"));
const historyTitle = /** @type {HTMLHeadingElement} */ (document.getElementById("historyTitle"));
const historyBody = /** @type {HTMLDivElement} */ (document.getElementById("historyBody"));
const historyClose = /** @type {HTMLButtonElement} */ (document.getElementById("historyClose"));

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );
}

function isClosed(board) {
  return board.status === "ended" || board.state === "file-gone";
}

function relativeTime(iso) {
  const at = Date.parse(iso || "");
  if (!Number.isFinite(at)) return "";
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + " min ago";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
  const days = Math.round(hours / 24);
  if (days < 14) return days + (days === 1 ? " day ago" : " days ago");
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function plural(count, one, many) {
  return count + " " + (count === 1 ? one : many);
}

// Who is there, in words, for the line under the title.
function whoLine(board) {
  if (board.owner) {
    const name = board.owner.label || "Owner";
    if (board.owner.stale) return name + " not heard from";
    if (board.owner.state === "live") return name + " is live";
    if (board.owner.state === "working") return name + " is working";
    if (board.owner.state === "finished")
      return name + " finished" + (board.owner.detail ? " · " + board.owner.detail : "");
    return name + " is gone";
  }
  if (board.listener) return "Listener: " + board.listener;
  if (board.status === "ended") return "";
  return "Nobody listening";
}

function metaLine(board) {
  const parts = [];
  const who = whoLine(board);
  if (who && !isClosed(board)) parts.push(who);
  if (board.notes) parts.push(plural(board.notes, "note from you", "notes from you"));
  if (board.replies) parts.push(plural(board.replies, "reply", "replies"));
  if (!board.notes && !board.replies) parts.push("no messages yet");
  if (board.pending_prompts) parts.push(plural(board.pending_prompts, "unread", "unread"));
  if (board.unsent_drafts) parts.push(plural(board.unsent_drafts, "unsent draft", "unsent drafts"));
  if (board.tabs) parts.push(plural(board.tabs, "tab open", "tabs open"));
  const when = relativeTime(board.last_activity);
  if (when) parts.push(when);
  return parts.join(" · ");
}

// The last few path segments say which board it is; the full path is in the tooltip.
function shortPath(file) {
  const parts = String(file || "")
    .split("/")
    .filter(Boolean);
  return parts.length > 3 ? "…/" + parts.slice(-3).join("/") : String(file || "");
}

function actionsHtml(board) {
  const key = escapeHtml(board.key);
  const disabled = busy.has(board.key) ? " disabled" : "";
  const actions = [];
  if (board.state === "file-gone") {
    actions.push(`<button type="button" class="act" data-act="history" data-key="${key}">History</button>`);
    if (board.status !== "ended") {
      actions.push(`<button type="button" class="act" data-act="close" data-key="${key}"${disabled}>Close</button>`);
    }
    return actions.join("");
  }
  if (board.status === "ended") {
    actions.push(`<button type="button" class="act" data-act="reopen" data-key="${key}"${disabled}>Reopen</button>`);
    actions.push(`<button type="button" class="act" data-act="history" data-key="${key}">History</button>`);
    return actions.join("");
  }
  actions.push(`<a class="act primary" href="${escapeHtml(board.url)}">Open →</a>`);
  actions.push(`<button type="button" class="act" data-act="history" data-key="${key}">History</button>`);
  actions.push(`<button type="button" class="act" data-act="close" data-key="${key}"${disabled}>Close</button>`);
  return actions.join("");
}

function boardHtml(board) {
  return (
    `<li class="board" data-key="${escapeHtml(board.key)}">` +
    `<div class="board-head"><h2 class="board-title">${escapeHtml(board.title)}</h2>` +
    `<span class="st st-${escapeHtml(board.tone)}">${escapeHtml(board.state_label)}</span></div>` +
    `<p class="meta">${escapeHtml(metaLine(board))}</p>` +
    `<p class="path" title="${escapeHtml(board.file)}">${escapeHtml(shortPath(board.file))}</p>` +
    `<div class="acts">${actionsHtml(board)}</div>` +
    `</li>`
  );
}

function render() {
  const openBoards = boards.filter((board) => !isClosed(board));
  const closedBoards = boards.filter(isClosed);
  countOpen.textContent = String(openBoards.length);
  countClosed.textContent = String(closedBoards.length);
  tabOpen.setAttribute("aria-pressed", showing === "open" ? "true" : "false");
  tabClosed.setAttribute("aria-pressed", showing === "closed" ? "true" : "false");
  const shown = showing === "open" ? openBoards : closedBoards;
  list.innerHTML = shown.map(boardHtml).join("");
  empty.hidden = shown.length > 0;
  empty.textContent = showing === "open" ? "No open boards." : "No closed boards yet.";

  const listening = openBoards.filter((board) => board.state === "taking-input").length;
  const unread = openBoards.filter((board) => board.state === "unread").length;
  const nobody = openBoards.filter((board) => board.state === "nobody").length;
  pill.textContent = unread
    ? plural(unread, "board has unread notes", "boards have unread notes")
    : plural(listening, "board live", "boards live");
  pill.dataset.tone = unread ? "warn" : listening ? "good" : "muted";
  lede.textContent =
    plural(openBoards.length, "open board", "open boards") +
    ": " +
    [
      listening && listening + " taking input",
      unread && unread + " with unread notes",
      nobody && nobody + " with nobody listening",
    ]
      .filter(Boolean)
      .join(", ") +
    (openBoards.length ? "." : "");
  if (!openBoards.length) lede.textContent = "No open boards. Closed ones can be reopened below.";
  updated.textContent = generatedAt ? new Date(generatedAt).toLocaleTimeString() : "";
}

function showNote(text, tone = "") {
  note.textContent = text;
  note.dataset.tone = tone;
  note.hidden = !text;
}

async function refresh() {
  clearTimeout(refreshTimer);
  try {
    const response = await fetch("/api/hub", { cache: "no-store" });
    if (!response.ok) throw new Error("hub request failed: " + response.status);
    const data = await response.json();
    boards = Array.isArray(data.boards) ? data.boards : [];
    generatedAt = String(data.generated_at || "");
    if (note.dataset.tone === "offline") showNote("");
    render();
  } catch {
    showNote("Lavish is not answering. The list below may be out of date.", "offline");
  } finally {
    refreshTimer = setTimeout(refresh, REFRESH_MS);
  }
}

async function closeBoard(board) {
  if (!window.confirm(`Close "${board.title}"? The file and its conversation are kept; you can reopen it.`)) return;
  busy.add(board.key);
  render();
  try {
    const response = await fetch("/api/hub/" + encodeURIComponent(board.key) + "/close", { method: "POST" });
    if (!response.ok) throw new Error(String(response.status));
    showNote(`Closed "${board.title}".`, "done");
  } catch {
    showNote(`Could not close "${board.title}". Try again.`, "error");
  } finally {
    busy.delete(board.key);
    await refresh();
  }
}

async function reopenBoard(board) {
  busy.add(board.key);
  render();
  try {
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: board.file, reopen: true }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.status !== "opened") throw new Error(result.error || String(response.status));
    showNote(`Reopened "${board.title}".`, "done");
    showing = "open";
  } catch {
    showNote(`Could not reopen "${board.title}".`, "error");
  } finally {
    busy.delete(board.key);
    await refresh();
  }
}

function receiptLabel(entry) {
  if (entry.role !== "user" || entry.receipt === "none") return "";
  if (entry.done_at) return "Done";
  if (entry.working_at) return "Working";
  if (entry.delivered_at) return "Seen";
  return "Not yet seen";
}

async function showHistory(board) {
  historyTitle.textContent = board.title;
  historyBody.innerHTML = '<p class="meta">Loading…</p>';
  if (typeof history.showModal === "function") history.showModal();
  else history.setAttribute("open", "");
  try {
    const response = await fetch("/api/" + encodeURIComponent(board.key) + "/conversation", { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json();
    const chat = Array.isArray(data.chat) ? data.chat : [];
    const download =
      `<p class="history-links"><a class="act" href="/api/${encodeURIComponent(board.key)}/conversation?format=markdown" download>Conversation (.md)</a>` +
      (board.file_exists
        ? ` <a class="act" href="/api/${encodeURIComponent(board.key)}/export" download>Board copy (.html)</a>`
        : "") +
      "</p>";
    historyBody.innerHTML =
      download +
      (chat.length
        ? chat
            .map((entry) => {
              const who = entry.role === "agent" ? "Agent" : "You";
              const anchor = entry.anchor ? [entry.anchor.label, entry.anchor.excerpt].filter(Boolean).join(" · ") : "";
              const receipt = receiptLabel(entry);
              // Agent entries arrive rendered from the server's restricted Markdown; user text is
              // always escaped, as in the board itself.
              const body =
                entry.role === "agent" && entry.html ? entry.html : "<p>" + escapeHtml(entry.text || "") + "</p>";
              return (
                `<article class="msg msg-${entry.role === "agent" ? "agent" : "you"}">` +
                `<p class="who">${who}${entry.at ? " · " + escapeHtml(relativeTime(entry.at)) : ""}</p>` +
                (anchor ? `<p class="anchor">${escapeHtml(anchor)}</p>` : "") +
                body +
                (receipt ? `<p class="receipt">${escapeHtml(receipt)}</p>` : "") +
                `</article>`
              );
            })
            .join("")
        : '<p class="meta">No messages on this board yet.</p>');
  } catch {
    historyBody.innerHTML = '<p class="meta">Could not load the conversation.</p>';
  }
}

list.addEventListener("click", (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  const button = /** @type {HTMLButtonElement | null} */ (target.closest?.("button[data-act]") || null);
  if (!button || button.disabled) return;
  const board = boards.find((candidate) => candidate.key === button.dataset.key);
  if (!board) return;
  if (button.dataset.act === "close") closeBoard(board);
  else if (button.dataset.act === "reopen") reopenBoard(board);
  else if (button.dataset.act === "history") showHistory(board);
});
tabOpen.addEventListener("click", () => {
  showing = "open";
  render();
});
tabClosed.addEventListener("click", () => {
  showing = "closed";
  render();
});
historyClose.addEventListener("click", () => {
  if (typeof history.close === "function") history.close();
  else history.removeAttribute("open");
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refresh();
});
if (location.hash === "#closed") showing = "closed";

render();
refreshTimer = setTimeout(refresh, REFRESH_MS);
