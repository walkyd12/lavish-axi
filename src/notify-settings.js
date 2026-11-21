// Generic per-person notification settings stored in one JSON file inside the Lavish state dir.
// Core Lavish does not interpret `send_to`; it validates bounds, enforces same-origin writes, and
// passes the current `notify_settings` map on every `LAVISH_AXI_ON_EVENT` payload.

import { readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { AsyncMutex } from "./async-mutex.js";

export const NOTIFY_PEOPLE_ENV = "LAVISH_AXI_NOTIFY_PEOPLE";
export const NOTIFY_SETTINGS_FILENAME = "notify-settings.json";
export const MAX_NOTIFY_PEOPLE = 100;
export const MAX_NOTIFY_PERSON_LENGTH = 64;
export const MAX_NOTIFY_SEND_TO_LENGTH = 256;

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export class NotifySettingsError extends Error {}

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
    seen.add(folded);
    seeded[name] = { tagged: false, done: false, send_to: "" };
    if (seen.size >= MAX_NOTIFY_PEOPLE) break;
  }
  return seeded;
}

/**
 * Validate and normalize an untrusted settings object from a client POST.
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
  return out;
}

/**
 * Leniently parse stored JSON on disk, dropping malformed entries without crashing.
 *
 * @param {string} rawJson
 * @returns {NotifySettingsMap}
 */
function parseStoredSettingsJson(rawJson) {
  const parsed = JSON.parse(rawJson);
  const candidate =
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    parsed.notify_settings &&
    typeof parsed.notify_settings === "object"
      ? parsed.notify_settings
      : parsed;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return {};
  /** @type {NotifySettingsMap} */
  const out = {};
  const seen = new Set();
  for (const [rawName, rawEntry] of Object.entries(candidate)) {
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
    seen.add(folded);
    out[name] = {
      tagged: rawEntry.tagged === true,
      done: rawEntry.done === true,
      send_to: sendTo,
    };
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

    async get() {
      return this.getSync();
    },

    /** @param {unknown} rawInput */
    async save(rawInput) {
      const normalized = normalizeNotifySettings(rawInput);
      return lock.runExclusive(async () => {
        initialized = true;
        await writeAtomic(normalized);
        return cloneSettings(cached);
      });
    },
  };
}
