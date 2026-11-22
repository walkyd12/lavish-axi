/* global document, location, window */
// The Lavish hub page (src/hub.js renders the shell). It bootstraps from `#hub-data`, stays synced
// over the `/events/hub` WebSocket (zero polling timers), runs search/tab/tag filtering and
// pagination on `/api/hub`, and manages per-person notification checkboxes via scoped patches.

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
let filterEpoch = 0;
let filterPending = false;
let filterFailed = false;
// Actions must use the board actually shown, even if an editor delays a live repaint.
const renderedBoards = new Map();

// "New" / "Updated" badges, shared per hub: New until anyone opens the board on its hub;
// Updated when there is activity after the last time anyone opened it.
function freshnessBadge(board) {
  if (board.status === "ended") return "";
  const opened = Date.parse(board.opened_at || "") || 0;
  if (!opened) return `<span class="fresh fresh-new">New</span>`;
  const activity = Date.parse(board.last_activity || "") || 0;
  // Anything new on the board since it was last opened (e.g. a new email's revision) makes it New again.
  return activity > opened + 5000 ? `<span class="fresh fresh-new">New</span>` : "";
}
let pendingWsRefreshAfterLoadMore = false;
/** @type {Record<string, { tagged: boolean, done: boolean, send_to: string }>} */
let notifySettings =
  initial.notify_settings && typeof initial.notify_settings === "object" && !Array.isArray(initial.notify_settings)
    ? initial.notify_settings
    : {};
let generatedAt = String(initial.generated_at || "");
let showing = "open";
let serverClients = Array.isArray(initial.clients) ? initial.clients : [];
let serverPeople = Array.isArray(initial.people) ? initial.people : [];
let viewer = Array.isArray(initial.viewer) ? initial.viewer : [];
let needsYouBoards = Array.isArray(initial.needs_you) ? initial.needs_you : [];
let needsYouTotal = Number(initial.needs_you_total) || 0;
let needsYouCount = Number(initial.needs_you_count) || 0;
let selectedClient = "";
let selectedPerson = "";
let needsInputOnly = false;
let showOlderBoards = false;
let editingClient = "";
let clientDraft = "";
let clientEditOrigin = "";
let clientEditIsPeer = false;
let savingClient = false;
let pendingClientFocus = "";
/** @type {Set<string>} */
const busy = new Set();
/** @type {ReturnType<typeof setTimeout> | undefined} */
let eventRefreshTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let searchDebounceTimer;
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const sendToSaveTimers = new Map();
/** @type {AbortController | null} */
let activeFetchController = null;
/** @type {AbortController | null} */
let loadMoreController = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let wsReconnectTimer;
let wsReconnectAttempt = 0;
let sawWsDisconnect = false;
let notifySaveChain = Promise.resolve();
let notifyDestinations = [];

const list = /** @type {HTMLOListElement} */ (document.getElementById("boards"));
const moreWrap = /** @type {HTMLDivElement | null} */ (document.getElementById("hubMoreWrap"));
const moreBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("hubMore"));
const empty = /** @type {HTMLParagraphElement} */ (document.getElementById("hubEmpty"));
const loadError = document.getElementById("hubLoadError");
const retry = document.getElementById("hubRetry");
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
const countClosed = /** @type {HTMLSpanElement | null} */ (document.getElementById("countClosed"));
const countCancelled = /** @type {HTMLSpanElement | null} */ (document.getElementById("countCancelled"));
const pinnedList = document.getElementById("needsYouBoards");
const pinnedSection = document.getElementById("needsYouSection");
const pinnedHint = document.getElementById("needsYouHint");
const pinnedMore = document.getElementById("needsYouMore");
const filters = document.getElementById("hubFilters");
const suggestions = document.getElementById("clientSuggestions");
const resultCount = document.getElementById("searchHint");
const listHeading = document.getElementById("boardListHeading");
const includeClosed = /** @type {HTMLInputElement | null} */ (document.getElementById("includeClosed"));
const showOlder = document.getElementById("showOlder");
const settings = /** @type {HTMLDialogElement | null} */ (document.getElementById("hubSettings"));
const settingsToggle = document.getElementById("settingsToggle");
const settingsClose = document.getElementById("settingsClose");
const history = /** @type {HTMLDialogElement} */ (document.getElementById("history"));
const historyTitle = /** @type {HTMLHeadingElement} */ (document.getElementById("historyTitle"));
const historyBody = /** @type {HTMLDivElement} */ (document.getElementById("historyBody"));
const historyClose = /** @type {HTMLButtonElement} */ (document.getElementById("historyClose"));

const notifyRows = /** @type {HTMLDivElement | null} */ (document.getElementById("notifyRows"));
const notifyEmpty = /** @type {HTMLParagraphElement | null} */ (document.getElementById("notifyEmpty"));
const notifyAddForm = /** @type {HTMLFormElement | null} */ (document.getElementById("notifyAddForm"));
const notifyAddInput = /** @type {HTMLInputElement | null} */ (document.getElementById("notifyAddInput"));
const notifyStatus = /** @type {HTMLParagraphElement | null} */ (document.getElementById("notifyStatus"));

const peerRows = /** @type {HTMLDivElement | null} */ (document.getElementById("peerRows"));
const peerAddForm = /** @type {HTMLFormElement | null} */ (document.getElementById("peerAddForm"));
const peerName = /** @type {HTMLInputElement | null} */ (document.getElementById("peerName"));
const peerOrigin = /** @type {HTMLInputElement | null} */ (document.getElementById("peerOrigin"));
const peerAdd = /** @type {HTMLButtonElement | null} */ (document.getElementById("peerAdd"));
const peerStatus = /** @type {HTMLParagraphElement | null} */ (document.getElementById("peerStatus"));
let peerSaving = false;

