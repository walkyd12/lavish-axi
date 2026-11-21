import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { open as openFile, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { createServer, get as httpGet } from "node:http";
import { isIP } from "node:net";
import { homedir, hostname as osHostname, networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hubArtifactSummary } from "./hub-summary.js";
import { runApprovalPreview } from "./approval-preview.js";

import chokidar from "chokidar";
import express from "express";

import {
  BoardMetadataError,
  boardSearchText,
  boardVersionBehind,
  filterHubBoards,
  normalizeCreator,
  normalizeClient,
  serializeBoardMetadata,
} from "./board-metadata.js";
import {
  classifySevereTextOverflow,
  classifyMaterialRectEscape,
  createArtifactSdk,
  deriveAttachmentNoticeState,
  deriveLavishQueueKey,
  findStableLayoutFindings,
  isMaterialPageOverflow,
  isModeToggleHotkeyEvent,
  isNativeInteractiveControl,
  isNearTotalOcclusion,
  isTrustedAttachmentResult,
  attachmentSizeError,
  acceptedImageTypes,
  classifyAttachmentBatch,
  partitionDroppedFiles,
  planClipboardPaste,
  MODE_TOGGLE_HOTKEY_KEY,
} from "./artifact-sdk.js";
import {
  activeLayoutWarningCount,
  resolveDiagnosticViewportClasses,
  serializeLayoutWarnings,
} from "./layout-warnings.js";
import * as artifactRevisions from "./artifact-revisions.js";
import * as mermaidNode from "./mermaid-node.js";
import * as tableCellHelpers from "./table-cell.js";
import { extractMermaidSources, whiteboardSourceHash } from "./mermaid-source.js";
import { createExcalidrawLibraryCache, excalidrawLibrariesDir } from "./whiteboard-library-store.js";
import { parseLibraryIconDirectives } from "./whiteboard-libraries.js";
import {
  isValidDiagramIndex,
  isValidWhiteboardKey,
  loadWhiteboard,
  saveWhiteboard,
  writeWhiteboardFeedbackFiles,
} from "./whiteboard-store.js";
import {
  buildSelfContainedHtml,
  exportFileName,
  exportWarningSummaries,
  splitExportWarnings,
} from "./export-bundle.js";
import { hostRejectedShareWrite, publishedDespiteError, publishToHtmlApp } from "./html-app.js";
import { normalizePromptAuthor, serializeChat, serializeChatAckIds, serializeChatSync } from "./chat-messages.js";
import { OwnerStatusError, serializeOwnerStatus } from "./owner-status.js";
import {
  boardTitle,
  boardNeedsYou,
  hubViewerNames,
  conversationMarkdown,
  createHubHtml,
  serializeHubBoard,
  sortHubBoards,
  summarizeHubBoards,
} from "./hub.js";
import {
  createNotifySettingsStore,
  NOTIFY_PEOPLE_ENV,
  NotifySettingsError,
  normalizeNotifyPersonName,
  normalizeNotifySendTo,
} from "./notify-settings.js";
import { createNotifyDestinations } from "./notify-destinations.js";
import {
  createPeerBoardSource,
  HUB_PEERS_ENV,
  isPeerKey,
  PEER_MAX_BOARDS,
  relayPeerHubAction,
  relayPeerBoardClient,
  resolvePeerBoardTarget,
  sanitizePeerHubEvent,
} from "./hub-peers.js";
import { DraftTooLargeError, normalizeDraftTabId, serializeDrafts } from "./review-drafts.js";
import { formatServerLogLine, serverStdioIsTimestamped } from "./server-log.js";
import { injectLavishSdk } from "./html-transform.js";
import { hostThemeCss, hostThemeMarkup, hostThemeTokens, resolveHostTheme } from "./host-theme.js";
import {
  bindHost,
  extraAllowedHosts,
  hostForUrl,
  IPV6_LOOPBACK_HOST,
  isWildcardHost,
  LOOPBACK_HOST,
  publicBaseUrl,
  resolveConcreteListenHosts,
  resolveLinkHost,
  resolveListenHosts,
  sanitizeListenHosts,
  stateId,
} from "./paths.js";
import { detectTailscale, isLoopbackIp, normalizeRemoteIp, whoisTailscalePeer } from "./tailscale.js";
import { artifactTreeRoot, isArtifactPathError, isHtmlPath, resolveAllowedArtifactFile } from "./artifact-path.js";
import { canonicalFile, SessionStore, sessionKey } from "./session-store.js";
import { HubPeerSettingsError, HubPeerSettingsStore } from "./hub-peer-settings.js";
import { AsyncMutex } from "./async-mutex.js";
import { generateSharePassword } from "./share-password.js";
import {
  ACCEPTED_IMAGE_MIME,
  isValidAttachmentKey,
  removeAttachment,
  resolveAttachment,
  resolveAttachmentConfig,
  statAttachmentForServe,
  sweepAttachments,
  writeAttachment,
} from "./attachment-store.js";

const chromeClientUrl = new URL("./chrome-client.js", import.meta.url);
const chromeCssUrl = new URL("./chrome.css", import.meta.url);
const hubClientUrl = new URL("./hub-client.js", import.meta.url);
const hubCssUrl = new URL("./hub.css", import.meta.url);
const designAssetUrls = {
  "daisyui.css": {
    packaged: new URL("./design/daisyui.css", import.meta.url),
    source: new URL("../node_modules/daisyui/daisyui.css", import.meta.url),
    type: "text/css",
  },
  "daisyui-themes.css": {
    packaged: new URL("./design/daisyui-themes.css", import.meta.url),
    source: new URL("../node_modules/daisyui/themes.css", import.meta.url),
    type: "text/css",
  },
  "tailwindcss-browser.js": {
    packaged: new URL("./design/tailwindcss-browser.js", import.meta.url),
    source: new URL("../node_modules/@tailwindcss/browser/dist/index.global.js", import.meta.url),
    type: "application/javascript",
  },
};

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
const WHITEBOARD_CHANNEL_TOKEN_TTL_MS = 5 * 60_000;
const NETWORK_RECONCILE_CACHE_MS = 1_000;
// Every concrete address gets this retry budget, not just the Tailscale one: an interface that is
// still coming up fails the same way whichever host names it, and the single-pinned-host case has
// no second listener to fall back on.
const BIND_RETRY_DELAYS_MS = [100, 250, 500];
// A requested address that still has not bound after that budget is retried in the background for
// the life of the process (the last delay repeats), so a tailnet address held by a stale daemon or
// absent while Tailscale restarts comes back without anyone restarting Lavish.
const BIND_RECOVERY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const LOOPBACK_OWNER_PROBE_TIMEOUT_MS = 500;
const WEBSOCKET_CLOSE_GRACE_MS = 250;
// A half-open socket (a slept laptop, a dropped tailnet path) never emits `close`, so without an
// application-level ping the server keeps counting a reviewer who is gone - which silently
// suppresses idle shutdown and makes presence wrong. Reaped on the next heartbeat after one
// unanswered ping.
const LIVE_EVENT_HEARTBEAT_MS = 30_000;
const DEFAULT_BROWSER_DISCONNECT_GRACE_MS = 10_000;
// An escaped popup can navigate to an artifact-owned HTML or SVG asset on the
// server origin. Keep every artifact response sandboxed at the response layer
// so active documents stay opaque-origin even when they are top-level.
const ARTIFACT_CONTENT_SECURITY_POLICY =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads";
// Sweep orphaned/expired attachments periodically, not just at startup: a
// detached server can run for days, and an upload whose /prompts follow-up never
// arrived would otherwise linger until the next restart.
const ATTACHMENT_SWEEP_INTERVAL_MS = 60 * 60_000;
// The reasons a caller may name for shutting this server down. Each one drives a different line
// in the chrome's outdated banner, so an unknown value is dropped rather than passed through to
// text the user would read as a fact.
const SHUTDOWN_REASONS = new Set(["upgrade", "local-build", "stop"]);
const AGENT_LISTENER_LABEL = "agent-listener";

// Live-reload coalescing. A normal save is one reload after a short debounce. While a queued
// layout-warning batch is outstanding, the agent is applying several related edits, so widen the
// window: the user asked for one group of fixes and should get one artifact refresh for it.
export const RELOAD_DEBOUNCE_MS = 100;
export const BATCH_RELOAD_DEBOUNCE_MS = 900;

// The whiteboard frame bundle (Excalidraw + Mermaid converter + React) is
// produced by `scripts/build.js` into dist/whiteboard. Packaged runs find it
// next to the served bundle; source runs (node bin/lavish-axi.js) fall back to
// the repo's dist output, so `pnpm run build` must have run at least once.
export function defaultWhiteboardAssetsDir() {
  const packaged = fileURLToPath(new URL("./whiteboard", import.meta.url));
  if (existsSync(packaged)) return packaged;
  return fileURLToPath(new URL("../dist/whiteboard", import.meta.url));
}

// Whiteboard scene saves carry full Excalidraw scenes (and, at queue time, a
// PNG preview data URL), which outgrow the default 2 MB JSON cap. Only the
// whiteboard write routes get the larger limit.
export function isWhiteboardWriteApiPath(pathname) {
  return /^\/api\/[0-9a-f]{16}\/whiteboard\/\d{1,3}(\/feedback-files)?$/.test(String(pathname || ""));
}

// The attachment upload carries raw image bytes, not JSON, so it bypasses both
// JSON body parsers and is read straight from the request stream by the route.
export function isAttachmentUploadApiPath(pathname) {
  return /^\/api\/[0-9a-f]{16}\/attachments$/.test(String(pathname || ""));
}

// Read the raw upload body, buffering at most `maxBytes` but always draining the
// stream to its end. If the body exceeds the cap it resolves `{ tooLarge: true }`
// (bytes discarded) rather than aborting mid-stream, so the caller can send a clean
// 413 the browser reliably receives even while it is still uploading a large file.
export function readAttachmentUploadBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let overCap = false;
    let settled = false;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
      req.off("close", onClose);
    };
    const onData = (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        // Stop buffering but keep consuming so the response is not sent while the
        // request body is still in flight.
        overCap = true;
        chunks.length = 0;
      } else {
        chunks.push(chunk);
      }
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(overCap ? { tooLarge: true, buffer: null } : { tooLarge: false, buffer: Buffer.concat(chunks) });
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAborted = () => onError(new Error("attachment upload aborted"));
    // Safety net: if the socket closes before "end" (client aborted mid-upload),
    // reject rather than leaving the route awaiting a promise that never settles.
    const onClose = () => {
      if (!settled) onError(new Error("attachment upload connection closed"));
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
    req.on("close", onClose);
  });
}

// The signed payload carries the session key, so a token is a capability for
// exactly one session. Without that binding any token - including one minted by
// a request that named no session - authenticated an arbitrary session's
// whiteboard channel. The wire format stays `${issuedAt}.${nonce}.${signature}`;
// the key is signed over, never transmitted in the token.
function whiteboardChannelPayload(issuedAt, nonce, sessionKey) {
  return `${issuedAt}.${nonce}.${sessionKey}`;
}

export function createWhiteboardChannelToken(secret, sessionKey, now = Date.now()) {
  const nonce = crypto.randomBytes(24).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(whiteboardChannelPayload(now, nonce, String(sessionKey || "")))
    .digest("base64url");
  return `${now}.${nonce}.${signature}`;
}

