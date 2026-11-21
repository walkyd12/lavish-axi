/* global document, location, window */
// The Lavish hub page (src/hub.js renders the shell). It bootstraps from `#hub-data`, stays synced
// over the `/events/hub` WebSocket (zero polling timers), runs search/tab/tag filtering and
// pagination on `/api/hub`, and manages per-person notification checkboxes. Served as a raw file.

const HUB_WS_BACKOFF_MS = [500, 1000, 2000, 5000];
const HUB_EVENT_DEBOUNCE_MS = 60;
const SEARCH_DEBOUNCE_MS = 150;
const SEND_TO_DEBOUNCE_MS = 350;
const DEFAULT_PAGE_LIMIT = 50;

const dataElement = document.getElementById("hub-data");
const initial = JSON.parse(dataElement?.textContent || "{}");
let boards = Array.isArray(initial.boards) ? initial.boards : [];
let peers = Array.isArray(initial.peers) ? initial.peers : [];
let serverCounts = initial.counts && typeof initial.counts === "object" ? initial.counts : null;
let serverOpenSummary = initial.open_summary && typeof initial.open_summary === "object" ? initial.open_summary : null;
let serverTags = Array.isArray(initial.tags) ? initial.tags : null;
let totalMatching = typeof initial.total === "number" ? initial.total : boards.length;
let hasMore = Boolean(initial.has_more);
let loadingMore = false;
/** @type {Record<string, { tagged: boolean, done: boolean, send_to: string }>} */
let notifySettings =
  initial.notify_settings && typeof initial.notify_settings === "object" && !Array.isArray(initial.notify_settings)
    ? initial.notify_settings
    : {};
let generatedAt = String(initial.generated_at || "");
let showing = "open";
/** @type {Set<string>} */
const busy = new Set();
/** @type {ReturnType<typeof setTimeout> | undefined} */
let eventRefreshTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let searchDebounceTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let sendToSaveTimer;
/** @type {AbortController | null} */
let activeFetchController = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let wsReconnectTimer;
let wsReconnectAttempt = 0;
let sawWsDisconnect = false;
let notifySaveChain = Promise.resolve();

const list = /** @type {HTMLOListElement} */ (document.getElementById("boards"));
const moreWrap = /** @type {HTMLDivElement | null} */ (document.getElementById("hubMoreWrap"));
const moreBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("hubMore"));
const empty = /** @type {HTMLParagraphElement} */ (document.getElementById("hubEmpty"));
const note = /** @type {HTMLParagraphElement} */ (document.getElementById("hubNote"));
const peerNote = /** @type {HTMLParagraphElement} */ (document.getElementById("peerNote"));
const pill = /** @type {HTMLSpanElement} */ (document.getElementById("hubPill"));
const lede = /** @type {HTMLParagraphElement} */ (document.getElementById("hubLede"));
const updated = /** @type {HTMLSpanElement} */ (document.getElementById("hubUpdated"));
const tabOpen = /** @type {HTMLButtonElement} */ (document.getElementById("tabOpen"));
const tabNeedsInput = /** @type {HTMLButtonElement | null} */ (document.getElementById("tabNeedsInput"));
const tabClosed = /** @type {HTMLButtonElement} */ (document.getElementById("tabClosed"));
const tabCancelled = /** @type {HTMLButtonElement | null} */ (document.getElementById("tabCancelled"));
const search = /** @type {HTMLInputElement} */ (document.getElementById("hubSearch"));
const tagFilter = /** @type {HTMLSelectElement} */ (document.getElementById("hubTag"));
const countOpen = /** @type {HTMLSpanElement} */ (document.getElementById("countOpen"));
const countNeedsInput = /** @type {HTMLSpanElement | null} */ (document.getElementById("countNeedsInput"));
const countClosed = /** @type {HTMLSpanElement} */ (document.getElementById("countClosed"));
const countCancelled = /** @type {HTMLSpanElement | null} */ (document.getElementById("countCancelled"));
const history = /** @type {HTMLDialogElement} */ (document.getElementById("history"));
const historyTitle = /** @type {HTMLHeadingElement} */ (document.getElementById("historyTitle"));
const historyBody = /** @type {HTMLDivElement} */ (document.getElementById("historyBody"));
const historyClose = /** @type {HTMLButtonElement} */ (document.getElementById("historyClose"));