function renderPeersPanel() {
  if (!peerRows) return;
  peerRows.innerHTML = peers.length
    ? peers
        .map((peer) => {
          const status = peer.pending ? "Checking…" : peer.ok ? "ok" : "down";
          return `<div class="notify-row peer-row"><div><strong>${escapeHtml(peer.name)}</strong><p class="meta peer-url">${escapeHtml(peer.url)}</p></div><span class="peer-status" data-tone="${peer.ok ? "good" : "bad"}">${status}</span><button type="button" class="notify-remove peer-remove" data-peer-remove="${escapeHtml(peer.name)}" aria-label="Remove ${escapeHtml(peer.name)}"${peerSaving ? " disabled" : ""}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button></div>`;
        })
        .join("")
    : '<p class="meta">No hubs connected yet.</p>';
}

async function savePeerMutation(body) {
  if (peerSaving) return false;
  peerSaving = true;
  if (peerAdd) peerAdd.disabled = true;
  renderPeersPanel();
  try {
    const response = await fetch("/api/hub/peers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not save connected hubs");
    // Discard any hub fetch that began before the settings change.
    activeFetchController?.abort();
    activeFetchController = null;
    cancelLoadMore();
    peers = Array.isArray(data.peers) ? data.peers : [];
    if (peerStatus) {
      peerStatus.textContent = "Connected hubs saved.";
      peerStatus.dataset.tone = "saved";
      peerStatus.hidden = false;
    }
    void refresh();
    return true;
  } catch (error) {
    if (peerStatus) {
      peerStatus.textContent = error.message || "Could not save connected hubs";
      peerStatus.dataset.tone = "error";
      peerStatus.hidden = false;
    }
    return false;
  } finally {
    peerSaving = false;
    if (peerAdd) peerAdd.disabled = false;
    renderPeersPanel();
  }
}

peerAddForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!peerName || !peerOrigin) return;
  if (await savePeerMutation({ add: { name: peerName.value, origin: peerOrigin.value } })) {
    peerName.value = "";
    peerOrigin.value = "";
  }
});
peerRows?.addEventListener("click", (event) => {
  const button = /** @type {HTMLButtonElement | null} */ (
    /** @type {HTMLElement} */ (event.target).closest?.("button[data-peer-remove]")
  );
  if (button && !button.disabled) void savePeerMutation({ remove: button.dataset.peerRemove });
});