export function isValidWhiteboardChannelToken(token, secret, sessionKey, now = Date.now()) {
  if (!isValidWhiteboardKey(sessionKey)) return false;
  const [issuedAtText, nonce, signature, extra] = String(token || "").split(".");
  if (extra !== undefined || !/^\d{13}$/.test(issuedAtText) || !/^[A-Za-z0-9_-]{32}$/.test(nonce)) return false;
  const issuedAt = Number(issuedAtText);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now || now - issuedAt > WHITEBOARD_CHANNEL_TOKEN_TTL_MS)
    return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(whiteboardChannelPayload(issuedAtText, nonce, String(sessionKey)))
    .digest("base64url");
  const actualBuffer = Buffer.from(signature || "", "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

// A detached server should not live forever. When no browser chrome or agent poll
// are connected for this long, the server shuts itself down so it stops dangling. The next
// `lavish-axi <file>` invocation re-spawns a fresh server and adopts resumable sessions from
// state.json. Browser-ended sessions still require the explicit --reopen opt-in. Set
// LAVISH_AXI_IDLE_TIMEOUT_MS to 0/off to disable, or to a custom millisecond budget.
export function resolveIdleTimeoutMs(env = process.env) {
  const raw = env.LAVISH_AXI_IDLE_TIMEOUT_MS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_IDLE_TIMEOUT_MS;
  if (raw === "0" || raw.toLowerCase() === "off") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_IDLE_TIMEOUT_MS;
  return Math.min(value, 2147483647);
}

// How long an active poll waits for a review page to reconnect after the last one drops before it
// returns browser_disconnected. A phone that locks or backgrounds the tab drops its socket, so the
// 10s default can be too short there. Set LAVISH_AXI_DISCONNECT_GRACE_MS to a custom millisecond
// budget, or to 0/off so a disconnect never releases the poll (only feedback, an end, or its own
// timeout does). Both resolvers clamp to 2147483647 ms, setTimeout's maximum; a larger delay would
// overflow and fire after about 1 ms.
export function resolveBrowserDisconnectGraceMs(env = process.env) {
  const raw = env.LAVISH_AXI_DISCONNECT_GRACE_MS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_BROWSER_DISCONNECT_GRACE_MS;
  if (raw === "0" || raw.toLowerCase() === "off") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_BROWSER_DISCONNECT_GRACE_MS;
  return Math.min(value, 2147483647);
}

function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(String(a || ""), "utf8");
  const bufB = Buffer.from(String(b || ""), "utf8");
  return bufA.length > 0 && bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Parse `LAVISH_AXI_APPROVAL_TOKENS="Name=secret,Other=secret2"` into reviewer -> secret entries.
 * @param {string | Record<string, string> | undefined} raw
 */
export function parseApprovalTokens(raw) {
  /** @type {Array<{ reviewer: string, token: string }>} */
  const out = [];
  if (!raw) return out;
  if (typeof raw === "object") {
    for (const [name, tok] of Object.entries(raw)) {
      const reviewer = normalizePromptAuthor(name);
      const token = typeof tok === "string" ? tok.trim() : "";
      if (reviewer && token) out.push({ reviewer, token });
    }
    return out;
  }
  for (const part of String(raw).split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const reviewer = normalizePromptAuthor(entry.slice(0, eq));
    const token = entry.slice(eq + 1).trim();
    if (reviewer && token) out.push({ reviewer, token });
  }
  return out;
}

/**
 * Parse optional `LAVISH_AXI_APPROVAL_USERS="Name=login_or_handle,..."` alias map for Tailscale whois.
 * @param {string | Record<string, string | string[]> | undefined} raw
 */
export function parseApprovalUsers(raw) {
  /** @type {Map<string, Set<string>>} */
  const map = new Map();
  const add = (name, alias) => {
    const cleanName = normalizePromptAuthor(name).toLowerCase();
    const cleanAlias = String(alias || "")
      .trim()
      .toLowerCase();
    if (!cleanName || !cleanAlias) return;
    let set = map.get(cleanName);
    if (!set) {
      set = new Set();
      map.set(cleanName, set);
    }
    set.add(cleanAlias);
  };
  if (!raw) return map;
  if (typeof raw === "object") {
    for (const [name, val] of Object.entries(raw)) {
      for (const item of Array.isArray(val) ? val : [val]) add(name, item);
    }
    return map;
  }
  for (const part of String(raw).split(",")) {
    const entry = part.trim();
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    for (const item of entry
      .slice(eq + 1)
      .split("|")
      .map((s) => s.trim())) {
      add(entry.slice(0, eq), item);
    }
  }
  return map;
}

function reviewerMatchesName(suppliedAuthor, expectedReviewer) {
  const sup = normalizePromptAuthor(suppliedAuthor).toLowerCase();
  const exp = normalizePromptAuthor(expectedReviewer).toLowerCase();
  if (!sup || !exp) return false;
  if (sup === exp) return true;
  const supFirst = sup.split(/\s+/)[0];
  const expFirst = exp.split(/\s+/)[0];
  return Boolean(supFirst && supFirst === expFirst && (sup === supFirst || exp === expFirst));
}

export function doesAuthorMatchTailscaleWhois(suppliedAuthor, whois, aliasMap) {
  const sup = normalizePromptAuthor(suppliedAuthor).toLowerCase();
  if (!sup || !whois) return false;
  const login = String(whois.loginName || "")
    .trim()
    .toLowerCase();
  const aliases = aliasMap?.get(sup) || aliasMap?.get(sup.split(/\s+/)[0]);
  return Boolean(login && aliases?.has(login));
}

/**
 * @param {{ [key: string]: any }} [options]
 */
export async function serve({
  env = process.env,
  port,
  stateFile,
  version = "",
  debug = false,
  log = null,
  pollHeartbeatMs = 15_000,
  liveEventHeartbeatMs = LIVE_EVENT_HEARTBEAT_MS,
  browserDisconnectGraceMs = resolveBrowserDisconnectGraceMs(env),
  idleTimeoutMs = resolveIdleTimeoutMs(),
  host = bindHost(env),
  hosts,
  linkHost: linkHostName,
  publicUrl = publicBaseUrl(env),
  allowedHosts,
  detectTailscale: detectTailscaleFn,
  whoisPeer: whoisPeerFn,
  approvalTokens = env.LAVISH_AXI_APPROVAL_TOKENS,
  approvalUsers = env.LAVISH_AXI_APPROVAL_USERS,
  lookupHost,
  extraListenHosts = [],
  bindRecoveryDelaysMs = BIND_RECOVERY_DELAYS_MS,
  whiteboardAssetsDir = defaultWhiteboardAssetsDir(),
  theme = resolveHostTheme(env),
  hubPeers = env[HUB_PEERS_ENV],
  hubPeerOptions = {},
  actionLabel = env.LAVISH_AXI_ACTION_LABEL,
  onEvent = null,
} = {}) {
  const whoisPeer = whoisPeerFn === undefined ? whoisTailscalePeer : whoisPeerFn;
  const resolvedApprovalTokens = parseApprovalTokens(approvalTokens);
  const resolvedApprovalUsers = parseApprovalUsers(approvalUsers);
  const resolvedActionLabel =
    String(actionLabel || "Send")
      .trim()
      .slice(0, 64) || "Send";
  // Keep the transport dependency off fast metadata paths such as `--version`.
  const { WebSocket, WebSocketServer } = await import("ws");
  // LAVISH_AXI_PUBLIC_URL replaces the origin of every board link the server emits, and its
  // hostname is answered to automatically, so a reverse proxy needs only this one setting.
  const publicOrigin = publicUrl ? new URL(publicUrl).origin : "";
  const extraHosts = [
    ...(allowedHosts ?? extraAllowedHosts(env)),
    ...(publicOrigin ? [new URL(publicOrigin).hostname] : []),
  ];
  const envHost = env.LAVISH_AXI_HOST?.trim();
  const autoTailscale = !envHost;
  const detect = detectTailscaleFn === undefined ? detectTailscale : detectTailscaleFn;
  const tailscale = !hosts?.length && autoTailscale && typeof detect === "function" ? await detect() : null;
  const requestedListenHosts = sanitizeListenHosts(
    hosts?.length
      ? [...hosts, ...extraListenHosts]
      : resolveListenHosts({ host, env, tailscale, extraHosts: extraListenHosts }),
  );
  const lookupOptions = lookupHost ? { lookup: lookupHost } : {};
  const listenHosts = await resolveConcreteListenHosts(requestedListenHosts, {
    ...lookupOptions,
    keepUnresolved: true,
  });
  const activeTailscaleNetwork = tailscaleNetworkKey(tailscale);
  const serverStateId = stateId(stateFile);
  let tailscalePhoneReady = false;
  let tailscaleDetectionWarning = typeof tailscale?.warning === "string" ? tailscale.warning : "";
  // Requested addresses that have not bound yet, with the last error for each. Background recovery
  // keeps retrying them and every surface that reports network health reads them from here, so a
  // failed tailnet bind is never just one log line nobody sees.
  /** @type {Map<string, Error>} */
  const pendingBinds = new Map();
  let resolvedLinkHost = linkHostName ?? resolveLinkHost({ env, tailscale, fallbackHost: host });
  // Declared before anything listens: a live-event client or /shutdown can reach these handlers
  // the moment the first listener binds, while later addresses are still retrying. Declaring them
  // after the bind loop made that window a TDZ ReferenceError that crashed restarted servers.
  let idleTimer = null;
  let attachmentSweepTimer = null;
  let bindRecoveryTimer = null;
  const app = express();
  const store = new SessionStore(stateFile);
  const notifySettingsStore = createNotifySettingsStore(path.dirname(stateFile), {
    seedPeople: String(env[NOTIFY_PEOPLE_ENV] ?? process.env[NOTIFY_PEOPLE_ENV] ?? ""),
  });
  const events = new EventEmitter();
  const watchers = new Map();
  const activePolls = new Map();
  const deliveredFeedback = new Set();
  const pollOwnershipLock = new AsyncMutex();
  // Keyed by session so a version-driven shutdown can reload the one chrome whose artifact is
  // being reopened and leave every other open review page on screen. Current chromes use a
  // WebSocket, while the legacy SSE route remains available during rolling local upgrades.
  const liveEventClients = new Map();
  const browserDisconnectTimers = new Map();
  const browserDisconnectPending = new Set();
  const whiteboardChannelSecret = crypto.randomBytes(32);
  // Sessions with at least one warning the user queued that has not been re-checked yet.
  const outstandingRepairBatches = new Set();
  const diagnosticViewportClasses = resolveDiagnosticViewportClasses();
  const verbose = debug || env.LAVISH_AXI_DEBUG === "1";
  // The detached server's stderr is appended to server.log across restarts, where an untimestamped
  // line cannot be dated or correlated with an outage. An injected logger formats its own lines.
  const writeLog =
    typeof log === "function"
      ? log
      : (line) => process.stderr.write(`${serverStdioIsTimestamped() ? line : formatServerLogLine(line)}\n`);
  const logEvent = verbose ? (line) => writeLog(`[lavish] ${line}`) : null;
  if (tailscaleDetectionWarning) writeLog(`[lavish] WARNING: ${tailscaleDetectionWarning}`);
  let publicPort = port;
  let serverReady = false;
  let networkReconcileCheckedAt = 0;
  let cachedNetworkStale = false;
  let shuttingDown = false;
  /** @type {Promise<boolean> | null} */
  let networkReconcilePromise = null;

  function broadcastLiveEvent(type, key, data = {}) {
    for (const [client, clientKey] of liveEventClients) {
      if (clientKey === key) client.sendEvent(type, data);
    }
  }

  // One listener per event scales independently of the number of open review tabs and avoids the
  // EventEmitter listener warning the former one-listener-per-SSE-client design reached at only a
  // few boards.
  events.on("reload", (key) => {
    broadcastLiveEvent("reload", key);
    notifyHubStateChanged();
    // Working (docs/delivery-acks.md): a save after a delivery is the agent acting on what it was
    // handed. The store writes nothing when no delivered, unanswered note exists.
    store
      .markWorking(key)
      .then((session) => {
        if (session) events.emit("chat-sync", key, session);
      })
      .catch((error) => writeLog(`[lavish] working stamp after reload failed: ${error?.message || error}`));
  });
  // The transcript the chrome renders is computed here (src/chat-messages.js): agent text ships
  // with its rendered html, user entries ship as text with their anchor, never as html.
  events.on("agent-reply", (key, entry) => {
    broadcastLiveEvent("agent-reply", key, entry);
    notifyHubStateChanged();
  });
  events.on("board-metadata", (key, metadata) => broadcastLiveEvent("board-metadata", key, metadata));
  events.on("chat-sync", (key, session) => broadcastLiveEvent("chat-sync", key, serializeChatSync(session)));
  events.on("agent-presence", (key, state) => {
    broadcastLiveEvent("agent-presence", key, presenceEventData(key, state, activePolls, deliveredFeedback));
    notifyHubStateChanged();
  });
  events.on("layout-warnings", (key, warnings) => broadcastLiveEvent("layout-warnings", key, { warnings }));
  events.on("owner-status", (key, owner) => {
    broadcastLiveEvent("owner-status", key, { owner: owner || null });
    notifyHubStateChanged();
  });
  events.on("ended", (key, endedBy) => broadcastLiveEvent("ended", key, { ended_by: endedBy || null }));
  events.on("ended", (key, endedBy) => {
    runEndHook(key, endedBy).catch((error) => writeLog(`[lavish] end hook failed: ${error?.message || error}`));
    emitLocalBoardEnded(key, endedBy).catch((error) =>
      writeLog(`[lavish] board end event failed: ${error?.message || error}`),
    );
  });

  function tagDiff(before = [], after = []) {
    const beforeLower = new Set((Array.isArray(before) ? before : []).map((tag) => String(tag).toLowerCase()));
    const afterLower = new Set((Array.isArray(after) ? after : []).map((tag) => String(tag).toLowerCase()));
    return {
      added: (Array.isArray(after) ? after : []).filter((tag) => !beforeLower.has(String(tag).toLowerCase())),
      removed: (Array.isArray(before) ? before : []).filter((tag) => !afterLower.has(String(tag).toLowerCase())),
    };
  }

  const MAX_HOOK_ARG_BYTES = 65_536;

  function compactEventPayload(
    payload,
    { promptMax = 16_384, chatMax = 8_192, promptLimit = 32, chatLimit = 40, minimalAttachments = false } = {},
  ) {
    const out = { ...payload };
    if (typeof out.search_text === "string" && out.search_text.length > 16_384) {
      out.search_text = out.search_text.slice(0, 16_384);
    }
    if (Array.isArray(out.prompts)) {
      out.prompts =
        promptLimit <= 0
          ? []
          : out.prompts.slice(-promptLimit).map((prompt) => ({
              prompt: String(prompt?.prompt || "").slice(0, promptMax),
              tag: String(prompt?.tag || "").slice(0, 64),
              selector: String(prompt?.selector || "").slice(0, minimalAttachments ? 128 : 512),
              text: String(prompt?.text || "").slice(0, minimalAttachments ? 64 : 256),
              ...(prompt?.prompt_id ? { prompt_id: String(prompt.prompt_id).slice(0, 128) } : {}),
              ...(prompt?.author ? { author: String(prompt.author).slice(0, 80) } : {}),
              ...(prompt?.via === "cli" || prompt?.via === "chrome_approval" ? { via: prompt.via } : {}),
              ...(prompt?.approval_auth && typeof prompt.approval_auth === "object"
                ? { approval_auth: prompt.approval_auth }
                : {}),
              ...(!minimalAttachments && prompt?.target ? { target: prompt.target } : {}),
              ...(Array.isArray(prompt?.attachments) && prompt.attachments.length > 0
                ? {
                    attachments: prompt.attachments
                      .slice(0, 16)
                      .filter((att) => att && typeof att === "object" && att.id)
                      .map((att) => ({
                        id: String(att.id).slice(0, 128),
                        ...(att.name ? { name: String(att.name).slice(0, 200) } : {}),
                        ...(!minimalAttachments && att.path ? { path: String(att.path).slice(0, 1024) } : {}),
                        ...(!minimalAttachments && att.mime ? { mime: String(att.mime).slice(0, 64) } : {}),
                        ...(!minimalAttachments && Number.isFinite(att.bytes) ? { bytes: Number(att.bytes) } : {}),
                        ...(!minimalAttachments && Number.isFinite(att.width) ? { width: Number(att.width) } : {}),
                        ...(!minimalAttachments && Number.isFinite(att.height) ? { height: Number(att.height) } : {}),
                      })),
                  }
                : {}),
            }));
    }
    if (Array.isArray(out.chat)) {
      out.chat =
        chatLimit <= 0
          ? []
          : out.chat.slice(-chatLimit).map((entry) => ({
              role: entry?.role === "agent" ? "agent" : "user",
              text: String(entry?.text || "").slice(0, chatMax),
              ...(entry?.author ? { author: String(entry.author).slice(0, 80) } : {}),
              ...(entry?.at ? { at: String(entry.at).slice(0, 40) } : {}),
              ...(Array.isArray(entry?.attachments) && entry.attachments.length > 0
                ? {
                    attachments: entry.attachments
                      .slice(0, 16)
                      .filter((att) => att && typeof att === "object" && att.id)
                      .map((att) => ({
                        id: String(att.id).slice(0, 128),
                        ...(att.name ? { name: String(att.name).slice(0, 200) } : {}),
                      })),
                  }
                : {}),
            }));
    }
    return out;
  }

  function fitNotifySettingsToBudget(notifySettings, maxBytes) {
    if (!notifySettings || typeof notifySettings !== "object") return {};
    if (Buffer.byteLength(JSON.stringify(notifySettings), "utf8") <= maxBytes) return notifySettings;
    /** @type {Record<string, any>} */
    const fitted = {};
    // Prioritize rows with active notifications (`tagged || done`) first if an oversized disk file ever appears.
    const entries = Object.entries(notifySettings).sort(
      ([, a], [, b]) => Number(Boolean(b?.tagged || b?.done)) - Number(Boolean(a?.tagged || a?.done)),
    );
    for (const [name, cfg] of entries) {
      const next = { ...fitted, [name]: cfg };
      if (Buffer.byteLength(JSON.stringify(next), "utf8") > maxBytes) continue;
      fitted[name] = cfg;
    }
    return fitted;
  }

  function serializeBoundedHookPayload(eventPayload, notifySettings, maxBytes = MAX_HOOK_ARG_BYTES) {
    const boundedSettings = fitNotifySettingsToBudget(notifySettings, Math.floor(maxBytes / 2));
    const tiers = [
      () => ({ ...eventPayload, notify_settings: boundedSettings }),
      () => ({
        ...compactEventPayload(
          { ...eventPayload, search_text: String(eventPayload.search_text || "").slice(0, 4_096) },
          { promptMax: 1_024, chatMax: 512, promptLimit: 16, chatLimit: 20 },
        ),
        notify_settings: boundedSettings,
      }),
      () => ({
        ...compactEventPayload(
          { ...eventPayload, search_text: String(eventPayload.search_text || "").slice(0, 512) },
          { promptMax: 256, chatMax: 128, promptLimit: 8, chatLimit: 8, minimalAttachments: true },
        ),
        notify_settings: boundedSettings,
      }),
      () => ({
        ...compactEventPayload(
          { ...eventPayload, search_text: "", chat: [] },
          { promptMax: 128, chatMax: 0, promptLimit: 4, chatLimit: 0, minimalAttachments: true },
        ),
        notify_settings: boundedSettings,
      }),
      () => {
        const minimal = compactEventPayload(
          {
            ...eventPayload,
            title: String(eventPayload.title || "").slice(0, 200),
            search_text: "",
            chat: [],
            prompts: [],
          },
          { promptLimit: 0, chatLimit: 0 },
        );
        delete minimal.search_text;
        delete minimal.chat;
        return { ...minimal, notify_settings: boundedSettings };
      },
    ];
    for (const buildTier of tiers) {
      const serialized = JSON.stringify(buildTier());
      if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return serialized;
    }
    const bareWithoutSettings = {
      event: eventPayload.event,
      key: eventPayload.key,
      ...(eventPayload.file ? { file: eventPayload.file } : {}),
      ...(eventPayload.url ? { url: eventPayload.url } : {}),
      ...(eventPayload.base ? { base: eventPayload.base } : {}),
      ...(eventPayload.action ? { action: eventPayload.action } : {}),
      ...(eventPayload.action_label ? { action_label: eventPayload.action_label } : {}),
      ...(Array.isArray(eventPayload.tags) ? { tags: eventPayload.tags.slice(0, 32) } : {}),
      ...(Array.isArray(eventPayload.added) ? { added: eventPayload.added.slice(0, 32) } : {}),
      ...(Array.isArray(eventPayload.removed) ? { removed: eventPayload.removed.slice(0, 32) } : {}),
    };
    const bareOverhead = Buffer.byteLength(JSON.stringify({ ...bareWithoutSettings, notify_settings: {} }), "utf8");
    const bare = {
      ...bareWithoutSettings,
      notify_settings: fitNotifySettingsToBudget(boundedSettings, Math.max(0, maxBytes - bareOverhead - 32)),
    };
    return JSON.stringify(bare);
  }

  const MAX_HUB_EVENT_HISTORY = 256;
  const HOOK_STEP_TIMEOUT_MS = 10_000;
  const hubInstanceId = crypto.randomUUID();
  let hubEventSeq = 0;
  /** @type {Array<{ seq: number, event: Record<string, any> }>} */
  const hubEventHistory = [];
  /** @type {Set<import("ws").WebSocket>} */
  const hubPeerStreamClients = new Set();
  /** @type {Set<import("ws").WebSocket>} */
  const hubViewStreamClients = new Set();
  let hookQueue = Promise.resolve();

  function sendToSocketSet(clients, wire) {
    for (const subscriber of clients) {
      if (subscriber.readyState === WebSocket.OPEN) {
        try {
          subscriber.send(wire);
        } catch {
          // closed subscriber cleans up via close/heartbeat
        }
      }
    }
  }

  function notifyHubViewers() {
    if (hubViewStreamClients.size === 0) return;
    sendToSocketSet(hubViewStreamClients, JSON.stringify({ type: "hub-refresh", at: new Date().toISOString() }));
  }

  function notifyHubStateChanged() {
    notifyHubViewers();
    if (hubPeerStreamClients.size > 0) {
      sendToSocketSet(hubPeerStreamClients, JSON.stringify({ type: "hub-invalidate" }));
    }
  }

  function runDetachedHookOrdered(envVar, command, args, extraEnv = {}) {
    if (!command) {
      return { configured: false, launched: Promise.resolve({ ok: true, error: "" }) };
    }
    if (!path.isAbsolute(command)) {
      const msg = `${envVar} must be an absolute path to an executable; skipped`;
      writeLog(`[lavish] ${msg}`);
      return { configured: true, launched: Promise.resolve({ ok: false, error: msg }) };
    }
    /** @type {(res: { ok: boolean, error: string }) => void} */
    let resolveLaunched;
    const launched = new Promise((resolve) => {
      resolveLaunched = resolve;
    });
    let launchSettled = false;
    const settleLaunch = (ok, error = "") => {
      if (launchSettled) return;
      launchSettled = true;
      resolveLaunched({ ok, error });
    };
    hookQueue = hookQueue
      .then(
        () =>
          new Promise((resolve) => {
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve();
            };
            const timer = setTimeout(() => {
              settleLaunch(false, `event hook ${command} timed out`);
              finish();
            }, HOOK_STEP_TIMEOUT_MS);
            timer.unref?.();
            try {
              const child = spawn(command, args, {
                detached: true,
                stdio: "ignore",
                env: { ...process.env, ...env, ...extraEnv },
              });
              child.once("spawn", () => settleLaunch(true));
              child.on("error", (error) => {
                writeLog(`[lavish] event hook ${command} failed to start: ${error.message}`);
                settleLaunch(false, error.message);
                finish();
              });
              child.once("close", () => {
                settleLaunch(true);
                finish();
              });
              child.unref();
            } catch (error) {
              const message = String(error?.message || error);
              writeLog(`[lavish] event hook ${command} failed: ${message}`);
              settleLaunch(false, message);
              finish();
            }
          }),
      )
      .catch(() => {
        settleLaunch(false, "event hook queue failed");
      });
    return { configured: true, launched };
  }

  // LAVISH_AXI_ON_EVENT (and optional LAVISH_AXI_ON_ACTION for board_action) names an executable run
  // (no shell, detached, fire-and-forget) whenever a hub/board event occurs (board_created,
  // board_reopened, message, board_action, tag_change, board_closed, board_cancelled), receiving one
  // compact JSON payload argument so external workflows stay event-driven without polling.
  function emitHubEvent(payload, { broadcast = true, notifySnapshot = notifySettingsStore.getSync() } = {}) {
    const base = `http://${hostForUrl(LOOPBACK_HOST)}:${publicPort}`;
    const isLocal = !payload.source;
    const seq = isLocal && broadcast ? (hubEventSeq += 1) : undefined;
    const eventPayload = compactEventPayload({
      ...payload,
      ...(isLocal ? { instance_id: hubInstanceId } : {}),
      ...(seq ? { seq } : {}),
      base,
      at: new Date().toISOString(),
    });
    if (isLocal && seq) {
      hubEventHistory.push({ seq, event: eventPayload });
      if (hubEventHistory.length > MAX_HUB_EVENT_HISTORY) {
        hubEventHistory.splice(0, hubEventHistory.length - MAX_HUB_EVENT_HISTORY);
      }
      const wire = JSON.stringify({ type: "hub-event", instance_id: hubInstanceId, seq, event: eventPayload });
      sendToSocketSet(hubPeerStreamClients, wire);
      sendToSocketSet(hubViewStreamClients, wire);
    } else if (broadcast) {
      notifyHubViewers();
    }
    const hookPayload = { ...eventPayload, notify_settings: notifySnapshot };
    if (typeof onEvent === "function") {
      Promise.resolve()
        .then(() => onEvent(hookPayload))
        .catch((error) => writeLog(`[lavish] onEvent callback failed: ${error?.message || error}`));
    }
    const serialized = serializeBoundedHookPayload(eventPayload, notifySnapshot, MAX_HOOK_ARG_BYTES);
    const hookEnv = { LAVISH_AXI_EVENT: String(eventPayload.event || "") };
    const eventCommand = String(env.LAVISH_AXI_ON_EVENT || process.env.LAVISH_AXI_ON_EVENT || "").trim();
    const launchResults = [runDetachedHookOrdered("LAVISH_AXI_ON_EVENT", eventCommand, [serialized], hookEnv)];
    if (eventPayload.event === "board_action") {
      const actionCommand = String(env.LAVISH_AXI_ON_ACTION || process.env.LAVISH_AXI_ON_ACTION || "").trim();
      if (actionCommand && actionCommand !== eventCommand) {
        launchResults.push(runDetachedHookOrdered("LAVISH_AXI_ON_ACTION", actionCommand, [serialized], hookEnv));
      }
    }
    const configuredLaunches = launchResults.filter((item) => item.configured).map((item) => item.launched);
    return {
      configured: configuredLaunches.length > 0,
      launched:
        configuredLaunches.length === 0
          ? Promise.resolve({ ok: true, error: "" })
          : Promise.all(configuredLaunches).then((outcomes) => {
              const failedOutcome = outcomes.find((item) => !item.ok);
              return failedOutcome || { ok: true, error: "" };
            }),
    };
  }

  async function emitLocalBoardEnded(key, endedBy) {
    const session = await store.findByKey(key);
    if (!session) return;
    const head = await readBoardHead(session.file, { includeSearchText: true });
    const cancelled = session.ended_reason === "cancelled";
    emitHubEvent({
      event: cancelled ? "board_cancelled" : "board_closed",
      key,
      file: session.file,
      url: session.url,
      title: boardTitle(session, head.title),
      creator: session.creator || "",
      tags: session.tags || [],
      cancelled,
      ended_by: endedBy === "user" ? "user" : "agent",
      search_text: head.searchText || "",
    });
  }

  // LAVISH_AXI_ON_END names an executable run (no shell) whenever a session ends - from the
  // browser, Send & End, the hub, or `lavish-axi end` - with the board file, session key, who
  // ended it, and this server's loopback base URL as arguments, so an operator can keep a closed
  // board's copy (GET /api/:key/export) and conversation (GET /api/:key/conversation). Detached and
  // fire-and-forget: a slow or failing hook never delays or fails the end.
  async function runEndHook(key, endedBy) {
    const command = String(env.LAVISH_AXI_ON_END || process.env.LAVISH_AXI_ON_END || "").trim();
    if (!command) return;
    if (!path.isAbsolute(command)) {
      writeLog("[lavish] LAVISH_AXI_ON_END must be an absolute path to an executable; skipped");
      return;
    }
    const session = await store.findByKey(key);
    if (!session) return;
    const base = `http://${hostForUrl(LOOPBACK_HOST)}:${publicPort}`;
    const child = spawn(command, [session.file, key, endedBy === "user" ? "user" : "agent", base], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, LAVISH_AXI_ENDED_FILE: session.file, LAVISH_AXI_ENDED_KEY: key },
    });
    child.on("error", (error) => writeLog(`[lavish] end hook ${command} failed to start: ${error.message}`));
    child.unref();
  }

  function hasLiveEventClient(key) {
    for (const clientKey of liveEventClients.values()) {
      if (clientKey === key) return true;
    }
    return false;
  }

  function clearBrowserDisconnectTimer(key) {
    const timer = browserDisconnectTimers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    browserDisconnectTimers.delete(key);
  }

  function scheduleBrowserDisconnect(key) {
    clearBrowserDisconnectTimer(key);
    if (browserDisconnectGraceMs === null) return;
    if (shuttingDown || hasLiveEventClient(key) || !activePolls.has(key)) return;
    const timer = setTimeout(() => {
      browserDisconnectTimers.delete(key);
      if (!hasLiveEventClient(key) && activePolls.has(key)) {
        browserDisconnectPending.add(key);
        events.emit("browser-disconnected", key);
      }
    }, browserDisconnectGraceMs);
    timer.unref?.();
    browserDisconnectTimers.set(key, timer);
  }

  function attachLiveEventClient(client, key, onClose) {
    clearBrowserDisconnectTimer(key);
    browserDisconnectPending.delete(key);
    liveEventClients.set(client, key);
    refreshIdleTimer();
    notifyHubStateChanged();
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      liveEventClients.delete(client);
      scheduleBrowserDisconnect(key);
      refreshIdleTimer();
      notifyHubStateChanged();
    };
    onClose(cleanup);
    return cleanup;
  }

  async function sendInitialLiveEventState(client, key, cleanup) {
    const session = await store.findByKey(key);
    if (client.isClosed()) {
      cleanup();
      return;
    }
    client.sendEvent("chat-sync", serializeChatSync(session));
    const presence = computePresence(key, activePolls, deliveredFeedback);
    client.sendEvent("agent-presence", presenceEventData(key, presence, activePolls, deliveredFeedback));
    // A reconnect may have missed a status change, and a stored status may have lapsed meanwhile.
    client.sendEvent("owner-status", { owner: serializeOwnerStatus(session?.owner_status) });
    // A connection that attaches after the live end event still needs the terminal snapshot.
    if (session?.status === "ended") client.sendEvent("ended", { ended_by: session.ended_by || null });
  }

  function networkWarningField() {
    const networkWarning = currentNetworkWarning();
    return networkWarning ? { network_warning: networkWarning } : {};
  }

  function describeBindFailure(listenHost, error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    const why =
      code === "EADDRINUSE"
        ? "EADDRINUSE: another process is already listening there"
        : code === "EADDRNOTAVAIL"
          ? "EADDRNOTAVAIL: that address is not on this machine right now"
          : code === "ENOTFOUND" || code === "EAI_AGAIN"
            ? `${code}: that name does not resolve right now`
            : code || (error instanceof Error ? error.message : String(error));
    const address = `${hostForUrl(listenHost)}:${publicPort || port}`;
    const reachable = `Lavish remains available on ${boundHosts.map((bound) => hostForUrl(bound)).join(", ") || "loopback"}`;
    if (listenHost === tailscale?.ipv4) {
      return `Tailscale binding failed for ${address} (${why}); there is no phone access and tailnet review links do not load. ${reachable} and keeps retrying the tailnet address in the background.`;
    }
    const fellBack = boundHosts.length > 0 && boundHosts.every((bound) => bound === LOOPBACK_HOST);
    return `Could not bind ${address} (${why}); ${fellBack ? "Lavish fell back to loopback and is" : "Lavish is"} not reachable at that address. ${reachable} and keeps retrying ${hostForUrl(listenHost)} in the background.`;
  }

  // Everything that reports network health reads this, so the warning appears and clears with the
  // bind state instead of being stamped once at startup.
  function currentNetworkWarning() {
    return [
      tailscaleDetectionWarning,
      ...[...pendingBinds].map(([listenHost, error]) => describeBindFailure(listenHost, error)),
    ]
      .filter(Boolean)
      .join(" ");
  }

  // A requested address that failed to bind is recovered in this process (retried now, and in the
  // background), never by reporting the server stale: a restart cannot free a port another process
  // holds, and it would drop every live review connection for an address that comes back on its own.
  async function reconcileNetwork() {
    await retryPendingBinds();
    if (!(autoTailscale && typeof detect === "function")) return false;
    return reconcileTailscaleNetwork();
  }

  async function reconcileTailscaleNetwork() {
    if (Date.now() - networkReconcileCheckedAt < NETWORK_RECONCILE_CACHE_MS) return cachedNetworkStale;
    if (networkReconcilePromise) return networkReconcilePromise;
    networkReconcilePromise = (async () => {
      try {
        const detectedTailscale = await detect();
        const detectedNetwork = tailscaleNetworkKey(detectedTailscale);
        const stale = detectedNetwork !== activeTailscaleNetwork;
        if (stale) {
          tailscaleDetectionWarning = typeof detectedTailscale?.warning === "string" ? detectedTailscale.warning : "";
        }
        return stale;
      } catch {
        return false;
      }
    })();
    try {
      cachedNetworkStale = await networkReconcilePromise;
      networkReconcileCheckedAt = Date.now();
      return cachedNetworkStale;
    } finally {
      networkReconcilePromise = null;
    }
  }

  function finishFeedbackDelivery(key, result) {
    if (result.status !== "feedback") return;
    markFeedbackDelivered(key, activePolls, deliveredFeedback, events);
    // The take already stamped the batch Seen in state.json (docs/delivery-acks.md); tell the open
    // tabs only now, on the path that is about to write the response, never from the destructive
    // take itself, so a tab is not told Seen for a batch a disconnect is about to put back.
    void publishChatSync(key);
  }

  async function publishChatSync(key) {
    try {
      const session = await store.findByKey(key);
      if (session) events.emit("chat-sync", key, session);
    } catch (error) {
      writeLog(`[lavish] chat-sync after delivery failed: ${error?.message || error}`);
    }
  }

  // What the agent receives. `delivery_seq` is the store's own bookkeeping for undoing a take's Seen
  // stamps on a closed poll; it means nothing to an agent and stays off the wire.
  function agentFacingFeedback(result) {
    if (!result || result.status !== "feedback" || !("delivery_seq" in result)) return result;
    const rest = { ...result };
    delete rest.delivery_seq;
    return rest;
  }

  // `takeFeedback` is destructive: it clears the batch from `state.json` before anything is
  // written to the response. A client that disconnected while that take was in flight would
  // otherwise lose the feedback for good, so put it back verbatim through the store's `restore`
  // mode and leave delivery unmarked - nothing reached an agent. A restore that comes back short
  // is logged, so a batch that could not be put back whole is visible instead of silently gone.
  // A restore that THROWS (the state write failed) is the same loss with no return value to
  // inspect, and the caller is a socket the client already closed, so it is logged and swallowed
  // here rather than escaping into an error path that has no one left to tell.
  // The re-queued batch also has to be announced: another poll can take "waiting" in the window
  // between the destructive take and this restore, and it would then long-poll forever over
  // feedback that is sitting in `state.json`. Emitting wakes it exactly like a fresh `/prompts`.
  async function restoreClosedFeedback(key, result) {
    if (result.status !== "feedback") return;
    const prompts = Array.isArray(result.prompts) ? result.prompts : [];
    let session = null;
    let restoreError = null;
    try {
      session = await store.queuePrompts(
        key,
        {
          dom_snapshot: result.dom_snapshot || "",
          prompts,
          ...(Array.isArray(result.artifact_failures) ? { artifact_failures: result.artifact_failures } : {}),
          // Lets the store take this take's Seen stamps off again (docs/delivery-acks.md).
          ...(Number.isInteger(result.delivery_seq) ? { delivery_seq: result.delivery_seq } : {}),
        },
        {
          restore: true,
          resolveAttachment: (sessionKeyValue, id) => resolveAttachment(attachmentStateRoot, sessionKeyValue, id),
          maxPerPrompt: attachmentConfig.maxPerPrompt,
          maxPromptBytes: attachmentConfig.maxPromptBytes,
        },
      );
    } catch (error) {
      restoreError = error;
    }
    const restoredPrompts =
      prompts.length === 0
        ? []
        : session && !session.rejected && !session.conflict && Array.isArray(session.prompts)
          ? session.prompts.slice(0, prompts.length)
          : null;
    const restoredFailures = session && Array.isArray(session.artifact_failures) ? session.artifact_failures : null;
    const failuresRestored =
      !Array.isArray(result.artifact_failures) ||
      (Array.isArray(restoredFailures) &&
        result.artifact_failures.every((failure) =>
          restoredFailures.some((restoredFailure) => JSON.stringify(restoredFailure) === JSON.stringify(failure)),
        ));
    const persistedNothing = !session || Boolean(session.rejected) || Boolean(session.conflict);
    if (restoreError) {
      writeLog(
        `[lavish] closed poll feedback restore failed; the batch was lost: ${restoreError?.message || restoreError}`,
      );
    } else if (persistedNothing) {
      writeLog("[lavish] closed poll feedback restore was refused; nothing was re-queued and the batch was lost");
    } else if (!restoredPrompts || JSON.stringify(restoredPrompts) !== JSON.stringify(prompts) || !failuresRestored) {
      writeLog("[lavish] closed poll feedback restore was incomplete; delivery was not marked");
    }
    const pendingAfterRestore =
      (Array.isArray(restoredPrompts) && restoredPrompts.length > 0) ||
      (Array.isArray(restoredFailures) && restoredFailures.length > 0);
    if (pendingAfterRestore) events.emit("feedback", key);
    // A tab that saw the batch stamped Seen between the take and this restore learns it is not -
    // a refused restore included, which still takes the stamps off.
    await publishChatSync(key);
  }
  // Whiteboard sidecar files live next to state.json, keyed by session + diagram.
  const whiteboardStateRoot = path.dirname(stateFile);
  const loadExcalidrawLibraries = createExcalidrawLibraryCache();
  const libraryDir = excalidrawLibrariesDir(whiteboardStateRoot);

  // DNS-rebinding guard. isSameOriginRequest (used on /share and the whiteboard
  // write routes) stops classic cross-origin CSRF but NOT DNS rebinding: a page
  // that rebinds its own domain to this loopback port sends that domain in both
  // Origin and Host, so the two still match. The robust defense is a Host-header
  // allowlist - a rebound browser carries the attacker's domain in Host, which is
  // never one of the hostnames this server answers to.
  //
  // Loopback names are always accepted. Binding to a concrete interface
  // (LAVISH_AXI_HOST) or naming a link host (LAVISH_AXI_LINK_HOST) adds that host,
  // so an operator who intentionally exposes the server on a specific interface
  // keeps rebinding protection while their chosen hostname works. Additional
  // names (a reverse-proxy hostname, extra interfaces) are an explicit opt-in via
  // LAVISH_AXI_ALLOWED_HOSTS; a lone "*" there disables the guard for operators
  // who front the server with their own authentication. When a reverse proxy sits
  // in front, X-Forwarded-Host is validated too (see isAllowedRequestHost).
  //
  // This guard is installed as the first middleware so every route - including the
  // attachment upload/fetch/remove endpoints below - is behind the Host allowlist.
  // The mutating-route origin/Referer guard is installed immediately after.
  const allowedHostnames = buildAllowedHostnames({
    host: requestedListenHosts[0],
    hosts: [...requestedListenHosts, ...listenHosts],
    linkHost: resolvedLinkHost,
    allowedHosts: extraHosts,
  });
  const allowAnyHostname = allowsAllHosts(extraHosts);

  // The origin every emitted board link starts with: the configured public URL when set,
  // otherwise the resolved link host on the port this server listens on.
  function linkOrigin() {
    return publicOrigin || `http://${hostForUrl(resolvedLinkHost)}:${publicPort}`;
  }

  function workingUrlFor(req, { includeSessionPath = true } = {}) {
    const origin = linkOrigin();
    if (includeSessionPath && typeof req.path === "string" && req.path.startsWith("/session/")) {
      return `${origin}${req.path}`;
    }
    return `${origin}/`;
  }

  function sendDenied(req, res, { status, error, title, message, workingUrl = undefined }) {
    const resolvedWorkingUrl = workingUrl || workingUrlFor(req);
    if (wantsHtml(req)) {
      res
        .status(status)
        .type("html")
        .send(createDeniedHtml({ title, message, workingUrl: resolvedWorkingUrl, theme }));
      return;
    }
    res.status(status).json({ error });
  }

  function sendSessionNotFound(req, res) {
    sendDenied(req, res, {
      status: 404,
      error: "session not found",
      title: "Session not found",
      message: "This review session does not exist. Return to your agent and open the session URL it printed.",
      workingUrl: workingUrlFor(req, { includeSessionPath: false }),
    });
  }

  // Pre-fix state.json can still name a non-HTML path. Never read that file back to a caller.
  function refuseNonHtmlArtifact(session, res) {
    if (isHtmlPath(session.file)) return false;
    res.status(403).send("Forbidden");
    return true;
  }

  if (!allowAnyHostname) {
    app.use((req, res, next) => {
      const requestHost = { host: req.headers.host, forwardedHost: req.headers["x-forwarded-host"] };
      if (isAllowedRequestHost(requestHost, allowedHostnames)) {
        next();
        return;
      }
      logEvent?.(
        `rejected request with disallowed host host=${req.headers.host ?? ""} x-forwarded-host=${req.headers["x-forwarded-host"] ?? ""} path=${req.path}`,
      );
      sendDenied(req, res, {
        status: 403,
        error: "forbidden host",
        title: "Wrong address",
        message: tailscalePhoneReady
          ? "This Lavish review server does not accept that host. Open the working URL below on this computer or your phone through Tailscale."
          : "This Lavish review server does not accept that host. Open the working URL below on this computer. Phone access is unavailable.",
      });
    });
  }

  // CSRF defense-in-depth on top of the Host allowlist. A foreign page that
  // can reach 127.0.0.1 passes the Host check, but the browser attaches the
  // real Origin, so mutating requests with a present, non-matching Origin or
  // Referer are rejected. Header-less CLI control-channel requests have no
  // Origin and are allowed; the Host allowlist remains their gate. Routes that
  // already call isSameOriginRequest keep those checks - they also reject
  // header-less callers, and this middleware does not replace them.
  app.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      next();
      return;
    }
    if (hasPresentOriginOrReferer(req) && !isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
      res.status(403).json({ error: "cross-origin request rejected" });
      return;
    }
    next();
  });

  const attachmentConfig = resolveAttachmentConfig();
  // Attachment bytes are content-addressed on disk alongside the whiteboard sidecars.
  const attachmentStateRoot = path.dirname(stateFile);
  // The store owns the ONE shared lock covering BOTH state consistency AND the
  // attachment lifecycle. It serializes every state.json read-modify-write
  // internally (E1); the server routes its attachment disk sections - upload
  // finalize, delete, the reference-aware sweep - through the same lock via
  // `store.runExclusive`, so a reference can never be acquired in the window between
  // the sweeper's reference snapshot and its delete (D5), and `queuePrompts` cannot
  // interleave with a concurrent poll.

  const defaultJsonParser = express.json({ limit: "2mb" });
  const whiteboardJsonParser = express.json({ limit: "20mb" });
  app.use((req, res, next) => {
    // The attachment upload reads the raw request stream itself (see the route),
    // so no body parser runs for it - express.raw's limit aborts on Content-Length
    // WITHOUT draining the body, which leaves the browser's in-flight upload to be
    // reset mid-stream instead of receiving the 413.
    if (req.method === "POST" && isAttachmentUploadApiPath(req.path)) return next();
    if (isWhiteboardWriteApiPath(req.path)) return whiteboardJsonParser(req, res, next);
    return defaultJsonParser(req, res, next);
  });

  // ---- The hub (src/hub.js) ----
  // The front page lists every board with a state computed from what this server already knows.
  const DEFAULT_HUB_LIMIT = 50;
  const MAX_HUB_LIMIT = 200;
  const BOARD_IO_CONCURRENCY = 32;
  const MAX_BOARD_HEAD_CACHE = 2048;
  /** @type {Map<string, { stamp: string, title: string, nextStep?: string, searchText: string | null }>} */
  const boardHeadCache = new Map();

  /**
   * @template T, R
   * @param {T[]} items
   * @param {number} concurrency
   * @param {(item: T, index: number) => Promise<R>} worker
   * @returns {Promise<R[]>}
   */
  async function mapLimit(items, concurrency, worker) {
    if (items.length === 0) return [];
    const results = new Array(items.length);
    let cursor = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    });
    await Promise.all(runners);
    return results;
  }

  async function checkBoardFileExists(file) {
    try {
      const st = await stat(file);
      return st.isFile();
    } catch (error) {
      return error?.code !== "ENOENT" && error?.code !== "ENOTDIR";
    }
  }

  async function readBoardHead(file, { includeSearchText = false } = {}) {
    let st;
    try {
      st = await stat(file, { bigint: true });
    } catch (error) {
      boardHeadCache.delete(file);
      return { exists: error?.code !== "ENOENT" && error?.code !== "ENOTDIR", title: "", searchText: "" };
    }
    if (!st.isFile()) {
      boardHeadCache.delete(file);
      return { exists: false, title: "", searchText: "" };
    }
    const stamp = `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
    const cached = boardHeadCache.get(file);
    if (cached && cached.stamp === stamp && (!includeSearchText || cached.searchText !== null)) {
      return { exists: true, title: cached.title, searchText: cached.searchText || "" };
    }
    const maxBytes = includeSearchText ? 1024 * 1024 : 64 * 1024;
    const toRead = Math.min(Number(st.size), maxBytes);
    if (toRead === 0) {
      boardHeadCache.set(file, { stamp, title: "", searchText: "" });
      return { exists: true, title: "", searchText: "" };
    }
    let handle;
    try {
      handle = await openFile(file, "r");
      const buffer = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const html = buffer.subarray(0, bytesRead).toString("utf8");
      const { title, nextStep } = hubArtifactSummary(html);
      const searchText = includeSearchText
        ? boardSearchText(html).slice(0, 64 * 1024)
        : cached && cached.stamp === stamp
          ? cached.searchText
          : null;
      if (!boardHeadCache.has(file) && boardHeadCache.size >= MAX_BOARD_HEAD_CACHE) {
        const oldestKey = boardHeadCache.keys().next().value;
        if (oldestKey !== undefined) boardHeadCache.delete(oldestKey);
      }
      boardHeadCache.set(file, { stamp, title, nextStep, searchText });
      return { exists: true, title, searchText: searchText || "" };
    } catch (error) {
      return { exists: error?.code !== "ENOENT" && error?.code !== "ENOTDIR", title: "", searchText: "" };
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  function liveClientCount(key) {
    let count = 0;
    for (const clientKey of liveEventClients.values()) if (clientKey === key) count += 1;
    return count;
  }

  const peerSettings = new HubPeerSettingsStore(path.dirname(stateFile), hubPeers);
  const peerSeedErrors = await peerSettings.init();
  for (const error of peerSeedErrors) writeLog(`[lavish] ${error}; skipped`);
  /** @type {import("./hub-peers.js").HubPeer[]} */
  let configuredPeers = [];
  /** @type {Set<string>} */
  const livePeerStreams = new Set();
  const collectPeerBoards = createPeerBoardSource([], {
    ...hubPeerOptions,
    isStreamLive: (peerName) => livePeerStreams.has(String(peerName).toLowerCase()),
    onSettled: () => notifyHubViewers(),
  });
  const PEER_WS_BACKOFF_MS = [200, 500, 1000, 2000, 5000];
  /** @type {Map<string, { origin: string, name: string, close: () => void }>} */
  const peerEventSubscriptions = new Map();
  const peerCursorsFile = path.join(path.dirname(stateFile), "peer-cursors.json");
  /** @type {Record<string, { instance_id: string, seq: number }>} */
  const peerCursors = {};
  let peerCursorWriteChain = Promise.resolve();

  async function loadPeerCursors() {
    try {
      const raw = await readFile(peerCursorsFile, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      for (const [k, val] of Object.entries(parsed)) {
        if (!val || typeof val !== "object") continue;
        const inst = typeof val.instance_id === "string" ? val.instance_id.trim() : "";
        const seq = Number(val.seq);
        if (inst || (Number.isInteger(seq) && seq >= 0)) {
          peerCursors[k.toLowerCase()] = {
            instance_id: inst,
            seq: Number.isInteger(seq) && seq >= 0 ? seq : 0,
          };
        }
      }
    } catch {
      // Missing or unreadable sidecar starts fresh.
    }
  }

  function persistPeerCursor(peerKey, instanceId, seq) {
    peerCursors[peerKey] = { instance_id: instanceId, seq };
    const snapshot = `${JSON.stringify(peerCursors, null, 2)}\n`;
    peerCursorWriteChain = peerCursorWriteChain
      .then(async () => {
        const tmp = `${peerCursorsFile}.${process.pid}.tmp`;
        await writeFile(tmp, snapshot, { mode: 0o600 });
        await rename(tmp, peerCursorsFile);
      })
      .catch(() => {});
    return peerCursorWriteChain;
  }

  function applyPeerSettings(peers) {
    configuredPeers = peers;
    collectPeerBoards.setPeers(peers);
    startPeerEventSubscribers();
    void collectPeerBoards({ maxWaitMs: 0 });
    notifyHubViewers();
  }

  function startPeerEventSubscribers() {
    for (const [key, sub] of peerEventSubscriptions) {
      if (configuredPeers.some((peer) => peer.name === sub.name && peer.origin === sub.origin)) continue;
      sub.close();
      peerEventSubscriptions.delete(key);
    }
    for (const peer of configuredPeers) {
      const peerKey = peer.name.toLowerCase();
      if (peerEventSubscriptions.has(peerKey)) continue;
      const savedCursor = peerCursors[peerKey];
      let peerInstanceId = savedCursor?.instance_id || "";
      let lastSeq = savedCursor?.seq || 0;
      let attempt = 0;
      let closed = false;
      let peerFrameQueue = Promise.resolve();
      /** @type {import("ws").WebSocket | null} */
      let socket = null;
      /** @type {ReturnType<typeof setTimeout> | null} */
      let retryTimer = null;
      const wsOrigin = peer.origin.replace(/^http/i, "ws");

      const scheduleReconnect = () => {
        if (closed || shuttingDown || retryTimer) return;
        const delay = PEER_WS_BACKOFF_MS[Math.min(attempt, PEER_WS_BACKOFF_MS.length - 1)];
        attempt += 1;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          connect();
        }, delay);
        retryTimer.unref?.();
      };

      const connect = () => {
        if (closed || shuttingDown) return;
        try {
          const params = new URLSearchParams({ peers: "0", since: String(lastSeq) });
          if (peerInstanceId) params.set("instance", peerInstanceId);
          const ws = new WebSocket(`${wsOrigin}/events/hub?${params}`);
          socket = ws;
          ws.on("open", () => {
            if (closed || shuttingDown) return;
            attempt = 0;
            livePeerStreams.add(peerKey);
            collectPeerBoards?.invalidate(peer.name);
            notifyHubViewers();
          });
          ws.on("message", (raw) => {
            peerFrameQueue = peerFrameQueue
              .then(async () => {
                if (closed || shuttingDown) return;
                const msg = JSON.parse(String(raw));
                if (!msg || typeof msg !== "object") return;
                if (msg.type === "hub-hello") {
                  const nextInstance = typeof msg.instance_id === "string" ? msg.instance_id.trim() : "";
                  if (nextInstance && nextInstance !== peerInstanceId) {
                    peerInstanceId = nextInstance;
                    lastSeq = 0;
                    await persistPeerCursor(peerKey, peerInstanceId, lastSeq);
                    collectPeerBoards?.invalidate(peer.name);
                    notifyHubViewers();
                  }
                  return;
                }
                if (msg.type === "hub-invalidate") {
                  collectPeerBoards?.invalidate(peer.name);
                  notifyHubViewers();
                  return;
                }
                if (msg.type !== "hub-event") return;
                let cursorChanged = false;
                const eventInstance = typeof msg.instance_id === "string" ? msg.instance_id.trim() : "";
                if (eventInstance && eventInstance !== peerInstanceId) {
                  peerInstanceId = eventInstance;
                  lastSeq = 0;
                  cursorChanged = true;
                }
                const seq = Number(msg.seq);
                if (Number.isInteger(seq) && seq > 0) {
                  if (seq <= lastSeq) return;
                  lastSeq = seq;
                  cursorChanged = true;
                }
                if (cursorChanged) {
                  await persistPeerCursor(peerKey, peerInstanceId, lastSeq);
                }
                if (closed || shuttingDown) return;
                collectPeerBoards?.invalidate(peer.name);
                const sanitized = sanitizePeerHubEvent(peer, msg.event);
                if (sanitized) emitHubEvent(sanitized);
              })
              .catch(() => {
                // ignore malformed peer frame
              });
          });
          ws.on("error", () => {});
          ws.on("close", () => {
            if (closed || shuttingDown) return;
            if (socket === ws) socket = null;
            livePeerStreams.delete(peerKey);
            collectPeerBoards?.invalidate(peer.name);
            notifyHubViewers();
            scheduleReconnect();
          });
        } catch {
          scheduleReconnect();
        }
      };

      connect();
      peerEventSubscriptions.set(peerKey, {
        origin: peer.origin,
        name: peer.name,
        close() {
          closed = true;
          livePeerStreams.delete(peerKey);
          if (retryTimer) {
            clearTimeout(retryTimer);
            retryTimer = null;
          }
          if (socket) {
            try {
              socket.terminate();
            } catch {
              // ignore
            }
            socket = null;
          }
        },
      });
    }
    refreshIdleTimer();
  }

  function closePeerEventSubscribers() {
    for (const sub of peerEventSubscriptions.values()) sub.close();
    peerEventSubscriptions.clear();
    collectPeerBoards.setPeers([]);
  }

  const PEER_TOTAL_SEARCH_TEXT_BUDGET = 16 * 1024 * 1024;

  function stripBoardSearchText(board) {
    if (!board || typeof board !== "object" || !Object.hasOwn(board, "search_text")) return board;
    const copy = { ...board };
    delete copy.search_text;
    return copy;
  }

  function parseHubLimit(rawLimit) {
    if (rawLimit === undefined || rawLimit === "") return DEFAULT_HUB_LIMIT;
    const parsed = Number(rawLimit);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_HUB_LIMIT;
    return Math.min(Math.floor(parsed), MAX_HUB_LIMIT);
  }

  function parseHubOffset(rawOffset) {
    if (rawOffset === undefined || rawOffset === "") return 0;
    const parsed = Number(rawOffset);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.min(Math.floor(parsed), 1_000_000);
  }

  const HUB_INITIAL_PEER_WAIT_MS = 80;
  // Whois runs after first paint. Never let a slow identity probe hold GET /.
  const hubViewers = new Map();
  function cachedHubViewer(req) {
    return hubViewers.get(normalizeRemoteIp(req.socket?.remoteAddress)) || [];
  }
  app.get("/api/hub/viewer", async (req, res) => {
    const ip = normalizeRemoteIp(req.socket?.remoteAddress);
    let viewer = [];
    if (ip && !isOwnServerIp(ip) && typeof whoisPeer === "function") {
      try {
        const identity = await whoisPeer(ip, req.socket?.remotePort);
        viewer = hubViewerNames(identity, resolvedApprovalUsers);
      } catch {
        /* Unknown identity uses the needs-input fallback. */
      }
    }
    // Bound the cache; identity remains a display preference, never authorization.
    if (hubViewers.size >= 256) hubViewers.clear();
    hubViewers.set(ip, viewer);
    res.setHeader("cache-control", "no-store");
    res.json({ viewer });
  });

  /**
   * @param {{
   *   includePeers?: boolean,
   *   maxPeerWaitMs?: number,
   *   peersOnly?: boolean,
   *   query?: string,
   *   tag?: string,
   *   state?: string,
   *   client?: string,
   *   person?: string,
   *   needsInput?: boolean,
   *   recent?: boolean,
   *   viewer?: string[],
   *   limit?: number,
   *   offset?: number,
   * }} [options]
   */
  async function queryHub({
    includePeers = true,
    maxPeerWaitMs = undefined,
    peersOnly = false,
    query = "",
    tag = "",
    state = "",
    client = "",
    person = "",
    needsInput = false,
    recent = false,
    viewer = [],
    limit = DEFAULT_HUB_LIMIT,
    offset = 0,
  } = {}) {
    const [sessions, remote] = await Promise.all([
      store.listSessions(),
      includePeers && collectPeerBoards ? collectPeerBoards({ maxWaitMs: maxPeerWaitMs }) : null,
    ]);
    const now = Date.now();
    /** @type {Map<string, any>} */
    const sessionByKey = new Map();
    const openSessions = [];
    for (const session of sessions) {
      sessionByKey.set(String(session.key), session);
      if (session.status !== "ended") openSessions.push(session);
    }
    const openExists = await mapLimit(openSessions, BOARD_IO_CONCURRENCY, (session) =>
      checkBoardFileExists(session.file),
    );
    /** @type {Map<string, boolean>} */
    const existsByKey = new Map();
    for (let i = 0; i < openSessions.length; i += 1) {
      existsByKey.set(String(openSessions[i].key), openExists[i]);
    }

    const buildLocalBoard = (session, facts = {}) => {
      const holder = activePolls.get(session.key);
      const cachedHead = boardHeadCache.get(session.file);
      return serializeHubBoard(session, {
        listener: holder ? listenerLabel(holder) : null,
        tabs: liveClientCount(session.key),
        fileExists: facts.fileExists !== undefined ? facts.fileExists : (existsByKey.get(String(session.key)) ?? true),
        title: facts.title !== undefined ? facts.title : cachedHead?.title || "",
        nextStep: cachedHead?.nextStep || "",
        ...(facts.includeSearchText ? { searchText: facts.searchText || "", includeSearchText: true } : {}),
        version,
        now,
      });
    };

    const localSkeletons = sessions.map((session) => buildLocalBoard(session));
    const remoteBoards = remote
      ? remote.boards.map((board) => ({ ...board, version_behind: boardVersionBehind(board, version) }))
      : [];
    const sortedAll = sortHubBoards([...localSkeletons, ...remoteBoards]);
    const summary = {
      ...summarizeHubBoards(sortedAll),
      people: [...new Set([...Object.keys(notifySettingsStore.getSync()), ...resolvedApprovalUsers.keys()])],
    };
    const needsYou = sortedAll.filter((board) => boardNeedsYou(board, viewer));
    const extraFilters = { client, person, needsInput, recent, now };
    const sourceBoards = state === "needs-you" ? needsYou : sortedAll;

    const cleanQuery = String(query || "").trim();
    const cleanTag = String(tag || "").trim();
    const cleanState = state === "needs-you" ? "open" : String(state || "").trim();

    let candidates = filterHubBoards(sourceBoards, { query: "", tag: cleanTag, state: cleanState, ...extraFilters });
    let filtered;
    if (cleanQuery) {
      const hydrated = await mapLimit(candidates, BOARD_IO_CONCURRENCY, async (board) => {
        if (board.source) return board;
        const session = sessionByKey.get(board.key);
        if (!session) return board;
        const head = await readBoardHead(session.file, { includeSearchText: true });
        return buildLocalBoard(session, {
          fileExists: head.exists,
          title: head.title,
          searchText: head.searchText,
          includeSearchText: true,
        });
      });
      filtered = sortHubBoards(
        filterHubBoards(hydrated, { query: cleanQuery, tag: cleanTag, state: cleanState, ...extraFilters }),
      );
    } else {
      filtered = candidates;
    }

    if (peersOnly) {
      let peerSlice = filtered.slice(0, PEER_MAX_BOARDS);
      if (!cleanQuery && peerSlice.length > 0) {
        peerSlice = await mapLimit(peerSlice, BOARD_IO_CONCURRENCY, async (board) => {
          if (board.source) return board;
          const session = sessionByKey.get(board.key);
          if (!session) return board;
          const head = await readBoardHead(session.file, { includeSearchText: true });
          return buildLocalBoard(session, {
            fileExists: head.exists,
            title: head.title,
            searchText: head.searchText,
            includeSearchText: true,
          });
        });
      }
      if (peerSlice.length > 0) {
        const perBoardMax = Math.min(
          64 * 1024,
          Math.max(4 * 1024, Math.floor(PEER_TOTAL_SEARCH_TEXT_BUDGET / peerSlice.length)),
        );
        if (perBoardMax < 64 * 1024) {
          peerSlice = peerSlice.map((board) =>
            typeof board.search_text === "string" && board.search_text.length > perBoardMax
              ? { ...board, search_text: board.search_text.slice(0, perBoardMax) }
              : board,
          );
        }
      }
      return {
        boards: peerSlice,
        needs_you: [],
        needs_you_total: 0,
        needs_you_count: 0,
        viewer: [],
        peers: [],
        ...summary,
        total: filtered.length,
        limit: PEER_MAX_BOARDS,
        offset: 0,
        has_more: filtered.length > peerSlice.length,
      };
    }

    const total = filtered.length;
    let pageSlice = filtered.slice(offset, offset + limit);
    if (!cleanQuery && pageSlice.length > 0) {
      pageSlice = await mapLimit(pageSlice, BOARD_IO_CONCURRENCY, async (board) => {
        if (board.source) return board;
        const session = sessionByKey.get(board.key);
        if (!session) return board;
        const head = await readBoardHead(session.file, { includeSearchText: false });
        return buildLocalBoard(session, { fileExists: head.exists, title: head.title });
      });
    }
    const publicBoards = pageSlice.map(stripBoardSearchText);
    const attention = filtered.filter((board) => boardNeedsYou(board, viewer));
    const pageByKey = new Map(publicBoards.map((board) => [board.key, board]));
    const pinned = await mapLimit(attention.slice(0, DEFAULT_HUB_LIMIT), BOARD_IO_CONCURRENCY, async (board) => {
      if (pageByKey.has(board.key)) return pageByKey.get(board.key);
      if (board.source || cleanQuery) return stripBoardSearchText(board);
      const session = sessionByKey.get(board.key);
      const head = await readBoardHead(session.file);
      return buildLocalBoard(session, { fileExists: head.exists, title: head.title });
    });
    return {
      boards: publicBoards,
      needs_you: pinned,
      needs_you_total: attention.length,
      needs_you_count: needsYou.length,
      viewer,
      peers: remote ? remote.peers : [],
      ...summary,
      total,
      limit,
      offset,
      has_more: offset + publicBoards.length < total,
      notify_settings: notifySettingsStore.getSync(),
    };
  }

  app.get("/", async (req, res, next) => {
    try {
      res.setHeader("x-frame-options", "DENY");
      res.setHeader("content-security-policy", "frame-ancestors 'none'");
      const view = await queryHub({
        includePeers: true,
        maxPeerWaitMs: HUB_INITIAL_PEER_WAIT_MS,
        state: "open",
        viewer: cachedHubViewer(req),
        limit: DEFAULT_HUB_LIMIT,
        offset: 0,
      });
      res.type("html").send(
        createHubHtml({
          boards: view.boards,
          peers: view.peers,
          counts: view.counts,
          openSummary: view.open_summary,
          tags: view.tags,
          total: view.total,
          limit: view.limit,
          offset: view.offset,
          hasMore: view.has_more,
          notifySettings: notifySettingsStore.getSync(),
          hostname: osHostname(),
          title: String(env.LAVISH_AXI_HUB_TITLE || "")
            .trim()
            .slice(0, 120),
          needsYou: view.needs_you,
          needsYouTotal: view.needs_you_total,
          needsYouCount: view.needs_you_count,
          clients: view.clients,
          people: view.people,
          viewer: view.viewer,
          identifyViewer: Boolean(
            normalizeRemoteIp(req.socket?.remoteAddress) &&
            !isOwnServerIp(normalizeRemoteIp(req.socket?.remoteAddress)),
          ),
          theme,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/hub/peers", async (_req, res, next) => {
    try {
      const { peers } = await collectPeerBoards({ maxWaitMs: 0 });
      res.json({ peers });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/hub/peers", async (req, res, next) => {
    if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
      res.status(403).json({ error: "cross-origin peer settings write rejected" });
      return;
    }
    try {
      await peerSettings.mutate(req.body, applyPeerSettings);
      const { peers } = await collectPeerBoards({ maxWaitMs: 0 });
      res.json({ peers });
    } catch (error) {
      if (error instanceof HubPeerSettingsError) {
        res.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  const getNotifyDestinations = createNotifyDestinations(String(env.LAVISH_AXI_NOTIFY_DESTINATIONS || "").trim(), env);
  app.get("/api/hub/notification-destinations", async (_req, res) => {
    res.set("Cache-Control", "no-store").json(await getNotifyDestinations());
  });
  app.post("/api/hub/notifications/test", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin notification test rejected" });
        return;
      }
      const person = normalizeNotifyPersonName(req.body?.person);
      const sendTo = normalizeNotifySendTo(req.body?.send_to);
      const settings = notifySettingsStore.getSync();
      if (!Object.hasOwn(settings, person) || !sendTo) {
        throw new NotifySettingsError("Choose a person and a destination first");
      }
      if (!onEvent && !String(env.LAVISH_AXI_ON_EVENT || process.env.LAVISH_AXI_ON_EVENT || "").trim()) {
        res.status(503).json({ error: "Notifications are not connected on this hub yet." });
        return;
      }
      const delivery = emitHubEvent(
        {
          event: "notify_test",
          person,
          send_to: sendTo,
          reason: "test",
          title: "Test notification",
          url: `http://${hostForUrl(LOOPBACK_HOST)}:${publicPort}/`,
        },
        { broadcast: false, notifySnapshot: { ...settings, [person]: { ...settings[person], send_to: sendTo } } },
      );
      const launched = await delivery.launched;
      if (!launched.ok) {
        res.status(503).json({ error: "Could not start the notification hook. Check the server log." });
        return;
      }
      res.status(202).json({ message: "Test queued. Check your destination." });
    } catch (error) {
      if (error instanceof NotifySettingsError) res.status(error.statusCode).json({ error: error.message });
      else next(error);
    }
  });

  app.get("/api/hub/notifications", async (_req, res, next) => {
    try {
      const current = await notifySettingsStore.get();
      res.json({ notify_settings: current, revision: notifySettingsStore.revision() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/hub/notifications", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin notification settings write rejected" });
        return;
      }
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null;
      let saved;
      if (body && Object.hasOwn(body, "seed")) {
        saved = await notifySettingsStore.seedIfMissing(typeof body.seed === "string" ? body.seed : "");
      } else if (body && Object.hasOwn(body, "add")) {
        saved = await notifySettingsStore.addPerson(body.add);
      } else if (body && Object.hasOwn(body, "remove")) {
        saved = await notifySettingsStore.removePerson(body.remove);
      } else if (body && Object.hasOwn(body, "patch")) {
        saved = await notifySettingsStore.patchPerson(body.patch);
      } else {
        const rawSettings = body && Object.hasOwn(body, "notify_settings") ? body.notify_settings : req.body;
        const expectedRevision = body && typeof body.revision === "string" ? body.revision.trim() : "";
        saved = await notifySettingsStore.save(rawSettings, { expectedRevision });
      }
      notifyHubViewers();
      res.json({ notify_settings: saved, revision: notifySettingsStore.revision() });
    } catch (error) {
      if (error instanceof NotifySettingsError) {
        res.status(error.statusCode || 400).json({
          error: error.message,
          notify_settings: notifySettingsStore.getSync(),
          revision: notifySettingsStore.revision(),
        });
        return;
      }
      next(error);
    }
  });

  app.get("/api/hub", async (req, res, next) => {
    try {
      // `?peers=0` is what a peer hub asks for: this server's own boards only, so hubs that list
      // each other never loop, and bounded to PEER_MAX_BOARDS so a large peer never overflows PEER_MAX_BYTES.
      const peersOnly = req.query.peers === "0";
      const view = await queryHub({
        includePeers: !peersOnly,
        peersOnly,
        maxPeerWaitMs: HUB_INITIAL_PEER_WAIT_MS,
        query: String(req.query.q || ""),
        tag: String(req.query.tag || ""),
        state: String(req.query.state || ""),
        client: String(req.query.client || ""),
        person: String(req.query.person || ""),
        needsInput: req.query.needs_input === "1",
        recent: req.query.recent === "1",
        viewer: cachedHubViewer(req),
        limit: parseHubLimit(req.query.limit),
        offset: parseHubOffset(req.query.offset),
      });
      res.json({
        ...view,
        action_label: resolvedActionLabel,
        version,
        generated_at: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  // Close from the hub. Same-origin like /prompts: only the hub page may close a board this way.
  // Unlike the board's own End, it never shuts the server down - the reviewer is still on the hub.
  // Configured peer boards relay to that peer's own hub endpoint with zero viewer headers forwarded.
  app.post("/api/hub/:key/close", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin close rejected" });
        return;
      }
      if (isPeerKey(req.params.key)) {
        const target = resolvePeerBoardTarget(req.params.key, configuredPeers);
        if (!target) {
          res.status(404).json({ error: "peer board not found" });
          return;
        }
        // peer_origin is optional for older tabs/API callers; when sent, a changed mapping fails closed.
        if (req.body?.peer_origin !== undefined && req.body?.peer_origin !== target.peer.origin) {
          res.status(409).json({ error: "peer hub changed; refresh before trying again" });
          return;
        }
        const relayed = await relayPeerHubAction(target.peer, target.peerKey, "close", hubPeerOptions);
        if (relayed.ok) collectPeerBoards?.invalidate(target.peer.name);
        res.status(relayed.status).json(relayed.payload);
        return;
      }
      const session = await store.endSession(req.params.key, "user");
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (session.end_changed) {
        clearFeedbackDelivery(req.params.key, activePolls, deliveredFeedback, events);
        events.emit("ended", req.params.key, session.ended_by);
      }
      res.json({ status: "ended", ended_by: session.ended_by, ...serializeBoardMetadata(session) });
    } catch (error) {
      next(error);
    }
  });

  // Cancel from the hub or board chrome: ends the board without marking it Done, so external brain
  // hooks skip cancelled boards while keeping them searchable and restorable from Cancelled.
  app.post("/api/hub/:key/cancel", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin cancel rejected" });
        return;
      }
      if (isPeerKey(req.params.key)) {
        const target = resolvePeerBoardTarget(req.params.key, configuredPeers);
        if (!target) {
          res.status(404).json({ error: "peer board not found" });
          return;
        }
        // peer_origin is optional for older tabs/API callers; when sent, a changed mapping fails closed.
        if (req.body?.peer_origin !== undefined && req.body?.peer_origin !== target.peer.origin) {
          res.status(409).json({ error: "peer hub changed; refresh before trying again" });
          return;
        }
        const relayed = await relayPeerHubAction(target.peer, target.peerKey, "cancel", hubPeerOptions);
        if (relayed.ok) collectPeerBoards?.invalidate(target.peer.name);
        res.status(relayed.status).json(relayed.payload);
        return;
      }
      const session = await store.endSession(req.params.key, "user", { cancelled: true });
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (session.end_changed) {
        clearFeedbackDelivery(req.params.key, activePolls, deliveredFeedback, events);
        events.emit("ended", req.params.key, session.ended_by);
      }
      res.json({ status: "ended", ended_by: session.ended_by, ...serializeBoardMetadata(session) });
    } catch (error) {
      next(error);
    }
  });

  // Reactivate a closed or cancelled board from the hub in one tap (local or configured peer).
  app.post("/api/hub/:key/reopen", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin reopen rejected" });
        return;
      }
      if (isPeerKey(req.params.key)) {
        const target = resolvePeerBoardTarget(req.params.key, configuredPeers);
        if (!target) {
          res.status(404).json({ error: "peer board not found" });
          return;
        }
        // peer_origin is optional for older tabs/API callers; when sent, a changed mapping fails closed.
        if (req.body?.peer_origin !== undefined && req.body?.peer_origin !== target.peer.origin) {
          res.status(409).json({ error: "peer hub changed; refresh before trying again" });
          return;
        }
        const relayed = await relayPeerHubAction(target.peer, target.peerKey, "reopen", hubPeerOptions);
        if (relayed.ok) collectPeerBoards?.invalidate(target.peer.name);
        res.status(relayed.status).json(relayed.payload);
        return;
      }
      const existing = await store.findByKey(req.params.key);
      if (!existing) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      const file = await resolveAllowedArtifactFile(existing.file);
      const key = sessionKey(file);
      const sessionUrl = `${linkOrigin()}/session/${key}`;
      const wasReopened = existing.status === "ended";
      const session = await store.upsertSession(file, sessionUrl, { version });
      if (wasReopened) {
        clearFeedbackDelivery(key, activePolls, deliveredFeedback, events);
      }
      logEvent?.(`session reopened from hub key=${key} file=${file}`);
      await syncOutstandingRepairs(key);
      await watchSession(session, watchers, events, logEvent, reloadDebounceMs);
      if (wasReopened) {
        const { title } = await readBoardHead(session.file);
        emitHubEvent({
          event: "board_reopened",
          key,
          file: session.file,
          url: session.url,
          title: boardTitle(session, title),
          creator: session.creator || "",
          tags: session.tags || [],
          created_version: session.created_version || "",
          served_version: session.served_version || "",
        });
      }
      res.json({
        key,
        file,
        url: sessionUrl,
        status: "opened",
        ...serializeBoardMetadata(session),
        ...networkWarningField(),
      });
    } catch (error) {
      if (isArtifactPathError(error)) {
        res.status(error.statusCode).json({
          status: "error",
          code: error.code,
          error: error.message,
        });
        return;
      }
      next(error);
    }
  });

  // Generic configurable board workflow action (default label "Send", overridden via
  // LAVISH_AXI_ACTION_LABEL). Normal board chat stays free conversation; clicking this control (or
  // passing --send from the CLI) fires `board_action` so each person's external workflow can run.
  app.post("/api/:key/action", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin action rejected" });
        return;
      }
      if (isPeerKey(req.params.key)) {
        res.status(400).json({ error: "run actions on a peer board from its own server" });
        return;
      }
      let current = await store.findByKey(req.params.key);
      if (!current) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (current.status === "ended") {
        res.status(409).json({ status: "ended", error: "session already ended", ended_by: current.ended_by });
        return;
      }
      const activeHolder = activePolls.get(req.params.key);
      const inlinePrompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
      const inlineAuthor = typeof req.body?.author === "string" ? req.body.author.trim() : "";
      const inlineAttachments = req.body?.attachments;
      let acceptedPrompts = [];
      let clearedTags = [];
      if (inlinePrompt || inlineAttachments != null) {
        const queued = await store.queuePrompts(
          req.params.key,
          {
            prompts: [
              {
                uid: "",
                prompt: inlinePrompt,
                selector: "",
                tag: "message",
                text: "Board message",
                prompt_id: `action-${crypto.randomUUID()}`,
                ...(inlineAuthor ? { author: inlineAuthor } : {}),
                ...(inlineAttachments != null ? { attachments: inlineAttachments } : {}),
              },
            ],
          },
          {
            resolveAttachment: (sessionKeyValue, id) => resolveAttachment(attachmentStateRoot, sessionKeyValue, id),
            maxPerPrompt: attachmentConfig.maxPerPrompt,
            maxPromptBytes: attachmentConfig.maxPromptBytes,
          },
        );
        if (!queued) {
          res.status(404).json({ error: "session not found" });
          return;
        }
        if (queued.ended) {
          res.status(409).json({ status: "ended", error: "session already ended", ended_by: queued.ended_by });
          return;
        }
        if (queued.rejected) {
          res.status(400).json({
            error: "some attachments could not be delivered",
            rejected: queued.rejected,
            caps: queued.caps,
          });
          return;
        }
        if (queued.conflict) {
          res.status(409).json({ status: "conflict", error: "message could not be queued" });
          return;
        }
        current = queued;
        acceptedPrompts = Array.isArray(queued.accepted_prompts) ? queued.accepted_prompts : [];
        clearedTags = Array.isArray(queued.cleared_tags) ? queued.cleared_tags : [];
        if (queued.fresh_feedback) {
          emitHubEvent({
            event: "message",
            key: req.params.key,
            file: current.file,
            url: current.url,
            creator: current.creator || "",
            tags: current.tags || [],
            had_listener: Boolean(activeHolder),
            listener: activeHolder ? listenerLabel(activeHolder) : null,
            prompts: acceptedPrompts,
          });
          events.emit("feedback", req.params.key, current.ended_by);
          events.emit("chat-sync", req.params.key, current);
        }
      }
      if (Array.isArray(current.tags) && current.tags.some((tag) => String(tag).toLowerCase() === "needs-input")) {
        const priorTags = current.tags;
        const updated = await store.updateBoardTags(req.params.key, { remove: ["needs-input"] });
        if (updated) {
          const diff = tagDiff(priorTags, updated.tags || []);
          clearedTags = [...clearedTags, ...diff.removed];
          current = updated;
        }
      }
      const metadata = serializeBoardMetadata(current);
      const head = await readBoardHead(current.file);
      if (clearedTags.length) {
        events.emit("board-metadata", req.params.key, metadata);
        emitHubEvent({
          event: "tag_change",
          key: req.params.key,
          file: current.file,
          url: current.url,
          title: boardTitle(current, head.title),
          creator: current.creator || "",
          tags: metadata.tags,
          added: [],
          removed: clearedTags,
        });
      }
      const actionName =
        String(req.body?.action || "send")
          .trim()
          .slice(0, 40) || "send";
      const actionHook = emitHubEvent({
        event: "board_action",
        action: actionName,
        action_label: resolvedActionLabel,
        key: req.params.key,
        file: current.file,
        url: current.url,
        title: boardTitle(current, head.title),
        creator: current.creator || "",
        tags: metadata.tags,
        had_listener: Boolean(activeHolder),
        listener: activeHolder ? listenerLabel(activeHolder) : null,
        ...(inlineAuthor ? { author: inlineAuthor } : {}),
        prompts: acceptedPrompts.length ? acceptedPrompts : current.prompts || [],
        chat: current.chat || [],
      });
      // Send stays fire-and-forget (as before 11/21): waiting on the ordered hook queue could outlast a
      // caller's timeout and invite a retry that dispatches the same work twice. Launch failures are logged.
      void actionHook;
      res.json({
        status: "sent",
        action: actionName,
        action_label: resolvedActionLabel,
        ...metadata,
        ...serializeChatSync(current),
      });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/:key/metadata", async (req, res, next) => {
    if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
      res.status(403).json({ error: "cross-origin metadata write rejected" });
      return;
    }
    try {
      if (Object.hasOwn(req.body || {}, "client")) {
        const isPeer = isPeerKey(req.params.key);
        if (Object.keys(req.body).some((field) => !["client", ...(isPeer ? ["peer_origin"] : [])].includes(field))) {
          throw new BoardMetadataError("Use an exclusive client patch");
        }
        const client = normalizeClient(req.body.client);
        if (isPeer) {
          const target = resolvePeerBoardTarget(req.params.key, configuredPeers);
          if (!target) return void res.status(404).json({ error: "peer board not found" });
          if (req.body.peer_origin !== target.peer.origin)
            return void res.status(409).json({ error: "peer hub changed; refresh before trying again" });
          const relayed = await relayPeerBoardClient(target.peer, target.peerKey, client, hubPeerOptions);
          if (relayed.ok) collectPeerBoards.invalidate(target.peer.name);
          res.status(relayed.status).json(relayed.payload);
          return;
        }
        const session = await store.updateBoardClient(req.params.key, client);
        if (!session) return void res.status(404).json({ error: "session not found" });
        const metadata = serializeBoardMetadata(session);
        events.emit("board-metadata", req.params.key, metadata);
        if (session.client_changed) {
          const { title } = await readBoardHead(session.file);
          emitHubEvent({
            event: "tag_change",
            key: req.params.key,
            file: session.file,
            url: session.url,
            title: boardTitle(session, title),
            creator: session.creator || "",
            tags: metadata.tags,
            client: metadata.client,
            previous_client: session.previous_client,
            added: [],
            removed: [],
          });
        }
        res.json(metadata);
        return;
      }
      if (isPeerKey(req.params.key)) return void res.status(400).json({ error: "edit a peer board on its own server" });
      if (Object.hasOwn(req.body || {}, "creator") || Object.hasOwn(req.body || {}, "expected_file")) {
        const session = await store.fillEmptyCreator(req.params.key, req.body);
        if (!session) return void res.status(404).json({ error: "session not found" });
        if (session.conflict) return void res.status(409).json({ error: "creator update preconditions changed" });
        const metadata = serializeBoardMetadata(session);
        events.emit("board-metadata", req.params.key, metadata);
        res.json(metadata);
        return;
      }
      const prior = await store.findByKey(req.params.key);
      const session = await store.updateBoardTags(req.params.key, req.body);
      if (!session) return void res.status(404).json({ error: "session not found" });
      const metadata = serializeBoardMetadata(session);
      events.emit("board-metadata", req.params.key, metadata);
      const { added, removed } = tagDiff(prior?.tags || [], metadata.tags);
      if (added.length || removed.length) {
        const { title } = await readBoardHead(session.file);
        emitHubEvent({
          event: "tag_change",
          key: req.params.key,
          file: session.file,
          url: session.url,
          title: boardTitle(session, title),
          creator: session.creator || "",
          tags: metadata.tags,
          added,
          removed,
        });
      }
      res.json(metadata);
    } catch (error) {
      if (error instanceof BoardMetadataError) {
        res.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  app.get("/board-metadata.css", async (_req, res, next) => {
    try {
      res.type("text/css").send(await readFile(new URL("./board-metadata.css", import.meta.url), "utf8"));
    } catch (error) {
      next(error);
    }
  });

  app.get("/board-metadata-client.js", async (_req, res, next) => {
    try {
      res
        .type("application/javascript")
        .send(await readFile(new URL("./board-metadata-client.js", import.meta.url), "utf8"));
    } catch (error) {
      next(error);
    }
  });

  // A board's conversation, for the hub's history view and for keeping a closed board's record.
  // Read-only, like the session page that already shows it. `?format=markdown` returns Markdown.
  app.get("/api/:key/conversation", async (req, res, next) => {
    try {
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      const { title } = await readBoardHead(session.file);
      if (req.query.format === "markdown") {
        res.type("text/markdown").send(conversationMarkdown(session, { title }));
        return;
      }
      res.json({
        ...serializeBoardMetadata(session),
        key: session.key,
        file: session.file,
        title: boardTitle(session, title),
        status: session.status === "ended" ? "ended" : "open",
        ended_by: session.status === "ended" ? session.ended_by || "agent" : null,
        updated_at: session.updated_at || "",
        owner: serializeOwnerStatus(session.owner_status),
        chat: serializeChat(session.chat || []),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/hub-client.js", async (_req, res, next) => {
    try {
      res.type("application/javascript").send(await readFile(hubClientUrl, "utf8"));
    } catch (error) {
      next(error);
    }
  });

  app.get("/hub.css", async (_req, res, next) => {
    try {
      res.type("text/css").send(await readFile(hubCssUrl, "utf8"));
    } catch (error) {
      next(error);
    }
  });

  app.get("/health", async (req, res) => {
    if (!serverReady) {
      res.status(503).json({ ok: false, app: "lavish-axi", version });
      return;
    }
    const networkStale = req.query.reconcile_network === "1" ? await reconcileNetwork() : false;
    const networkWarning = currentNetworkWarning();
    res.json({
      ok: true,
      app: "lavish-axi",
      version,
      state_id: serverStateId,
      state_dir: path.dirname(stateFile),
      // Where this process is listening and every address it was asked to serve (bound or still
      // retrying). The CLI uses both to find one daemon per port whatever host it was configured
      // with, and to tell a same-port daemon at another address apart from this one.
      hosts: [...boundHosts],
      // Configured names sit beside the addresses they resolved to, so a CLI that resolves the same
      // name finds it served whichever form it compares.
      requested_hosts: [...new Set([...listenHosts, ...requestedListenHosts])],
      ...(networkStale ? { network_stale: true } : {}),
      ...(networkWarning ? { network_warning: networkWarning } : {}),
      listeners: [...activePolls].map(([key, holder]) => ({
        key,
        label: listenerLabel(holder),
      })),
    });
  });

  let shutdownResolve;
  const done = new Promise((resolve) => {
    shutdownResolve = resolve;
  });

  app.post("/shutdown", (req, res) => {
    // The caller names the session it is about to reopen, and only that session's chrome is
    // reloaded. A call that names none reloads nothing. It also names why it is shutting this
    // server down, because the banner every other chrome shows has to be true for that reason;
    // an unrecognized or absent reason claims nothing beyond "this server is gone".
    const reloadKey = String(req.body?.reload_key || "");
    const reason = SHUTDOWN_REASONS.has(String(req.body?.reason || "")) ? String(req.body.reason) : "";
    res.json({ status: "shutting-down" });
    // Defer until after the response flushes so the client gets confirmation.
    setImmediate(() => shutdown(reloadKey, reason, "shutdown-request"));
  });

  app.post("/api/sessions", async (req, res, next) => {
    try {
      let creator;
      try {
        creator = normalizeCreator(req.body?.creator);
      } catch (error) {
        res.status(400).json({ error: error.message });
        return;
      }
      const file = await resolveAllowedArtifactFile(req.body?.file);
      const key = sessionKey(file);
      const reopen = Boolean(req.body.reopen);
      const existing = await store.findByKey(key);
      const sessionUrl = `${linkOrigin()}/session/${key}`;
      // A user-initiated end (ending or send-and-ending from the browser) means the human
      // deliberately closed the review surface. Silently reopening it on the next
      // `lavish-axi <file>` is the exact behavior this route exists to prevent - require an
      // explicit `reopen` opt-in instead of reviving it automatically. Agent-initiated ends
      // (`lavish-axi end`) keep reviving on the next open, same as before this change.
      if (existing?.status === "ended" && existing.ended_by === "user" && !reopen) {
        logEvent?.(`session open blocked (user-ended) key=${key} file=${file}`);
        res.json({
          key,
          file,
          url: sessionUrl,
          status: "user-ended",
          ...serializeBoardMetadata(existing),
          ...networkWarningField(),
        });
        return;
      }
      const url = shouldDisableLayoutGateOpen(req.body || {}) ? appendNoGateParam(sessionUrl) : sessionUrl;
      const wasNew = !existing;
      const wasReopened = Boolean(existing && existing.status === "ended");
      const session = await store.upsertSession(file, sessionUrl, { creator: creator || undefined, version });
      if (existing?.status === "ended") {
        clearFeedbackDelivery(key, activePolls, deliveredFeedback, events);
      }
      logEvent?.(`session opened key=${key} file=${file}`);
      await syncOutstandingRepairs(key);
      await watchSession(session, watchers, events, logEvent, reloadDebounceMs);
      if (wasNew || wasReopened) {
        const { title } = await readBoardHead(session.file);
        emitHubEvent({
          event: wasNew ? "board_created" : "board_reopened",
          key,
          file: session.file,
          url: session.url,
          title: boardTitle(session, title),
          creator: session.creator || "",
          tags: session.tags || [],
          created_version: session.created_version || "",
          served_version: session.served_version || "",
        });
      }
      res.json({
        key,
        file,
        url,
        status: "opened",
        ...serializeBoardMetadata(session),
        ...networkWarningField(),
      });
    } catch (error) {
      if (isArtifactPathError(error)) {
        res.status(error.statusCode).json({
          status: "error",
          code: error.code,
          error: error.message,
        });
        return;
      }
      next(error);
    }
  });

  async function publishAgentReply(key, text, { requireOpen = false } = {}) {
    const session = await store.addAgentReply(key, text, { requireOpen });
    if (!session || (requireOpen && session.status === "ended")) return session;
    const lastEntry = session.chat?.at(-1);
    const entry = serializeChat([
      lastEntry?.role === "agent" ? lastEntry : { role: "agent", text, at: session.updated_at },
    ])[0];
    events.emit("agent-reply", key, entry);
    events.emit("chat-sync", key, session);
    // The reply concludes the delivered-feedback "working" state. Human sends remain available
    // while working because the server queues them for the next poll.
    clearFeedbackDelivery(key, activePolls, deliveredFeedback, events);
    return session;
  }

  const handlePoll = async (req, res, next) => {
    const takeover = req.query.takeover === "1";
    const agentReply =
      req.method === "POST" && req.body?.agent_reply !== undefined ? String(req.body.agent_reply) : null;
    if (takeover && req.method !== "POST") {
      res.status(405).json({ error: "poll takeover requires POST" });
      return;
    }
    if (req.method === "POST" && (agentReply === null ? !takeover : !agentReply.trim())) {
      res.status(405).json({ error: "POST /api/poll requires agent_reply or takeover=1" });
      return;
    }
    // `close` is subscribed before the first `await` and re-checked after the listeners are armed,
    // because a client that disconnects while `takeFeedback` is in flight would otherwise arrive
    // too late for its own cleanup: the handler marks the poll active afterwards and nothing left
    // would clear it, leaving presence stuck on "listening" for an agent that is already gone.
    let requestClosed = Boolean(req.aborted || (req.method !== "POST" && req.destroyed));
    let cleanupPoll = null;
    let claimedHolder = null;
    const onRequestClose = () => {
      // A POST request emits `close` when its JSON body stream ends, before the long-poll
      // response has been written. `aborted` distinguishes that normal parser lifecycle from a
      // client that actually went away.
      if (req.method === "POST" && !req.aborted) return;
      requestClosed = true;
      cleanupPoll?.();
    };
    const onResponseClose = () => {
      // Once the body has been parsed, a POST request's close event is no longer useful: the
      // response socket is the authoritative signal for a client that aborts its long-poll.
      if (req.method === "POST" && !res.writableEnded) {
        requestClosed = true;
        cleanupPoll?.();
      }
    };
    res.on("close", onResponseClose);
    const detachRequestClose = () => req.off("close", onRequestClose);
    req.on("close", onRequestClose);
    try {
      const file = await canonicalFile(String(req.query.file || ""));
      const key = sessionKey(file);
      const ownerValue = typeof req.query.owner === "string" ? req.query.owner.trim() : "";
      if (ownerValue.toLowerCase() === "none" || ownerValue.startsWith("-")) {
        detachRequestClose();
        res.status(400).json({
          status: "error",
          code: "VALIDATION_ERROR",
          error: "--owner none is reserved; pass a different listener label",
        });
        return;
      }
      const owner = ownerValue || null;
      if (hasPresentOriginOrReferer(req) && !isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        detachRequestClose();
        res.status(403).json({ error: "cross-origin poll takeover rejected" });
        return;
      }
      const { holder, previousPresence, conflict, missing } = await pollOwnershipLock.runExclusive(async () => {
        const currentHolder = activePolls.get(key);
        if (currentHolder && !takeover) return { conflict: listenerConflict(currentHolder, "LISTENER_ACTIVE") };
        const nextHolder = { key, owner, startedAt: Date.now(), replaced: false, replace: null };
        claimedHolder = nextHolder;
        const priorPresence = presenceSignature(key, activePolls, deliveredFeedback);
        if (currentHolder) {
          // Install the successor before releasing the old response so its cleanup cannot emit a
          // transient "waiting" state or clear the successor's listener ownership.
          currentHolder.replaced = true;
          activePolls.set(key, nextHolder);
          currentHolder.replace?.();
        } else {
          activePolls.set(key, nextHolder);
        }
        // Attaching a fresh round retires the prior delivery marker; releasing a poll never does.
        deliveredFeedback.delete(key);
        if (agentReply !== null) {
          const session = await publishAgentReply(key, agentReply);
          if (!session) {
            activePolls.delete(key);
            return { missing: true };
          }
        }
        return { holder: nextHolder, previousPresence: priorPresence };
      });
      if (conflict) {
        detachRequestClose();
        res.status(409).json(conflict);
        return;
      }
      if (missing) {
        detachRequestClose();
        res.status(404).json({ error: "session not found" });
        return;
      }
      const timeoutMs =
        req.query.timeoutMs === undefined ? null : Math.max(0, Math.min(Number(req.query.timeoutMs || 0), 2147483647));
      const immediate = await store.takeFeedback(key);
      if (immediate.status !== "waiting") {
        if (holder.replaced) {
          await restoreClosedFeedback(key, immediate);
          detachRequestClose();
          res.json(listenerConflict(holder, "LISTENER_REPLACED"));
          releasePollListener(holder, activePolls, deliveredFeedback, events);
          return;
        }
        if (requestClosed || res.writableEnded) {
          await restoreClosedFeedback(key, immediate);
          releasePollListener(holder, activePolls, deliveredFeedback, events);
          detachRequestClose();
          return;
        }
        finishFeedbackDelivery(key, immediate);
        releasePollListener(holder, activePolls, deliveredFeedback, events);
        if (immediate.session_ended) clearFeedbackDelivery(key, activePolls, deliveredFeedback, events);
        detachRequestClose();
        res.json(agentFacingFeedback(immediate));
        return;
      }
      if (holder.replaced) {
        detachRequestClose();
        res.json(listenerConflict(holder, "LISTENER_REPLACED"));
        releasePollListener(holder, activePolls, deliveredFeedback, events);
        return;
      }
      if (requestClosed || res.writableEnded) {
        releasePollListener(holder, activePolls, deliveredFeedback, events);
        detachRequestClose();
        return;
      }
      const streamHeartbeat = timeoutMs === null;
      let heartbeat = null;
      if (streamHeartbeat) {
        res.status(200).type("application/json").set("Lavish-Poll-State", "listening");
        res.write(" ");
        heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(" ");
        }, pollHeartbeatMs);
        heartbeat.unref?.();
      }
      refreshIdleTimer();
      let timer = null;
      let cleaned = false;
      let responding = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        if (timer) clearTimeout(timer);
        if (heartbeat) clearInterval(heartbeat);
        events.off("feedback", onFeedback);
        events.off("ended", onFeedback);
        events.off("browser-disconnected", onBrowserDisconnected);
        releasePollListener(holder, activePolls, deliveredFeedback, events);
        if (!activePolls.has(key)) {
          clearBrowserDisconnectTimer(key);
          browserDisconnectPending.delete(key);
        }
        refreshIdleTimer();
        cleanupPoll = null;
        detachRequestClose();
        res.off("close", onResponseClose);
      };
      const respondReplacement = () => {
        if (responding || res.writableEnded) return;
        responding = true;
        try {
          const replacement = listenerConflict(holder, "LISTENER_REPLACED");
          if (streamHeartbeat) res.end(JSON.stringify(replacement));
          else res.json(replacement);
        } finally {
          cleanup();
        }
      };
      holder.replace = respondReplacement;
      const respond = async (forcedResult = null) => {
        if (responding || res.writableEnded) return;
        responding = true;
        let finalSessionEnded = false;
        try {
          const result = await store.takeFeedback(key);
          // Feedback or an explicit end that raced the grace timer wins. The disconnect result
          // is only the non-terminal replacement for a poll that would otherwise keep waiting.
          const responseResult = forcedResult && result.status === "waiting" ? forcedResult : result;
          finalSessionEnded = responseResult?.session_ended === true;
          if (holder.replaced) {
            if (responseResult.status !== "waiting") await restoreClosedFeedback(key, responseResult);
            if (!requestClosed && !res.writableEnded) {
              if (streamHeartbeat) res.end(JSON.stringify(listenerConflict(holder, "LISTENER_REPLACED")));
              else res.json(listenerConflict(holder, "LISTENER_REPLACED"));
            }
            return;
          }
          if (requestClosed || res.writableEnded) {
            await restoreClosedFeedback(key, responseResult);
            return;
          }
          finishFeedbackDelivery(key, responseResult);
          const agentResponse = agentFacingFeedback(responseResult);
          if (streamHeartbeat) {
            res.end(JSON.stringify(agentResponse));
          } else {
            res.json(agentResponse);
          }
        } finally {
          cleanup();
          if (finalSessionEnded) clearFeedbackDelivery(key, activePolls, deliveredFeedback, events);
        }
      };
      function handleRespondError(error) {
        if (streamHeartbeat) {
          cleanup();
          if (!res.writableEnded) res.destroy(error);
          return;
        }
        next(error);
      }
      const onFeedback = (changedKey) => {
        if (changedKey !== key || res.writableEnded) {
          return;
        }
        respond().catch(handleRespondError);
      };
      const onBrowserDisconnected = (changedKey) => {
        if (changedKey !== key || res.writableEnded) return;
        respond({ status: "browser_disconnected" }).catch(handleRespondError);
      };
      events.on("feedback", onFeedback);
      events.on("ended", onFeedback);
      events.on("browser-disconnected", onBrowserDisconnected);
      cleanupPoll = cleanup;
      if (holder.replaced) {
        respondReplacement();
        return;
      }
      if (requestClosed || res.writableEnded) {
        cleanup();
        return;
      }
      // A browser can disappear while the initial take is in flight. The disconnect timer may
      // have fired before this request installed its event listeners, so reconcile that state now.
      if (browserDisconnectPending.has(key)) {
        browserDisconnectPending.delete(key);
        onBrowserDisconnected(key);
        return;
      }
      const nextPresence = presenceSignature(key, activePolls, deliveredFeedback);
      if (nextPresence !== previousPresence) {
        events.emit("agent-presence", key, computePresence(key, activePolls, deliveredFeedback));
      }
      timer = timeoutMs === null ? null : setTimeout(() => respond().catch(handleRespondError), timeoutMs);
    } catch (error) {
      cleanupPoll?.();
      if (claimedHolder) releasePollListener(claimedHolder, activePolls, deliveredFeedback, events);
      detachRequestClose();
      next(error);
    }
  };
  app.get("/api/poll", handlePoll);
  app.post("/api/poll", handlePoll);

  // The one route that puts words in the reviewer's mouth: whatever lands here
  // reaches the agent as the user's own instructions. The session key is derived
  // from the artifact path, not a secret, so knowing it must not be enough -
  // only this server's own chrome may queue prompts.
  app.post("/api/:key/prompts", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin prompt submission rejected" });
        return;
      }
      const shouldEndSession = Boolean(req.body?.endSession || req.body?.end_session);
      const hasLayoutWarningPrompt = Array.isArray(req.body?.prompts)
        ? req.body.prompts.some((prompt) => prompt?.tag === "layout-warnings")
        : false;
      const result = await store.queuePrompts(req.params.key, req.body || {}, {
        resolveAttachment: (sessionKeyValue, id) => resolveAttachment(attachmentStateRoot, sessionKeyValue, id),
        maxPerPrompt: attachmentConfig.maxPerPrompt,
        maxPromptBytes: attachmentConfig.maxPromptBytes,
      });
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      // The session was already ended by someone else before this batch arrived - no agent will
      // ever poll it again, so a 200 here would be a lie. Nothing was persisted; the chrome keeps
      // its queue and goes read-only itself in case it missed the live `ended` event.
      if (result.ended) {
        res.status(409).json({ status: "ended", error: "session already ended", ended_by: result.ended_by });
        return;
      }
      // Atomic attachment rejection (C4): the batch resolved-and-persisted nothing
      // because one or more images could not be honored. Return 400 with the
      // rejected refs and the caps so the chrome keeps its queue and can surface
      // exactly what to fix, instead of silently dropping the images.
      if (result.rejected) {
        res.status(400).json({
          error: "some attachments could not be delivered",
          rejected: result.rejected,
          caps: result.caps,
        });
        return;
      }
      const session = result;
      if (session.conflict) {
        res.status(409).json({
          status: "conflict",
          error: "a layout warning changed before it was sent; review the warning again",
          warning_ids: session.warning_ids,
          warnings: session.warnings,
        });
        return;
      }
      const freshFeedback = session.fresh_feedback === true;
      const acceptedPrompts = Array.isArray(session.accepted_prompts) ? session.accepted_prompts : [];
      const clearedTags = Array.isArray(session.cleared_tags) ? session.cleared_tags : [];
      const activeHolder = activePolls.get(req.params.key);
      if (shouldEndSession) clearFeedbackDelivery(req.params.key, activePolls, deliveredFeedback, events);
      let publishedSession = session;
      if (hasLayoutWarningPrompt) {
        await syncOutstandingRepairs(req.params.key);
        publishedSession = (await store.findByKey(req.params.key)) || session;
        events.emit("layout-warnings", req.params.key, serializeLayoutWarnings(publishedSession.layout_warnings));
      }
      if (clearedTags.length) {
        const metadata = serializeBoardMetadata(publishedSession);
        const { title } = await readBoardHead(publishedSession.file);
        events.emit("board-metadata", req.params.key, metadata);
        emitHubEvent({
          event: "tag_change",
          key: req.params.key,
          file: publishedSession.file,
          url: publishedSession.url,
          title: boardTitle(publishedSession, title),
          creator: publishedSession.creator || "",
          tags: metadata.tags,
          added: [],
          removed: clearedTags,
        });
      }
      if (freshFeedback) {
        emitHubEvent({
          event: "message",
          key: req.params.key,
          file: publishedSession.file,
          url: publishedSession.url,
          creator: publishedSession.creator || "",
          tags: publishedSession.tags || [],
          had_listener: Boolean(activeHolder),
          listener: activeHolder ? listenerLabel(activeHolder) : null,
          prompts: acceptedPrompts,
        });
      }
      if (shouldEndSession) events.emit("ended", req.params.key, publishedSession.ended_by);
      else if (freshFeedback) events.emit("feedback", req.params.key, publishedSession.ended_by);
      // The accepted batch is part of the conversation now: answer with the transcript so the
      // sending chrome can settle its queued bubbles in place, and sync every other tab of this
      // session at send time rather than when a poll happens to take the batch.
      events.emit("chat-sync", req.params.key, publishedSession);
      res.json({
        status: "queued",
        pending_prompts: publishedSession.pending_prompts,
        ...serializeChatSync(publishedSession),
      });
      if (shouldEndSession) await shutdownIfNoLiveSessions();
    } catch (error) {
      next(error);
    }
  });

  function isOwnServerIp(ip) {
    if (!ip || isLoopbackIp(ip)) return true;
    if (tailscale?.ipv4 && normalizeRemoteIp(tailscale.ipv4) === ip) return true;
    for (const bound of boundHosts) {
      if (normalizeRemoteIp(bound) === ip) return true;
    }
    try {
      for (const entries of Object.values(networkInterfaces() || {})) {
        for (const entry of entries || []) {
          if (entry?.address && normalizeRemoteIp(entry.address) === ip) return true;
        }
      }
    } catch {
      // ignore interface enumeration failure
    }
    return false;
  }

  async function resolveRemoteViewerName(req) {
    const socketIp = normalizeRemoteIp(req.socket?.remoteAddress);
    if (!socketIp || isOwnServerIp(socketIp) || typeof whoisPeer !== "function") return "";
    try {
      const whois = await whoisPeer(socketIp, req.socket?.remotePort);
      return whois?.displayName ? normalizePromptAuthor(whois.displayName) : "";
    } catch {
      return "";
    }
  }

  async function verifyApprovalReviewer(req, suppliedAuthor) {
    const authHeader = String(req.headers.authorization || "").trim();
    const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
    const providedToken =
      typeof req.body?.approval_token === "string" && req.body.approval_token.trim()
        ? req.body.approval_token.trim()
        : bearer;
    if (providedToken && resolvedApprovalTokens.length > 0) {
      const matched = resolvedApprovalTokens.find((entry) => timingSafeEqualString(providedToken, entry.token));
      if (!matched) {
        return { ok: false, status: 403, error: "invalid approval token" };
      }
      if (suppliedAuthor && !reviewerMatchesName(suppliedAuthor, matched.reviewer)) {
        return { ok: false, status: 403, error: "supplied reviewer name does not match approval token" };
      }
      return { ok: true, auth: { method: "token", reviewer: matched.reviewer } };
    }
    if (resolvedApprovalTokens.length > 0) {
      return { ok: false, status: 403, error: "an approval token is required to confirm this action" };
    }
    const socketIp = normalizeRemoteIp(req.socket?.remoteAddress);
    if (!socketIp || isOwnServerIp(socketIp)) {
      return {
        ok: false,
        status: 403,
        error:
          "reviewer identity could not be verified from loopback; open this board from your personal Tailscale device or configure LAVISH_AXI_APPROVAL_TOKENS",
      };
    }
    const whois = typeof whoisPeer === "function" ? await whoisPeer(socketIp, req.socket?.remotePort) : null;
    if (!whois) {
      return {
        ok: false,
        status: 403,
        error: "reviewer identity could not be verified via Tailscale whois",
      };
    }
    if (!doesAuthorMatchTailscaleWhois(suppliedAuthor, whois, resolvedApprovalUsers)) {
      return {
        ok: false,
        status: 403,
        error: "supplied reviewer name does not match authenticated Tailscale user",
      };
    }
    return {
      ok: true,
      auth: {
        method: "tailscale",
        reviewer: suppliedAuthor,
        ...(whois.loginName ? { login: whois.loginName } : {}),
        ...(whois.displayName ? { display_name: whois.displayName } : {}),
        ...(whois.nodeName ? { node: whois.nodeName } : {}),
        ip: whois.ip || socketIp,
      },
    };
  }

  // Preview is sourced only from the server session and an operator-configured executable.
  app.post("/api/:key/approval-preview", async (req, res, next) => {
    try {
      if (
        !isSameOriginRequest(req, allowedHostnames, allowAnyHostname) ||
        (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")
      ) {
        res.status(403).json({ error: "cross-origin preview rejected" });
        return;
      }
      if (!(await store.verifyReviewerHandoff(req.params.key, req.body?.chrome_load_token))) {
        res.status(409).json({ error: "review tab is superseded or expired; reload to confirm" });
        return;
      }
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      const preview = await runApprovalPreview(env.LAVISH_AXI_APPROVAL_PREVIEW, session);
      res.setHeader("Cache-Control", "no-store");
      res.json({ preview });
    } catch (error) {
      next(error);
    }
  });

  // Human-confirmed approval from the outer review chrome (`chrome-client.js`), never from the
  // sandboxed artifact iframe or CLI/bot callers. Requires same-origin, the active reviewer
  // handoff capability (`chrome_load_token`), an open `/events/:key` browser WebSocket on this
  // session, and a server-verified reviewer identity (either a configured approval token or a
  // personal Tailscale peer verified via `tailscale whois`).
  app.post("/api/:key/approval", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin approval rejected" });
        return;
      }
      const fetchSite = String(req.headers["sec-fetch-site"] || "")
        .trim()
        .toLowerCase();
      if (fetchSite && fetchSite !== "same-origin") {
        res.status(403).json({ error: "cross-site approval rejected" });
        return;
      }
      const author = normalizePromptAuthor(req.body?.author);
      const promptText = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
      if (!author || !promptText) {
        res.status(400).json({ error: "reviewer name and approval text are required" });
        return;
      }
      if (!hasLiveEventClient(req.params.key)) {
        res.status(403).json({ error: "an active browser review session is required" });
        return;
      }
      const validHandoff = await store.verifyReviewerHandoff(req.params.key, req.body?.chrome_load_token);
      if (!validHandoff) {
        res.status(409).json({ error: "review tab is superseded or expired; reload to confirm" });
        return;
      }
      const verified = await verifyApprovalReviewer(req, author);
      if (!verified.ok) {
        res.status(verified.status).json({ error: verified.error });
        return;
      }
      const activeHolder = activePolls.get(req.params.key);
      const result = await store.queuePrompts(
        req.params.key,
        {
          prompts: [
            {
              uid: "",
              prompt: promptText,
              selector: typeof req.body?.selector === "string" ? req.body.selector.slice(0, 512) : "",
              tag: "send_approval",
              text: typeof req.body?.text === "string" ? req.body.text.slice(0, 240) : "Approval",
              prompt_id: `approval-${crypto.randomUUID()}`,
              author: verified.auth.reviewer,
            },
          ],
        },
        {
          trustedApproval: verified.auth,
          resolveAttachment: (sessionKeyValue, id) => resolveAttachment(attachmentStateRoot, sessionKeyValue, id),
          maxPerPrompt: attachmentConfig.maxPerPrompt,
          maxPromptBytes: attachmentConfig.maxPromptBytes,
        },
      );
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (result.ended) {
        res.status(409).json({ status: "ended", error: "session already ended", ended_by: result.ended_by });
        return;
      }
      const acceptedPrompts = Array.isArray(result.accepted_prompts) ? result.accepted_prompts : [];
      const clearedTags = Array.isArray(result.cleared_tags) ? result.cleared_tags : [];
      if (clearedTags.length) {
        const metadata = serializeBoardMetadata(result);
        const { title } = await readBoardHead(result.file);
        events.emit("board-metadata", req.params.key, metadata);
        emitHubEvent({
          event: "tag_change",
          key: req.params.key,
          file: result.file,
          url: result.url,
          title: boardTitle(result, title),
          creator: result.creator || "",
          tags: metadata.tags,
          added: [],
          removed: clearedTags,
        });
      }
      if (result.fresh_feedback) {
        emitHubEvent({
          event: "message",
          key: req.params.key,
          file: result.file,
          url: result.url,
          creator: result.creator || "",
          tags: result.tags || [],
          had_listener: Boolean(activeHolder),
          listener: activeHolder ? listenerLabel(activeHolder) : null,
          prompts: acceptedPrompts,
        });
        events.emit("feedback", req.params.key, result.ended_by);
      }
      events.emit("chat-sync", req.params.key, result);
      res.json({
        status: "approved",
        pending_prompts: result.pending_prompts,
        ...serializeChatSync(result),
      });
    } catch (error) {
      next(error);
    }
  });

  // The reviewer's unsent notes, mirrored from the chrome as they change so closing the tab does
  // not lose them (src/review-drafts.js). Same-origin guarded like /prompts: a stored draft is
  // restored into the next tab's queue, where one click sends it as the reviewer's own words.
  app.put("/api/:key/drafts", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin draft write rejected" });
        return;
      }
      if (!normalizeDraftTabId(req.body?.tab)) {
        res.status(400).json({ error: "a draft write needs a tab id" });
        return;
      }
      const result = await store.saveDrafts(req.params.key, req.body || {});
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (result.ended) {
        res.status(409).json({ status: "ended", ended_by: result.ended_by });
        return;
      }
      if (result.changed) notifyHubStateChanged();
      res.json({ status: "saved" });
    } catch (error) {
      if (error instanceof DraftTooLargeError) {
        res.status(413).json({ error: "draft too large" });
        return;
      }
      next(error);
    }
  });

  // Passive detection. A diagnostic pass updates the warning inbox and notifies open browser
  // chromes - it never emits "feedback", so it can never make `lavish-axi poll` return and can
  // never wake an agent. Only the user's explicit "Queue selected fixes" does that, through the
  // ordinary prompt queue.
  app.post("/api/:key/layout-diagnostics", async (req, res, next) => {
    try {
      const result = await store.recordLayoutDiagnostics(req.params.key, req.body || {}, {
        viewportClasses: diagnosticViewportClasses,
      });
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      const activeCount = activeLayoutWarningCount(result.session.layout_warnings);
      if (!result.stale) {
        await syncOutstandingRepairs(req.params.key);
        if (result.changed) events.emit("layout-warnings", req.params.key, result.warnings);
      }
      res.json({ status: result.stale ? "stale" : "recorded", active_count: activeCount, warnings: result.warnings });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/:key/layout-warnings", async (req, res, next) => {
    try {
      const result = await store.listLayoutWarnings(req.params.key);
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      res.json({ warnings: result.warnings, revision: result.revision });
    } catch (error) {
      next(error);
    }
  });

  // Prepare the user's selected warnings. The prompt commits the repair request through
  // /api/:key/prompts with the rest of the ordinary feedback queue.
  app.post("/api/:key/layout-warnings/queue", async (req, res, next) => {
    try {
      const result = await store.prepareLayoutWarningFixes(req.params.key, req.body?.ids);
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      res.json({
        status: result.queued.length > 0 ? "prepared" : "unchanged",
        queued_count: result.queued.length,
        prompt: result.prompt,
        warnings: result.warnings,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/layout-warnings/dismiss", async (req, res, next) => {
    try {
      const result = await store.dismissLayoutWarning(req.params.key, req.body?.id);
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (result.changed) events.emit("layout-warnings", req.params.key, result.warnings);
      res.json({ status: result.changed ? "dismissed" : "unchanged", warnings: result.warnings });
    } catch (error) {
      next(error);
    }
  });

  // The narrow fatal path: the artifact cannot be served, or one of its own local assets failed
  // to load. There is no usable review to triage from, so this still reaches the agent directly.
  app.post("/api/:key/artifact-failures", async (req, res, next) => {
    try {
      const result = await store.recordArtifactFailures(req.params.key, req.body || {});
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (result.stale) {
        res.status(409).json({ status: "stale" });
        return;
      }
      if (result.changed) events.emit("feedback", req.params.key);
      res.json({ status: "recorded" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/end", async (req, res, next) => {
    try {
      const session = await store.endSession(req.params.key, "user");
      if (session?.end_changed) {
        clearFeedbackDelivery(req.params.key, activePolls, deliveredFeedback, events);
        events.emit("ended", req.params.key, session.ended_by);
      }
      res.json({ status: "ended", ...(session ? serializeBoardMetadata(session) : { closed: true }) });
      if (session?.end_changed) await shutdownIfNoLiveSessions();
    } catch (error) {
      next(error);
    }
  });

  // The owner's statement about itself, shown as the board's presence pill (src/owner-status.js).
  // A control route like poll: the CLI calls it header-less, and the global guard above rejects a
  // present foreign Origin. It is display state only - it can neither queue nor deliver feedback.
  async function setOwnerStatus(req, res, key) {
    try {
      const session = await store.setOwnerStatus(key, {
        state: req.body?.state,
        label: req.body?.label,
        detail: req.body?.detail,
        ttl_seconds: req.body?.ttl_seconds,
        clear: req.body?.clear === true,
      });
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      const owner = serializeOwnerStatus(session.owner_status);
      events.emit("owner-status", key, owner);
      res.json({ status: owner ? "set" : "cleared", owner });
    } catch (error) {
      if (error instanceof OwnerStatusError) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  }

  app.post("/api/:key/owner", async (req, res, next) => {
    try {
      await setOwnerStatus(req, res, req.params.key);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/owner", async (req, res, next) => {
    try {
      const file = await canonicalFile(String(req.body?.file || ""));
      await setOwnerStatus(req, res, sessionKey(file));
    } catch (error) {
      if (error?.code === "ENOENT") {
        res.status(404).json({ error: "session not found" });
        return;
      }
      next(error);
    }
  });

  // Append external context to the conversation without delivering or answering work.
  app.post("/api/:key/note", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin note rejected" });
        return;
      }
      const text = String(req.body?.text || "").trim();
      if (!text) {
        res.status(400).json({ error: "note text required" });
        return;
      }
      const session = await store.addNote(req.params.key, { ...req.body, text });
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (session.status === "ended") {
        res.status(409).json({ status: "ended", ended_by: session.ended_by });
        return;
      }
      events.emit("chat-sync", req.params.key, session);
      res.json({ status: "sent" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/agent-reply", async (req, res, next) => {
    try {
      const session = await publishAgentReply(req.params.key, String(req.body?.text || ""), {
        requireOpen: true,
      });
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (session.status === "ended") {
        res.status(409).json({ status: "ended", ended_by: session.ended_by });
        return;
      }
      res.json({ status: "sent" });
    } catch (error) {
      next(error);
    }
  });

  // Static export: inline the artifact's local assets into one portable HTML file the user can
  // open from disk or host anywhere, with no dependency on this server. Remote CDN/font URLs are
  // left as references for the browser to load, so the export needs network to render those.
  app.get("/api/:key/export", async (req, res, next) => {
    try {
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (refuseNonHtmlArtifact(session, res)) return;
      const source = await readFile(session.file, "utf8");
      const root = path.dirname(session.file);
      const { html, warnings } = await buildSelfContainedHtml(source, {
        baseDir: root,
        confineDir: root,
        resolveAbsolute: resolveDesignAssetPath,
      });
      const { unresolved, notices } = splitExportWarnings(warnings);
      // Although this response downloads in normal chrome usage, an escaped artifact popup can
      // navigate to it directly. Preserve the artifact's opaque-origin boundary if the browser
      // renders the exported HTML instead of saving it.
      res.setHeader("content-security-policy", ARTIFACT_CONTENT_SECURITY_POLICY);
      res.setHeader("content-disposition", exportContentDisposition(session.file));
      res.setHeader("x-lavish-export-warning-count", String(unresolved.length));
      res.setHeader("x-lavish-export-notice-count", String(notices.length));
      res.type("html").send(html);
    } catch (error) {
      next(error);
    }
  });

  // Hosted share: build the local-inlined artifact and publish it to ht-ml.app, a third-party
  // hosting service not part of Lavish, returning the share URL. Publishing sends the artifact
  // to ht-ml.app's servers. Remote CDN/font references are left intact for the viewer's browser
  // to load.
  // Publishing creates a public third-party page unless a password is supplied, so this is gated
  // behind a same-origin check - a cross-origin page must not be able to drive a publish via the
  // loopback server.
  app.post("/api/:key/share", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin share request rejected" });
        return;
      }
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (refuseNonHtmlArtifact(session, res)) return;
      const body = req.body || {};
      // The password is generated here rather than in the chrome because chrome-client.js is
      // served raw and cannot import modules: a browser-side generator would be a second copy of
      // the alphabet and length rules, free to drift from the one the CLI uses.
      const generatePassword = body.generate_password === true;
      const password = generatePassword ? generateSharePassword() : optionalBodyString(body.password);
      const source = await readFile(session.file, "utf8");
      const root = path.dirname(session.file);
      const { html, warnings } = await buildSelfContainedHtml(source, {
        baseDir: root,
        confineDir: root,
        resolveAbsolute: resolveDesignAssetPath,
      });
      let site;
      try {
        site = await publishToHtmlApp(html, { password });
      } catch (error) {
        // Same three-way split the CLI makes, from the same shared classifiers, and the stakes
        // here are higher: the password was minted in this request, so a failure that discards it
        // can leave the page live behind a secret nobody was ever shown.
        const message = error instanceof Error ? error.message : String(error);
        // A 200 the host answered with an unreadable body is not an unknown outcome - the page
        // landed - so whatever fields did arrive go back rather than being hedged away.
        const landed = publishedDespiteError(error);
        if (landed) {
          res.status(502).json({
            error: message,
            outcome: "published-incomplete",
            public: !password,
            ...(landed.url ? { url: landed.url } : {}),
            ...(landed.siteId ? { site_id: landed.siteId } : {}),
            ...(landed.updateKey ? { update_key: landed.updateKey } : {}),
            ...(generatePassword ? { password } : {}),
          });
          return;
        }
        // Only a 4xx proves nothing was published.
        const rejected = hostRejectedShareWrite(error);
        res.status(502).json({
          error: message,
          outcome: rejected ? "rejected" : "indeterminate",
          ...(rejected
            ? {}
            : {
                public: !password,
                // A rejection gates nothing, so it must never carry the password.
                ...(generatePassword ? { password } : {}),
              }),
        });
        return;
      }
      const { unresolved, notices } = splitExportWarnings(warnings);
      res.json({
        ...site,
        // Only a password Lavish minted goes back to the browser; one the user typed is already
        // theirs, and echoing it would put it in a field they did not ask to have filled.
        ...(generatePassword ? { password } : {}),
        ...(warnings.length ? { warnings: exportWarningSummaries(warnings) } : {}),
        ...(unresolved.length ? { unresolved_local_assets: exportWarningSummaries(unresolved) } : {}),
        ...(notices.length ? { notices: exportWarningSummaries(notices) } : {}),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/end", async (req, res, next) => {
    try {
      const file = await canonicalFile(req.body.file);
      const key = sessionKey(file);
      const session = await store.endSession(key, "agent", { cancelled: req.body?.cancel === true });
      if (session?.end_changed) {
        clearFeedbackDelivery(key, activePolls, deliveredFeedback, events);
        events.emit("ended", key, session.ended_by);
      }
      res.json({ status: "ended", ...(session ? serializeBoardMetadata(session) : { closed: true }) });
      if (session?.end_changed) await shutdownIfNoLiveSessions();
    } catch (error) {
      next(error);
    }
  });

  app.get("/session/:key", async (req, res, next) => {
    try {
      const chromeLoad = await store.issueReviewerHandoff(req.params.key);
      if (!chromeLoad) {
        sendSessionNotFound(req, res);
        return;
      }
      const session = (await store.recordServedVersion(req.params.key, version)) || chromeLoad.session;
      if (refuseNonHtmlArtifact(session, res)) return;
      await watchSession(session, watchers, events, logEvent, reloadDebounceMs);
      const artifactHtml = await readFile(session.file, "utf8").catch(() => "");
      const { faviconTag, title } = extractArtifactHead(artifactHtml);
      // Nothing legitimately frames the review chrome - it is the top-level
      // page, and shares/exports ship standalone HTML rather than embedding it.
      // Refusing to be framed denies an attacker page both a window handle to
      // this chrome and a clickjacking surface over Send. Scoped to this route:
      // /artifact/* is framed by this page and /whiteboard-frame is framed by
      // that artifact document, whose sandbox gives it an opaque origin no
      // frame-ancestors expression can name.
      res.setHeader("x-frame-options", "DENY");
      // `frame-src 'self'` keeps the artifact iframe on this server: a board script that
      // navigates its own frame to another site (`location.href = "https://x/?data"`) is refused
      // by the browser before any request leaves. Links meant for elsewhere open a new tab.
      const viewerName = await resolveRemoteViewerName(req);
      res.setHeader("content-security-policy", "frame-ancestors 'none'; frame-src 'self'");
      res.type("html").send(
        createChromeHtml(session, {
          layoutGateEnabled: shouldEnableLayoutGate(req.query || {}),
          faviconTag,
          title: title ? `${title} · Lavish` : "Lavish Editor",
          artifactRevision: chromeLoad.artifact_revision,
          artifactLoadToken: chromeLoad.artifact_load_token,
          artifactLoadSequence: chromeLoad.artifact_load_sequence,
          chromeLoadToken: chromeLoad.chrome_load_token,
          attachmentMaxBytes: attachmentConfig.maxBytes,
          attachmentMaxCount: attachmentConfig.maxPerPrompt,
          actionLabel: resolvedActionLabel,
          notifyPeople: Object.keys(notifySettingsStore.getSync()),
          initialViewerName: viewerName,
          requiresApprovalToken: resolvedApprovalTokens.length > 0,
          theme,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/artifact/:key", (req, res) => {
    res.redirect(`/artifact/${req.params.key}/index.html`);
  });

  app.post("/api/:key/chrome-loads/begin", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin chrome handoff rejected" });
        return;
      }
      const handoff = await store.issueReviewerHandoff(req.params.key);
      if (!handoff) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      res.json({
        chrome_load_token: handoff.chrome_load_token,
        artifact_revision: handoff.artifact_revision,
        artifact_load_token: handoff.artifact_load_token,
        artifact_load_sequence: handoff.artifact_load_sequence,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/artifact-loads/begin", async (req, res, next) => {
    try {
      const result = await store.beginArtifactLoad(req.params.key, {
        requestId: req.body?.request_id,
        requestSequence: req.body?.request_sequence,
        handoffToken: req.body?.chrome_load_token,
      });
      if (!result) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (result.stale) {
        res.status(409).json({ status: result.stale });
        return;
      }
      res.json({ artifact_revision: result.artifact_revision, artifact_load_token: result.artifact_load_token });
    } catch (error) {
      next(error);
    }
  });

  app.get(/^\/artifact\/([^/]+)\/index\.html$/, async (req, res, next) => {
    try {
      res.setHeader("content-security-policy", ARTIFACT_CONTENT_SECURITY_POLICY);
      const key = req.params[0];
      const token = String(req.query.artifact_load_token || "");
      const revision = req.query.artifact_revision;
      const beforeRead = await store.verifyArtifactLoad(key, token, revision);
      if (!beforeRead) {
        sendSessionNotFound(req, res);
        return;
      }
      if (refuseNonHtmlArtifact(beforeRead.session, res)) return;
      if (!beforeRead.valid) {
        res
          .status(409)
          .type("html")
          .send(
            "<!doctype html><title>Artifact load expired</title><p>This artifact load is no longer current. Reload Lavish to continue.</p>",
          );
        return;
      }
      const html = await readFile(beforeRead.session.file, "utf8");
      const verified = await store.verifyArtifactLoad(key, token, revision);
      if (!verified?.valid) {
        res
          .status(409)
          .type("html")
          .send(
            "<!doctype html><title>Artifact load expired</title><p>This artifact load is no longer current. Reload Lavish to continue.</p>",
          );
        return;
      }
      res.type("html").send(injectLavishSdk(html, key, verified.artifact_revision, verified.artifact_load_token));
    } catch (error) {
      next(error);
    }
  });

  app.get(/^\/artifact\/([^/]+)\/(.+)$/, async (req, res, next) => {
    try {
      res.setHeader("content-security-policy", ARTIFACT_CONTENT_SECURITY_POLICY);
      const key = req.params[0];
      const assetPath = req.params[1];
      const session = await store.findByKey(key);
      if (!session) {
        sendSessionNotFound(req, res);
        return;
      }
      if (refuseNonHtmlArtifact(session, res)) return;
      const root = artifactTreeRoot(session.file);
      const file = await resolveArtifactAsset(root, assetPath);
      if (!file) {
        res.status(403).send("Forbidden");
        return;
      }
      res.sendFile(file, { dotfiles: "allow" });
    } catch (error) {
      next(error);
    }
  });

  app.get("/events/:key", (_req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "close",
    });
    res.end(`event: chrome-reload\ndata: ${JSON.stringify({ reason: "server-restarted" })}\n\n`);
  });

  app.get("/chrome-client.js", async (req, res, next) => {
    try {
      res.type("application/javascript").send(await readFile(chromeClientUrl, "utf8"));
    } catch (error) {
      next(error);
    }
  });

  app.get("/chrome.css", async (req, res, next) => {
    try {
      res.type("text/css").send(await readFile(chromeCssUrl, "utf8"));
    } catch (error) {
      next(error);
    }
  });

  app.get("/design/:asset", async (req, res, next) => {
    try {
      const asset = designAssetUrls[req.params.asset];
      if (!asset) {
        res.status(404).send("Not found");
        return;
      }
      res.type(asset.type).send(await readDesignAsset(asset));
    } catch (error) {
      next(error);
    }
  });

  app.get("/sdk.js", async (req, res, next) => {
    try {
      const verified = await store.verifyArtifactLoad(
        String(req.query.key || ""),
        req.query.artifact_load_token,
        req.query.artifact_revision,
      );
      if (!verified) {
        sendSessionNotFound(req, res);
        return;
      }
      if (!verified.valid) {
        res.status(409).json({ status: "stale" });
        return;
      }
      res.type("application/javascript").send(
        createSdkJs(String(req.query.key || ""), verified.artifact_revision, verified.artifact_load_token, {
          maxAttachmentCount: attachmentConfig.maxPerPrompt,
          maxAttachmentBytes: attachmentConfig.maxBytes,
          theme,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  // The whiteboard frame page. Hosted by the chrome in a dedicated sandboxed
  // iframe (allow-scripts allow-popups, no allow-same-origin) so untrusted
  // Mermaid text renders - and the Excalidraw editor runs - inside an opaque
  // origin, matching the artifact iframe's trust posture. The chrome passes
  // the diagram source and saved scene over postMessage after the frame
  // reports ready.
  app.get("/whiteboard-frame", (req, res) => {
    res.setHeader("cache-control", "no-store");
    // The frame's channel token is minted for one session, so the caller must
    // name it. Both call sites (the chrome overlay and the artifact SDK's
    // inline embed) know their own key; a request without one could only
    // produce a token that authenticates nothing, so reject it outright.
    const sessionKey = String(req.query.key || "");
    if (!isValidWhiteboardKey(sessionKey)) {
      res.status(400).type("text/plain").send("Missing session key");
      return;
    }
    res.type("html").send(createWhiteboardFrameHtml(createWhiteboardChannelToken(whiteboardChannelSecret, sessionKey)));
  });

  // Whiteboard bundle, stylesheet, and vendored Excalidraw fonts. The frame
  // runs in an opaque origin, and font fetches from an opaque origin are
  // CORS-gated, so this static, public-content route must answer with
  // Access-Control-Allow-Origin: * or every canvas font falls back.
  app.get(/^\/whiteboard-assets\/(.+)$/, async (req, res, next) => {
    try {
      const file = await resolveArtifactAsset(whiteboardAssetsDir, req.params[0]);
      if (!file) {
        res.status(403).send("Forbidden");
        return;
      }
      if (!existsSync(file)) {
        res
          .status(404)
          .send(existsSync(whiteboardAssetsDir) ? "Not found" : "Whiteboard bundle missing - run `pnpm run build`");
        return;
      }
      res.setHeader("access-control-allow-origin", "*");
      // Revalidate on every use (304 via Last-Modified/ETag): the bundle URL
      // is unversioned, and a memory-cached stale bundle after an upgrade or
      // local rebuild is far worse than cheap loopback revalidations.
      res.setHeader("cache-control", "no-cache");
      // Traversal is already rejected by resolveArtifactAsset; "allow" keeps
      // dot components in the assets dir's own absolute path (e.g. a checkout
      // under a dot-directory) from 403ing every asset.
      res.sendFile(file, { dotfiles: "allow" });
    } catch (error) {
      next(error);
    }
  });

  // Mermaid sources for a session's artifact, extracted from the HTML on disk
  // in document order so `index` matches the browser's `.mermaid` element
  // order. The hash feeds whiteboard staleness detection.
  app.get("/api/:key/mermaid-sources", async (req, res, next) => {
    try {
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (refuseNonHtmlArtifact(session, res)) return;
      const html = await readFile(session.file, "utf8").catch(() => "");
      const extracted = extractMermaidSources(html);
      const usesLibraries = extracted.some(({ source }) => parseLibraryIconDirectives(source).length > 0);
      const snapshot = usesLibraries ? await loadExcalidrawLibraries(libraryDir) : null;
      const libraries = snapshot ? snapshot.libraries : [];
      const sources = extracted.map(({ index, source }) => ({
        index,
        source,
        hash: whiteboardSourceHash(source, libraries),
      }));
      // The chrome compares this with /api/whiteboard-libraries' version: a
      // library file that changed between the two requests means the frame's
      // libraries do not match these hashes.
      res.json(snapshot ? { sources, libraries_version: snapshot.version } : { sources });
    } catch (error) {
      next(error);
    }
  });

  // User-supplied Excalidraw libraries for every whiteboard's library panel and
  // for `%% lavish-icon` nodes. Read-only: Lavish never writes that directory.
  app.get("/api/whiteboard-libraries", async (req, res, next) => {
    try {
      if (hasPresentOriginOrReferer(req) && !isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin whiteboard library request rejected" });
        return;
      }
      const { libraries, version } = await loadExcalidrawLibraries(libraryDir);
      res.setHeader("cache-control", "no-store");
      res.json({ libraries: libraries.map(({ id, items }) => ({ id, items })), version });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/:key/whiteboard/:index", async (req, res, next) => {
    try {
      const session = await store.findByKey(req.params.key);
      if (!session || !isValidDiagramIndex(req.params.index)) {
        res.status(404).json({ error: "whiteboard not found" });
        return;
      }
      const whiteboard = await loadWhiteboard(whiteboardStateRoot, req.params.key, Number(req.params.index));
      res.json({ whiteboard });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/whiteboard-channel", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin whiteboard channel request rejected" });
        return;
      }
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (!isValidWhiteboardChannelToken(req.body?.token, whiteboardChannelSecret, req.params.key)) {
        res.status(403).json({ error: "invalid whiteboard channel" });
        return;
      }
      res.json({ status: "authenticated" });
    } catch (error) {
      next(error);
    }
  });

  // Writing to the local state directory is a state-changing action, so both
  // whiteboard write routes are same-origin guarded like /share - a hostile
  // cross-origin page must not be able to fill the state dir through the
  // loopback server.
  app.put("/api/:key/whiteboard/:index", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin whiteboard write rejected" });
        return;
      }
      const session = await store.findByKey(req.params.key);
      if (!session || !isValidWhiteboardKey(req.params.key) || !isValidDiagramIndex(req.params.index)) {
        res.status(404).json({ error: "whiteboard not found" });
        return;
      }
      const body = req.body || {};
      await saveWhiteboard(whiteboardStateRoot, req.params.key, Number(req.params.index), {
        sourceHash: String(body.source_hash || body.sourceHash || ""),
        textMetricsVersion: Number(body.text_metrics_version || body.textMetricsVersion) || 0,
        scene: body.scene ?? null,
        baseline: body.baseline ?? null,
      });
      res.json({ status: "saved" });
    } catch (error) {
      next(error);
    }
  });

  // Publish the agent-facing feedback files (.excalidraw scene + PNG preview)
  // for a diagram, returning their absolute paths for the queued prompt's
  // target. Files stay on this machine; the prompt carries only the paths.
  app.post("/api/:key/whiteboard/:index/feedback-files", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin whiteboard write rejected" });
        return;
      }
      const session = await store.findByKey(req.params.key);
      if (!session || !isValidWhiteboardKey(req.params.key) || !isValidDiagramIndex(req.params.index)) {
        res.status(404).json({ error: "whiteboard not found" });
        return;
      }
      const body = req.body || {};
      const { scenePath, previewPath } = await writeWhiteboardFeedbackFiles(
        whiteboardStateRoot,
        req.params.key,
        Number(req.params.index),
        { scene: body.scene ?? null, pngDataUrl: String(body.pngDataUrl || body.png_data_url || "") },
      );
      res.json({ scene_path: scenePath, preview_path: previewPath });
    } catch (error) {
      next(error);
    }
  });

  // Annotation image attachments. Upload writes raw bytes to the state dir and
  // returns server-vetted metadata (content-hash id + absolute path); the prompt
  // later references the id and the server re-resolves it (see queuePrompts).
  // Upload and delete write/remove local files, so they are same-origin guarded
  // like the whiteboard writes - a hostile cross-origin page must not drive them.
  app.post("/api/:key/attachments", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin attachment upload rejected" });
        return;
      }
      if (!isValidAttachmentKey(req.params.key) || !(await store.findByKey(req.params.key))) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      // Read the raw stream ourselves, draining past the cap to end-of-body before
      // responding. That guarantees the browser receives the 413 for an over-cap
      // upload instead of a mid-stream connection reset (only the same-origin chrome
      // can reach this route, so draining a rejected body is bounded and trusted).
      const { tooLarge, buffer } = await readAttachmentUploadBody(req, attachmentConfig.maxBytes);
      if (tooLarge) {
        res.status(413).json({ error: `attachment exceeds the ${attachmentConfig.maxBytes} byte limit` });
        return;
      }
      // Finalize under the lifecycle lock so the dedup mtime refresh (B3), the dims
      // sidecar write, AND the disk-cap admission (reference snapshot + reclaim +
      // write) are one atomic critical section. Admission is a HARD cap: a new object
      // that can't fit after reclaiming unreferenced files is refused with 507, so
      // concurrent pages can never push committed storage past `maxDiskBytes` via
      // queued references (the sweep alone never evicts referenced files). The
      // eviction grace keeps a just-uploaded ready card off the reclaim list so it
      // survives until the user sends it.
      const attachment = await store.runExclusive(async () => {
        const referenced = await store.referencedAttachmentIds();
        return writeAttachment(attachmentStateRoot, req.params.key, buffer, {
          maxBytes: attachmentConfig.maxBytes,
          maxDiskBytes: attachmentConfig.maxDiskBytes,
          maxObjects: attachmentConfig.maxObjects,
          ttlMs: attachmentConfig.ttlMs,
          referenced,
          evictionGraceMs: attachmentConfig.evictionGraceMs,
        });
      });
      res.json({ status: "stored", attachment });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/:key/attachments/:id", async (req, res, next) => {
    try {
      // D6: a render is one stat + one streamed read. `statAttachmentForServe`
      // confirms existence and derives the mime from the validated id extension
      // WITHOUT re-parsing the image to recover dimensions the route never uses.
      const serve = await statAttachmentForServe(attachmentStateRoot, req.params.key, req.params.id);
      if (!serve) {
        res.status(404).json({ error: "attachment not found" });
        return;
      }
      res.setHeader("cache-control", "private, max-age=300");
      res.type(serve.mime);
      res.sendFile(serve.file, { dotfiles: "allow" });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/:key/attachments/:id", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
        res.status(403).json({ error: "cross-origin attachment delete rejected" });
        return;
      }
      // Reference-counted delete under the lifecycle lock: a content-addressed file
      // shared by an already-queued prompt (the same image attached twice, deduped
      // to one id) must survive a chip removal, or the queued prompt's thumbnail and
      // path break. `referencedAttachmentIds` also covers attachments delivered
      // within the read grace, so a poll's images are not deletable out from under
      // the agent. The chrome never drives this route (see chrome-client's note on
      // the removed eager delete); it remains a same-origin-guarded server API.
      const status = await store.runExclusive(async () => {
        const referenced = await store.referencedAttachmentIds();
        if (referenced.has(`${req.params.key}/${req.params.id}`)) return "referenced";
        return (await removeAttachment(attachmentStateRoot, req.params.key, req.params.id)) ? "removed" : "absent";
      });
      res.json({ status });
    } catch (error) {
      next(error);
    }
  });

  app.use((error, req, res, _next) => {
    // Body-parser errors carry a meaningful HTTP status (413 payload-too-large,
    // 400 malformed JSON); surface it instead of flattening everything to 500.
    const status = Number(error?.statusCode || error?.status) || 500;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  });

  const eventWebSocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const hubEventWebSocketServer = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  function rejectEventUpgrade(socket, status, message) {
    const body = `${message}\n`;
    socket.end(
      `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  }

  function handleEventUpgrade(req, socket, head) {
    let parsedUrl;
    try {
      parsedUrl = new URL(String(req.url || ""), "http://lavish.local");
    } catch {
      rejectEventUpgrade(socket, 400, "Bad Request");
      return;
    }
    const pathname = parsedUrl.pathname;

    const hostAllowed = allowAnyHostname
      ? parseHostAuthority(req.headers.host) !== null
      : isAllowedRequestHost(
          { host: req.headers.host, forwardedHost: req.headers["x-forwarded-host"] },
          allowedHostnames,
        );

    if (pathname === "/events/hub") {
      // Server-to-server peer hubs connect header-less (like /api/poll); any present browser
      // Origin/Referer must match this server's own origin.
      if (
        !hostAllowed ||
        (hasPresentOriginOrReferer(req) && !isSameOriginRequest(req, allowedHostnames, allowAnyHostname))
      ) {
        rejectEventUpgrade(socket, 403, "Forbidden");
        return;
      }
      const sinceRaw = Number(parsedUrl.searchParams.get("since") || "0");
      const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;
      const peersOnly = parsedUrl.searchParams.get("peers") === "0";
      const requestedInstance = String(parsedUrl.searchParams.get("instance") || "").trim();
      // If a peer server restarted with a fresh `hubInstanceId`, its `seq` restarted at 0, so a
      // subscriber presenting an older `instance` gets every event since this instance booted.
      const effectiveSince = requestedInstance && requestedInstance !== hubInstanceId ? 0 : since;
      const targetSet = peersOnly ? hubPeerStreamClients : hubViewStreamClients;
      hubEventWebSocketServer.handleUpgrade(req, socket, head, (webSocket) => {
        webSocket.on("error", () => {});
        if (liveEventHeartbeatMs != null && liveEventHeartbeatMs > 0) {
          let awaitingPong = false;
          const heartbeat = setInterval(() => {
            if (awaitingPong) {
              webSocket.terminate();
              return;
            }
            awaitingPong = true;
            try {
              webSocket.ping();
            } catch {
              webSocket.terminate();
            }
          }, liveEventHeartbeatMs);
          heartbeat.unref?.();
          webSocket.on("pong", () => {
            awaitingPong = false;
          });
          webSocket.once("close", () => clearInterval(heartbeat));
        }
        if (webSocket.readyState === WebSocket.OPEN) {
          try {
            webSocket.send(JSON.stringify({ type: "hub-hello", instance_id: hubInstanceId, seq: hubEventSeq }));
          } catch {
            // closed immediately
          }
        }
        for (const entry of hubEventHistory) {
          if (entry.seq > effectiveSince && webSocket.readyState === WebSocket.OPEN) {
            try {
              webSocket.send(
                JSON.stringify({
                  type: "hub-event",
                  instance_id: hubInstanceId,
                  seq: entry.seq,
                  event: entry.event,
                }),
              );
            } catch {
              break;
            }
          }
        }
        targetSet.add(webSocket);
        refreshIdleTimer();
        webSocket.once("close", () => {
          targetSet.delete(webSocket);
          refreshIdleTimer();
        });
      });
      return;
    }

    const match = pathname.match(/^\/events\/([^/]+)$/);
    if (!match) {
      rejectEventUpgrade(socket, 404, "Not Found");
      return;
    }

    // WebSocket reads are not protected by CORS. Require the chrome page's exact Origin as well
    // as the normal Host allowlist so a foreign site cannot read a known session's live events.
    if (!hostAllowed || !req.headers.origin || !isSameOriginRequest(req, allowedHostnames, allowAnyHostname)) {
      rejectEventUpgrade(socket, 403, "Forbidden");
      return;
    }

    let key;
    try {
      key = decodeURIComponent(match[1]);
    } catch {
      rejectEventUpgrade(socket, 400, "Bad Request");
      return;
    }
    eventWebSocketServer.handleUpgrade(req, socket, head, (webSocket) => {
      const client = {
        sendEvent(type, data) {
          if (webSocket.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify({ type, data }));
        },
        close(code = 1001, reason = "Lavish server shutdown") {
          webSocket.close(code, reason);
          const terminateTimer = setTimeout(() => {
            if (webSocket.readyState !== WebSocket.CLOSED) webSocket.terminate();
          }, WEBSOCKET_CLOSE_GRACE_MS);
          terminateTimer.unref?.();
          webSocket.once("close", () => clearTimeout(terminateTimer));
        },
        isClosed() {
          return webSocket.readyState === WebSocket.CLOSING || webSocket.readyState === WebSocket.CLOSED;
        },
      };
      webSocket.on("error", () => {});
      // Liveness, not latency: a reviewer whose machine slept leaves a socket that never emits
      // `close`, so only an unanswered ping proves they are gone. `terminate()` emits `close`,
      // which runs the same cleanup a graceful disconnect does - dropping the client from
      // liveEventClients and re-arming the idle timer.
      if (liveEventHeartbeatMs != null && liveEventHeartbeatMs > 0) {
        let awaitingPong = false;
        const heartbeat = setInterval(() => {
          if (awaitingPong) {
            logEvent?.(`event WebSocket heartbeat missed session=${key}, terminating`);
            webSocket.terminate();
            return;
          }
          awaitingPong = true;
          try {
            webSocket.ping();
          } catch {
            webSocket.terminate();
          }
        }, liveEventHeartbeatMs);
        heartbeat.unref?.();
        webSocket.on("pong", () => {
          awaitingPong = false;
        });
        webSocket.once("close", () => clearInterval(heartbeat));
      }
      const cleanup = attachLiveEventClient(client, key, (remove) => webSocket.once("close", remove));
      sendInitialLiveEventState(client, key, cleanup).catch((error) => {
        client.close(1011, "Failed to initialize live events");
        cleanup();
        logEvent?.(`event WebSocket initialization failed session=${key}: ${error?.message || error}`);
      });
    });
  }

  const httpServers = [];
  const boundHosts = [];
  let boundPort = port;
  let lastBindError = null;

  // One listen attempt. A listener that finishes binding after shutdown began is closed at once,
  // or it would keep the process alive with nothing left to serve.
  // A configured name is resolved here, through the same lookup and all-interfaces refusal as at
  // startup, so one that only resolves later is served at its address and reported by it. A name
  // that resolves to an address already bound is served by that listener.
  async function listenOnce(listenHost) {
    const address = isIP(listenHost) ? listenHost : (await resolveConcreteListenHosts([listenHost], lookupOptions))[0];
    if (address !== listenHost) {
      if (!listenHosts.includes(address)) listenHosts.push(address);
      if (boundHosts.includes(address)) {
        boundHosts.push(listenHost);
        return;
      }
    }
    const httpServer = await listenHttp(app, boundPort, address, (error) => {
      writeLog(`[lavish] HTTP server error: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (shuttingDown) {
      httpServer.close();
      throw new Error("Lavish server is shutting down");
    }
    httpServer.on("upgrade", handleEventUpgrade);
    if (boundPort === 0) boundPort = httpServer.address().port;
    if (!publicPort) publicPort = boundPort;
    httpServers.push(httpServer);
    boundHosts.push(listenHost);
    if (address !== listenHost) boundHosts.push(address);
  }

  // Bind one address, retrying a transient failure. Whether anything else has bound yet is
  // deliberately NOT consulted here: that check used to run before the retry, which made both the
  // retry and the loopback fallback unreachable whenever the first (or only) host failed - exactly
  // the single pinned-host case, where the process then exited with no listener at all.
  async function bindListener(listenHost) {
    let retryIndex = 0;
    while (true) {
      try {
        await listenOnce(listenHost);
        return null;
      } catch (error) {
        if (!shuttingDown && retryIndex < BIND_RETRY_DELAYS_MS.length) {
          await new Promise((resolve) => setTimeout(resolve, BIND_RETRY_DELAYS_MS[retryIndex]));
          retryIndex += 1;
          continue;
        }
        return error instanceof Error ? error : new Error(String(error));
      }
    }
  }

  // Session URLs, the Host allowlist, and phone readiness all follow what is actually bound, so
  // they are recomputed whenever a listener comes up rather than frozen at startup.
  function applyNetworkState() {
    tailscalePhoneReady = Boolean(tailscale?.ipv4 && boundHosts.includes(tailscale.ipv4));
    if (linkHostName != null) {
      resolvedLinkHost = linkHostName;
    } else if (tailscalePhoneReady) {
      resolvedLinkHost = resolveLinkHost({ env, tailscale, fallbackHost: host });
    } else if (boundHosts.includes(listenHosts[0])) {
      resolvedLinkHost = resolveLinkHost({ env, tailscale: null, fallbackHost: host });
    } else {
      // Session URLs must name somewhere that is actually listening, so while the requested host
      // is unbound the link host moves to loopback unless the operator named one explicitly.
      resolvedLinkHost = resolveLinkHost({ env, tailscale: null, fallbackHost: LOOPBACK_HOST });
    }
    const servesHost = (candidate) => candidate !== tailscale?.ipv4 || tailscalePhoneReady;
    const nextAllowedHostnames = buildAllowedHostnames({
      host: requestedListenHosts[0],
      hosts: [...requestedListenHosts.filter(servesHost), ...listenHosts.filter(servesHost), ...boundHosts],
      linkHost: resolvedLinkHost,
      allowedHosts: extraHosts,
    });
    allowedHostnames.clear();
    for (const allowedHostname of nextAllowedHostnames) allowedHostnames.add(allowedHostname);
  }

  // A later attempt for every requested address still unbound. Shared by the background schedule
  // and by /health?reconcile_network=1, so a CLI invocation right after the address frees up binds
  // it immediately instead of waiting for the next tick.
  let bindRecoveryInFlight = null;
  async function retryPendingBinds() {
    if (pendingBinds.size === 0 || shuttingDown) return;
    if (!bindRecoveryInFlight) {
      bindRecoveryInFlight = (async () => {
        let bound = false;
        for (const listenHost of [...pendingBinds.keys()]) {
          if (shuttingDown) return;
          try {
            await listenOnce(listenHost);
            pendingBinds.delete(listenHost);
            bound = true;
            writeLog(`[lavish] now listening on ${hostForUrl(listenHost)}:${boundPort} after an earlier bind failure.`);
          } catch (error) {
            if (!shuttingDown) pendingBinds.set(listenHost, error instanceof Error ? error : new Error(String(error)));
          }
        }
        if (bound) applyNetworkState();
      })().finally(() => {
        bindRecoveryInFlight = null;
      });
    }
    await bindRecoveryInFlight;
  }

  let bindRecoveryAttempt = 0;
  function scheduleBindRecovery() {
    if (shuttingDown || pendingBinds.size === 0 || bindRecoveryTimer || !bindRecoveryDelaysMs.length) return;
    const delay = bindRecoveryDelaysMs[Math.min(bindRecoveryAttempt, bindRecoveryDelaysMs.length - 1)];
    bindRecoveryAttempt += 1;
    bindRecoveryTimer = setTimeout(() => {
      bindRecoveryTimer = null;
      retryPendingBinds()
        .catch(() => {})
        .finally(() => scheduleBindRecovery());
    }, delay);
    bindRecoveryTimer.unref?.();
  }

  // Loopback is bound first because it is this port's control address: every CLI probes it
  // whatever its own LAVISH_AXI_HOST says. Whoever holds it owns the port, so a second Lavish
  // server started concurrently (two agents with different host settings) loses here and exits
  // instead of taking the remaining addresses and splitting one port across two daemons that share
  // one state file.
  const bindOrder = listenHosts.includes(LOOPBACK_HOST)
    ? [LOOPBACK_HOST, ...listenHosts.filter((listenHost) => listenHost !== LOOPBACK_HOST)]
    : listenHosts;
  for (const listenHost of bindOrder) {
    const error = await bindListener(listenHost);
    if (!error) continue;
    lastBindError = error;
    if (listenHost === LOOPBACK_HOST && isAddressInUseBindError(error)) {
      const owner = await probeLavishHealth(LOOPBACK_HOST, boundPort);
      throw new Error(
        owner
          ? `Another Lavish server (version ${owner.version || "unknown"}) already owns port ${boundPort} on ${LOOPBACK_HOST}; not starting a second one.`
          : `Loopback ${LOOPBACK_HOST}:${boundPort} is already in use; not starting a Lavish server on another address.`,
        { cause: error },
      );
    }
    pendingBinds.set(listenHost, error);
  }

  // Loopback floor. A server that cannot reach its requested address is still far more useful on
  // loopback than absent: the local agent CLI keeps working, and the next invocation finds THIS
  // server instead of spawning a duplicate beside it. Only reached when nothing else bound and
  // loopback was not requested, so a healthy multi-listener startup is untouched.
  if (httpServers.length === 0 && !listenHosts.includes(LOOPBACK_HOST)) {
    const error = await bindListener(LOOPBACK_HOST);
    if (error) lastBindError = error;
  }
  if (httpServers.length === 0) {
    throw new Error(
      `Lavish server failed to bind any address${lastBindError ? `: ${lastBindError.message}` : ""}`,
      lastBindError ? { cause: lastBindError } : undefined,
    );
  }
  // The CLI control channel only probes the primary requested host and loopback. A process that
  // bound neither is alive and unreachable, so close every listener already taken in this call.
  if (!boundHosts.includes(LOOPBACK_HOST) && !boundHosts.includes(listenHosts[0])) {
    const error = new Error(
      `Lavish server failed to bind a control-channel address${lastBindError ? `: ${lastBindError.message}` : ""}`,
      lastBindError ? { cause: lastBindError } : undefined,
    );
    await Promise.all(
      httpServers.splice(0).map(
        (httpServer) =>
          new Promise((resolve) => {
            httpServer.close(() => resolve(undefined));
          }),
      ),
    );
    boundHosts.length = 0;
    throw error;
  }
  applyNetworkState();
  publicPort = httpServers[0].address().port;
  // Always logged, not only under --verbose: an address that silently stopped serving is what left
  // tailnet review links dead for most of an hour with nothing but a debug line to show for it.
  for (const [listenHost, error] of pendingBinds) {
    writeLog(`[lavish] WARNING: ${describeBindFailure(listenHost, error)}`);
  }
  serverReady = true;
  await notifySettingsStore.init();
  await loadPeerCursors();
  applyPeerSettings(peerSettings.get());
  scheduleBindRecovery();

  // `cause` is log-only and never reaches a chrome: `reason` is the user-facing SHUTDOWN_REASONS
  // value, and widening it here would let an internal cause render as a banner line that claims
  // something untrue. Without the log line, server.log records an exit with no explanation at all.
  function shutdown(reloadKey = "", reason = "", cause = "requested") {
    if (shuttingDown) return;
    shuttingDown = true;
    writeLog(`[lavish] shutting down: ${cause}${reason ? ` (reason=${reason})` : ""}`);
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (attachmentSweepTimer) {
      clearInterval(attachmentSweepTimer);
      attachmentSweepTimer = null;
    }
    if (bindRecoveryTimer) {
      clearTimeout(bindRecoveryTimer);
      bindRecoveryTimer = null;
    }
    // Only the chrome whose artifact is being reopened is reloaded: the replacement server
    // adopts that session via state.json once it binds, and the caller named it. Every other
    // open review page is told why this server went away and left alone - a forced reload of a
    // page the user is reading or writing in is exactly what this avoids.
    // Both events carry the same reason: the reloaded page can end up showing a line from it too,
    // and two pages describing one shutdown differently is how a false claim gets in.
    const shutdownData = { reason };
    for (const [client, clientKey] of liveEventClients) {
      try {
        if (reloadKey && clientKey === reloadKey) {
          client.sendEvent("chrome-reload", shutdownData);
        } else {
          client.sendEvent("chrome-outdated", shutdownData);
        }
        client.close();
      } catch {
        // best effort
      }
    }
    liveEventClients.clear();
    closePeerEventSubscribers();
    for (const subscriber of [...hubPeerStreamClients, ...hubViewStreamClients]) {
      try {
        subscriber.terminate();
      } catch {
        // best effort
      }
    }
    hubPeerStreamClients.clear();
    hubViewStreamClients.clear();
    for (const timer of browserDisconnectTimers.values()) clearTimeout(timer);
    browserDisconnectTimers.clear();
    for (const w of watchers.values()) {
      w.close().catch(() => {});
    }
    watchers.clear();
    let remaining = httpServers.length;
    const closed = () => {
      remaining -= 1;
      if (remaining === 0) shutdownResolve();
    };
    for (const httpServer of httpServers) {
      httpServer.close(closed);
      // Force-close keep-alive sockets so legacy SSE / long-polls don't keep us alive.
      if (typeof httpServer.closeAllConnections === "function") {
        httpServer.closeAllConnections();
      }
    }
  }

  function hasActiveHubOrSessionConnections() {
    return (
      liveEventClients.size > 0 ||
      activePolls.size > 0 ||
      hubViewStreamClients.size > 0 ||
      hubPeerStreamClients.size > 0 ||
      peerEventSubscriptions.size > 0
    );
  }

  // Idle self-shutdown: the timer only runs while nothing is connected. Any live event chrome,
  // hub viewer, peer hub stream/subscription, or active long-poll cancels it; losing the last
  // connection (re)arms it.
  function refreshIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (shuttingDown || idleTimeoutMs == null) return;
    if (hasActiveHubOrSessionConnections()) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!shuttingDown && !hasActiveHubOrSessionConnections()) {
        shutdown("", "", `idle-timeout after ${idleTimeoutMs}ms with no connections`);
      }
    }, idleTimeoutMs);
    idleTimer.unref?.();
  }

  // When the final open session ends with nothing connected, there is nothing left to serve,
  // so step down immediately rather than waiting out the idle timeout. If a browser chrome, hub
  // viewer, peer subscription, or poll is still attached (e.g. the user is about to reopen), leave
  // the server up and let the idle timer reap it once those connections drop. Best-effort: never
  // let a read failure block the end response.
  async function shutdownIfNoLiveSessions() {
    if (hasActiveHubOrSessionConnections()) return;
    try {
      const sessions = await store.listSessions();
      if (sessions.every((session) => session.status === "ended")) {
        setImmediate(() => shutdown("", "", "last open session ended with no live connections"));
      }
    } catch {
      // ignore - the idle timer remains as a backstop
    }
  }

  // A queued repair batch is outstanding until a diagnostic pass re-checks it. While it is, the
  // agent's related saves coalesce into one artifact refresh for that group.
  async function syncOutstandingRepairs(key) {
    try {
      if (await store.hasOutstandingLayoutRepairs(key)) {
        outstandingRepairBatches.add(key);
      } else {
        outstandingRepairBatches.delete(key);
      }
    } catch {
      // Best effort - the normal debounce still applies.
    }
  }

  function reloadDebounceMs(key) {
    return outstandingRepairBatches.has(key) ? BATCH_RELOAD_DEBOUNCE_MS : RELOAD_DEBOUNCE_MS;
  }

  // Reference-aware attachment cleanup: reap files that are both past their TTL
  // and unreferenced, plus the optional disk-cap backstop. Runs once at startup
  // and then on a fixed interval; skipped entirely when neither a TTL nor a disk
  // cap is configured. Never touches attachments referenced by pending prompts.
  const attachmentSweepEnabled = attachmentConfig.ttlMs != null || attachmentConfig.maxDiskBytes != null;
  async function sweepAttachmentsNow() {
    try {
      // The reference snapshot AND the enumerate/delete run as one critical section
      // so a reference acquired mid-sweep (a concurrent upload finalize or /prompts
      // resolve) can never point at a file this sweep is about to remove (D5).
      const result = await store.runExclusive(async () => {
        const referenced = await store.referencedAttachmentIds();
        return sweepAttachments(attachmentStateRoot, {
          ttlMs: attachmentConfig.ttlMs,
          maxDiskBytes: attachmentConfig.maxDiskBytes,
          maxObjects: attachmentConfig.maxObjects,
          referenced,
          evictionGraceMs: attachmentConfig.evictionGraceMs,
        });
      });
      if (result.deleted > 0) {
        logEvent?.(`attachment sweep removed ${result.deleted} file(s), freed ${result.freedBytes} bytes`);
      }
    } catch (error) {
      logEvent?.(`attachment sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (attachmentSweepEnabled) {
    sweepAttachmentsNow();
    attachmentSweepTimer = setInterval(() => {
      sweepAttachmentsNow();
    }, ATTACHMENT_SWEEP_INTERVAL_MS);
    attachmentSweepTimer.unref?.();
  }

  // Arm the idle timer for a server that is spawned but never opens a session.
  refreshIdleTimer();

  return {
    port: publicPort,
    hosts: boundHosts,
    addresses: httpServers.map((server) => server.address()),
    close: async () => {
      shutdown("", "", "close() called");
      await done;
    },
    done,
  };
}

function listenHttp(app, port, host, onRuntimeError) {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    let listening = false;
    const onError = (error) => {
      if (!listening) {
        server.off("listening", onListening);
        reject(error);
        return;
      }
      onRuntimeError?.(error);
    };
    const onListening = () => {
      listening = true;
      const address = server.address();
      if (address && typeof address === "object" && isWildcardHost(address.address)) {
        server.close(() => reject(new Error(`Refusing all-interfaces listener at ${address.address}`)));
        return;
      }
      resolve(server);
    };
    // Keep this listener after startup: removing it when `listening` fires turns any later server
    // error into an unhandled EventEmitter error that terminates the detached process silently.
    server.on("error", onError);
    server.once("listening", onListening);
    // `host` has already been sanitized by resolveListenHosts. Keeping this helper
    // concrete is an important defense: Tailscale reachability must never turn into
    // an all-interfaces wildcard listener.
    server.listen({ port, host });
  });
}

function tailscaleNetworkKey(tailscale) {
  if (!tailscale) return "down";
  if (tailscale.warning) return "incomplete";
  if (!tailscale.ipv4 || !tailscale.magicDnsName) return "incomplete";
  return `up\n${tailscale.ipv4}\n${tailscale.magicDnsName}`;
}

function isAddressInUseBindError(error) {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}

// Whether a Lavish server answers /health at this address. Bounded, because a foreign process
// that accepts the connection and never answers must not stall startup, and the socket is
// destroyed on every exit path: a lingering probe connection keeps a failed server process alive
// and holds the other process's close() open.
function probeLavishHealth(host, port) {
  return new Promise((resolve) => {
    const request = httpGet({ host, port, path: "/health", agent: false }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) request.destroy();
      });
      response.on("end", () => {
        request.destroy();
        try {
          const parsed = JSON.parse(body);
          resolve(parsed && typeof parsed === "object" && parsed.app === "lavish-axi" ? parsed : null);
        } catch {
          resolve(null);
        }
      });
      response.on("error", () => resolve(null));
    });
    request.setTimeout(LOOPBACK_OWNER_PROBE_TIMEOUT_MS, () => {
      request.destroy();
      resolve(null);
    });
    request.on("error", () => resolve(null));
    request.on("close", () => resolve(null));
  });
}

function wantsHtml(req) {
  const accept = String(req.get("accept") || "");
  return accept.toLowerCase().includes("text/html");
}

// Shares the hub's token names, so the hub preset (src/host-theme.js) themes it too.
export function createDeniedHtml({ title, message, workingUrl, theme = "" }) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const safeUrl = escapeHtml(workingUrl);
  const themed = hostThemeMarkup(theme, "hub");
  return `<!doctype html><html lang="en"${themed.htmlAttribute}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle} - Lavish Editor</title><style>:root{color-scheme:light;--paper:#f7f4ef;--ink:#25221f;--line:#d9d0c5;--card:#fffdf9;--well:#f0ebe4;--card-shadow:#25221f18}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--paper);color:var(--ink);font:16px/1.5 system-ui,sans-serif}.card{width:min(560px,calc(100% - 40px));padding:32px;border:1px solid var(--line);border-radius:16px;background:var(--card);box-shadow:0 12px 40px var(--card-shadow)}h1{margin:0 0 12px;font-size:26px}p{margin:0 0 18px}.url{display:block;padding:12px 14px;border-radius:10px;background:var(--well);color:var(--ink);overflow-wrap:anywhere}a{color:inherit;font-weight:700}</style>${themed.style}</head><body><main class="card"><h1>${safeTitle}</h1><p>${safeMessage}</p><p>Open this working URL:</p><a class="url" href="${safeUrl}">${safeUrl}</a></main></body></html>`;
}

async function readDesignAsset(asset) {
  try {
    return await readFile(asset.packaged, "utf8");
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
    return readFile(asset.source, "utf8");
  }
}

// Map a legacy root-absolute `/design/<asset>` reference to the packaged design file on disk
// (falling back to the node_modules source for source runs) so an export can inline it instead
// of pointing back at this server's `/design` route.
export function resolveDesignAssetPath(refPath) {
  const match = /^\/design\/([^/?#]+)(?:[?#].*)?$/.exec(refPath);
  if (!match) return null;
  const asset = designAssetUrls[match[1]];
  if (!asset) return null;
  const packaged = fileURLToPath(asset.packaged);
  if (existsSync(packaged)) return packaged;
  const source = fileURLToPath(asset.source);
  return existsSync(source) ? source : null;
}

export function exportContentDisposition(file) {
  const filename = exportFileName(file);
  return `attachment; filename="${sanitizeDispositionFilename(filename)}"; filename*=UTF-8''${encodeRfc5987Value(filename)}`;
}

function sanitizeDispositionFilename(filename) {
  const fallback = Array.from(String(filename || ""), (char) => {
    const codePoint = char.codePointAt(0) || 0;
    if (codePoint < 0x20 || codePoint > 0x7e || char === '"' || char === "\\") return "_";
    return char;
  }).join("");
  return fallback || "artifact.export.html";
}

function encodeRfc5987Value(value) {
  return encodeURIComponent(String(value)).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

// The set of Host header hostnames this server answers to: loopback names plus
// every concrete listener and the resolved link host. Wildcard bind values and the
// explicit "*" opt-out never become hostnames. Lowercased for case-insensitive
// comparison against the incoming Host.
export function buildAllowedHostnames({ host, hosts = [], linkHost: linkHostName, allowedHosts = [] }) {
  return new Set(
    [LOOPBACK_HOST, IPV6_LOOPBACK_HOST, "localhost", host, ...hosts, linkHostName, ...allowedHosts]
      .map((value) =>
        String(value || "")
          .trim()
          .toLowerCase(),
      )
      .filter((value) => value && value !== "*" && !isWildcardHost(value)),
  );
}

// A lone "*" in LAVISH_AXI_ALLOWED_HOSTS is an explicit opt-out of the Host
// allowlist, for operators who front the server with their own auth/proxy.
export function allowsAllHosts(allowedHosts = []) {
  return allowedHosts.some((value) => String(value).trim() === "*");
}

function parseHostAuthority(value) {
  const raw = String(value).trim();
  if (!raw || /[@/\\?#\s]/.test(raw)) return null;

  let hostname;
  let port;
  let bracketed = false;
  if (raw.startsWith("[")) {
    const match = /^\[([0-9A-Fa-f:.]+)\](?::(\d+))?$/.exec(raw);
    if (!match || isIP(match[1]) !== 6) return null;
    [, hostname, port = ""] = match;
    bracketed = true;
  } else {
    const match = /^([A-Za-z0-9._-]+)(?::(\d+))?$/.exec(raw);
    if (!match) return null;
    [, hostname, port = ""] = match;
  }
  if (port && Number(port) > 65535) return null;

  hostname = hostname.toLowerCase();
  const authority = `${bracketed ? `[${hostname}]` : hostname}${port ? `:${port}` : ""}`;
  try {
    const parsed = new URL(`http://${authority}`);
    if (!parsed.origin || parsed.origin === "null") return null;
  } catch {
    return null;
  }
  return { hostname, port, authority };
}

// Extract the hostname (without port) from a Host header value, honoring
// bracketed IPv6 literals ("[::1]:4387"). Returns null for a malformed authority.
export function hostnameFromHostHeader(value) {
  return parseHostAuthority(value)?.hostname ?? null;
}

// DNS-rebinding defense: a loopback-bound server answers only to its own known
// hostnames. A rebound browser carries the attacker's domain in Host and is
// rejected. Host is mandatory in HTTP/1.1 and every browser sends it, so a
// missing or blank value is never a legitimate client - reject it rather than
// fail open.
export function isAllowedHostHeader(hostHeader, allowedHostnames) {
  if (hostHeader === undefined || hostHeader === null) return false;
  const authority = parseHostAuthority(hostHeader);
  return authority !== null && allowedHostnames.has(authority.hostname);
}

// Validate a request's effective host for DNS-rebinding protection. The Host
// header is required and must be allowlisted. When an X-Forwarded-Host is present
// - a reverse proxy in front of the loopback server - its outermost (last) value
// must ALSO be allowlisted, so a proxy works once its public hostname is added to
// LAVISH_AXI_ALLOWED_HOSTS. This is an AND check: a client-spoofed forwarded host
// can only narrow access (Host is still checked), never widen it into a bypass. A
// blank forwarded host is treated as absent, matching how proxies omit it.
/**
 * @param {{ host?: string|undefined|null, forwardedHost?: string|undefined|null }} headers
 * @param {Set<string>} allowedHostnames
 */
export function isAllowedRequestHost({ host, forwardedHost }, allowedHostnames) {
  if (!isAllowedHostHeader(host, allowedHostnames)) return false;
  const forwarded = forwardedHost === undefined || forwardedHost === null ? "" : String(forwardedHost).trim();
  if (forwarded === "") return true;
  return isAllowedHostHeader(forwarded.split(",").pop(), allowedHostnames);
}

function hasPresentOriginOrReferer(req) {
  return Boolean(req.headers?.origin || req.headers?.referer);
}

// Guard state-changing, outward-facing routes (publishing to a third-party host) against CSRF: a
// browser attaches an Origin/Referer that must match this server's own origin. The global
// mutating-route middleware reuses this helper so forwarded Host/Proto stay in lockstep; that
// middleware is lenient (absent headers pass) while per-route callers still reject header-less
// requests.
function isSameOriginRequest(req, allowedHostnames, allowAnyHostname = false) {
  const host = parseHostAuthority(req.headers.host);
  if (!host) return false;

  let protocol = req.protocol || "http";
  let authority = host;
  const forwardedHost = String(req.headers["x-forwarded-host"] || "")
    .split(",")
    .pop()
    .trim();
  if (forwardedHost) {
    const forwardedAuthority = parseHostAuthority(forwardedHost);
    if (
      !forwardedAuthority ||
      (!allowAnyHostname &&
        (!allowedHostnames.has(host.hostname) || !allowedHostnames.has(forwardedAuthority.hostname)))
    )
      return false;
    protocol = String(req.headers["x-forwarded-proto"] || protocol)
      .split(",")
      .pop()
      .trim()
      .toLowerCase();
    if (protocol !== "http" && protocol !== "https") return false;
    authority = forwardedAuthority;
  }
  const expectedOrigin = normalizeOrigin(`${protocol}://${authority.authority}`);
  if (!expectedOrigin) return false;
  const origin = req.headers.origin;
  if (origin) {
    return normalizeOrigin(origin) === expectedOrigin;
  }
  const referer = req.headers.referer;
  return Boolean(referer) && normalizeOrigin(referer) === expectedOrigin;
}

function normalizeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function optionalBodyString(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || undefined;
}

// Confines an asset request lexically first, then - like export-bundle.js's guardedRead -
// resolves the real (symlink-followed) path and refuses anything that escapes the session's
// artifact tree (the HTML file's directory), so a symlink placed beside the artifact can't
// make this route serve an outside file (e.g. ~/.ssh/id_rsa).
export async function resolveArtifactAsset(root, assetPath) {
  const file = path.resolve(root, assetPath);
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  let real;
  try {
    real = await realpath(file);
  } catch (error) {
    // Nonexistent path (e.g. an asset that hasn't been built yet): nothing to read, so the
    // lexical confinement above is enough - the caller's existsSync/sendFile handles the 404.
    // Every other realpath failure fails closed, like guardedRead.
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return file;
    }
    throw error;
  }
  let realRoot;
  try {
    realRoot = await realpath(root);
  } catch {
    realRoot = path.resolve(root);
  }
  const relativeReal = path.relative(realRoot, real);
  if (relativeReal === ".." || relativeReal.startsWith(`..${path.sep}`) || path.isAbsolute(relativeReal)) {
    return null;
  }
  // Hand back the resolved path, not the requested one: a real path contains no symlinks, so
  // sendFile re-opening it cannot be redirected by a link swapped in after this check.
  return real;
}

/**
 * @param {(key: string) => number} reloadDebounceMs
 */
async function watchSession(session, watchers, events, logEvent, reloadDebounceMs = () => RELOAD_DEBOUNCE_MS) {
  if (watchers.has(session.key)) {
    return;
  }
  const target = await resolveWatchTarget(session);
  if (watchers.has(session.key)) {
    return;
  }
  logEvent?.(`watch session=${session.key} scope=${target.scope} path=${target.path}`);
  const watcher = chokidar.watch(target.path, target.options);
  let timer = null;
  watcher.on("all", (event, file) => {
    logEvent?.(`watch event=${event} session=${session.key} file=${file ?? ""}`);
    clearTimeout(timer);
    timer = setTimeout(() => events.emit("reload", session.key), reloadDebounceMs(session.key));
  });
  watcher.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    logEvent?.(`watch error session=${session.key} message=${message}`);
  });
  watchers.set(session.key, watcher);
}

// Watching the artifact's parent directory recursively can stall the event loop when the
// artifact lives in a large tree (e.g. ~/Downloads). Default to watching only the artifact
// itself; an artifact opts back into directory-wide live reload via either a
// `data-lavish-live-reload-root` attribute on its root element or
// `<meta name="lavish-live-reload" content="root">`.
export async function resolveWatchTarget(session) {
  const baseOptions = {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  };
  try {
    const html = await readFile(session.file, "utf8");
    if (hasLiveReloadRootOptIn(html)) {
      return {
        path: path.dirname(session.file),
        scope: "directory",
        options: {
          ...baseOptions,
          ignored: /(^|[/\\])(\.git|node_modules|dist|build|\.lavish-axi)([/\\]|$)/,
        },
      };
    }
  } catch {
    // Fall through to file-only watching when the artifact can't be read.
  }
  return { path: session.file, scope: "file", options: baseOptions };
}

export function hasLiveReloadRootOptIn(html) {
  if (typeof html !== "string") return false;
  const searchableHtml = html.replace(/<!--[\s\S]*?-->/g, "");
  if (/<html\b[^>]*\sdata-lavish-live-reload-root(?:[\s=>/]|$)[^>]*>/i.test(searchableHtml)) return true;
  return /<meta\b(?=[^>]*name=["']lavish-live-reload["'])(?=[^>]*content=["']root["'])[^>]*>/i.test(searchableHtml);
}

function releasePollListener(holder, activePolls, deliveredFeedback, events) {
  if (activePolls.get(holder.key) !== holder) return;
  const previousPresence = computePresence(holder.key, activePolls, deliveredFeedback);
  activePolls.delete(holder.key);
  const nextPresence = computePresence(holder.key, activePolls, deliveredFeedback);
  if (nextPresence !== previousPresence) events.emit("agent-presence", holder.key, nextPresence);
}

function listenerLabel(holder) {
  return holder.owner || AGENT_LISTENER_LABEL;
}

function listenerConflict(holder, code) {
  return {
    status: "error",
    code,
    error:
      code === "LISTENER_ACTIVE"
        ? "Lavish Editor already has an active poll listener"
        : "Lavish Editor poll listener was replaced",
    holder: { label: listenerLabel(holder), age_ms: Math.max(0, Date.now() - holder.startedAt) },
  };
}

function markFeedbackDelivered(key, activePolls, deliveredFeedback, events) {
  const previousPresence = computePresence(key, activePolls, deliveredFeedback);
  deliveredFeedback.add(key);
  const nextPresence = computePresence(key, activePolls, deliveredFeedback);
  if (nextPresence !== previousPresence) {
    events.emit("agent-presence", key, nextPresence);
  }
}

function clearFeedbackDelivery(key, activePolls, deliveredFeedback, events) {
  const previousPresence = computePresence(key, activePolls, deliveredFeedback);
  deliveredFeedback.delete(key);
  const nextPresence = computePresence(key, activePolls, deliveredFeedback);
  if (nextPresence !== previousPresence) {
    events.emit("agent-presence", key, nextPresence);
  }
}

export function computePresence(key, activePolls, deliveredFeedback) {
  if (deliveredFeedback.has(key)) return "working";
  return activePolls.has(key) ? "listening" : "waiting";
}

function presenceSignature(key, activePolls, deliveredFeedback) {
  return `${computePresence(key, activePolls, deliveredFeedback)}:${presenceMode(key, activePolls, deliveredFeedback)}`;
}

export function presenceMode(key, activePolls, deliveredFeedback) {
  if (deliveredFeedback.has(key)) return "agent-busy";
  const holder = activePolls.get(key);
  if (!holder) return "waiting-on-captain";
  // --owner is used by a supervisor process listening on behalf of a worker. A bare poll is the
  // agent's own waiting round; an identified holder must not make the composer invite captain
  // input while the owning worker is busy elsewhere.
  return holder.owner ? "external-listener" : "agent-listener";
}

function presenceEventData(key, state, activePolls, deliveredFeedback) {
  const mode = presenceMode(key, activePolls, deliveredFeedback);
  return mode === "waiting-on-captain" ? { state } : { state, mode };
}

function chromeIcon(paths, size = 16, strokeWidth = 1.7) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

const chromeIcons = {
  more: chromeIcon(
    '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
  ),
  file: chromeIcon(
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    13,
  ),
  copy: chromeIcon(
    '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    12,
  ),
  check: chromeIcon('<polyline points="20 6 9 17 4 12"/>', 12),
  refresh: chromeIcon(
    '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    15,
  ),
  camera: chromeIcon(
    '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',
    15,
  ),
  download: chromeIcon(
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    15,
  ),
  globe: chromeIcon(
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14.5 14.5 0 0 1 0 18a14.5 14.5 0 0 1 0-18z"/>',
    15,
  ),
  exit: chromeIcon(
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    15,
  ),
  warning: chromeIcon(
    '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    16,
  ),
  reveal: chromeIcon('<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>', 13),
  dismiss: chromeIcon('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', 13),
  // The desktop conversation-panel toggle: a window with its right-hand column marked off.
  sidebar: chromeIcon('<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="15" y1="4" x2="15" y2="20"/>'),
  phone: chromeIcon('<rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/>'),
  // The mobile conversation sheet's only chevron: CSS rotates it when the sheet is open.
  chevronUp: chromeIcon('<polyline points="6 15 12 9 18 15"/>', 18, 2),
};

// Display the path with the home directory shortened to "~", split so the directory part can
// ellipsize in the menu while the file name itself always stays visible.
export function displayPathParts(file, home = homedir()) {
  const normalizedFile = file.replaceAll("\\", "/");
  const normalizedHome = home.replaceAll("\\", "/");
  const display =
    normalizedHome && normalizedFile.startsWith(`${normalizedHome}/`)
      ? `~/${normalizedFile.slice(normalizedHome.length + 1)}`
      : normalizedFile;
  const tailStart = display.lastIndexOf("/") + 1;
  return { head: display.slice(0, tailStart), tail: display.slice(tailStart) };
}

export function shouldEnableLayoutGate(query = {}) {
  const noGate = query["no-gate"] ?? query.noGate ?? query.no_gate;
  if (isTruthyFlag(noGate)) return false;

  const gate = query.gate ?? query.layoutGate ?? query.layout_gate;
  if (isFalseyFlag(gate)) return false;

  return true;
}

function shouldDisableLayoutGateOpen(body = {}) {
  const noGate = body["no-gate"] ?? body.noGate ?? body.no_gate;
  if (isTruthyFlag(noGate)) return true;

  const gate = body.gate ?? body.layoutGate ?? body.layout_gate;
  return isFalseyFlag(gate);
}

function appendNoGateParam(url) {
  const parsed = new URL(url);
  parsed.searchParams.set("no-gate", "1");
  return parsed.toString();
}

function isTruthyFlag(value) {
  const normalized = normalizeFlagValue(value);
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isFalseyFlag(value) {
  const normalized = normalizeFlagValue(value);
  return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off";
}

function normalizeFlagValue(value) {
  if (Array.isArray(value)) return normalizeFlagValue(value[0]);
  return value === undefined || value === null ? "" : String(value).trim().toLowerCase();
}

const LAVISH_DEFAULT_FAVICON =
  "<link rel=\"icon\" href=\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u{1F48E}</text></svg>\">";

function readTagAttr(tag, name) {
  // Tokenize real attributes rather than searching for the bare name anywhere in
  // the tag: a `\b`-anchored name matches attribute-name suffixes (e.g. `href`
  // inside `data-href`) and names that appear inside another attribute's quoted
  // value (e.g. `href=` inside a `title="... href=x"`), both of which would make
  // us adopt the wrong href. Walking whole `name="value"` pairs consumes each
  // value as one unit, so only genuine attribute names are matched.
  const attrRe = /([a-z][\w:-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  const target = name.toLowerCase();
  let match;
  while ((match = attrRe.exec(tag)) !== null) {
    if (match[1].toLowerCase() === target) {
      return (match[3] ?? match[4] ?? match[5] ?? "").trim();
    }
  }
  return "";
}

// Pull a tab favicon + title out of the artifact's own <head>. Lavish renders the
// artifact in a sandboxed iframe, so the artifact's own <link rel="icon"> and
// <title> never reach the browser tab; surfacing them here makes a wall of Lavish
// tabs identifiable. Falls back to the Lavish default favicon. Only data: and
// absolute (http/https/protocol-relative) icon hrefs are adopted verbatim;
// artifact-relative hrefs would not resolve against the chrome page, so they fall
// back to the default.
export function extractArtifactHead(html) {
  const head = String(html || "").slice(0, 10000);
  let faviconTag = LAVISH_DEFAULT_FAVICON;
  const linkTags = head.match(/<link\b(?:"[^"]*"|'[^']*'|[^"'>])*>/gi) || [];
  const iconTag = linkTags.find((tag) => /(^|\s)icon(\s|$)/i.test(readTagAttr(tag, "rel")));
  const iconHref = iconTag ? readTagAttr(iconTag, "href") : "";
  if (iconHref && /^(data:|https?:|\/\/)/i.test(iconHref)) {
    const safeHref = iconHref.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    faviconTag = `<link rel="icon" href="${safeHref}">`;
  }
  let title = "";
  const titleMatch = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) title = titleMatch[1].replace(/\s+/g, " ").trim();
  return { faviconTag, title };
}

// The chrome page ships with the layout-gate overlay already covering the artifact area. Install
// its bounded escape and manual bypass inline before `chrome-client.js`, so they still work if the
// shared server shuts down between serving the page and serving that script. This block also arms
// the boot-failure card before the external script tag, surviving a request that hangs instead of
// erroring; `chrome-client.js` cancels that boot timer once it has run to completion and reuses the
// gate escape for every later overlay state.
export const CHROME_BOOT_FAILSAFE_MS = 15000;
export const CHROME_LAYOUT_GATE_MAX_HOLD_MS = 12000;
// The failsafe's button is the only control on a page whose client script is dead, so its own
// probe is bounded too: a port that accepts and never answers must not disable it for good.
const CHROME_BOOT_FAILSAFE_PROBE_TIMEOUT_MS = 4000;
const CHROME_BOOT_FAILSAFE_JS = `(function(){
var t=setTimeout(fail,${CHROME_BOOT_FAILSAFE_MS});
var o=document.getElementById("layoutGateOverlay"),h,c,a,b,gt=0,manual=false,ended=false;
try{ended=JSON.parse(document.getElementById("lavish-session").textContent).initialEnded===true;}catch(e){}
function cancelGate(){if(gt)clearTimeout(gt);gt=0;}
function reveal(){cancelGate();if(o)o.hidden=true;if(document.body)document.body.classList.remove("layout-gate-active");}
function manualReveal(){if(ended)return false;manual=true;reveal();return true;}
function armGate(ms,onTimeout){cancelGate();if(!ended)gt=setTimeout(function(){if(ended)return;if(onTimeout)onTimeout();else reveal();},ms);}
function showBypass(){b=document.getElementById("layoutGateBypass");if(b){b.hidden=false;b.onclick=manualReveal;}}
window.__lavishLayoutGateEscape={arm:armGate,cancel:cancelGate,reveal:reveal,manualReveal:manualReveal,showBypass:showBypass,end:function(){ended=true;cancelGate();},isEnded:function(){return ended;},isManuallyBypassed:function(){return manual;}};
a=document.getElementById("layoutGateAction");
if(ended){reveal();b=document.getElementById("endedOverlay");if(b)b.hidden=false;}
if(a&&!ended)a.onclick=manualReveal;
if(o&&!o.hidden&&!ended)armGate(${CHROME_LAYOUT_GATE_MAX_HOLD_MS});
window.__lavishCancelChromeBootFailsafe=function(){clearTimeout(t);};
window.__lavishChromeBootFailed=function(){clearTimeout(t);fail();};
function fail(){
if(window.__lavishChromeReady||ended)return;
h=document.getElementById("layoutGateTitle");
c=document.getElementById("layoutGateCopy");
a=document.getElementById("layoutGateAction");
if(h)h.textContent="Lavish could not finish loading.";
if(c)c.textContent="The Lavish editor script did not load. The server usually restarted while this page was opening. Check and reload to reconnect.";
if(a){a.textContent="Check and reload";a.disabled=false;a.onclick=check;}
showBypass();
if(o)o.hidden=false;
if(document.body)document.body.classList.add("layout-gate-active");
armGate(${CHROME_LAYOUT_GATE_MAX_HOLD_MS});
}
function check(){
if(a)a.disabled=true;
var ctl=new AbortController();
var pt=setTimeout(function(){ctl.abort();},${CHROME_BOOT_FAILSAFE_PROBE_TIMEOUT_MS});
fetch("/health",{cache:"no-store",signal:ctl.signal}).then(function(r){return r&&r.ok?"running":"not-running";},function(){return ctl.signal.aborted?"no-answer":"not-running";}).then(function(outcome){
clearTimeout(pt);
if(outcome==="running"){location.reload();return;}
if(a)a.disabled=false;
if(c)c.textContent=outcome==="no-answer"?"Lavish did not answer the check, so this page cannot tell whether it is running. Try again in a moment.":"Lavish is still not running. Start it again with your agent, then use Check and reload.";
});
}
})();`;

export function createChromeHtml(
  session,
  {
    layoutGateEnabled = true,
    faviconTag = LAVISH_DEFAULT_FAVICON,
    title = "Lavish Editor",
    artifactRevision = 0,
    artifactLoadToken = "",
    artifactLoadSequence = 0,
    chromeLoadToken = "",
    attachmentMaxBytes = 0,
    attachmentMaxCount = 0,
    attachmentAcceptedMime = ACCEPTED_IMAGE_MIME,
    actionLabel = "Send",
    notifyPeople = [],
    initialViewerName = "",
    requiresApprovalToken = false,
    theme = "",
  } = {},
) {
  const acceptedMime = attachmentAcceptedMime.map(String);
  const themed = hostThemeMarkup(theme, "board");
  const sessionJson = jsonScript({
    key: session.key,
    file: session.file,
    // A page loaded (or reloaded) after the session already ended has no future live `ended`
    // event to wait for - it must start read-only instead of looking live until the user tries
    // to send and gets refused (#171).
    initialEnded: session.status === "ended",
    initialEndedBy: session.ended_by || null,
    initialChat: serializeChat(session.chat || []),
    initialChatAckIds: serializeChatAckIds(session.chat_ack_ids),
    initialChatRevision:
      Number.isSafeInteger(session.chat_revision) && session.chat_revision >= 0 ? session.chat_revision : 0,
    // The owner's own statement about whether it is there (src/owner-status.js); null when no
    // supervisor has said anything, and the pill falls back to Lavish's poll presence.
    initialOwnerStatus: serializeOwnerStatus(session.owner_status),
    // Unsent notes other tabs left behind, so a reopened link restores them instead of starting
    // from an empty queue (src/review-drafts.js).
    initialDrafts: serializeDrafts(session),
    // Bootstrapping the inbox from the server is what makes it survive a browser refresh or a
    // reconnect: the chrome never owns warning state, it only renders it.
    initialLayoutWarnings: serializeLayoutWarnings(session.layout_warnings),
    initialArtifactRevision: artifactRevision,
    initialArtifactLoadToken: artifactLoadToken,
    initialArtifactLoadSequence: artifactLoadSequence,
    chromeLoadToken,
    initialViewerName: initialViewerName || "",
    requiresApprovalToken: requiresApprovalToken === true,
    layoutGateEnabled,
    modeToggleHotkeyKey: MODE_TOGGLE_HOTKEY_KEY,
    attachmentMaxBytes,
    attachmentMaxCount,
    attachmentAcceptedMime: acceptedMime,
    // The legend's swatches are server-owned, not artifact-owned. The chrome
    // derives every swatch from this palette by registry position, so an
    // artifact cannot hand all its revisions the same colour and pattern and
    // collapse the one signal that tells the rounds apart.
    revisionPalette: artifactRevisions.revisionPalette(),
  });
  const { head: pathHead, tail: pathTail } = displayPathParts(session.file);
  const bodyClass = layoutGateEnabled ? "lavish layout-gate-active" : "lavish";
  const layoutGateHidden = layoutGateEnabled ? "" : " hidden";
  const modeHotkeyUpper = MODE_TOGGLE_HOTKEY_KEY.toUpperCase();
  const modeToggleHint = `Toggle annotate/explore mode (⌘${modeHotkeyUpper} / Ctrl+${modeHotkeyUpper})`;
  return `<!doctype html>
<html${themed.htmlAttribute}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<title>${escapeHtml(title)}</title>
${faviconTag}
<script src="/board-metadata-client.js" defer></script>
<link rel="stylesheet" href="/board-metadata.css">
<link rel="stylesheet" href="/chrome.css">
${themed.style}
</head>
<body class="${bodyClass}">
<div class="bar"><div class="brand"><span class="brand-mark">Lavish</span><span class="brand-support">Editor</span></div><span class="presence-pill" id="presencePill" role="status" aria-live="polite" data-tone="off"><span class="presence-dot" aria-hidden="true"></span><span class="presence-text" id="presencePillText">Connecting…</span></span><div class="spacer" aria-hidden="true"></div><div class="warnings-wrap" id="warningsWrap" hidden><button class="warnings-button" id="warningsButton" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="warningsDrawer">${chromeIcons.warning}<span class="warnings-count" id="warningsCount">0</span></button><div class="menu warnings-drawer" id="warningsDrawer" role="dialog" aria-labelledby="warningsTitle" aria-describedby="warningsSummary" hidden><div class="warnings-head"><h2 class="warnings-title" id="warningsTitle">Layout issues</h2><p class="warnings-summary" id="warningsSummary"></p></div><div class="warnings-toolbar"><label class="warnings-selectall"><input type="checkbox" id="warningsSelectAll"><span>Select all</span></label><span class="warnings-selected" id="warningsSelected" role="status" aria-live="polite"></span></div><div class="warnings-list" id="warningsList"></div><div class="warnings-foot"><p class="warnings-note">Queueing sends a repair request with your next feedback. An issue is marked resolved only after a newer artifact load and a complete check at the same viewport no longer finds it.</p><button class="button" id="warningsQueueButton" type="button" disabled>Queue selected fixes</button></div></div></div><div class="revisions-wrap" id="revisionsWrap" hidden><button class="revisions-button" id="revisionsButton" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="revisionsDrawer"><span class="revisions-button-text">Revisions</span><span class="revisions-count" id="revisionsCount">0</span></button><div class="menu revisions-drawer" id="revisionsDrawer" role="dialog" aria-labelledby="revisionsTitle" aria-describedby="revisionsSummary" hidden><div class="revisions-head"><h2 class="revisions-title" id="revisionsTitle">Revisions</h2><p class="revisions-summary" id="revisionsSummary"></p></div><div class="revisions-list" id="revisionsList"></div><div class="revisions-foot"><p class="revisions-note">The agent declares these in the artifact itself. Reveal flashes the next block it marked for that revision; nothing about the page is restyled, so the saved file still looks the way it does here.</p></div></div></div><button class="annotate-switch" id="annotation" type="button" aria-pressed="true" title="${escapeHtml(modeToggleHint)}"><span class="switch-track" aria-hidden="true"><span class="switch-knob"></span></span><span>Annotate</span></button><button class="sidebar-toggle" id="sidebarToggle" type="button" aria-controls="panel" aria-expanded="true" aria-label="Hide conversation" title="Hide conversation">${chromeIcons.sidebar}<span class="sidebar-toggle-count" id="sidebarToggleCount" aria-hidden="true" hidden></span></button><div class="more-wrap" id="moreWrap"><button class="more-button" id="moreButton" type="button" title="More" aria-haspopup="menu" aria-expanded="false">${chromeIcons.more}</button><div class="menu more-menu" id="moreMenu" hidden><div class="menu-head"><div class="menu-label">Editing</div><button class="menu-file" id="copyPath" type="button" title="Copy path · ${escapeHtml(session.file)}">${chromeIcons.file}<span class="menu-file-text"><span class="path-head">${escapeHtml(pathHead)}</span><span class="path-tail">${escapeHtml(pathTail)}</span></span><span class="copy-hint" id="copyHint"><span class="icon-copy">${chromeIcons.copy}</span><span class="icon-check">${chromeIcons.check}</span><span id="copyHintText">Copy</span></span></button></div><div class="menu-rule"></div><button class="menu-item" id="reloadArtifact" type="button">${chromeIcons.refresh}<span>Reload artifact</span></button><button class="menu-item" id="layoutToggle" type="button" title="Switch between the phone and desktop layouts. Remembered on this device.">${chromeIcons.phone}<span id="layoutToggleText">Layout: Auto</span></button><button class="menu-item" id="copySnapshot" type="button">${chromeIcons.camera}<span>Copy DOM snapshot</span></button><button class="menu-item" id="exportArtifact" type="button">${chromeIcons.download}<span>Export standalone HTML</span></button><button class="menu-item" id="shareArtifact" type="button">${chromeIcons.globe}<span>Publish link</span></button><div class="menu-rule"></div><button class="menu-item danger" id="end" type="button">${chromeIcons.exit}<span>End session</span></button></div></div></div>
<div class="layout"><div class="frame"><iframe id="artifact" sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads" data-artifact-src="/artifact/${session.key}/index.html"></iframe></div><div class="panel-scrim" id="panelScrim"></div><aside class="panel" id="panel"><div class="panel-head" id="panelHead"><span class="panel-handle" aria-hidden="true"></span><div class="panel-head-row"><h2>Conversation</h2><span class="panel-summary" id="panelSummary" role="status" aria-live="polite"></span><button class="panel-toggle" id="panelToggle" type="button" aria-expanded="false" aria-controls="panel" aria-label="Show conversation">${chromeIcons.chevronUp}</button></div></div><div class="panel-scroll" id="panelScroll"><div class="chrome-board-metadata" data-board-metadata="${session.key}" data-chrome="true" data-action-label="${escapeHtml(actionLabel)}" data-people="${escapeHtml(JSON.stringify(Array.isArray(notifyPeople) ? notifyPeople : []))}" data-file="${escapeHtml(session.file)}" data-metadata="${escapeHtml(JSON.stringify(serializeBoardMetadata(session)))}"></div><div class="chat" id="chatLog"></div><div class="chat chat-queued" id="queuedLog"></div></div><div class="composer" id="chatComposer"><div class="presence-banner handoff-banner" id="handoffBanner" hidden><span>This review is open in another Lavish tab. Unsent notes are saved with this review, so reopening the link in a new tab or window brings them back.</span><button class="handoff-takeover" id="handoffTakeover" type="button">Take over here</button></div><div class="presence-banner handoff-banner" id="outdatedBanner" hidden><span id="outdatedText">The Lavish server this page was connected to is no longer running. Reloading will work once it is running again.</span><span class="outdated-actions"><button class="handoff-takeover" id="outdatedReload" type="button">Check and reload</button><button class="handoff-takeover" id="outdatedDismiss" type="button">Dismiss</button></span></div><div class="presence-banner handoff-banner approval-banner" id="approvalBanner" hidden><span id="approvalBannerText"></span><pre id="approvalPreview" class="approval-preview" aria-live="polite"></pre><label class="approval-author-wrap" for="approvalAuthorInput"><span>Reviewer</span><input id="approvalAuthorInput" type="text" maxlength="80" placeholder="Your name"></label><label class="approval-author-wrap" id="approvalTokenWrap" for="approvalTokenInput" hidden><span>Token</span><input id="approvalTokenInput" type="password" maxlength="200" placeholder="Approval token"></label><span class="outdated-actions"><button class="handoff-takeover" id="approvalConfirm" type="button">Confirm</button><button class="handoff-takeover" id="approvalCancel" type="button">Cancel</button></span></div><div class="presence-banner" id="presenceBanner" hidden>Your agent is not listening. If this persists, ask your agent to poll for updates from Lavish.</div><textarea id="chatInput" placeholder="Write a message for the agent..."></textarea><div class="chat-attachments" id="chatAttachments"></div><div class="chat-attachment-toolbar"><button class="chat-attach" id="chatAttach" type="button">Attach images</button><input id="chatAttachInput" type="file" accept="${escapeHtml(acceptedMime.join(","))}" multiple hidden><span class="chat-attachment-notice" id="chatAttachmentNotice" role="status"></span></div><div class="send-hint" id="sendHint" hidden>Nothing queued in this tab. Unsent notes are saved with this review, so reopening the link in a new tab or window brings them back.</div><div class="actions" id="sendActions"><button class="button button-danger" id="sendAndEnd" type="button">${chromeIcons.exit}<span>Send &amp; End</span></button><button class="button" id="send">Send to Agent</button></div></div></aside></div>
<div class="share-overlay" id="shareDialog" role="dialog" aria-modal="true" aria-labelledby="shareTitleText" hidden><form class="share-card" id="shareForm"><div class="share-head"><div><div class="share-kicker">Publish to <a class="share-link" href="https://ht-ml.app" target="_blank" rel="noopener noreferrer">ht-ml.app</a></div><h2 id="shareTitleText">Publish artifact</h2></div><button class="share-close" id="shareClose" type="button" aria-label="Close publish dialog"><svg width="14" height="14" viewBox="0 0 10 10" fill="none" aria-hidden="true" focusable="false"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div><p class="share-note">ht-ml.app is a separate, third-party hosting service, not part of Lavish. Publishing sends this artifact to its servers.</p><p class="share-copy">This uploads this artifact to ht-ml.app with local assets inlined. Without a password, the page is PUBLIC and anyone with the link can open it. With a password, the page is PRIVATE and viewers must supply the password to view.</p><p class="share-note">Do not publish secrets. The Lavish annotation SDK is not included.</p><div class="share-grid"><label class="share-check"><input id="shareGenerate" type="checkbox"><span>Generate a password (makes this page private)</span></label><label>Password (optional)<input id="sharePassword" name="password" type="password" autocomplete="new-password" placeholder="Leave blank for a public page"></label></div><div class="share-status" id="shareStatus" role="status"></div><div class="share-result" id="shareResult" hidden><label id="shareUrlResult">Share URL<div class="share-copy-row"><input id="shareUrl" readonly><button class="share-copy-btn" id="copyShareUrl" type="button">Copy URL</button></div></label><label id="sharePasswordResult" hidden>Password (shared secret)<div class="share-copy-row"><input id="sharePasswordOut" readonly><button class="share-copy-btn" id="copySharePassword" type="button">Copy password</button></div></label><label id="shareSiteIdResult" hidden>Site ID<div class="share-copy-row"><input id="shareSiteId" readonly><button class="share-copy-btn" id="copyShareSiteId" type="button">Copy site ID</button></div></label><label id="shareUpdateKeyResult">Update key (secret)<div class="share-copy-row"><input id="shareUpdateKey" readonly><button class="share-copy-btn" id="copyUpdateKey" type="button">Copy key</button></div></label><p class="share-note" id="shareUpdateKeyNote">Keep the update key private. ht-ml.app returns it once and it is the only way to update this page later; the service has no delete. Republish this page&#39;s HTML with <code>lavish-axi share &lt;file&gt; --site &lt;site id&gt; --update-key &lt;key&gt;</code>, and add <code>--private</code> to also lock it behind a new generated password.</p></div><div class="share-actions"><button class="share-cancel" id="shareCancel" type="button">Cancel</button><button class="button" id="sharePublish" type="submit">Publish</button></div></form></div>
<div class="ended-overlay layout-gate-overlay" id="layoutGateOverlay"${layoutGateHidden}><div class="ended-card"><div class="ended-title" id="layoutGateTitle">Checking layout.<br>One moment.</div><p class="ended-copy" id="layoutGateCopy">Lavish is waiting for fonts and final geometry before revealing this artifact.</p><button class="button ended-action" id="layoutGateAction" type="button">Show anyway</button><button class="button ended-action layout-gate-bypass" id="layoutGateBypass" type="button" hidden>Show anyway</button></div></div>
<div class="ended-overlay" id="endedOverlay" hidden><div class="ended-card"><div class="ended-title">Session ended.<br>Return to your agent to continue.</div><p class="ended-copy">${escapeHtml(session.file)}</p><button type="button" class="button ended-action" data-reactivate data-key="${session.key}" data-file="${escapeHtml(session.file)}">Reactivate board</button><p><a href="/">Fusion Hub</a></p></div></div>
<div class="whiteboard-overlay" id="whiteboardOverlay" hidden><div class="whiteboard-shell"><div class="whiteboard-error" id="whiteboardError" hidden></div><button class="whiteboard-close" id="whiteboardClose" type="button" aria-label="Close whiteboard"><svg width="14" height="14" viewBox="0 0 10 10" fill="none" aria-hidden="true" focusable="false"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button><iframe id="whiteboardFrame" title="Excalidraw whiteboard" sandbox="allow-scripts allow-popups"></iframe></div></div>
<script id="lavish-session" type="application/json">${sessionJson}</script>
<script>${CHROME_BOOT_FAILSAFE_JS}</script>
<script src="/chrome-client.js" onerror="window.__lavishChromeBootFailed()"></script>
</body>
</html>`;
}

export function createWhiteboardFrameHtml(channelToken = "") {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lavish Whiteboard</title>
<link rel="stylesheet" href="/whiteboard-assets/whiteboard.css">
</head>
<body>
<script>window.__lavishWhiteboardChannelToken=${JSON.stringify(channelToken)};</script>
<script src="/whiteboard-assets/whiteboard.js"></script>
</body>
</html>`;
}

// Serialize every helper a shared module exports as a same-scope const so cross-helper calls
// (e.g. mermaidNodeFrom → mermaidNodeElement) resolve in the browser. Deriving these from the
// module's exports — rather than a hand-kept list — means adding a helper can never silently
// ReferenceError at runtime.
// Only functions survive `toString()` round-tripping: a Set, Map, or RegExp would serialize to a
// valid-looking `{}` and reach the browser semantically empty, which is far harder to find than
// this throw. A shared module must therefore export nothing but helpers.
function serializeModuleHelpers(module) {
  const entries = Object.entries(module);
  const unsupported = entries.filter(([, value]) => typeof value !== "function").map(([name]) => name);
  if (unsupported.length > 0) {
    throw new TypeError(
      `Cannot serialize non-function SDK helper export(s) into the artifact bundle: ${unsupported.join(", ")}`,
    );
  }
  return {
    declarations: entries.map(([name, fn]) => `const ${name}=${fn.toString()};`).join("\n"),
    names: entries.map(([name]) => name),
  };
}

/**
 * @param {string} key
 * @param {number} [artifactRevision]
 * @param {string} [artifactLoadToken]
 * @param {{ maxAttachmentCount?: number, maxAttachmentBytes?: number, acceptedImageMime?: string[], theme?: string }} [options]
 */
export function createSdkJs(
  key,
  artifactRevision = 0,
  artifactLoadToken = "",
  { maxAttachmentCount, maxAttachmentBytes, acceptedImageMime = ACCEPTED_IMAGE_MIME, theme = "" } = {},
) {
  const mermaidHelperSource = serializeModuleHelpers(mermaidNode);
  const tableHelperSource = serializeModuleHelpers(tableCellHelpers);
  const revisionHelperSource = serializeModuleHelpers(artifactRevisions);
  const revisionNumber = Number(artifactRevision);
  const revision = Number.isFinite(revisionNumber) && revisionNumber >= 0 ? Math.trunc(revisionNumber) : 0;
  const loadToken = String(artifactLoadToken || "").slice(0, 200);
  // The per-prompt attachment cap is authoritative on the server (attachment-store.js);
  // pass it to the SDK so the annotation card's local count guard matches the server
  // limit instead of a hardcoded literal (W1). The card is still only a UX guide - the
  // server re-enforces the cap on /prompts and rejects the whole batch on a mismatch.
  const sdkOptions = {
    maxAttachmentCount: Number.isFinite(maxAttachmentCount) ? maxAttachmentCount : undefined,
    maxAttachmentBytes: Number.isFinite(maxAttachmentBytes) ? maxAttachmentBytes : undefined,
    acceptedImageMime: acceptedImageMime.map(String),
    // The interface theme's tokens for the annotation UI's shadow root, and its accent for the
    // outline drawn on artifact elements. Empty for the stock look (src/host-theme.js).
    themeCss: hostThemeCss(theme, "board", ":host"),
    themeAccent: hostThemeTokens(theme, "board")?.accent || "",
  };
  return `(() => {
const key=${JSON.stringify(key)};
const artifactRevision=${revision};
const artifactLoadToken=${JSON.stringify(loadToken)};
const deriveQueueKey=${deriveLavishQueueKey.toString()};
const isNativeInteractiveControl=${isNativeInteractiveControl.toString()};
const MODE_TOGGLE_HOTKEY_KEY=${JSON.stringify(MODE_TOGGLE_HOTKEY_KEY)};
const isModeToggleHotkeyEvent=${isModeToggleHotkeyEvent.toString()};
const classifySevereTextOverflow=${classifySevereTextOverflow.toString()};
const classifyMaterialRectEscape=${classifyMaterialRectEscape.toString()};
const isMaterialPageOverflow=${isMaterialPageOverflow.toString()};
const findStableLayoutFindings=${findStableLayoutFindings.toString()};
const isNearTotalOcclusion=${isNearTotalOcclusion.toString()};
const attachmentSizeError=${attachmentSizeError.toString()};
const classifyAttachmentBatch=${classifyAttachmentBatch.toString()};
const partitionDroppedFiles=${partitionDroppedFiles.toString()};
const planClipboardPaste=${planClipboardPaste.toString()};
const acceptedImageTypes=${acceptedImageTypes.toString()};
const isTrustedAttachmentResult=${isTrustedAttachmentResult.toString()};
const deriveAttachmentNoticeState=${deriveAttachmentNoticeState.toString()};
${mermaidHelperSource.declarations}
const mermaidHelpers={ ${mermaidHelperSource.names.join(", ")} };
${tableHelperSource.declarations}
${revisionHelperSource.declarations}
(${createArtifactSdk.toString()})(deriveQueueKey, isNativeInteractiveControl, mermaidHelpers, artifactRevision, artifactLoadToken, key, ${JSON.stringify(sdkOptions)});
})();`;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

function jsonScript(value) {
  return JSON.stringify(value)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
