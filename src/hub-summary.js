import { open } from "node:fs/promises";
import { boardSearchText } from "./board-metadata.js";
import { parseFragment } from "parse5";
import { parseRevisionRegistry } from "./artifact-revisions.js";

// Metadata/revisions use 64 KiB windows; only explicit search reads up to 1 MiB.
// Never let embedded evidence size dictate card memory use, even on cache misses.
export async function readHubArtifact(file, { includeSearchText = false } = {}) {
  const windowBytes = 64 * 1024;
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const readWindow = async (position, length) => {
      const buffer = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      return buffer.subarray(0, offset);
    };
    const head = await readWindow(0, Math.min(size, includeSearchText ? 1024 * 1024 : windowBytes));
    const revisionHead = head.subarray(0, windowBytes);
    const tailStart = Math.max(revisionHead.length, size - windowBytes);
    const tail =
      size <= head.length
        ? head.subarray(tailStart, Math.min(size, head.length))
        : await readWindow(tailStart, Math.max(0, size - tailStart));
    // Join contiguous windows so a registry can straddle 64 KiB. Never join a gap:
    // partial markup from unrelated positions must not fabricate a registry.
    const revisionLabel =
      tailStart === revisionHead.length
        ? hubArtifactRevision(Buffer.concat([revisionHead, tail]).toString("utf8"))
        : hubArtifactRevision(revisionHead.toString("utf8")) || hubArtifactRevision(tail.toString("utf8"));
    return { html: head.toString("utf8"), revisionLabel };
  } finally {
    await handle.close();
  }
}

// Match the board legend's validated registry, never the layout audit's load sequence.
export function hubArtifactRevision(html) {
  const root = parseFragment(String(html));
  const pending = [...root.childNodes].reverse();
  while (pending.length) {
    const node = pending.pop();
    if (
      "tagName" in node &&
      node.tagName === "script" &&
      node.attrs.some((attr) => attr.name === "data-lavish-revisions")
    ) {
      const textContent = node.childNodes.map((child) => ("value" in child ? child.value : "")).join("");
      return parseRevisionRegistry({ querySelector: () => ({ textContent }) }).at(-1)?.label || "";
    }
    if ("childNodes" in node) pending.push(...[...node.childNodes].reverse());
  }
  return "";
}

// Use the same bounded 64 KiB slice already read for cards. Never execute page code.
export function hubArtifactSummary(html) {
  const visible = String(html)
    .slice(0, 65536)
    .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  const text = (value, max) => {
    if (!value) return "";
    const plain = /[<&]/.test(value) ? boardSearchText(value) : value.replace(/\s+/g, " ").trim();
    return plain.slice(0, max);
  };
  const heading = visible.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i);
  const title = visible.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const explicit = visible.match(
    /<([\w-]+)\b[^>]*\bdata-lavish-next-step(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*>([\s\S]*?)<\/\1\s*>/i,
  );
  const label =
    /<(h[1-6]|p|div|span|strong)\b[^>]*>[^<>]{0,80}\bnext steps?\s*:?\s*<\/\1\s*>\s*<(h[1-6]|p|div)\b[^>]*>([\s\S]*?)<\/\2\s*>/i.exec(
      visible,
    );
  return { title: text(heading?.[1] || title?.[1], 200), nextStep: text(explicit?.[2] || label?.[3], 240) };
}