function syncGlobalNotifyPeople() {
  window["lavishNotifyPeople"] = [...new Set([...Object.keys(notifySettings), ...serverPeople])];
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
  if (board.state === "file-gone") return { label: "File unavailable", tone: "bad" };
  if (isCancelled(board)) return { label: "Cancelled", tone: "muted" };
  if (board.status === "ended") return { label: "Done", tone: "muted" };
  return {
    label: board.board_state_label || (isNeedsInput(board) ? "Needs input" : "Working"),
    tone: isNeedsInput(board) ? "warn" : "muted",
  };
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
  if (isClosed(board)) {
    actions.push(`<button type="button" class="act" data-act="reopen" data-key="${key}"${disabled}>Reopen</button>`);
    if (href && board.state !== "file-gone") {
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
  if (isClosed(board)) {
    actions.push(`<button type="button" class="act" data-act="reopen" data-key="${key}"${disabled}>Reopen</button>`);
    return actions.join("");
  }
  actions.push(`<a class="act primary" href="${escapeHtml(board.url)}">Open →</a>`);
  actions.push(`<button type="button" class="act" data-act="close" data-key="${key}"${disabled}>Close</button>`);
  actions.push(`<button type="button" class="act" data-act="cancel" data-key="${key}"${disabled}>Cancel</button>`);
  return actions.join("");
}

function clientHtml(board) {
  const key = escapeHtml(board.key);
  if (editingClient === board.key) {
    return `<form class="client-edit" data-client-key="${key}"><label>Client<input name="client" aria-label="Client for ${escapeHtml(board.title)}" value="${escapeHtml(clientDraft)}" maxlength="64" list="clientSuggestions" autocomplete="off"${savingClient ? " disabled" : ""}></label><button type="submit"${savingClient ? " disabled" : ""}>${savingClient ? "Saving…" : "Save"}</button><button type="button" data-client-cancel${savingClient ? " disabled" : ""}>Cancel</button></form>`;
  }
  return `<button type="button" class="client-chip" data-client-edit="${key}" aria-label="Edit client for ${escapeHtml(board.title)}">${escapeHtml(board.client || "No client")}</button>`;
}

function waitingOn(board) {
  const people = new Set(
    [...serverPeople, ...Object.keys(notifySettings), ...viewer].map((name) => name.toLowerCase()),
  );
  return (board.tags || []).filter((tag) => people.has(tag.toLowerCase())).join(", ");
}

function boardHtml(board) {
  const badge = displayBadge(board);
  const href = safeHref(board.url);
  const waiting = isNeedsInput(board) ? waitingOn(board) : "";
  return (
    `<li class="board" data-key="${escapeHtml(board.key)}">` +
    `<div class="board-head">${freshnessBadge(board)}<h3 class="board-title" title="${escapeHtml(board.title)}">${escapeHtml(board.title)}</h3></div>` +
    `<p class="board-created">${
      board.created_at
        ? `Created ${escapeHtml(new Date(board.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }))}`
        : `Created date unavailable · ${escapeHtml(
            String(board.file || board.peer_key || board.key)
              .split("/")
              .pop(),
          )}`
    }${board.artifact_revision > 1 ? ` · Revision ${escapeHtml(board.artifact_revision)}` : ""}</p>` +
    `<div class="board-summary">${clientHtml(board)}<span class="st st-${escapeHtml(badge.tone)}">${escapeHtml(badge.label)}</span><span class="activity">${escapeHtml(relativeTime(board.last_activity))}</span></div>` +
    (waiting ? `<p class="next-step">Waiting on ${escapeHtml(waiting)}</p>` : "") +
    (board.next_step
      ? `<p class="next-step" title="${escapeHtml(board.next_step)}">Next: ${escapeHtml(board.next_step)}</p>`
      : "") +
    (board.state === "file-gone"
      ? `<p class="meta">The board file is unavailable. Restore the file before reopening.</p>`
      : "") +
    `<div data-board-metadata="${escapeHtml(board.key)}" data-readonly="${Boolean(board.source)}" data-metadata="${escapeHtml(JSON.stringify(board))}"></div>` +
    `<div class="acts">${actionsHtml(board)}</div>` +
    `<details class="board-details"><summary>Details</summary>` +
    (board.source
      ? `<p class="meta">Hub: ${escapeHtml(board.source)}</p>`
      : `<p class="path">${escapeHtml(board.file)}</p>`) +
    (href
      ? `<div class="board-link"><a href="${escapeHtml(href)}">${escapeHtml(href)}</a><button type="button" class="act" data-copy-link="${escapeHtml(href)}">Copy link</button></div>`
      : "") +
    (!board.source
      ? `<button type="button" class="act" data-act="history" data-key="${escapeHtml(board.key)}">History</button>`
      : "") +
    `<p class="meta">Created by ${escapeHtml(board.creator || "Unknown")} · Created on Lavish ${escapeHtml(board.created_version || "unknown version")} · Last served on Lavish ${escapeHtml(board.served_version || "unknown version")}${board.version_behind ? " · Older Lavish version" : ""}</p>` +
    `<p class="meta">${escapeHtml(metaLine(board))}</p>` +
    `</details>` +
    `</li>`
  );
}

function renderFilters() {
  if (!filters) return;
  const chip = (label, kind, value, active) =>
    `<button type="button" class="filter-chip" data-filter="${kind}" data-value="${escapeHtml(value)}" aria-pressed="${active}">${escapeHtml(label)}</button>`;
  const clients = [...new Set([...serverClients, ...(selectedClient ? [selectedClient] : [])])];
  const peopleSeen = new Map();
  for (const name of [...serverPeople, ...Object.keys(notifySettings), ...(selectedPerson ? [selectedPerson] : [])]) {
    const k = String(name).toLowerCase();
    if (!peopleSeen.has(k)) peopleSeen.set(k, name);
  }
  const people = [...peopleSeen.values()];
  filters.innerHTML =
    `<div class="filter-group" role="group" aria-label="Status">${chip("Needs input", "needs", "", needsInputOnly)}` +
    (selectedClient || selectedPerson || needsInputOnly
      ? `<button type="button" class="filter-chip filter-clear" data-filter="clear" data-value="">✕ Clear filters</button>`
      : "") +
    `</div>` +
    (clients.length
      ? `<div class="filter-group" role="group" aria-label="Clients"><span class="filter-label">Client</span>` +
        `<select class="filter-select" data-filter-select="client" aria-label="Filter by client"><option value="">All clients</option>${clients
          .map(
            (name) =>
              `<option value="${escapeHtml(name)}"${name === selectedClient ? " selected" : ""}>${escapeHtml(name)}</option>`,
          )
          .join("")}</select>` +
        `</div>`
      : "") +
    (people.length
      ? `<div class="filter-group" role="group" aria-label="People"><span class="filter-label">People</span>${people.map((name) => chip(name, "person", name, name === selectedPerson)).join("")}</div>`
      : "");
  if (suggestions)
    suggestions.innerHTML = serverClients.map((name) => `<option value="${escapeHtml(name)}"></option>`).join("");
}

function applyViewData(data) {
  if (Array.isArray(data.clients)) serverClients = data.clients;
  if (Array.isArray(data.people)) serverPeople = data.people;
  if (Array.isArray(data.viewer)) viewer = data.viewer;
  if (Array.isArray(data.needs_you)) needsYouBoards = data.needs_you;
  if (typeof data.needs_you_total === "number") needsYouTotal = data.needs_you_total;
  if (typeof data.needs_you_count === "number") needsYouCount = data.needs_you_count;
}

// The box shows a friendly name ("Zach's Cortana DM") for known destinations; the stored value
// stays the route id. Typing a known name maps back to its id; anything else is taken as typed.
function displaySendTo(value) {
  const hit = notifyDestinations.find((item) => item.id === value);
  return hit ? hit.label : String(value || "");
}
function storedSendTo(text) {
  const clean = String(text || "").trim();
  const hit = notifyDestinations.find((item) => item.label.toLowerCase() === clean.toLowerCase());
  return hit ? hit.id : clean;
}

function destinationStatus(value) {
  const destination = notifyDestinations.find((item) => item.id === value);
  if (destination) return { label: destination.ready ? "Ready" : "Not connected", ready: destination.ready };
  return {
    label: value
      ? /^https?:\/\//i.test(value)
        ? "URL · use Send test to check"
        : "Custom · use Send test to check"
      : "Choose a destination",
    ready: false,
  };
}

function destinationOptions(value) {
  return `<option value="">Choose a destination…</option>${notifyDestinations.map((item) => `<option value="${escapeHtml(item.id)}"${value === item.id ? " selected" : ""}>${escapeHtml(item.label)} · ${item.ready ? "Ready" : "Not connected"}</option>`).join("")}`;
}

function syncDestinationRow(row, value) {
  const statusElement = row.querySelector(".destination-status");
  const status = destinationStatus(value);
  if (statusElement) {
    statusElement.textContent = status.label;
    statusElement.setAttribute("data-ready", String(status.ready));
  }
  const picker = row.querySelector("select[data-notify-pick]");
  if (picker) picker.innerHTML = destinationOptions(value);
}

function notifyRowHtml(person, cfg) {
  const safeName = escapeHtml(person);
  const index = Object.keys(notifySettings).indexOf(person);
  const status = destinationStatus(cfg.send_to);
  return (
    `<div class="notify-row" data-notify-row="${safeName}">` +
    `<div class="notify-person-head"><strong class="notify-person-name">${safeName}</strong>` +
    `<button type="button" class="notify-remove" data-notify-remove="${safeName}" aria-label="Remove ${safeName}" title="Remove ${safeName}">×</button></div>` +
    `<div class="notify-checks">` +
    `<label class="notify-check"><input type="checkbox" data-notify-person="${safeName}" data-notify-field="tagged"${cfg.tagged ? " checked" : ""}><span>When tagged</span></label>` +
    `<label class="notify-check"><input type="checkbox" data-notify-person="${safeName}" data-notify-field="done"${cfg.done ? " checked" : ""}><span>When board is done</span></label>` +
    `</div>` +
    `<label class="notify-sendto"><span>Destination</span><input type="text" data-notify-person="${safeName}" data-notify-field="send_to" value="${escapeHtml(displaySendTo(cfg.send_to))}" placeholder="Pick below, or paste a webhook URL" maxlength="2048"></label>` +
    `<label class="notify-sendto"><span>Suggested destinations</span><select data-notify-pick="${safeName}" aria-describedby="destination-status-${index}">${destinationOptions(cfg.send_to)}</select></label>` +
    `<div class="destination-check"><span class="destination-status" id="destination-status-${index}" data-ready="${status.ready}">${escapeHtml(status.label)}</span><button type="button" class="act" data-notify-test="${safeName}" aria-label="Send test for ${safeName}">Send test</button></div>` +
    `</div>`
  );
}

function renderNotificationsPanel() {
  if (!notifyRows || !notifyEmpty) return;
  const people = Object.keys(notifySettings);
  notifyEmpty.hidden = people.length > 0;
  const activeEl = /** @type {HTMLElement | null} */ (document.activeElement);
  const focusedSendTo =
    activeEl && notifyRows.contains(activeEl) && activeEl.matches?.('input[type="text"][data-notify-field="send_to"]')
      ? /** @type {HTMLInputElement} */ (activeEl)
      : null;

  if (!focusedSendTo) {
    notifyRows.innerHTML = people
      .map((person) => notifyRowHtml(person, notifySettings[person] || { tagged: false, done: false, send_to: "" }))
      .join("");
    return;
  }

  // Update rows in place so a focused `send_to` input keeps cursor position while checkboxes and
  // other people's rows sync immediately across tabs.
  const existingByPerson = new Map();
  for (const row of /** @type {NodeListOf<HTMLElement>} */ (notifyRows.querySelectorAll(".notify-row"))) {
    const key = row.dataset.notifyRow || "";
    if (!Object.hasOwn(notifySettings, key)) {
      row.remove();
    } else {
      existingByPerson.set(key, row);
    }
  }
  for (const person of people) {
    const cfg = notifySettings[person] || { tagged: false, done: false, send_to: "" };
    const existing = existingByPerson.get(person);
    if (!existing) {
      const temp = document.createElement("div");
      temp.innerHTML = notifyRowHtml(person, cfg);
      if (temp.firstElementChild) notifyRows.appendChild(temp.firstElementChild);
      continue;
    }
    for (const input of /** @type {NodeListOf<HTMLInputElement>} */ (
      existing.querySelectorAll("input[data-notify-field]")
    )) {
      const field = input.dataset.notifyField;
      if (field === "tagged") input.checked = Boolean(cfg.tagged);
      else if (field === "done") input.checked = Boolean(cfg.done);
      else if (field === "send_to" && input !== focusedSendTo && !sendToSaveTimers.has(person)) {
        input.value = displaySendTo(cfg.send_to);
      }
    }
    const field = /** @type {HTMLInputElement | null} */ (existing.querySelector('input[data-notify-field="send_to"]'));
    syncDestinationRow(existing, storedSendTo(field?.value || ""));
  }
}

function setNotifyStatus(text, isError = false) {
  if (!notifyStatus) return;
  notifyStatus.textContent = text;
  notifyStatus.dataset.tone = isError ? "error" : "saved";
  notifyStatus.hidden = !text;
}

function queueNotifyMutation(payload, { rerender = false } = {}) {
  notifySaveChain = notifySaveChain
    .then(async () => {
      try {
        const response = await fetch("/api/hub/notifications", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await response.json().catch(() => ({}));
        if (data.notify_settings && typeof data.notify_settings === "object" && !Array.isArray(data.notify_settings)) {
          notifySettings = data.notify_settings;
          syncGlobalNotifyPeople();
          if (rerender || !response.ok) renderNotificationsPanel();
        }
        if (!response.ok) throw new Error(data.error || "Could not save notification settings.");
        setNotifyStatus("Saved.");
      } catch (error) {
        setNotifyStatus(error?.message || "Could not save notification settings.", true);
      }
    })
    .catch(() => {});
  return notifySaveChain;
}

function cancelLoadMore() {
  if (loadMoreController) {
    loadMoreController.abort();
    loadMoreController = null;
  }
  loadingMore = false;
  pendingWsRefreshAfterLoadMore = false;
}

function beginFilterTransition() {
  editingClient = "";
  clientDraft = "";
  filterEpoch += 1;
  filterPending = true;
  filterFailed = false;
  hasMore = false;
  cancelLoadMore();
  activeFetchController?.abort();
  activeFetchController = null;
  render();
}

function render() {
  window.dispatchEvent(new CustomEvent("lavish:capture-metadata"));
  const expandedBoards = new Set(
    Array.from(document.querySelectorAll?.(".board-details[open]") || []).map(
      (element) => /** @type {HTMLElement} */ (element.closest(".board"))?.dataset.key,
    ),
  );
  const focusedClientKey =
    pendingClientFocus || /** @type {HTMLElement | null} */ (document.activeElement)?.dataset?.clientEdit;
  pendingClientFocus = "";
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
  if (countNeedsInput) countNeedsInput.textContent = String(needsYouCount || counts.needs_input);
  if (countClosed) countClosed.textContent = String(counts.closed);
  if (countCancelled) countCancelled.textContent = String(counts.cancelled);

  tabOpen.setAttribute("aria-pressed", showing === "open" ? "true" : "false");
  if (tabNeedsInput) tabNeedsInput.setAttribute("aria-pressed", showing === "needs-you" ? "true" : "false");
  tabClosed.setAttribute("aria-pressed", showing === "closed" ? "true" : "false");
  if (tabCancelled) tabCancelled.setAttribute("aria-pressed", showing === "cancelled" ? "true" : "false");

  const allSearch = Boolean(search.value.trim() && includeClosed?.checked);
  for (const tab of [tabOpen, tabNeedsInput, tabClosed, tabCancelled]) {
    if (allSearch) tab?.setAttribute("aria-pressed", "false");
  }
  const selected = tagFilter.value;
  let tags = serverTags;
  if (!tags) {
    const names = new Map();
    for (const tag of boards.flatMap((board) => board.tags || [])) {
      if (!names.has(tag.toLowerCase())) names.set(tag.toLowerCase(), tag);
    }
    tags = [...names.values()].sort((a, b) => a.localeCompare(b));
  }
  const shortcutTags = new Set(
    ["needs-input", ...serverPeople, ...Object.keys(notifySettings)].map((name) => name.toLowerCase()),
  );
  tags = tags.filter((tag) => !shortcutTags.has(tag.toLowerCase()));
  tagFilter.innerHTML =
    '<option value="">All tags</option>' +
    tags.map((tag) => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`).join("");
  tagFilter.value = tags.find((tag) => tag.toLowerCase() === selected.toLowerCase()) || "";

  const query = search.value.trim();
  const searching = Boolean(query || tagFilter.value);
  const hideBoards = filterPending || filterFailed;
  const pinned = hideBoards ? [] : needsYouBoards;
  const pinnedKeys = new Set(pinned.map((board) => board.key));
  const remaining = (hideBoards ? [] : boards).filter((board) => !pinnedKeys.has(board.key));
  renderedBoards.clear();
  for (const board of [...pinned, ...remaining]) renderedBoards.set(board.key, { ...board });
  if (pinnedList) pinnedList.innerHTML = pinned.map(boardHtml).join("");
  if (pinnedSection) pinnedSection.hidden = pinned.length === 0;
  if (pinnedHint) pinnedHint.textContent = `${needsYouTotal} ${needsYouTotal === 1 ? "board" : "boards"}`;
  if (pinnedMore) pinnedMore.hidden = pinned.length >= needsYouTotal || showing === "needs-you";
  list.innerHTML = remaining.map(boardHtml).join("");
  if (listHeading) {
    listHeading.hidden = remaining.length === 0;
    listHeading.textContent =
      query && includeClosed?.checked
        ? "Search results"
        : showing === "closed"
          ? "Closed boards"
          : showing === "cancelled"
            ? "Cancelled boards"
            : showing === "needs-you"
              ? "Needs you"
              : pinned.length
                ? "Other open boards"
                : "Open boards";
  }
  if (resultCount)
    resultCount.textContent = filterPending
      ? "Searching…"
      : filterFailed
        ? "Could not load boards."
        : `${totalMatching} ${totalMatching === 1 ? "board" : "boards"} · ${query && includeClosed?.checked ? "Including closed and cancelled" : showing === "open" ? "Open" : showing === "needs-you" ? "Needs you" : showing === "closed" ? "Closed" : "Cancelled"}${(showing === "closed" || showing === "cancelled") && !showOlderBoards && !query ? " · Last 14 days" : ""}`;
  if (showOlder)
    showOlder.hidden =
      hideBoards || !(showing === "closed" || showing === "cancelled") || showOlderBoards || Boolean(query);
  if (loadError) loadError.hidden = !filterFailed;
  renderFilters();
  window.dispatchEvent(new CustomEvent("lavish:render-metadata"));
  for (const details of document.querySelectorAll?.(".board-details") || []) {
    if (expandedBoards.has(/** @type {HTMLElement} */ (details.closest(".board"))?.dataset.key))
      /** @type {HTMLDetailsElement} */ (details).open = true;
  }
  if (focusedClientKey) {
    const chip = Array.from(document.querySelectorAll?.("[data-client-edit]") || []).find(
      (element) => /** @type {HTMLElement} */ (element).dataset.clientEdit === focusedClientKey,
    );
    /** @type {HTMLElement | undefined} */ (chip)?.focus();
  }

  if (moreWrap && moreBtn) {
    const showMore = hasMore && !hideBoards;
    moreWrap.hidden = !showMore;
    moreBtn.disabled = loadingMore;
    const visibleCount = new Set([...boards, ...pinned].map((board) => board.key)).size;
    moreBtn.textContent = loadingMore
      ? "Loading…"
      : totalMatching > boards.length
        ? `Load more (${visibleCount} of ${totalMatching})`
        : "Load more";
  }

  empty.hidden = boards.length > 0 || pinned.length > 0 || hideBoards;
  empty.textContent = searching
    ? "No matching boards."
    : showing === "needs-you"
      ? "No boards waiting on input."
      : showing === "cancelled"
        ? "No cancelled boards."
        : showing === "closed"
          ? "No closed boards yet."
          : "No open boards.";

  const listening = openSummary.listening || 0;
  const unread = openSummary.unread || 0;
  pill.textContent = unread
    ? plural(unread, "board has unread notes", "boards have unread notes")
    : plural(listening, "board live", "boards live");
  pill.dataset.tone = unread ? "warn" : listening ? "good" : "muted";
  lede.textContent = needsYouCount
    ? `${needsYouCount} ${needsYouCount === 1 ? "board needs" : "boards need"} your attention.`
    : "Open a board to review it or send a message.";
  updated.textContent = generatedAt ? new Date(generatedAt).toLocaleTimeString() : "";
  const down = peers.filter((peer) => peer && peer.ok === false && !peer.pending).map((peer) => String(peer.name));
  peerNote.textContent = down.length
    ? (down.length === 1 ? down[0] + " is" : down.join(", ") + " are") +
      " not answering, so " +
      (down.length === 1 ? "its" : "their") +
      " boards are missing from this list."
    : "";
  peerNote.hidden = !down.length;
  renderPeersPanel();
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
  if (!(q && includeClosed?.checked)) params.set("state", showing);
  if (selectedClient) params.set("client", selectedClient);
  if (selectedPerson) params.set("person", selectedPerson);
  if (needsInputOnly) params.set("needs_input", "1");
  if ((showing === "closed" || showing === "cancelled") && !showOlderBoards && !q) params.set("recent", "1");
  params.set("limit", String(limit));
  if (offset > 0) params.set("offset", String(offset));
  return "/api/hub?" + params.toString();
}

async function refresh({ resetLimit = false } = {}) {
  clearTimeout(eventRefreshTimer);
  eventRefreshTimer = undefined;
  if (!resetLimit) {
    if (searchDebounceTimer) return;
    if (loadingMore) {
      pendingWsRefreshAfterLoadMore = true;
      return;
    }
  } else {
    cancelLoadMore();
  }
  activeFetchController?.abort();
  const controller = new AbortController();
  activeFetchController = controller;
  const reqEpoch = filterEpoch;
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
    if (activeFetchController !== controller || reqEpoch !== filterEpoch) return;
    filterPending = false;
    filterFailed = false;
    applyViewData(data);
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
    if (
      !editingClient &&
      (!(list.contains(document.activeElement) || pinnedList?.contains(document.activeElement)) ||
        !document.activeElement?.matches("input"))
    )
      render();
  } catch (error) {
    if (
      /** @type {any} */ (error)?.name === "AbortError" ||
      activeFetchController !== controller ||
      reqEpoch !== filterEpoch
    )
      return;
    filterFailed = filterPending || filterFailed;
    filterPending = false;
    render();
    showNote(filterFailed ? "" : "Lavish is not answering. The list below may be out of date.", "offline");
  }
}

async function loadMore() {
  if (loadingMore || !hasMore || filterPending || searchDebounceTimer) return;
  const reqEpoch = filterEpoch;
  const queryUrl = buildHubQuery({ offset: boards.length, limit: DEFAULT_PAGE_LIMIT });
  const controller = new AbortController();
  loadMoreController = controller;
  loadingMore = true;
  render();
  try {
    const response = await fetch(queryUrl, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("hub request failed: " + response.status);
    const data = await response.json();
    if (loadMoreController !== controller || reqEpoch !== filterEpoch) return;
    applyViewData(data);
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
  } catch (error) {
    if (
      /** @type {any} */ (error)?.name === "AbortError" ||
      loadMoreController !== controller ||
      reqEpoch !== filterEpoch
    ) {
      return;
    }
    showNote("Could not load more boards. Try again.", "error");
  } finally {
    if (loadMoreController === controller) {
      loadMoreController = null;
      loadingMore = false;
      render();
      if (pendingWsRefreshAfterLoadMore) {
        pendingWsRefreshAfterLoadMore = false;
        scheduleEventRefresh();
      }
    }
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
    const response = await fetch("/api/hub/" + encodeURIComponent(board.key) + "/close", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ peer_origin: board.peer_origin }),
    });
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
    const response = await fetch("/api/hub/" + encodeURIComponent(board.key) + "/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ peer_origin: board.peer_origin }),
    });
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
      body: JSON.stringify({ peer_origin: board.peer_origin }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.status !== "opened") throw new Error(result.error || String(response.status));
    showNote(`Reopened "${board.title}".`, "done");
    if (showing !== "open") {
      showing = "open";
      beginFilterTransition();
    }
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
  if (!settings) return;
  if (open) {
    settings.showModal();
    renderNotificationsPanel();
    renderPeersPanel();
    void fetch("/api/hub/notification-destinations", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return response.json();
      })
      .then((data) => {
        notifyDestinations = Array.isArray(data.destinations) ? data.destinations : [];
        renderNotificationsPanel();
        if (data.error) setNotifyStatus(data.error, true);
      })
      .catch(() => setNotifyStatus("Suggested destinations are unavailable. You can still paste a URL.", true));
  } else settings.close();
  settingsToggle?.setAttribute("aria-expanded", String(open));
}
settingsToggle?.addEventListener("click", () => setNotifyPanelOpen(true));
settingsClose?.addEventListener("click", () => setNotifyPanelOpen(false));
function switchSettingsPanel(peersOpen) {
  const notifications = document.getElementById("notifyPanel");
  const connections = document.getElementById("peerPanel");
  if (notifications) notifications.hidden = peersOpen;
  if (connections) connections.hidden = !peersOpen;
  document.getElementById("settingsNotifications")?.setAttribute("aria-pressed", String(!peersOpen));
  document.getElementById("settingsPeers")?.setAttribute("aria-pressed", String(peersOpen));
}
document.getElementById("settingsNotifications")?.addEventListener("click", () => switchSettingsPanel(false));
document.getElementById("settingsPeers")?.addEventListener("click", () => switchSettingsPanel(true));
settings?.addEventListener("close", () => {
  settingsToggle?.setAttribute("aria-expanded", "false");
  settingsToggle?.focus();
});
settings?.addEventListener("click", (event) => {
  if (event.target === settings) setNotifyPanelOpen(false);
});

notifyRows?.addEventListener("change", (event) => {
  const select = /** @type {HTMLSelectElement} */ (event.target);
  const pickedPerson = select.dataset?.notifyPick;
  if (pickedPerson && select.value && Object.hasOwn(notifySettings, pickedPerson)) {
    const timer = sendToSaveTimers.get(pickedPerson);
    if (timer) clearTimeout(timer);
    sendToSaveTimers.delete(pickedPerson);
    const field = /** @type {HTMLInputElement | null} */ (
      select.closest("[data-notify-row]")?.querySelector('input[data-notify-field="send_to"]')
    );
    if (field) field.value = displaySendTo(select.value);
    notifySettings[pickedPerson] = { ...notifySettings[pickedPerson], send_to: select.value };
    void queueNotifyMutation({ patch: { person: pickedPerson, send_to: select.value } }, { rerender: true });
    renderNotificationsPanel();
    return;
  }
  const input = /** @type {HTMLInputElement | null} */ (event.target);
  const person = input?.dataset?.notifyPerson;
  const field = input?.dataset?.notifyField;
  if (!input || !person || !field || !Object.hasOwn(notifySettings, person)) return;
  if (field === "tagged" || field === "done") {
    const checked = Boolean(input.checked);
    notifySettings[person] = { ...notifySettings[person], [field]: checked };
    void queueNotifyMutation({ patch: { person, [field]: checked } });
  } else if (field === "send_to") {
    const existingTimer = sendToSaveTimers.get(person);
    if (existingTimer) {
      clearTimeout(existingTimer);
      sendToSaveTimers.delete(person);
    }
    const cleaned = storedSendTo(input.value);
    notifySettings[person] = { ...notifySettings[person], send_to: cleaned };
    void queueNotifyMutation({ patch: { person, send_to: cleaned } }, { rerender: true });
  }
});
notifyRows?.addEventListener("input", (event) => {
  const input = /** @type {HTMLInputElement | null} */ (event.target);
  const person = input?.dataset?.notifyPerson;
  const field = input?.dataset?.notifyField;
  if (!input || !person || field !== "send_to" || !Object.hasOwn(notifySettings, person)) return;
  const cleaned = storedSendTo(input.value);
  notifySettings[person] = { ...notifySettings[person], send_to: cleaned };
  const row = input.closest("[data-notify-row]");
  if (row) syncDestinationRow(row, cleaned);
  const existingTimer = sendToSaveTimers.get(person);
  if (existingTimer) clearTimeout(existingTimer);
  const timer = setTimeout(() => {
    sendToSaveTimers.delete(person);
    void queueNotifyMutation({ patch: { person, send_to: cleaned } }, { rerender: true });
  }, SEND_TO_DEBOUNCE_MS);
  sendToSaveTimers.set(person, timer);
});
notifyRows?.addEventListener("click", async (event) => {
  const testButton = /** @type {HTMLButtonElement | null} */ (
    /** @type {HTMLElement} */ (event.target).closest?.("button[data-notify-test]")
  );
  const testPerson = testButton?.dataset.notifyTest;
  if (testButton && testPerson && !testButton.disabled && Object.hasOwn(notifySettings, testPerson)) {
    testButton.disabled = true;
    const field = /** @type {HTMLInputElement | null} */ (
      testButton.closest("[data-notify-row]")?.querySelector('input[data-notify-field="send_to"]')
    );
    const sendTo = field ? storedSendTo(field.value) : notifySettings[testPerson].send_to;
    try {
      await notifySaveChain;
      const response = await fetch("/api/hub/notifications/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ person: testPerson, send_to: sendTo }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not send test");
      setNotifyStatus(data.message);
    } catch (error) {
      setNotifyStatus(error.message || "Could not send test", true);
    } finally {
      testButton.disabled = false;
    }
    return;
  }
  const button = /** @type {HTMLButtonElement | null} */ (
    /** @type {HTMLElement} */ (event.target).closest?.("button[data-notify-remove]") || null
  );
  const person = button?.dataset?.notifyRemove;
  if (!person || !Object.hasOwn(notifySettings, person)) return;
  if (button.dataset.armed !== "1") {
    // Two taps to remove someone, like Close/Cancel on boards: the first tap asks.
    button.dataset.armed = "1";
    button.classList.add("armed");
    button.textContent = "Tap again to remove";
    setTimeout(() => {
      if (!button.isConnected) return;
      button.dataset.armed = "";
      button.classList.remove("armed");
      button.textContent = "×";
    }, 4000);
    return;
  }
  const pendingTimer = sendToSaveTimers.get(person);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    sendToSaveTimers.delete(person);
  }
  const next = { ...notifySettings };
  delete next[person];
  notifySettings = next;
  syncGlobalNotifyPeople();
  renderNotificationsPanel();
  void queueNotifyMutation({ remove: person }, { rerender: true });
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
  void queueNotifyMutation({ add: rawName }, { rerender: true });
});

function handleBoardClick(event) {
  const target = /** @type {HTMLElement} */ (event.target);
  const button = /** @type {HTMLButtonElement | null} */ (target.closest?.("button[data-act]") || null);
  if (!button || button.disabled) return;
  const board = renderedBoards.get(button.dataset.key);
  if (!board) return;
  if (button.dataset.act === "close" || button.dataset.act === "cancel") {
    // Two-tap confirm so nobody closes or cancels a board by accident: the first tap arms the
    // button for a few seconds, the second tap does it.
    if (button.dataset.armed !== "1") {
      const original = button.textContent || "";
      button.dataset.armed = "1";
      button.dataset.originalLabel = original;
      button.classList.add("armed");
      button.textContent = button.dataset.act === "close" ? "Tap again to close" : "Tap again to cancel";
      setTimeout(() => {
        if (button.dataset.armed === "1") {
          button.dataset.armed = "";
          button.classList.remove("armed");
          button.textContent = button.dataset.originalLabel || original;
        }
      }, 4000);
      return;
    }
    button.dataset.armed = "";
    button.classList.remove("armed");
    return button.dataset.act === "close" ? closeBoard(board) : cancelBoard(board);
  } else if (button.dataset.act === "reopen") return reopenBoard(board);
  else if (button.dataset.act === "history" && !board.source) showHistory(board);
}
list.addEventListener("click", handleBoardClick);
pinnedList?.addEventListener("click", handleBoardClick);
moreBtn?.addEventListener("click", () => {
  void loadMore();
});
retry?.addEventListener("click", () => {
  beginFilterTransition();
  return refresh({ resetLimit: true });
});

function switchTab(nextTab) {
  if (showing === nextTab && !search.value.trim() && !tagFilter.value && !includeClosed?.checked) return;
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = undefined;
  showing = nextTab;
  if (includeClosed) includeClosed.checked = false;
  showOlderBoards = false;
  beginFilterTransition();
  void refresh({ resetLimit: true });
}

tabOpen.addEventListener("click", () => switchTab("open"));
tabNeedsInput?.addEventListener("click", () => switchTab("needs-you"));
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
else if (location.hash === "#needs-input") showing = "needs-you";
else if (location.hash === "#cancelled") showing = "cancelled";
else if (location.hash === "#notifications") setNotifyPanelOpen(true);

search.addEventListener("input", () => {
  clearTimeout(searchDebounceTimer);
  beginFilterTransition();
  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = undefined;
    void refresh({ resetLimit: true });
  }, SEARCH_DEBOUNCE_MS);
});
tagFilter.addEventListener("change", () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = undefined;
  beginFilterTransition();
  void refresh({ resetLimit: true });
});
window.addEventListener("lavish:metadata-saved", () => {
  void refresh();
});

syncGlobalNotifyPeople();
renderNotificationsPanel();
render();
if (showing !== "open") {
  beginFilterTransition();
  void refresh({ resetLimit: true });
} else if (peers.some((peer) => peer && peer.pending)) {
  void refresh();
}
connectHubEvents();

filters?.addEventListener("change", (event) => {
  const select = /** @type {HTMLSelectElement | null} */ (
    /** @type {HTMLElement} */ (event.target).closest?.("select[data-filter-select]")
  );
  if (!select || select.dataset.filterSelect !== "client") return;
  selectedClient = select.value || "";
  beginFilterTransition();
  void refresh({ resetLimit: true });
});

filters?.addEventListener("click", (event) => {
  const button = /** @type {HTMLElement | null} */ (
    /** @type {HTMLElement} */ (event.target).closest?.("button[data-filter]")
  );
  if (!button) return;
  const value = button.dataset.value || "";
  if (button.dataset.filter === "clear") {
    selectedClient = "";
    selectedPerson = "";
    needsInputOnly = false;
  } else if (button.dataset.filter === "client") selectedClient = selectedClient === value ? "" : value;
  else if (button.dataset.filter === "person") selectedPerson = selectedPerson === value ? "" : value;
  else needsInputOnly = !needsInputOnly;
  beginFilterTransition();
  void refresh({ resetLimit: true });
});
includeClosed?.addEventListener("change", () => {
  beginFilterTransition();
  void refresh({ resetLimit: true });
});
showOlder?.addEventListener("click", () => {
  showOlderBoards = true;
  beginFilterTransition();
  void refresh({ resetLimit: true });
});
pinnedMore?.addEventListener("click", () => switchTab("needs-you"));

document.addEventListener("click", async (event) => {
  const copy = /** @type {HTMLButtonElement | null} */ (
    /** @type {HTMLElement} */ (event.target).closest?.("[data-copy-link]")
  );
  if (copy) {
    try {
      const value = copy.dataset.copyLink || "";
      let copied = false;
      if (window.navigator.clipboard?.writeText) {
        try {
          await window.navigator.clipboard.writeText(value);
          copied = true;
        } catch {
          /* Fall back for plain-http origins and denied clipboard permissions. */
        }
      }
      if (!copied) {
        const textarea = document.createElement("textarea");
        textarea.value = value;
        textarea.setAttribute("aria-label", "Board link");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        try {
          textarea.select();
          if (!document.execCommand("copy")) throw new Error("Copy unavailable");
        } finally {
          textarea.remove();
          copy.focus();
        }
      }
      copy.textContent = "Copied";
    } catch {
      showNote("Copy is unavailable here. Select the link in Details to copy it.", "error");
    }
    return;
  }
  const button = /** @type {HTMLElement | null} */ (
    /** @type {HTMLElement} */ (event.target).closest?.("[data-client-edit], [data-client-cancel]")
  );
  if (!button || savingClient) return;
  if (button.hasAttribute("data-client-cancel")) {
    pendingClientFocus = editingClient;
    editingClient = "";
    render();
    return;
  }
  const board = [...boards, ...needsYouBoards].find((item) => item.key === button.dataset.clientEdit);
  if (!board) return;
  editingClient = board.key;
  clientEditOrigin = board.peer_origin || "";
  clientEditIsPeer = Boolean(board.source);
  clientDraft = board.client || "";
  render();
  const input = /** @type {HTMLInputElement | null} */ (document.querySelector(".client-edit input"));
  input?.focus();
  input?.select();
});
document.addEventListener("input", (event) => {
  const input = /** @type {HTMLInputElement} */ (event.target);
  if (input.matches?.(".client-edit input")) clientDraft = input.value;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && editingClient && !savingClient) {
    event.preventDefault();
    pendingClientFocus = editingClient;
    editingClient = "";
    render();
  }
});
document.addEventListener("submit", async (event) => {
  const form = /** @type {HTMLFormElement} */ (event.target);
  if (!form.matches?.(".client-edit")) return;
  event.preventDefault();
  if (savingClient) return;
  const board = [...boards, ...needsYouBoards].find((item) => item.key === form.dataset.clientKey);
  if (!board) {
    editingClient = "";
    render();
    showNote("This board is no longer in this view. Refresh to edit it.", "error");
    return;
  }
  savingClient = true;
  render();
  try {
    const response = await fetch(`/api/${encodeURIComponent(board.key)}/metadata`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client: clientDraft.trim(),
        ...(clientEditIsPeer ? { peer_origin: clientEditOrigin } : {}),
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not save client");
    board.client = result.client;
    pendingClientFocus = editingClient;
    editingClient = "";
    window.dispatchEvent(new CustomEvent("lavish:metadata-saved", { detail: { key: board.key, ...result } }));
    showNote("Client saved.", "done");
  } catch (error) {
    showNote(error.message || "Could not save client", "error");
  } finally {
    savingClient = false;
    render();
  }
});
if (initial.identify_viewer) {
  void fetch("/api/hub/viewer", { cache: "no-store" })
    .then((response) => response.json())
    .then((data) => {
      if (Array.isArray(data.viewer) && data.viewer.length) {
        viewer = data.viewer;
        void refresh();
      }
    })
    .catch(() => {});
}
