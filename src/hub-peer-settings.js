// The state directory's single peer configuration file is authoritative after the first seed.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { AsyncMutex } from "./async-mutex.js";
import { parseHubPeers, validateHubPeer } from "./hub-peers.js";

export class HubPeerSettingsError extends Error {}

export class HubPeerSettingsStore {
  /** @param {string} stateDir @param {string} [seed] */
  constructor(stateDir, seed = "") {
    this.file = path.join(stateDir, "hub-peers.json");
    this.seed = seed;
    this.lock = new AsyncMutex();
    /** @type {import("./hub-peers.js").HubPeer[]} */
    this.peers = [];
  }

  async init() {
    let raw;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const seeded = parseHubPeers(this.seed);
      await this.persist(seeded.peers);
      return seeded.errors;
    }
    // An unreadable or malformed existing file must never fall back to the env seed.
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("hub-peers.json must contain a peer list");
    const peers = parsed.map((peer) => validateHubPeer(peer?.name, peer?.origin));
    if (new Set(peers.map((peer) => peer.name.toLowerCase())).size !== peers.length) {
      throw new Error("hub-peers.json contains duplicate names");
    }
    this.peers = peers;
    return [];
  }

  get() {
    return this.peers.map((peer) => ({ ...peer }));
  }

  /** @param {import("./hub-peers.js").HubPeer[]} peers */
  async persist(peers) {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(peers, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.file);
    this.peers = peers;
  }

  /** Scoped operations serialize so concurrent additions/removals never overwrite each other. */
  mutate(body, onSaved) {
    return this.lock.runExclusive(async () => {
      let next = this.get();
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1) {
        throw new HubPeerSettingsError("Use add: { name, origin } or remove: name");
      }
      if (Object.hasOwn(body, "add")) {
        let peer;
        try {
          peer = validateHubPeer(body.add?.name, body.add?.origin);
        } catch (error) {
          throw new HubPeerSettingsError(error.message);
        }
        if (next.some((old) => old.name.toLowerCase() === peer.name.toLowerCase())) {
          throw new HubPeerSettingsError("A hub with this name is already connected");
        }
        if (next.length >= 100) throw new HubPeerSettingsError("At most 100 hubs may be connected");
        next.push(peer);
      } else if (typeof body.remove === "string") {
        next = next.filter((peer) => peer.name.toLowerCase() !== body.remove.trim().toLowerCase());
      } else {
        throw new HubPeerSettingsError("Use add: { name, origin } or remove: name");
      }
      await this.persist(next);
      // Apply under the same lock: disk order and live configuration order must agree.
      onSaved(this.get());
      return this.get();
    });
  }
}
