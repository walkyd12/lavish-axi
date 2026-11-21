// Generic per-person notification settings stored in one JSON file inside the Lavish state dir.
// Core Lavish does not interpret `send_to`; it validates bounds, enforces same-origin writes, and
// passes the current `notify_settings` map on every `LAVISH_AXI_ON_EVENT` payload.

import crypto from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { AsyncMutex } from "./async-mutex.js";

export const NOTIFY_PEOPLE_ENV = "LAVISH_AXI_NOTIFY_PEOPLE";
export const NOTIFY_SETTINGS_FILENAME = "notify-settings.json";
export const MAX_NOTIFY_PEOPLE = 100;
export const MAX_NOTIFY_PERSON_LENGTH = 64;
export const MAX_NOTIFY_SEND_TO_LENGTH = 2048;
// Keeps serialized `notify_settings` at <= 32 KiB so every `LAVISH_AXI_ON_EVENT` payload stays well
// within the 64 KiB hook budget and Linux's 128 KiB single-argument `MAX_ARG_STRLEN` limit.
export const MAX_NOTIFY_SETTINGS_BYTES = 32_768;

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export class NotifySettingsError extends Error {
  /**
   * @param {string} message
   * @param {number} [statusCode]
   */
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * @typedef {{ tagged: boolean, done: boolean, send_to: string }} PersonNotifySetting
 * @typedef {Record<string, PersonNotifySetting>} NotifySettingsMap
 */

/** @param {unknown} raw */
export function normalizeNotifyPersonName(raw) {
  if (typeof raw !== "string") throw new NotifySettingsError("Person name must be text");
  const name = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (!name || name.length > MAX_NOTIFY_PERSON_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new NotifySettingsError(`Person name needs 1–${MAX_NOTIFY_PERSON_LENGTH} printable characters`);
  }
  if (FORBIDDEN_KEYS.has(name.toLowerCase())) {
    throw new NotifySettingsError("Invalid person name");
  }
  return name;
}

/** @param {unknown} raw */
export function normalizeNotifySendTo(raw) {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") throw new NotifySettingsError("Send-to value must be text");
  const cleaned = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (cleaned.length > MAX_NOTIFY_SEND_TO_LENGTH || /[\u0000-\u001f\u007f]/.test(cleaned)) {
    throw new NotifySettingsError(`Send-to value allows at most ${MAX_NOTIFY_SEND_TO_LENGTH} printable characters`);
  }
  return cleaned;
}

/** @param {NotifySettingsMap} settings */
function assertSettingsWithinByteLimit(settings) {
  if (Buffer.byteLength(JSON.stringify(settings), "utf8") > MAX_NOTIFY_SETTINGS_BYTES) {
    throw new NotifySettingsError(`Notification settings exceed the ${MAX_NOTIFY_SETTINGS_BYTES}-byte limit`);
  }
}

/** @param {NotifySettingsMap} settings */
export function settingsRevision(settings) {
  return crypto.createHash("sha256").update(JSON.stringify(settings)).digest("hex").slice(0, 16);
}

/**
 * Parse comma-separated `LAVISH_AXI_NOTIFY_PEOPLE` into an all-off settings map.
 * Invalid entries are skipped rather than crashing server startup.
 *
 * @param {string | undefined} raw
 * @returns {NotifySettingsMap}
 */
export function parseSeedNotifyPeople(raw) {
  /** @type {NotifySettingsMap} */
  const seeded = {};
  const seen = new Set();
  for (const part of String(raw || "").split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    let name;
    try {
      name = normalizeNotifyPersonName(trimmed);
    } catch {
      continue;
    }
    const folded = name.toLowerCase();
    if (seen.has(folded)) continue;
    const nextEntry = { tagged: false, done: false, send_to: "" };
    const candidate = { ...seeded, [name]: nextEntry };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_NOTIFY_SETTINGS_BYTES) break;
    seen.add(folded);
    seeded[name] = nextEntry;
    if (seen.size >= MAX_NOTIFY_PEOPLE) break;
  }
  return seeded;
}

