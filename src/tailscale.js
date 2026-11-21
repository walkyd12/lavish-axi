import { execFile } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function tailscaleCommandCandidates(platform = process.platform, env = process.env) {
  const candidates = ["tailscale"];
  if (platform === "darwin") {
    candidates.push(
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      "/Applications/Tailscale.app/Contents/MacOS/tailscale",
      "/opt/homebrew/bin/tailscale",
      "/usr/local/bin/tailscale",
    );
  } else if (platform === "win32") {
    const programFiles = env.ProgramFiles || "C:\\Program Files";
    candidates.push(`${programFiles}\\Tailscale\\tailscale.exe`);
  } else {
    candidates.push("/usr/bin/tailscale", "/usr/local/bin/tailscale");
  }
  return [...new Set(candidates)];
}

/**
 * @typedef {{ ipv4: string, magicDnsName: string }} TailscaleNet
 * @typedef {{ ipv4: null, magicDnsName: null, warning: string }} IncompleteTailscaleNet
 */

/**
 * Parse `tailscale status --json` into this machine's Tailscale IPv4 and MagicDNS
 * name, or null when Tailscale is not up. Never throws.
 * @param {string} raw
 * @returns {TailscaleNet | null}
 */
export function parseTailscaleStatus(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const state = String(data.BackendState || "");
  if (state !== "Running") return null;

  const ips = [];
  const selfIps = data.Self && Array.isArray(data.Self.TailscaleIPs) ? data.Self.TailscaleIPs : [];
  const topIps = Array.isArray(data.TailscaleIPs) ? data.TailscaleIPs : [];
  for (const ip of [...selfIps, ...topIps]) {
    if (typeof ip === "string") ips.push(ip.trim());
  }
  const ipv4 = ips.find((ip) => isIP(ip) === 4);
  if (!ipv4) return null;

  const dnsRaw = typeof data.Self?.DNSName === "string" ? data.Self.DNSName.trim() : "";
  const magicDnsName = dnsRaw.replace(/\.$/, "").toLowerCase();
  const labels = magicDnsName.split(".");
  if (
    magicDnsName.length > 253 ||
    labels.length < 2 ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    return null;
  }
  return { ipv4, magicDnsName };
}

async function resolveTailscaleCommand(command, env) {
  const candidates = path.isAbsolute(command)
    ? [command]
    : (env.PATH ?? (process.platform === "win32" ? "" : "/usr/bin:/bin")).split(path.delimiter).flatMap((directory) => {
        const candidate = path.resolve(directory, command);
        return process.platform === "win32" ? [candidate, `${candidate}.exe`] : [candidate];
      });
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Missing or inaccessible candidates must not trigger a launch attempt.
    }
  }
  return null;
}

/**
 * Detect a running Tailscale node on this machine. Missing binary, a stopped
 * tailnet, or any error returns null - never throws.
 * @param {{ execFile?: typeof execFileAsync, timeoutMs?: number, commands?: string[], now?: () => number, env?: NodeJS.ProcessEnv, resolveCommand?: typeof resolveTailscaleCommand }} [options]
 * @returns {Promise<TailscaleNet | IncompleteTailscaleNet | null>}
 */
export async function detectTailscale({
  execFile = execFileAsync,
  timeoutMs = 2000,
  commands = tailscaleCommandCandidates(),
  now = Date.now,
  env = process.env,
  resolveCommand = resolveTailscaleCommand,
} = {}) {
  const deadline = now() + timeoutMs;
  let incompleteRunningStatus = false;
  for (const command of commands) {
    if (deadline - now() <= 0) break;
    try {
      const resolvedCommand = await resolveCommand(command, env);
      if (!resolvedCommand) continue;
      const remainingMs = deadline - now();
      if (remainingMs <= 0) break;
      const { stdout } = await execFile(resolvedCommand, ["status", "--json"], {
        timeout: remainingMs,
        maxBuffer: 2_000_000,
        encoding: "utf8",
      });
      const raw = String(stdout || "");
      const status = parseTailscaleStatus(raw);
      if (status) return status;
      incompleteRunningStatus ||= isIncompleteRunningTailscaleStatus(raw);
    } catch {
      continue;
    }
  }
  if (incompleteRunningStatus) {
    return {
      ipv4: null,
      magicDnsName: null,
      warning:
        "Tailscale is running but MagicDNS is unavailable; there is no phone access. Lavish remains available on loopback.",
    };
  }
  return null;
}

