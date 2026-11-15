import fs from "node:fs/promises";

/** Root reads of agent-writable files: never follow a link, never wait on a FIFO, never read without a bound. */
export async function readAgentFile(file, max = 64_000) {
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max) throw new Error("Unexpected agent file.");
    // The file may grow after stat(); cap the actual read as well.
    const buffer = Buffer.alloc(max + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > max) throw new Error("Unexpected agent file.");
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    await handle.close();
  }
}

const TOKEN_FIELDS = ["access_token", "refresh_token", "id_token"];
const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]{20,4096}$/;
/**
 * The credentials in a Codex login file. The file is agent-writable after a run, and every value
 * returned here is hidden from logs and from the diff a reviewer reads, so only the known token
 * fields count, and only values shaped like tokens: an agent must not be able to hide code this way.
 */
export function loginTokens(auth) {
  const tokens = auth && typeof auth === "object" && auth.tokens && typeof auth.tokens === "object" ? auth.tokens : {};
  return TOKEN_FIELDS.map((field) => tokens[field]).filter((value) => typeof value === "string" && TOKEN_SHAPE.test(value));
}

/** Git as the agent user reads the agent's repository config: never let it start a monitor or a hook. */
export const SAFE_GIT = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];