const notifyToggle = /** @type {HTMLButtonElement | null} */ (document.getElementById("notifyToggle"));
const notifyPanel = /** @type {HTMLElement | null} */ (document.getElementById("notifyPanel"));
const notifyClose = /** @type {HTMLButtonElement | null} */ (document.getElementById("notifyClose"));
const notifyRows = /** @type {HTMLDivElement | null} */ (document.getElementById("notifyRows"));
const notifyEmpty = /** @type {HTMLParagraphElement | null} */ (document.getElementById("notifyEmpty"));
const notifyAddForm = /** @type {HTMLFormElement | null} */ (document.getElementById("notifyAddForm"));
const notifyAddInput = /** @type {HTMLInputElement | null} */ (document.getElementById("notifyAddInput"));
const notifyStatus = /** @type {HTMLParagraphElement | null} */ (document.getElementById("notifyStatus"));

function syncGlobalNotifyPeople() {
  window["lavishNotifyPeople"] = Object.keys(notifySettings);
  window.dispatchEvent(new CustomEvent("lavish:notify-people"));
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );
}

function isClosed(board) {
  return board.status === "ended" || board.state === "file-gone";
}

function isCancelled(board) {
  return Boolean(board.cancelled);
}

function isNeedsInput(board) {
  if (isClosed(board)) return false;
  if (board.board_state === "needs-input") return true;
  return Array.isArray(board.tags) && board.tags.some((tag) => String(tag).toLowerCase() === "needs-input");
}