export function normalizeRemoteIp(address) {
  const raw = typeof address === "string" ? address.trim() : "";
  if (!raw) return "";
  const unwrapped = raw.toLowerCase().startsWith("::ffff:") ? raw.slice(7) : raw;
  return isIP(unwrapped) ? unwrapped : "";
}

export function isLoopbackIp(address) {
  const ip = normalizeRemoteIp(address);
  if (!ip) return false;
  return ip === "::1" || ip === "127.0.0.1" || ip.startsWith("127.");
}

/**
 * Parse `tailscale whois --json` into a verified personal-device peer identity, or null when the
 * peer is this node itself, a tagged server/bot node, or lacks a user profile. Never throws.
 * @param {string} raw
 * @returns {{ loginName: string, displayName: string, nodeName: string, ip: string } | null}
 */
export function parseTailscaleWhois(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const node = data.Node && typeof data.Node === "object" ? data.Node : null;
  if (node?.SelfNode === true) return null;
  if (Array.isArray(node?.Tags) && node.Tags.length > 0) return null;
  const profile = data.UserProfile && typeof data.UserProfile === "object" ? data.UserProfile : null;
  if (!profile) return null;
  const loginName = typeof profile.LoginName === "string" ? profile.LoginName.trim() : "";
  const displayName = typeof profile.DisplayName === "string" ? profile.DisplayName.trim() : "";
  if ((!loginName && !displayName) || loginName.toLowerCase() === "tagged-devices") return null;
  const rawNodeName =
    (typeof node?.ComputedName === "string" && node.ComputedName.trim()) ||
    (typeof node?.Hostinfo?.Hostname === "string" && node.Hostinfo.Hostname.trim()) ||
    (typeof node?.Name === "string" && node.Name.trim()) ||
    "";
  const nodeName = rawNodeName.replace(/\.$/, "").toLowerCase();
  const addresses = Array.isArray(node?.Addresses) ? node.Addresses : [];
  let peerIp = "";
  for (const addr of addresses) {
    if (typeof addr !== "string") continue;
    const bare = addr.split("/")[0].trim();
    if (isIP(bare) === 4) {
      peerIp = bare;
      break;
    }
    if (!peerIp && isIP(bare)) peerIp = bare;
  }
  return { loginName, displayName, nodeName, ip: peerIp };
}

/**
 * Identify a remote Tailscale peer via `tailscale whois --json`. Loopback addresses, tagged server
 * nodes, self connections, missing binaries, and probe errors all return null - never throws.
 * @param {string | undefined} remoteAddress
 * @param {number | undefined} [remotePort]
 * @param {{ execFile?: typeof execFileAsync, timeoutMs?: number, commands?: string[], now?: () => number, env?: NodeJS.ProcessEnv, resolveCommand?: typeof resolveTailscaleCommand }} [options]
 */
export async function whoisTailscalePeer(
  remoteAddress,
  remotePort = undefined,
  {
    execFile = execFileAsync,
    timeoutMs = 1500,
    commands = tailscaleCommandCandidates(),
    now = Date.now,
    env = process.env,
    resolveCommand = resolveTailscaleCommand,
  } = {},
) {
  const ip = normalizeRemoteIp(remoteAddress);
  if (!ip || isLoopbackIp(ip)) return null;
  const hasPort = Number.isInteger(remotePort) && Number(remotePort) > 0 && Number(remotePort) <= 65535;
  const target = hasPort ? (isIP(ip) === 6 ? `[${ip}]:${remotePort}` : `${ip}:${remotePort}`) : ip;
  const deadline = now() + timeoutMs;
  for (const command of commands) {
    if (deadline - now() <= 0) break;
    try {
      const resolvedCommand = await resolveCommand(command, env);
      if (!resolvedCommand) continue;
      const remainingMs = deadline - now();
      if (remainingMs <= 0) break;
      const { stdout } = await execFile(resolvedCommand, ["whois", "--json", target], {
        timeout: remainingMs,
        maxBuffer: 512_000,
        encoding: "utf8",
      });
      const parsed = parseTailscaleWhois(String(stdout || ""));
      if (parsed) return { ...parsed, ip: parsed.ip || ip };
    } catch {
      continue;
    }
  }
  return null;
}

function isIncompleteRunningTailscaleStatus(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!data || typeof data !== "object" || String(data.BackendState || "") !== "Running") return false;
  const addresses = [
    ...(Array.isArray(data.Self?.TailscaleIPs) ? data.Self.TailscaleIPs : []),
    ...(Array.isArray(data.TailscaleIPs) ? data.TailscaleIPs : []),
  ];
  return addresses.some((address) => typeof address === "string" && isIP(address.trim()) === 4);
}
