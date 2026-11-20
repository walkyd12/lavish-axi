// Hub peers: other Lavish servers whose boards this hub also lists. Each peer keeps its own boards;
// this hub only reads the peer's `/api/hub` and links to the peer for everything else.
//
// LAVISH_AXI_HUB_PEERS="walkmate=http://host:4388,other=https://boards.example.com" names them.
// Unset or empty, the hub is exactly a single-server hub. A peer's answer is untrusted: every board
// is rebuilt field by field from a fixed shape, its link is built here from the configured origin
// (never taken from the peer), and a peer that is slow, down, or answers badly is skipped without
// breaking or holding up the hub for more than the one short timeout.

export const HUB_PEERS_ENV = "LAVISH_AXI_HUB_PEERS";
export const PEER_KEY_PREFIX = "peer:";
export const PEER_TIMEOUT_MS = 2000;
// After a failure, a peer is skipped without a request for this long, so a dead peer costs the
// hub's 10-second refresh nothing instead of a 2-second wait every time.
export const PEER_RETRY_AFTER_MS = 30_000;
export const PEER_MAX_BYTES = 1024 * 1024;
const PEER_MAX_BOARDS = 500;

const PEER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const BOARD_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const STATES = new Set(["taking-input", "unread", "nobody", "handed-off", "closed-user", "closed-agent", "file-gone"]);
const TONES = new Set(["good", "warn", "bad", "muted"]);
const OWNER_STATES = new Set(["live", "working", "finished", "gone"]);

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
    let url;
    try {
      url = new URL(value);
    } catch {
      errors.push(`${HUB_PEERS_ENV}: peer "${name}" has an invalid URL`);
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      errors.push(`${HUB_PEERS_ENV}: peer "${name}" must use http or https`);
      continue;
    }
    if (url.username || url.password) {
      errors.push(`${HUB_PEERS_ENV}: peer "${name}" must not carry credentials in its URL`);
      continue;
    }
    if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
      errors.push(`${HUB_PEERS_ENV}: peer "${name}" must be a bare origin; Lavish serves from the root of its host`);
      continue;
    }
    seen.add(name.toLowerCase());
    peers.push({ name, origin: url.origin });
  }
  return { peers, errors };
}

/** @param {string} key */
export function isPeerKey(key) {
  return String(key || "").startsWith(PEER_KEY_PREFIX);
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
  return {
    key: `${PEER_KEY_PREFIX}${peer.name}:${board.key}`,
    peer_key: board.key,
    tags: Array.isArray(board.tags)
      ? [
          ...new Set(
            board.tags
              .slice(0, 32)
              .map((tag) => text(tag, 64))
              .filter(Boolean),
          ),
        ]
      : [],
    creator: text(board.creator, 120),
    created_version: text(board.created_version, 40),
    served_version: text(board.served_version, 40),
    closed: status === "ended",
    search_text: text(board.search_text, 64 * 1024),
    source: peer.name,
    file: "",
    title: text(board.title, 200) || "Untitled board",
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
 * @param {{ timeoutMs?: number, maxBytes?: number, fetchImpl?: typeof fetch }} [options]
 */
export async function fetchPeerBoards(
  peer,
  { timeoutMs = PEER_TIMEOUT_MS, maxBytes = PEER_MAX_BYTES, fetchImpl = fetch } = {},
) {
  try {
    // `peers=0` asks the peer for its own boards only, so two hubs that list each other never loop.
    const response = await fetchImpl(`${peer.origin}/api/hub?peers=0`, {
      headers: { accept: "application/json" },
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(timeoutMs),
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
 * The hub's view of every peer, with a short back-off for a peer that just failed.
 *
 * @param {HubPeer[]} peers
 * @param {{ timeoutMs?: number, retryAfterMs?: number, fetchImpl?: typeof fetch, now?: () => number }} [options]
 */
export function createPeerBoardSource(
  peers,
  { timeoutMs = PEER_TIMEOUT_MS, retryAfterMs = PEER_RETRY_AFTER_MS, fetchImpl = fetch, now = Date.now } = {},
) {
  /** @type {Map<string, { until: number, error: string }>} */
  const failed = new Map();
  return async function collect() {
    const results = await Promise.all(
      peers.map(async (peer) => {
        const backoff = failed.get(peer.name);
        if (backoff && now() < backoff.until) return { peer, ok: false, boards: [], error: backoff.error };
        const result = await fetchPeerBoards(peer, { timeoutMs, fetchImpl });
        if (result.ok) failed.delete(peer.name);
        else failed.set(peer.name, { until: now() + retryAfterMs, error: result.error });
        return { peer, ...result };
      }),
    );
    return {
      boards: results.flatMap((result) => result.boards),
      peers: results.map((result) => ({
        name: result.peer.name,
        url: result.peer.origin,
        ok: result.ok,
        error: result.error || null,
      })),
    };
  };
}
