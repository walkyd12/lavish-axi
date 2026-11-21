import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeNotifySendTo } from "./notify-settings.js";

const runFile = promisify(execFile);

// Lazy and bounded: destination discovery never holds up the hub's first paint.
export function createNotifyDestinations(command = "", env = process.env) {
  let expires = 0;
  let cached = { destinations: [], error: "" };
  let pending;
  return async function getDestinations() {
    if (!command) return { destinations: [], error: "" };
    if (pending) return pending;
    if (Date.now() < expires) return cached;
    pending = (async () => {
      try {
        if (!path.isAbsolute(command)) throw new Error("Use an absolute executable path");
        const { stdout } = await runFile(command, [], { env, timeout: 3000, maxBuffer: 32768, encoding: "utf8" });
        const raw = JSON.parse(stdout);
        if (!Array.isArray(raw) || raw.length > 100) throw new Error("Expected up to 100 destinations");
        const seen = new Set();
        const destinations = raw.map((entry) => {
          const id = normalizeNotifySendTo(entry?.id);
          const label = normalizeNotifySendTo(entry?.label);
          const kind = normalizeNotifySendTo(entry?.kind);
          if (!id || !label || !kind || typeof entry.ready !== "boolean" || seen.has(id)) {
            throw new Error("Invalid destination");
          }
          seen.add(id);
          return { id, label, kind, ready: entry.ready };
        });
        cached = { destinations, error: "" };
      } catch {
        cached = { destinations: [], error: "Suggested destinations are unavailable. You can still paste a URL." };
      } finally {
        expires = Date.now() + 30000;
        pending = undefined;
      }
      return cached;
    })();
    return pending;
  };
}
