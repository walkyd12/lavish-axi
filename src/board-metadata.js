// Durable board metadata lives with the session, never in its HTML.
import { parse } from "parse5";

export class BoardMetadataError extends Error {}

export function normalizeTags(value) {
  if (!Array.isArray(value) || value.length > 64) throw new BoardMetadataError("Use at most 32 tags");
  const tags = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== "string") throw new BoardMetadataError("Tags must be text");
    const tag = raw.trim();
    // eslint-disable-next-line no-control-regex
    if (!tag || tag.length > 64 || /[\u0000-\u001f\u007f]/.test(tag))
      throw new BoardMetadataError("Tags need 1–64 printable characters");
    const folded = tag.toLowerCase();
    if (!seen.has(folded)) tags.push(tag);
    seen.add(folded);
  }
  if (tags.length > 32) throw new BoardMetadataError("Use at most 32 tags");
  return tags;
}

export function normalizeCreator(value) {
  if (value === undefined) return "";
  // eslint-disable-next-line no-control-regex
  if (typeof value !== "string" || !value.trim() || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new BoardMetadataError("Creator needs 1–120 printable characters");
  }
  return value.trim();
}

export function boardWorkflowState(session) {
  const ended = session?.status === "ended" || session?.closed === true;
  const cancelled = ended && (session?.ended_reason === "cancelled" || session?.cancelled === true);
  if (cancelled) return { board_state: "cancelled", board_state_label: "Cancelled", cancelled: true };
  if (ended) return { board_state: "done", board_state_label: "Done", cancelled: false };
  const tags = Array.isArray(session?.tags) ? session.tags : [];
  if (tags.some((tag) => String(tag).toLowerCase() === "needs-input")) {
    return { board_state: "needs-input", board_state_label: "Needs input", cancelled: false };
  }
  return { board_state: "working", board_state_label: "Working", cancelled: false };
}

export function serializeBoardMetadata(session) {
  const workflow = boardWorkflowState(session);
  return {
    tags: Array.isArray(session.tags) ? session.tags : [],
    creator: session.creator || "",
    created_version: session.created_version || "",
    served_version: session.served_version || "",
    closed: session.status === "ended",
    ...workflow,
  };
}

// Unknown versions aren't labelled old. Compare numeric components rather than strings.
export function boardVersionBehind(board, currentVersion) {
  const parseVersion = (value) =>
    /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/
      .exec(String(value || ""))
      ?.slice(1)
      .map(Number);
  const previous = parseVersion(board.served_version || board.created_version);
  const current = parseVersion(currentVersion);
  if (!previous || !current) return false;
  for (let i = 0; i < 3; i++) {
    if (previous[i] !== current[i]) return previous[i] < current[i];
  }
  return false;
}

// Search only text, excluding executable/style/template content. Reads are bounded by the caller.
export function boardSearchText(html) {
  const parts = [];
  /** @type {import("parse5").DefaultTreeAdapterMap["node"][]} */
  const pending = [parse(html)];
  while (pending.length) {
    const node = pending.pop();
    if ("tagName" in node && ["script", "style", "template", "noscript"].includes(node.tagName)) continue;
    if (node.nodeName === "#text" && "value" in node) parts.push(node.value);
    const children = "childNodes" in node ? node.childNodes : [];
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export function filterHubBoards(boards, { query = "", tag = "", state = "" } = {}) {
  const words = String(query).toLowerCase().trim().split(/\s+/).filter(Boolean);
  const selected = String(tag).toLowerCase().trim();
  const wantedState = String(state).toLowerCase().trim();
  return boards.filter((board) => {
    const tags = Array.isArray(board.tags) ? board.tags : [];
    const closed = Boolean(board.closed || board.status === "ended" || board.state === "file-gone");
    const cancelled = Boolean(board.cancelled);
    const boardState = String(board.board_state || "").toLowerCase();
    const stateMatches =
      !wantedState ||
      (wantedState === "open" && !closed) ||
      (wantedState === "closed" && closed && !cancelled) ||
      (wantedState === "done" && closed && !cancelled) ||
      (wantedState === "cancelled" && cancelled) ||
      (wantedState === "needs-input" &&
        !closed &&
        (boardState === "needs-input" || tags.some((v) => v.toLowerCase() === "needs-input"))) ||
      (wantedState === "working" && !closed && boardState === "working");
    const haystack = [board.title, board.search_text, ...tags].join(" ").toLowerCase();
    return (
      stateMatches &&
      (!selected || tags.some((value) => value.toLowerCase() === selected)) &&
      words.every((word) => haystack.includes(word))
    );
  });
}
