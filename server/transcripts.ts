// Moves a chat's Claude transcript to the account it continues on.
//
// Claude Code keeps a session's transcript under the config directory of the login that ran
// it: <CLAUDE_CONFIG_DIR>/projects/<encoded cwd>/<session id>.jsonl, plus a <session id>/
// folder (subagents, tool results) beside it and <CLAUDE_CONFIG_DIR>/file-history/<session
// id>/ for rewind. Resuming under another login only finds the conversation when these exist
// there too, so before a session reopens, the newest copy is copied into the target account.
// Only that one session is copied; the source is never modified.
import { cp, mkdir, readdir, readFile, rename, stat, copyFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import { paseoHome } from "./accounts.js";

// Session and agent IDs become path segments; anything else is refused.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const AgentRecordSchema = z.object({
  persistence: z.object({ sessionId: z.string() }).nullish(),
});

/** The Claude session ID Paseo stored for an agent, read from its record on disk. */
export async function claudeSessionId(agentId: string): Promise<string | null> {
  if (!ID_PATTERN.test(agentId)) return null;
  const root = join(paseoHome(), "agents");
  let directories: string[];
  try {
    directories = await readdir(root);
  } catch {
    return null;
  }
  for (const directory of directories) {
    try {
      const raw = await readFile(join(root, directory, `${agentId}.json`), "utf8");
      const sessionId = AgentRecordSchema.parse(JSON.parse(raw)).persistence?.sessionId;
      return sessionId && ID_PATTERN.test(sessionId) ? sessionId : null;
    } catch {
      // Not in this project's folder.
    }
  }
  return null;
}

interface TranscriptCopy {
  configDir: string;
  projectDir: string;
  size: number;
  mtimeMs: number;
}

async function findTranscripts(configDir: string, sessionId: string): Promise<TranscriptCopy[]> {
  const projects = join(configDir, "projects");
  let projectDirs: string[];
  try {
    projectDirs = await readdir(projects);
  } catch {
    return [];
  }
  const found: TranscriptCopy[] = [];
  for (const projectDir of projectDirs) {
    try {
      const info = await stat(join(projects, projectDir, `${sessionId}.jsonl`));
      if (info.isFile()) found.push({ configDir, projectDir, size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // No transcript for this session in that project.
    }
  }
  return found;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make `targetDir` hold the newest transcript of `sessionId` found in any of `sourceDirs`.
 * Transcripts are append-only, so the longest copy is the newest.
 */
export async function syncTranscript(
  sessionId: string,
  targetDir: string,
  sourceDirs: readonly string[],
): Promise<"copied" | "current" | "missing"> {
  if (!ID_PATTERN.test(sessionId)) return "missing";
  const copies = (
    await Promise.all([...new Set([targetDir, ...sourceDirs])].map((dir) => findTranscripts(dir, sessionId)))
  ).flat();
  const newest = copies.sort((a, b) => b.size - a.size || b.mtimeMs - a.mtimeMs)[0];
  if (!newest) return "missing";
  const inTarget = copies.find(
    (copy) => copy.configDir === targetDir && copy.projectDir === newest.projectDir,
  );
  if (newest.configDir === targetDir || (inTarget && inTarget.size >= newest.size)) return "current";

  const from = join(newest.configDir, "projects", newest.projectDir);
  const to = join(targetDir, "projects", newest.projectDir);
  await mkdir(to, { recursive: true });
  const temporary = join(to, `.${sessionId}.${randomUUID()}.tmp`);
  await copyFile(join(from, `${sessionId}.jsonl`), temporary);
  await rename(temporary, join(to, `${sessionId}.jsonl`));

  for (const [source, target] of [
    [join(from, sessionId), join(to, sessionId)],
    [join(newest.configDir, "file-history", sessionId), join(targetDir, "file-history", sessionId)],
  ] as const) {
    if (!(await exists(source))) continue;
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: true });
  }
  return "copied";
}
