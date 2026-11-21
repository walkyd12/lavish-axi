// Hub peers: other Lavish servers whose boards this hub also lists. Each peer keeps its own boards;
// this hub only reads the peer's `/api/hub` and links to the peer for everything else.
//
// LAVISH_AXI_HUB_PEERS="walkmate=http://host:4388,other=https://boards.example.com" names them.
// Unset or empty, the hub is exactly a single-server hub. A peer's answer is untrusted: every board
// is rebuilt field by field from a fixed shape, its link is built here from the configured origin
// (never taken from the peer), and a peer that is slow, down, or answers badly is skipped without
// breaking or holding up the hub for more than the one short timeout.

import { boardWorkflowState } from "./board-metadata.js";

export const HUB_PEERS_ENV = "LAVISH_AXI_HUB_PEERS";
export const PEER_KEY_PREFIX = "peer:";
export const PEER_TIMEOUT_MS = 2000;
// After a failure, a peer is skipped without a request for this long, so a dead peer costs a hub
// refresh nothing instead of a 2-second wait every time.
export const PEER_RETRY_AFTER_MS = 30_000;
export const PEER_MAX_BOARDS = 500;
// Sized for PEER_MAX_BOARDS at the 64 KiB per-board search_text ceiling plus metadata and JSON escaping.
export const PEER_MAX_BYTES = 64 * 1024 * 1024;

const PEER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const BOARD_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const STATES = new Set(["taking-input", "unread", "nobody", "handed-off", "closed-user", "closed-agent", "file-gone"]);
const TONES = new Set(["good", "warn", "bad", "muted"]);
const OWNER_STATES = new Set(["live", "working", "finished", "gone"]);
const PEER_ACTIONS = new Set(["close", "cancel", "reopen"]);
const PEER_EVENT_TYPES = new Set([
  "board_created",
  "board_reopened",
  "message",
  "board_action",
  "tag_change",
  "board_closed",
  "board_cancelled",
]);

/** @typedef {{ name: string, origin: string }} HubPeer */

/**
 * Parse `name=url` pairs, comma-separated. Bad entries are reported and dropped, never fatal: a
 * typo in one peer must not take the hub down.
 *
 * @param {string | undefined} raw
 * @returns {{ peers: HubPeer[], errors: string[] }}
 */