/**
 * Validate and normalize an untrusted full-map settings object from a client POST.
 *
 * @param {unknown} raw
 * @returns {NotifySettingsMap}
 */
export function normalizeNotifySettings(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new NotifySettingsError("Notification settings must be an object");
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_NOTIFY_PEOPLE) {
    throw new NotifySettingsError(`Use at most ${MAX_NOTIFY_PEOPLE} people`);
  }
  /** @type {NotifySettingsMap} */
  const out = {};
  const seen = new Set();
  for (const [rawName, rawEntry] of entries) {
    if (FORBIDDEN_KEYS.has(rawName)) {
      throw new NotifySettingsError("Invalid person name");
    }
    const name = normalizeNotifyPersonName(rawName);
    const folded = name.toLowerCase();
    if (seen.has(folded)) {
      throw new NotifySettingsError(`"${name}" is listed twice`);
    }
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      throw new NotifySettingsError(`Settings for "${name}" must be an object`);
    }
    seen.add(folded);
    out[name] = {
      tagged: rawEntry.tagged === true,
      done: rawEntry.done === true,
      send_to: normalizeNotifySendTo(rawEntry.send_to),
    };
  }
  assertSettingsWithinByteLimit(out);
  return out;
}

/**
 * Leniently parse stored JSON on disk, dropping malformed entries without crashing.
 * Stored JSON is always a flat `person -> { tagged, done, send_to }` map so a person literally
 * named `notify_settings` round-trips identically to any other name.
 *
 * @param {string} rawJson
 * @returns {NotifySettingsMap}
 */
function parseStoredSettingsJson(rawJson) {
  const parsed = JSON.parse(rawJson);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  /** @type {NotifySettingsMap} */
  const out = {};
  const seen = new Set();
  for (const [rawName, rawEntry] of Object.entries(parsed)) {
    if (FORBIDDEN_KEYS.has(rawName)) continue;
    let name;
    try {
      name = normalizeNotifyPersonName(rawName);
    } catch {
      continue;
    }
    const folded = name.toLowerCase();
    if (seen.has(folded)) continue;
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
    let sendTo;
    try {
      sendTo = normalizeNotifySendTo(rawEntry.send_to);
    } catch {
      sendTo = "";
    }
    const entry = {
      tagged: rawEntry.tagged === true,
      done: rawEntry.done === true,
      send_to: sendTo,
    };
    const nextCandidate = { ...out, [name]: entry };
    if (Buffer.byteLength(JSON.stringify(nextCandidate), "utf8") > MAX_NOTIFY_SETTINGS_BYTES) break;
    seen.add(folded);
    out[name] = entry;
    if (seen.size >= MAX_NOTIFY_PEOPLE) break;
  }
  return out;
}

/** @param {NotifySettingsMap} map */
function cloneSettings(map) {
  /** @type {NotifySettingsMap} */
  const copy = {};
  for (const [name, entry] of Object.entries(map)) {
    copy[name] = {
      tagged: Boolean(entry.tagged),
      done: Boolean(entry.done),
      send_to: String(entry.send_to || ""),
    };
  }
  return copy;
}

function statStamp(st) {
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
}

/**
 * Find the stored key matching `targetName` (exact match first, then `.toLowerCase()`).
 *
 * @param {NotifySettingsMap} map
 * @param {string} targetName
 */
function findPersonKey(map, targetName) {
  if (Object.hasOwn(map, targetName)) return targetName;
  const folded = targetName.toLowerCase();
  for (const key of Object.keys(map)) {
    if (key.toLowerCase() === folded) return key;
  }
  return null;
}

/**
 * Manage `<stateDir>/notify-settings.json`. Seeds once from `seedPeople` only when the settings
 * file does not exist yet; thereafter the file is the single source of truth.
 *
 * @param {string} stateDir
 * @param {{ seedPeople?: string }} [options]
 */
