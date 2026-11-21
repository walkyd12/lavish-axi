import { spawn } from "node:child_process";
import path from "node:path";

const UNAVAILABLE = "Preview unavailable";

/** Run only the operator-configured executable; artifact content supplies no arguments.
 * @param {string | undefined} executable
 * @param {{ key: string, file: string }} session
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<string>}
 */
export function runApprovalPreview(executable, session, { timeoutMs = 3000 } = {}) {
  if (!executable || !path.isAbsolute(executable)) return Promise.resolve(UNAVAILABLE);
  return new Promise((resolve) => {
    const child = spawn(executable, [session.key, session.file], { shell: false, stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve(text);
    };
    const timer = setTimeout(() => finish(UNAVAILABLE), timeoutMs);
    child.on("error", () => finish(UNAVAILABLE));
    child.stdout.on("error", () => finish(UNAVAILABLE));
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 128 * 1024) finish(UNAVAILABLE);
      else chunks.push(chunk);
    });
    child.on("close", (code) => {
      const text = Buffer.concat(chunks).toString("utf8");
      finish(code === 0 && text.trim() ? text : UNAVAILABLE);
    });
  });
}
