// Owner status: what the process responsible for a review says about itself, so the reviewer can
// tell from the board whether anyone is there. Lavish only sees its own poll; a supervisor that
// relays feedback to a worker (and the worker's own liveness) is invisible to it. The supervisor
// reports that here - `lavish-axi owner <file> --state live --label <name> --ttl <seconds>` - and
// the chrome shows it as the presence pill in the top bar.
//
// Contract (also documented in README's CLI reference):
//   state   live      the owner is running and will see notes promptly
//           working   the owner is busy acting on feedback
//           finished  the owner is done; `detail` says who has the board now, if anyone
//           gone      the owner has stopped and nobody has taken the board
//   label   short name of the owner (a task, an agent), at most OWNER_LABEL_MAX characters
//   detail  one short line shown on hover/tap, at most OWNER_DETAIL_MAX characters
//   ttl     seconds the statement holds. A supervisor that heartbeats sets it; once it lapses
//           without a refresh the pill says the owner has not been heard from, instead of
//           claiming a liveness nobody is vouching for. Omitted means it holds until replaced.
// Clearing (`--clear`) returns the pill to Lavish's own poll presence.

export const OWNER_STATES = Object.freeze(["live", "working", "finished", "gone"]);
export const OWNER_LABEL_MAX = 60;
export const OWNER_DETAIL_MAX = 200;
export const OWNER_TTL_MAX_SECONDS = 7 * 24 * 60 * 60;

export class OwnerStatusError extends Error {
  constructor(message) {
    super(message);
    this.code = "OWNER_STATUS_INVALID";
  }
}

function cleanText(value, max) {
  if (value === undefined || value === null) return "";
  // One line of plain text: control characters would corrupt the pill and the CLI listing.
  const text = Array.from(String(value), (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? " " : char;
  })
    .join("")
    .replace(/ {2,}/g, " ")
    .trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}

/**
 * Validate a status write. Returns the record to store, or null for a clear.
 *
 * @param {{ state?: unknown, label?: unknown, detail?: unknown, ttl_seconds?: unknown, clear?: unknown }} input
 * @param {{ now?: number }} [options]
 */
export function normalizeOwnerStatus(input, { now = Date.now() } = {}) {
  if (input?.clear === true) return null;
  const state = String(input?.state ?? "");
  if (!OWNER_STATES.includes(state)) {
    throw new OwnerStatusError(`state must be one of ${OWNER_STATES.join(", ")}`);
  }
  const record = {
    state,
    label: cleanText(input?.label, OWNER_LABEL_MAX),
    detail: cleanText(input?.detail, OWNER_DETAIL_MAX),
    updated_at: new Date(now).toISOString(),
  };
  if (input?.ttl_seconds !== undefined && input?.ttl_seconds !== null) {
    const ttl = Number(input.ttl_seconds);
    if (!Number.isFinite(ttl) || ttl < 1 || ttl > OWNER_TTL_MAX_SECONDS) {
      throw new OwnerStatusError(`ttl must be between 1 and ${OWNER_TTL_MAX_SECONDS} seconds`);
    }
    record.expires_at = new Date(now + Math.floor(ttl) * 1000).toISOString();
  }
  return record;
}

/**
 * What the chrome and listings are given. `stale` is computed at serialization time, and
 * `expires_in_ms` lets a page that keeps the record turn it stale on its own clock without
 * trusting that the browser's clock agrees with the server's.
 *
 * @param {any} record
 * @param {{ now?: number }} [options]
 */
export function serializeOwnerStatus(record, { now = Date.now() } = {}) {
  if (!record || typeof record !== "object" || !OWNER_STATES.includes(record.state)) return null;
  const expiresAt = record.expires_at ? Date.parse(record.expires_at) : NaN;
  const expiresIn = Number.isFinite(expiresAt) ? expiresAt - now : null;
  return {
    state: record.state,
    label: String(record.label || ""),
    detail: String(record.detail || ""),
    updated_at: String(record.updated_at || ""),
    stale: expiresIn !== null && expiresIn <= 0,
    expires_in_ms: expiresIn === null ? null : Math.max(0, expiresIn),
  };
}