export function parseHubPeers(raw) {
  /** @type {HubPeer[]} */
  const peers = [];
  const errors = [];
  const seen = new Set();
  for (const part of String(raw || "").split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    const name = eq > 0 ? entry.slice(0, eq).trim() : "";
    const value = eq > 0 ? entry.slice(eq + 1).trim() : "";
    if (!PEER_NAME.test(name)) {
      errors.push(`${HUB_PEERS_ENV}: "${entry}" needs a name=url pair with a short name (letters, digits, - and _)`);
      continue;
    }
    if (seen.has(name.toLowerCase())) {
      errors.push(`${HUB_PEERS_ENV}: peer "${name}" is listed twice`);
      continue;
    }
    let peer;
    try {
      peer = validateHubPeer(name, value);
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    seen.add(name.toLowerCase());
    peers.push(peer);
  }
  return { peers, errors };
}

/** Validate a single peer using the same rules for persisted settings and env seeds.
 * @param {unknown} rawName
 * @param {unknown} rawOrigin
 * @returns {HubPeer}
 */
export function validateHubPeer(rawName, rawOrigin) {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  const value = typeof rawOrigin === "string" ? rawOrigin.trim() : "";
  if (!PEER_NAME.test(name))
    throw new Error("Hub name needs 1–32 letters, digits, - or _, starting with a letter or digit");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${HUB_PEERS_ENV}: peer "${name}" has an invalid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${HUB_PEERS_ENV}: peer "${name}" must use http or https`);
  }
  if (url.username || url.password) {
    throw new Error(`${HUB_PEERS_ENV}: peer "${name}" must not carry credentials in its URL`);
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new Error(`${HUB_PEERS_ENV}: peer "${name}" must be a bare origin; Lavish serves from the root of its host`);
  }
  return { name, origin: url.origin };
}

/** @param {string} key */
export function isPeerKey(key) {
  return String(key || "").startsWith(PEER_KEY_PREFIX);
}

/**
 * Resolve a namespaced `peer:<name>:<key>` back to its configured `HubPeer` and validated peer session key.
 * Returns null for malformed keys or peers not configured on this server.
 *
 * @param {string} key
 * @param {HubPeer[]} peers
 * @returns {{ peer: HubPeer, peerKey: string } | null}
 */
export function resolvePeerBoardTarget(key, peers) {
  const raw = String(key || "");
  if (!raw.startsWith(PEER_KEY_PREFIX)) return null;
  const rest = raw.slice(PEER_KEY_PREFIX.length);
  const colon = rest.indexOf(":");
  if (colon <= 0) return null;
  const peerName = rest.slice(0, colon);
  const peerKey = rest.slice(colon + 1);
  if (!PEER_NAME.test(peerName) || !BOARD_KEY.test(peerKey)) return null;
  const peer = (Array.isArray(peers) ? peers : []).find(
    (candidate) => candidate && candidate.name.toLowerCase() === peerName.toLowerCase(),
  );
  if (!peer) return null;
  return { peer, peerKey };
}

function sanitizeTagList(rawTags) {
  if (!Array.isArray(rawTags)) return [];
  return [
    ...new Set(
      rawTags
        .slice(0, 32)
        .map((tag) => text(tag, 64).trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * Rebuild an untrusted live event received over a peer's `/events/hub` WebSocket into the central
 * hub's namespaced peer event shape, or null when malformed or already relayed from another peer.
 *
 * @param {HubPeer} peer
 * @param {any} rawEvent
 */
export function sanitizePeerHubEvent(peer, rawEvent) {
  if (!rawEvent || typeof rawEvent !== "object" || rawEvent.source) return null;
  const event = String(rawEvent.event || "");
  const rawKey = String(rawEvent.key || "");
  if (!PEER_EVENT_TYPES.has(event) || !BOARD_KEY.test(rawKey)) return null;
  const tags = sanitizeTagList(rawEvent.tags);
  const cancelled = rawEvent.cancelled === true;
  /** @type {Record<string, any>} */
  const out = {
    event,
    key: `${PEER_KEY_PREFIX}${peer.name}:${rawKey}`,
    peer_key: rawKey,
    peer_origin: peer.origin,
    source: peer.name,
    url: `${peer.origin}/session/${rawKey}`,
    title: text(rawEvent.title, 200) || "Untitled board",
    creator: text(rawEvent.creator, 120),
    client: text(rawEvent.client, 64),
    tags,
    cancelled,
    ended_by: rawEvent.ended_by === "user" ? "user" : rawEvent.ended_by === "agent" ? "agent" : null,
    last_activity: isoOrEmpty(rawEvent.last_activity || rawEvent.at),
    search_text: text(rawEvent.search_text, 16 * 1024),
  };
  const seq = Number(rawEvent.seq);
  if (Number.isInteger(seq) && seq > 0) out.peer_seq = seq;
  if (typeof rawEvent.instance_id === "string" && rawEvent.instance_id.trim()) {
    out.peer_instance = text(rawEvent.instance_id.trim(), 64);
  }
  if (event === "tag_change") {
    if (typeof rawEvent.previous_client === "string") out.previous_client = text(rawEvent.previous_client, 64);
    out.added = sanitizeTagList(rawEvent.added);
    out.removed = sanitizeTagList(rawEvent.removed);
  }
  if (Array.isArray(rawEvent.prompts)) {
    out.prompts = rawEvent.prompts.slice(0, 32).map((prompt) => ({
      prompt: text(prompt?.prompt, 4_096),
      tag: text(prompt?.tag, 64),
      selector: text(prompt?.selector, 512),
      text: text(prompt?.text, 256),
      ...(prompt?.prompt_id ? { prompt_id: text(prompt.prompt_id, 128) } : {}),
      ...(prompt?.author ? { author: text(prompt.author, 80) } : {}),
      ...(prompt?.via === "cli" || prompt?.via === "chrome_approval" ? { via: prompt.via } : {}),
      ...(Array.isArray(prompt?.attachments)
        ? {
            attachments: prompt.attachments
              .slice(0, 16)
              .filter((att) => att && typeof att === "object" && text(att.id, 128))
              .map((att) => ({
                id: text(att.id, 128),
                ...(att.name ? { name: text(att.name, 200) } : {}),
              })),
          }
        : {}),
    }));
  }
  if (event === "board_action") {
    out.action = text(rawEvent.action, 40) || "send";
    out.action_label = text(rawEvent.action_label, 64) || "Send";
    if (rawEvent.author) out.author = text(rawEvent.author, 80);
  }
  return out;
}

async function fetchOnceOrRetryStaleSocket(fetchImpl, url, init) {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    if (/** @type {any} */ (error)?.cause?.code === "UND_ERR_SOCKET") {
      return fetchImpl(url, init);
    }
    throw error;
  }
}

/**
 * Relay one lifecycle action (`close` | `cancel` | `reopen`) to a configured peer's hub endpoint,
 * forwarding nothing from the viewer and rebuilding the response field by field.
 *
 * @param {HubPeer} peer
 * @param {string} peerKey
 * @param {"close" | "cancel" | "reopen"} action
 * @param {{ timeoutMs?: number, maxBytes?: number, fetchImpl?: typeof fetch }} [options]
 */
export async function relayPeerHubAction(
  peer,
  peerKey,
  action,
  { timeoutMs = PEER_TIMEOUT_MS, maxBytes = PEER_MAX_BYTES, fetchImpl = fetch } = {},
) {
  if (!PEER_ACTIONS.has(action) || !BOARD_KEY.test(peerKey)) {
    return { ok: false, status: 400, payload: { error: "invalid peer lifecycle action" } };
  }
  try {
    const response = await fetchOnceOrRetryStaleSocket(
      fetchImpl,
      `${peer.origin}/api/hub/${encodeURIComponent(peerKey)}/${action}`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          origin: peer.origin,
        },
        body: "{}",
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    const rawBody = await readCapped(response, maxBytes).catch(() => "");
    let parsed = null;
    try {
      parsed = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      parsed = {};
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status >= 400 && response.status < 600 ? response.status : 502,
        payload: { error: text(parsed?.error, 200) || `peer answered ${response.status}` },
      };
    }
    const closed = action === "reopen" ? false : true;
    const cancelled = action === "cancel" ? true : false;
    const tags = sanitizeTagList(parsed?.tags);
    const workflow = boardWorkflowState({
      status: closed ? "ended" : "open",
      tags,
      cancelled,
    });
    return {
      ok: true,
      status: 200,
      payload: {
        key: `${PEER_KEY_PREFIX}${peer.name}:${peerKey}`,
        peer_key: peerKey,
        source: peer.name,
        url: `${peer.origin}/session/${peerKey}`,
        status: closed ? "ended" : "opened",
        ...(closed ? { ended_by: parsed?.ended_by === "agent" ? "agent" : "user" } : {}),
        tags,
        creator: text(parsed?.creator, 120),
        created_version: text(parsed?.created_version, 40),
        served_version: text(parsed?.served_version, 40),
        closed,
        ...workflow,
      },
    };
  } catch (error) {
    const name = /** @type {any} */ (error)?.name;
    const reason = name === "TimeoutError" || name === "AbortError" ? "peer timed out" : "peer not answering";
    return { ok: false, status: 502, payload: { error: reason } };
  }
}

/** Relay only a bounded client patch to a configured peer, with no viewer credentials. */
export async function relayPeerBoardClient(
  peer,
  peerKey,
  client,
  { timeoutMs = PEER_TIMEOUT_MS, fetchImpl = fetch } = {},
) {
  if (!BOARD_KEY.test(peerKey)) return { ok: false, status: 400, payload: { error: "invalid peer key" } };
  try {
    const response = await fetchOnceOrRetryStaleSocket(
      fetchImpl,
      `${peer.origin}/api/${encodeURIComponent(peerKey)}/metadata`,
      {
        method: "PUT",
        headers: { accept: "application/json", "content-type": "application/json", origin: peer.origin },
        body: JSON.stringify({ client }),
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    const parsed = JSON.parse(await readCapped(response, 64 * 1024));
    if (!response.ok)
      return {
        ok: false,
        status: response.status,
        payload: { error: text(parsed?.error, 200) || "Could not save client on connected hub" },
      };
    return { ok: true, status: 200, payload: { client: text(parsed?.client, 64) } };
  } catch {
    return { ok: false, status: 502, payload: { error: "Connected hub is not answering" } };
  }
}

function text(value, max) {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, max);
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(Math.floor(number), 1_000_000) : 0;
}

function isoOrEmpty(value) {
  if (typeof value !== "string" || value.length > 40) return "";
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : "";
}

function peerOwner(owner) {
  if (!owner || typeof owner !== "object") return null;
  return {
    state: OWNER_STATES.has(owner.state) ? owner.state : "gone",
    label: text(owner.label, 80),
    detail: text(owner.detail, 200),
    stale: owner.stale === true,
  };
}

/**
 * One peer board rebuilt into the hub's board shape, or null when it is not a board. The key is
 * namespaced, the link points at the peer, and no local file path is carried.
 *
 * @param {HubPeer} peer
 * @param {any} board
 */
export function serializePeerBoard(peer, board) {
  if (!board || typeof board !== "object" || typeof board.key !== "string" || !BOARD_KEY.test(board.key)) return null;
  const status = board.status === "ended" ? "ended" : "open";
  const state = STATES.has(board.state) ? board.state : status === "ended" ? "closed-agent" : "nobody";
  const tags = Array.isArray(board.tags)
    ? [
        ...new Set(
          board.tags
            .slice(0, 32)
            .map((tag) => text(tag, 64))
            .filter(Boolean),
        ),
      ]
    : [];
  const workflow = boardWorkflowState({
    status,
    tags,
    cancelled: status === "ended" && board.cancelled === true,
  });
  return {
    key: `${PEER_KEY_PREFIX}${peer.name}:${board.key}`,
    peer_key: board.key,
    peer_origin: peer.origin,
    tags,
    creator: text(board.creator, 120),
    client: text(board.client, 64),
    created_version: text(board.created_version, 40),
    served_version: text(board.served_version, 40),
    closed: status === "ended",
    ...workflow,
    search_text: text(board.search_text, 64 * 1024),
    source: peer.name,
    file: "",
    title: text(board.title, 200) || "Untitled board",
    next_step: text(board.next_step, 240),
    url: `${peer.origin}/session/${board.key}`,
    status,
    ended_by: status === "ended" ? (board.ended_by === "user" ? "user" : "agent") : null,
    state,
    state_label: text(board.state_label, 40) || state,
    tone: TONES.has(board.tone) ? board.tone : "muted",
    last_activity: isoOrEmpty(board.last_activity),
    notes: count(board.notes),
    replies: count(board.replies),
    pending_prompts: count(board.pending_prompts),
    unsent_drafts: count(board.unsent_drafts),
    tabs: count(board.tabs),
    listener: text(board.listener, 120) || null,
    owner: peerOwner(board.owner),
    file_exists: board.file_exists !== false,
  };
}

async function readCapped(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("answer too large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("answer too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read one peer's boards. Never throws: a failure comes back as `{ ok: false, error }`. The request
 * carries nothing from the viewer - no cookies, no forwarded headers - and does not follow redirects.
 *
 * @param {HubPeer} peer
 * @param {{ timeoutMs?: number, maxBytes?: number, fetchImpl?: typeof fetch, signal?: AbortSignal }} [options]
 */
export async function fetchPeerBoards(
  peer,
  { timeoutMs = PEER_TIMEOUT_MS, maxBytes = PEER_MAX_BYTES, fetchImpl = fetch, signal } = {},
) {
  try {
    // `peers=0` asks the peer for its own boards only, so two hubs that list each other never loop.
    const response = await fetchOnceOrRetryStaleSocket(fetchImpl, `${peer.origin}/api/hub?peers=0`, {
      headers: { accept: "application/json" },
      redirect: "error",
      credentials: "omit",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, boards: [], error: `answered ${response.status}` };
    }
    const data = JSON.parse(await readCapped(response, maxBytes));
    if (!data || !Array.isArray(data.boards)) return { ok: false, boards: [], error: "answered without boards" };
    const boards = [];
    for (const board of data.boards.slice(0, PEER_MAX_BOARDS)) {
      const serialized = serializePeerBoard(peer, board);
      if (serialized) boards.push(serialized);
    }
    return { ok: true, boards, error: "" };
  } catch (error) {
    const name = /** @type {any} */ (error)?.name;
    const reason = name === "TimeoutError" || name === "AbortError" ? "timed out" : "not answering";
    return { ok: false, boards: [], error: reason };
  }
}

/**
 * The hub's view of every peer, with a short back-off for a peer that just failed and an optional
 * `maxWaitMs` budget so `/` never blocks first local paint behind a slow or timing-out peer.
 *
 * @param {HubPeer[]} peers
 * @param {{
 *   timeoutMs?: number,
 *   retryAfterMs?: number,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   isStreamLive?: (peerName: string) => boolean,
 *   onSettled?: () => void,
 * }} [options]
 */
export function createPeerBoardSource(
  peers,
  {
    timeoutMs = PEER_TIMEOUT_MS,
    retryAfterMs = PEER_RETRY_AFTER_MS,
    fetchImpl = fetch,
    now = Date.now,
    isStreamLive = undefined,
    onSettled = undefined,
  } = {},
) {
  /** @type {Map<string, { until: number, error: string }>} */
  const failed = new Map();
  /** @type {Map<string, { boards: any[], dirty: boolean }>} */
  const cached = new Map();
  /** @type {Map<string, Promise<{ peer: HubPeer, ok: boolean, boards: any[], error: string }>>} */
  const inFlight = new Map();
  /** @type {Map<string, number>} */
  const invalidateSeq = new Map();
  /** @type {Map<string, AbortController>} */
  const controllers = new Map();

  /** @param {HubPeer} peer */
  function startOrJoinScrape(peer) {
    const key = peer.name.toLowerCase();
    const existing = inFlight.get(key);
    if (existing) return existing;
    const seqAtStart = invalidateSeq.get(key) || 0;
    const controller = new AbortController();
    controllers.set(key, controller);
    const task = fetchPeerBoards(peer, { timeoutMs, fetchImpl, signal: controller.signal }).then((result) => {
      // Removed/replaced peers cannot repopulate caches or notify viewers after their scrape ends.
      if (controllers.get(key) !== controller) return { peer, ...result };
      controllers.delete(key);
      inFlight.delete(key);
      const invalidatedDuringFetch = (invalidateSeq.get(key) || 0) !== seqAtStart;
      if (result.ok) {
        failed.delete(peer.name);
        cached.set(key, { boards: result.boards, dirty: invalidatedDuringFetch });
      } else {
        cached.delete(key);
        failed.set(peer.name, { until: now() + retryAfterMs, error: result.error });
      }
      if (typeof onSettled === "function") {
        try {
          onSettled();
        } catch {
          // ignore viewer notification error
        }
      }
      return { peer, ...result };
    });
    inFlight.set(key, task);
    return task;
  }

  /** @param {{ maxWaitMs?: number }} [collectOptions] */
  const collect = async function collect({ maxWaitMs = undefined } = {}) {
    const hasWaitBudget = typeof maxWaitMs === "number" && Number.isFinite(maxWaitMs) && maxWaitMs >= 0;
    const results = await Promise.all(
      peers.map(async (peer) => {
        const key = peer.name.toLowerCase();
        const entry = cached.get(key);
        if (entry && !entry.dirty && typeof isStreamLive === "function" && isStreamLive(peer.name)) {
          return { peer, ok: true, boards: entry.boards, error: "", pending: false };
        }
        const backoff = failed.get(peer.name);
        if (backoff && now() < backoff.until) {
          return { peer, ok: false, boards: [], error: backoff.error, pending: false };
        }
        const scrape = startOrJoinScrape(peer);
        if (!hasWaitBudget) {
          const settled = await scrape;
          return { ...settled, pending: false };
        }
        if (maxWaitMs === 0) {
          return { peer, ok: true, boards: entry ? entry.boards : [], error: "", pending: true };
        }
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let timer;
        const raced = await Promise.race([
          scrape.then((settled) => ({ ...settled, pending: false })),
          new Promise((resolve) => {
            timer = setTimeout(
              () => resolve({ peer, ok: true, boards: entry ? entry.boards : [], error: "", pending: true }),
              maxWaitMs,
            );
            timer.unref?.();
          }),
        ]);
        clearTimeout(timer);
        return raced;
      }),
    );
    return {
      boards: results.filter((result) => peers.includes(result.peer)).flatMap((result) => result.boards),
      peers: results
        .filter((result) => peers.includes(result.peer))
        .map((result) => ({
          name: result.peer.name,
          url: result.peer.origin,
          ok: result.ok,
          ...(result.pending ? { pending: true } : {}),
          error: result.error || null,
        })),
    };
  };
  /** @param {string} [peerName] */
  collect.invalidate = (peerName) => {
    if (!peerName) {
      for (const [k, entry] of cached.entries()) {
        entry.dirty = true;
        invalidateSeq.set(k, (invalidateSeq.get(k) || 0) + 1);
      }
      for (const peer of peers) {
        const k = peer.name.toLowerCase();
        invalidateSeq.set(k, (invalidateSeq.get(k) || 0) + 1);
      }
      failed.clear();
      return;
    }
    const key = String(peerName).toLowerCase();
    invalidateSeq.set(key, (invalidateSeq.get(key) || 0) + 1);
    const entry = cached.get(key);
    if (entry) entry.dirty = true;
    for (const candidate of failed.keys()) {
      if (candidate.toLowerCase() === key) failed.delete(candidate);
    }
  };
  /** Replace configuration while keeping unchanged peers' caches and backoff. @param {HubPeer[]} next */
  collect.setPeers = (next) => {
    const retained = next.map(
      (peer) => peers.find((old) => old.name === peer.name && old.origin === peer.origin) || peer,
    );
    for (const peer of peers) {
      if (retained.includes(peer)) continue;
      const key = peer.name.toLowerCase();
      const controller = controllers.get(key);
      controllers.delete(key);
      controller?.abort();
      inFlight.delete(key);
      cached.delete(key);
      failed.delete(peer.name);
      invalidateSeq.delete(key);
    }
    peers = retained;
  };
  return collect;
}