function displayBadge(board) {
  if (board.state === "file-gone") return { label: board.state_label || "File gone", tone: "bad" };
  if (isCancelled(board)) return { label: "Cancelled", tone: "muted" };
  if (board.status === "ended") return { label: "Done", tone: "muted" };
  if (isNeedsInput(board)) return { label: "Needs input", tone: "warn" };
  return { label: "Working", tone: board.tone === "warn" ? "warn" : "good" };
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

function shortPath(file) {
  const parts = String(file || "")
    .split("/")
    .filter(Boolean);
  return parts.length > 3 ? "…/" + parts.slice(-3).join("/") : String(file || "");
}

function safeHref(url) {
  try {
    const parsed = new URL(String(url || ""), location.href);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
  } catch {
    return "";
  }
}

function peerActionsHtml(board) {
  const key = escapeHtml(board.key);
  const disabled = busy.has(board.key) ? " disabled" : "";
  const href = safeHref(board.url);
  const actions = [];
  if (board.state === "file-gone") {
    if (board.status !== "ended") {
      actions.push(`<button type="button" class="act" data-act="close" data-key="${key}"${disabled}>Close</button>`);
      actions.push(`<button type="button" class="act" data-act="cancel" data-key="${key}"${disabled}>Cancel</button>`);
    }
    return actions.join("");
  }
  if (board.status === "ended") {
    actions.push(`<button type="button" class="act" data-act="reopen" data-key="${key}"${disabled}>Reopen</button>`);
    if (href) {
      actions.push(`<a class="act" href="${escapeHtml(href)}">Open on ${escapeHtml(board.source)} →</a>`);
    }
    return actions.join("");
  }
  if (href) {
    actions.push(`<a class="act primary" href="${escapeHtml(href)}">Open on ${escapeHtml(board.source)} →</a>`);
  }
  actions.push(`<button type="button" class="act" data-act="close" data-key="${key}"${disabled}>Close</button>`);
  actions.push(`<button type="button" class="act" data-act="cancel" data-key="${key}"${disabled}>Cancel</button>`);
  return actions.join("");
}

function actionsHtml(board) {
  if (board.source) return peerActionsHtml(board);
  const key = escapeHtml(board.key);
  const disabled = busy.has(board.key) ? " disabled" : "";
  const actions = [];
  if (board.state === "file-gone") {
    actions.push(`<button type="button" class="act" data-act="history" data-key="${key}">History</button>`);
    if (board.status !== "ended") {
      actions.push(`<button type="button" class="act" data-act="close" data-key="${key}"${disabled}>Close</button>`);
      actions.push(`<button type="button" class="act" data-act="cancel" data-key="${key}"${disabled}>Cancel</button>`);
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
  actions.push(`<button type="button" class="act" data-act="cancel" data-key="${key}"${disabled}>Cancel</button>`);
  return actions.join("");
}

function boardHtml(board) {
  const badge = displayBadge(board);
  return (
    `<li class="board" data-key="${escapeHtml(board.key)}">` +
    `<div class="board-head"><h2 class="board-title">${escapeHtml(board.title)}</h2>` +
    `<span class="st st-${escapeHtml(badge.tone)}">${escapeHtml(badge.label)}</span></div>` +
    (board.source ? `<p class="peer-badge">On ${escapeHtml(board.source)}</p>` : "") +
    `<p class="meta">${escapeHtml(metaLine(board))}</p>` +
    (board.source ? "" : `<p class="path" title="${escapeHtml(board.file)}">${escapeHtml(shortPath(board.file))}</p>`) +
    `<div data-board-metadata="${escapeHtml(board.key)}" data-readonly="${Boolean(board.source)}" data-metadata="${escapeHtml(JSON.stringify(board))}"></div>` +
    `<div class="acts">${actionsHtml(board)}</div>` +
    `</li>`
  );
}

function renderNotificationsPanel() {
  if (!notifyRows || !notifyEmpty) return;
  if (
    notifyPanel &&
    notifyPanel.contains(document.activeElement) &&
    document.activeElement?.matches('input[type="text"]')
  ) {
    return;
  }
  const people = Object.keys(notifySettings);
  notifyEmpty.hidden = people.length > 0;
  notifyRows.innerHTML = people
    .map((person) => {
      const cfg = notifySettings[person] || { tagged: false, done: false, send_to: "" };
      const safeName = escapeHtml(person);
      return (
        `<div class="notify-row" data-notify-row="${safeName}">` +
        `<div class="notify-person-head"><strong class="notify-person-name">${safeName}</strong>` +
        `<button type="button" class="notify-remove" data-notify-remove="${safeName}" aria-label="Remove ${safeName}" title="Remove ${safeName}">×</button></div>` +
        `<div class="notify-checks">` +
        `<label class="notify-check"><input type="checkbox" data-notify-person="${safeName}" data-notify-field="tagged"${cfg.tagged ? " checked" : ""}><span>When tagged</span></label>` +
        `<label class="notify-check"><input type="checkbox" data-notify-person="${safeName}" data-notify-field="done"${cfg.done ? " checked" : ""}><span>When board is done</span></label>` +
        `</div>` +
        `<label class="notify-sendto"><span>Send to</span><input type="text" data-notify-person="${safeName}" data-notify-field="send_to" value="${escapeHtml(cfg.send_to || "")}" placeholder="Optional destination" maxlength="256"></label>` +
        `</div>`
      );
    })
    .join("");
}

function setNotifyStatus(text, isError = false) {
  if (!notifyStatus) return;
  notifyStatus.textContent = text;
  notifyStatus.dataset.tone = isError ? "error" : "saved";
  notifyStatus.hidden = !text;
}

function saveNotifySettings(rerender = false) {
  const snapshot = JSON.parse(JSON.stringify(notifySettings));
  notifySaveChain = notifySaveChain
    .then(async () => {
      try {
        const response = await fetch("/api/hub/notifications", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ notify_settings: snapshot }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Could not save notification settings.");
        if (data.notify_settings && typeof data.notify_settings === "object") {
          notifySettings = data.notify_settings;
          syncGlobalNotifyPeople();
          if (rerender) renderNotificationsPanel();
        }
        setNotifyStatus("Saved.");
      } catch (error) {
        setNotifyStatus(error?.message || "Could not save notification settings.", true);
      }
    })
    .catch(() => {});
  return notifySaveChain;
}

function render() {
  const fallbackOpen = boards.filter((board) => !isClosed(board));
  const counts = serverCounts || {
    open: fallbackOpen.length,
    needs_input: fallbackOpen.filter(isNeedsInput).length,
    closed: boards.filter((board) => isClosed(board) && !isCancelled(board)).length,
    cancelled: boards.filter(isCancelled).length,
  };
  const openSummary = serverOpenSummary || {
    listening: fallbackOpen.filter((board) => board.state === "taking-input").length,
    unread: fallbackOpen.filter((board) => board.state === "unread").length,
    nobody: fallbackOpen.filter((board) => board.state === "nobody").length,
  };

  countOpen.textContent = String(counts.open);
  if (countNeedsInput) countNeedsInput.textContent = String(counts.needs_input);
  countClosed.textContent = String(counts.closed);
  if (countCancelled) countCancelled.textContent = String(counts.cancelled);

  tabOpen.setAttribute("aria-pressed", showing === "open" ? "true" : "false");
  if (tabNeedsInput) tabNeedsInput.setAttribute("aria-pressed", showing === "needs-input" ? "true" : "false");
  tabClosed.setAttribute("aria-pressed", showing === "closed" ? "true" : "false");
  if (tabCancelled) tabCancelled.setAttribute("aria-pressed", showing === "cancelled" ? "true" : "false");

  const selected = tagFilter.value;
  let tags = serverTags;
  if (!tags) {
    const names = new Map();
    for (const tag of boards.flatMap((board) => board.tags || [])) {
      if (!names.has(tag.toLowerCase())) names.set(tag.toLowerCase(), tag);
    }
    tags = [...names.values()].sort((a, b) => a.localeCompare(b));
  }
  tagFilter.innerHTML =
    '<option value="">All tags</option>' +
    tags.map((tag) => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`).join("");
  tagFilter.value = tags.find((tag) => tag.toLowerCase() === selected.toLowerCase()) || "";

  const query = search.value.trim();
  const searching = Boolean(query || tagFilter.value);
  list.innerHTML = boards.map(boardHtml).join("");
  window.dispatchEvent(new CustomEvent("lavish:render-metadata"));

  if (moreWrap && moreBtn) {
    moreWrap.hidden = !hasMore;
    moreBtn.disabled = loadingMore;
    moreBtn.textContent = loadingMore
      ? "Loading…"
      : totalMatching > boards.length
        ? `Load more (${boards.length} of ${totalMatching})`
        : "Load more";
  }

  empty.hidden = boards.length > 0;
  empty.textContent = searching
    ? "No matching boards."
    : showing === "needs-input"
      ? "No boards waiting on input."
      : showing === "cancelled"
        ? "No cancelled boards."
        : showing === "closed"
          ? "No closed boards yet."
          : "No open boards.";

  const listening = openSummary.listening || 0;
  const unread = openSummary.unread || 0;
  const nobody = openSummary.nobody || 0;
  pill.textContent = unread
    ? plural(unread, "board has unread notes", "boards have unread notes")
    : plural(listening, "board live", "boards live");
  pill.dataset.tone = unread ? "warn" : listening ? "good" : "muted";
  lede.textContent =
    plural(counts.open, "open board", "open boards") +
    (counts.open
      ? ": " +
        [
          listening && listening + " taking input",
          unread && unread + " with unread notes",
          nobody && nobody + " with nobody listening",
        ]
          .filter(Boolean)
          .join(", ") +
        "."
      : "");
  if (!counts.open) lede.textContent = "No open boards. Closed ones can be reopened below.";
  updated.textContent = generatedAt ? new Date(generatedAt).toLocaleTimeString() : "";
  const down = peers.filter((peer) => peer && peer.ok === false).map((peer) => String(peer.name));
  peerNote.textContent = down.length
    ? (down.length === 1 ? down[0] + " is" : down.join(", ") + " are") +
      " not answering, so " +
      (down.length === 1 ? "its" : "their") +
      " boards are missing from this list."
    : "";
  peerNote.hidden = !down.length;
}

function showNote(text, tone = "") {
  note.textContent = text;
  note.dataset.tone = tone;
  note.hidden = !text;
}

function buildHubQuery({ offset = 0, limit = DEFAULT_PAGE_LIMIT } = {}) {
  const params = new URLSearchParams();
  const q = search.value.trim();
  const tag = tagFilter.value.trim();
  if (q) params.set("q", q);
  if (tag) params.set("tag", tag);
  if (!q && !tag) params.set("state", showing);
  params.set("limit", String(limit));
  if (offset > 0) params.set("offset", String(offset));
  return "/api/hub?" + params.toString();
}

async function refresh({ resetLimit = false } = {}) {
  clearTimeout(eventRefreshTimer);
  eventRefreshTimer = undefined;
  activeFetchController?.abort();
  const controller = new AbortController();
  activeFetchController = controller;
  const desiredLimit = resetLimit
    ? DEFAULT_PAGE_LIMIT
    : Math.max(DEFAULT_PAGE_LIMIT, Math.min(boards.length || DEFAULT_PAGE_LIMIT, 200));
  try {
    const response = await fetch(buildHubQuery({ offset: 0, limit: desiredLimit }), {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("hub request failed: " + response.status);
    const data = await response.json();
    if (activeFetchController !== controller) return;
    boards = Array.isArray(data.boards) ? data.boards : [];
    peers = Array.isArray(data.peers) ? data.peers : [];
    if (data.counts && typeof data.counts === "object") serverCounts = data.counts;
    if (data.open_summary && typeof data.open_summary === "object") serverOpenSummary = data.open_summary;
    if (Array.isArray(data.tags)) serverTags = data.tags;
    totalMatching = typeof data.total === "number" ? data.total : boards.length;
    hasMore = Boolean(data.has_more);
    if (data.notify_settings && typeof data.notify_settings === "object" && !Array.isArray(data.notify_settings)) {
      notifySettings = data.notify_settings;
      syncGlobalNotifyPeople();
      renderNotificationsPanel();
    }
    generatedAt = String(data.generated_at || "");
    if (note.dataset.tone === "offline") showNote("");
    if (!list.contains(document.activeElement) || !document.activeElement?.matches("input")) render();
  } catch (error) {
    if (/** @type {any} */ (error)?.name === "AbortError") return;
    showNote("Lavish is not answering. The list below may be out of date.", "offline");
  }
}

async function loadMore() {
  if (loadingMore || !hasMore) return;
  loadingMore = true;
  render();
  try {
    const response = await fetch(buildHubQuery({ offset: boards.length, limit: DEFAULT_PAGE_LIMIT }), {
      cache: "no-store",
    });
    if (!response.ok) throw new Error("hub request failed: " + response.status);
    const data = await response.json();
    const seen = new Set(boards.map((board) => board.key));
    for (const board of Array.isArray(data.boards) ? data.boards : []) {
      if (board && !seen.has(board.key)) {
        seen.add(board.key);
        boards.push(board);
      }
    }
    if (data.counts && typeof data.counts === "object") serverCounts = data.counts;
    if (data.open_summary && typeof data.open_summary === "object") serverOpenSummary = data.open_summary;
    if (Array.isArray(data.tags)) serverTags = data.tags;
    totalMatching = typeof data.total === "number" ? data.total : boards.length;
    hasMore = Boolean(data.has_more);
    generatedAt = String(data.generated_at || generatedAt);
  } catch {
    showNote("Could not load more boards. Try again.", "error");
  } finally {
    loadingMore = false;
    render();
  }
}

function scheduleEventRefresh() {
  if (eventRefreshTimer) return;
  eventRefreshTimer = setTimeout(() => {
    eventRefreshTimer = undefined;
    void refresh();
  }, HUB_EVENT_DEBOUNCE_MS);
}

function connectHubEvents() {
  if (typeof WebSocket !== "function") return;
  clearTimeout(wsReconnectTimer);
  wsReconnectTimer = undefined;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  let socket;
  try {
    socket = new WebSocket(protocol + "//" + location.host + "/events/hub");
  } catch {
    const delay = HUB_WS_BACKOFF_MS[Math.min(wsReconnectAttempt, HUB_WS_BACKOFF_MS.length - 1)];
    wsReconnectAttempt += 1;
    wsReconnectTimer = setTimeout(connectHubEvents, delay);
    return;
  }
  socket.addEventListener("open", () => {
    wsReconnectAttempt = 0;
    if (sawWsDisconnect) {
      sawWsDisconnect = false;
      void refresh();
    }
  });
  socket.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(String(event.data || ""));
      if (msg && (msg.type === "hub-event" || msg.type === "hub-refresh")) {
        scheduleEventRefresh();
      }
    } catch {
      // ignore malformed frames
    }
  });
  socket.addEventListener("error", () => {});
  socket.addEventListener("close", () => {
    sawWsDisconnect = true;
    const delay = HUB_WS_BACKOFF_MS[Math.min(wsReconnectAttempt, HUB_WS_BACKOFF_MS.length - 1)];
    wsReconnectAttempt += 1;
    wsReconnectTimer = setTimeout(connectHubEvents, delay);
  });
}

async function closeBoard(board) {
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

async function cancelBoard(board) {
  busy.add(board.key);
  render();
  try {
    const response = await fetch("/api/hub/" + encodeURIComponent(board.key) + "/cancel", { method: "POST" });
    if (!response.ok) throw new Error(String(response.status));
    showNote(`Cancelled "${board.title}".`, "done");
  } catch {
    showNote(`Could not cancel "${board.title}". Try again.`, "error");
  } finally {
    busy.delete(board.key);
    await refresh();
  }
}

async function reopenBoard(board) {
  busy.add(board.key);
  render();
  try {
    const response = await fetch("/api/hub/" + encodeURIComponent(board.key) + "/reopen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.status !== "opened") throw new Error(result.error || String(response.status));
    showNote(`Reopened "${board.title}".`, "done");
    showing = "open";
  } catch {
    showNote(`Could not reopen "${board.title}".`, "error");
  } finally {
    busy.delete(board.key);
    await refresh({ resetLimit: true });
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
              const who = entry.role === "agent" ? "Agent" : escapeHtml(entry.author || "You");
              const anchor = entry.anchor ? [entry.anchor.label, entry.anchor.excerpt].filter(Boolean).join(" · ") : "";
              const receipt = receiptLabel(entry);
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

function setNotifyPanelOpen(open) {
  if (!notifyPanel || !notifyToggle) return;
  notifyPanel.hidden = !open;
  notifyToggle.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) renderNotificationsPanel();
}

notifyToggle?.addEventListener("click", () => {
  const nextOpen = Boolean(notifyPanel?.hidden);
  setNotifyPanelOpen(nextOpen);
});
notifyClose?.addEventListener("click", () => {
  setNotifyPanelOpen(false);
});
notifyRows?.addEventListener("change", (event) => {
  const input = /** @type {HTMLInputElement | null} */ (event.target);
  const person = input?.dataset?.notifyPerson;
  const field = input?.dataset?.notifyField;
  if (!input || !person || !field || !Object.hasOwn(notifySettings, person)) return;
  if (field === "tagged" || field === "done") {
    notifySettings[person] = { ...notifySettings[person], [field]: input.checked };
    void saveNotifySettings(false);
  } else if (field === "send_to") {
    clearTimeout(sendToSaveTimer);
    sendToSaveTimer = undefined;
    notifySettings[person] = { ...notifySettings[person], send_to: input.value.trim() };
    void saveNotifySettings(false);
  }
});
notifyRows?.addEventListener("input", (event) => {
  const input = /** @type {HTMLInputElement | null} */ (event.target);
  const person = input?.dataset?.notifyPerson;
  const field = input?.dataset?.notifyField;
  if (!input || !person || field !== "send_to" || !Object.hasOwn(notifySettings, person)) return;
  notifySettings[person] = { ...notifySettings[person], send_to: input.value.trim() };
  clearTimeout(sendToSaveTimer);
  sendToSaveTimer = setTimeout(() => {
    sendToSaveTimer = undefined;
    void saveNotifySettings(false);
  }, SEND_TO_DEBOUNCE_MS);
});
notifyRows?.addEventListener("click", (event) => {
  const button = /** @type {HTMLButtonElement | null} */ (
    /** @type {HTMLElement} */ (event.target).closest?.("button[data-notify-remove]") || null
  );
  const person = button?.dataset?.notifyRemove;
  if (!person || !Object.hasOwn(notifySettings, person)) return;
  const next = { ...notifySettings };
  delete next[person];
  notifySettings = next;
  syncGlobalNotifyPeople();
  renderNotificationsPanel();
  void saveNotifySettings(true);
});
notifyAddForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const rawName = (notifyAddInput?.value || "").trim();
  if (!rawName) return;
  const existing = Object.keys(notifySettings).find((key) => key.toLowerCase() === rawName.toLowerCase());
  if (existing) {
    setNotifyStatus(`"${existing}" is already in the list.`, true);
    return;
  }
  notifySettings = {
    ...notifySettings,
    [rawName]: { tagged: false, done: false, send_to: "" },
  };
  if (notifyAddInput) notifyAddInput.value = "";
  syncGlobalNotifyPeople();
  renderNotificationsPanel();
  void saveNotifySettings(true);
});

list.addEventListener("click", (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  const button = /** @type {HTMLButtonElement | null} */ (target.closest?.("button[data-act]") || null);
  if (!button || button.disabled) return;
  const board = boards.find((candidate) => candidate.key === button.dataset.key);
  if (!board) return;
  if (button.dataset.act === "close") closeBoard(board);
  else if (button.dataset.act === "cancel") cancelBoard(board);
  else if (button.dataset.act === "reopen") reopenBoard(board);
  else if (button.dataset.act === "history" && !board.source) showHistory(board);
});
moreBtn?.addEventListener("click", () => {
  void loadMore();
});

function switchTab(nextTab) {
  if (showing === nextTab && !search.value.trim() && !tagFilter.value) return;
  showing = nextTab;
  void refresh({ resetLimit: true });
}

tabOpen.addEventListener("click", () => switchTab("open"));
tabNeedsInput?.addEventListener("click", () => switchTab("needs-input"));
tabClosed.addEventListener("click", () => switchTab("closed"));
tabCancelled?.addEventListener("click", () => switchTab("cancelled"));
historyClose.addEventListener("click", () => {
  if (typeof history.close === "function") history.close();
  else history.removeAttribute("open");
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refresh();
});
if (location.hash === "#closed") showing = "closed";
else if (location.hash === "#needs-input") showing = "needs-input";
else if (location.hash === "#cancelled") showing = "cancelled";
else if (location.hash === "#notifications") setNotifyPanelOpen(true);

search.addEventListener("input", () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = undefined;
    void refresh({ resetLimit: true });
  }, SEARCH_DEBOUNCE_MS);
});
tagFilter.addEventListener("change", () => {
  void refresh({ resetLimit: true });
});
window.addEventListener("lavish:metadata-saved", () => {
  void refresh();
});

syncGlobalNotifyPeople();
renderNotificationsPanel();
render();
if (showing !== "open") {
  void refresh({ resetLimit: true });
}
connectHubEvents();
