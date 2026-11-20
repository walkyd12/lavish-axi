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

export function serializeBoardMetadata(session) {
  return {
    tags: Array.isArray(session.tags) ? session.tags : [],
    creator: session.creator || "",
    created_version: session.created_version || "",
    served_version: session.served_version || "",
    closed: session.status === "ended",
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

export function filterHubBoards(boards, { query = "", tag = "" } = {}) {
  const words = String(query).toLowerCase().trim().split(/\s+/).filter(Boolean);
  const selected = String(tag).toLowerCase().trim();
  return boards.filter((board) => {
    const tags = Array.isArray(board.tags) ? board.tags : [];
    const haystack = [board.title, board.search_text, ...tags].join(" ").toLowerCase();
    return (
      (!selected || tags.some((value) => value.toLowerCase() === selected)) &&
      words.every((word) => haystack.includes(word))
    );
  });
}
