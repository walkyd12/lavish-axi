import { boardSearchText } from "./board-metadata.js";
import { parseFragment } from "parse5";
import { parseRevisionRegistry } from "./artifact-revisions.js";

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
