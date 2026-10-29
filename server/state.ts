// The plugin's own state, kept beside the daemon config in $PASEO_HOME/claude-accounts.json.
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const StateSchema = z.object({
  version: z.literal(1),
  /** Provider ID of the account new and reopened Claude sessions run on. */
  activeAccountId: z.string().nullable(),
  /** Agent ID → account its live session was last opened on. */
  agents: z.record(z.string(), z.string()),
  /** Config directories of removed accounts; old chats may still have their transcript there. */
  retiredConfigDirs: z.array(z.string()).default([]),
});

export type State = z.infer<typeof StateSchema>;

const EMPTY: State = { version: 1, activeAccountId: null, agents: {}, retiredConfigDirs: [] };

function statePath(): string {
  const home = process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
  return join(home, "claude-accounts.json");
}

export async function readState(): Promise<State> {
  try {
    return StateSchema.parse(JSON.parse(await readFile(statePath(), "utf8")));
  } catch {
    return { ...EMPTY, agents: {}, retiredConfigDirs: [] };
  }
}

// Updates are read-modify-write; chaining them keeps two hooks from losing each other's write.
let queue: Promise<unknown> = Promise.resolve();

export function updateState(change: (state: State) => State): Promise<State> {
  const next = queue.then(async () => {
    const state = change(await readState());
    const path = statePath();
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
    return state;
  });
  queue = next.catch(() => {});
  return next;
}