export function createNotifySettingsStore(stateDir, { seedPeople = "" } = {}) {
  const filePath = path.join(stateDir, NOTIFY_SETTINGS_FILENAME);
  const lock = new AsyncMutex();
  /** @type {NotifySettingsMap} */
  let cached = {};
  let cachedStamp = "";
  let initialized = false;
  let writeSeq = 0;

  async function readLatestUnderLock() {
    try {
      const st = await stat(filePath, { bigint: true });
      const stamp = statStamp(st);
      if (stamp !== cachedStamp) {
        cached = parseStoredSettingsJson(await readFile(filePath, "utf8"));
        cachedStamp = stamp;
      }
      initialized = true;
      return cloneSettings(cached);
    } catch (error) {
      if (/** @type {any} */ (error)?.code === "ENOENT") {
        if (!initialized) {
          return parseSeedNotifyPeople(seedPeople);
        }
        cached = {};
        cachedStamp = "";
        return {};
      }
      return cloneSettings(cached);
    }
  }

  async function writeAtomic(settings) {
    await mkdir(stateDir, { recursive: true });
    writeSeq += 1;
    const tmp = `${filePath}.${process.pid}.${writeSeq}.tmp`;
    const serialized = `${JSON.stringify(settings, null, 2)}\n`;
    await writeFile(tmp, serialized, { mode: 0o600 });
    await rename(tmp, filePath);
    const st = await stat(filePath, { bigint: true });
    cached = cloneSettings(settings);
    cachedStamp = statStamp(st);
  }

  return {
    filePath,

    async init() {
      return lock.runExclusive(async () => {
        try {
          const st = await stat(filePath, { bigint: true });
          const raw = await readFile(filePath, "utf8");
          cached = parseStoredSettingsJson(raw);
          cachedStamp = statStamp(st);
          initialized = true;
          return cloneSettings(cached);
        } catch (error) {
          if (/** @type {any} */ (error)?.code !== "ENOENT") {
            cached = {};
            cachedStamp = "";
            initialized = true;
            return {};
          }
          const seeded = parseSeedNotifyPeople(seedPeople);
          initialized = true;
          if (Object.keys(seeded).length > 0) {
            await writeAtomic(seeded);
          } else {
            cached = {};
            cachedStamp = "";
          }
          return cloneSettings(cached);
        }
      });
    },

    getSync() {
      try {
        const st = statSync(filePath, { bigint: true });
        const stamp = statStamp(st);
        if (stamp !== cachedStamp) {
          cached = parseStoredSettingsJson(readFileSync(filePath, "utf8"));
          cachedStamp = stamp;
          initialized = true;
        }
        return cloneSettings(cached);
      } catch (error) {
        if (/** @type {any} */ (error)?.code === "ENOENT") {
          if (!initialized) return parseSeedNotifyPeople(seedPeople);
          cached = {};
          cachedStamp = "";
          return {};
        }
        return cloneSettings(cached);
      }
    },

    revision() {
      return settingsRevision(this.getSync());
    },

    async get() {
      return this.getSync();
    },

    /**
     * Seed from a comma-separated list ONLY when `notify-settings.json` does not exist yet.
     * Once the file exists on disk (even if `{}`), it remains the sole source of truth.
     *
     * @param {string | undefined} rawSeed
     */
    async seedIfMissing(rawSeed) {
      return lock.runExclusive(async () => {
        try {
          const st = await stat(filePath, { bigint: true });
          const stamp = statStamp(st);
          if (stamp !== cachedStamp) {
            cached = parseStoredSettingsJson(await readFile(filePath, "utf8"));
            cachedStamp = stamp;
          }
          initialized = true;
          return cloneSettings(cached);
        } catch (error) {
          if (/** @type {any} */ (error)?.code !== "ENOENT") {
            return cloneSettings(cached);
          }
          const seeded = parseSeedNotifyPeople(rawSeed);
          initialized = true;
          if (Object.keys(seeded).length > 0) {
            await writeAtomic(seeded);
          }
          return cloneSettings(cached);
        }
      });
    },

    /** @param {unknown} rawName */
    async addPerson(rawName) {
      const name = normalizeNotifyPersonName(rawName);
      return lock.runExclusive(async () => {
        const current = await readLatestUnderLock();
        const existingKey = findPersonKey(current, name);
        if (existingKey) {
          throw new NotifySettingsError(`"${existingKey}" is already in the list.`, 409);
        }
        if (Object.keys(current).length >= MAX_NOTIFY_PEOPLE) {
          throw new NotifySettingsError(`Use at most ${MAX_NOTIFY_PEOPLE} people`);
        }
        const next = {
          ...current,
          [name]: { tagged: false, done: false, send_to: "" },
        };
        assertSettingsWithinByteLimit(next);
        initialized = true;
        await writeAtomic(next);
        return cloneSettings(cached);
      });
    },

    /** @param {unknown} rawName */
    async removePerson(rawName) {
      const name = normalizeNotifyPersonName(rawName);
      return lock.runExclusive(async () => {
        const current = await readLatestUnderLock();
        const existingKey = findPersonKey(current, name);
        const next = { ...current };
        if (existingKey) {
          delete next[existingKey];
        }
        initialized = true;
        await writeAtomic(next);
        return cloneSettings(cached);
      });
    },

    /**
     * Scoped field-level update for one existing person so concurrent edits in separate browser
     * tabs never overwrite another person's notification checkboxes or resurrect a removed row.
     *
     * @param {unknown} rawPatch
     */
    async patchPerson(rawPatch) {
      if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) {
        throw new NotifySettingsError("Notification patch must be an object");
      }
      const patch = /** @type {Record<string, unknown>} */ (rawPatch);
      const name = normalizeNotifyPersonName(patch.person);
      const hasTagged = Object.hasOwn(patch, "tagged");
      const hasDone = Object.hasOwn(patch, "done");
      const hasSendTo = Object.hasOwn(patch, "send_to");
      if (!hasTagged && !hasDone && !hasSendTo) {
        throw new NotifySettingsError("Notification patch requires at least one field");
      }
      if (hasTagged && typeof patch.tagged !== "boolean") {
        throw new NotifySettingsError("Checkbox value must be a boolean");
      }
      if (hasDone && typeof patch.done !== "boolean") {
        throw new NotifySettingsError("Checkbox value must be a boolean");
      }
      const nextSendTo = hasSendTo ? normalizeNotifySendTo(patch.send_to) : undefined;
      return lock.runExclusive(async () => {
        const current = await readLatestUnderLock();
        const existingKey = findPersonKey(current, name);
        if (!existingKey) {
          throw new NotifySettingsError(`"${name}" is no longer in the list.`, 409);
        }
        const prior = current[existingKey];
        const next = {
          ...current,
          [existingKey]: {
            tagged: hasTagged ? Boolean(patch.tagged) : prior.tagged,
            done: hasDone ? Boolean(patch.done) : prior.done,
            send_to: nextSendTo !== undefined ? nextSendTo : prior.send_to,
          },
        };
        assertSettingsWithinByteLimit(next);
        initialized = true;
        await writeAtomic(next);
        return cloneSettings(cached);
      });
    },

    /**
     * @param {unknown} rawInput
     * @param {{ expectedRevision?: string }} [options]
     */
    async save(rawInput, { expectedRevision = "" } = {}) {
      const normalized = normalizeNotifySettings(rawInput);
      return lock.runExclusive(async () => {
        if (expectedRevision) {
          const current = await readLatestUnderLock();
          if (settingsRevision(current) !== expectedRevision) {
            throw new NotifySettingsError("Notification settings changed in another tab; reload and try again.", 409);
          }
        }
        initialized = true;
        await writeAtomic(normalized);
        return cloneSettings(cached);
      });
    },
  };
}
