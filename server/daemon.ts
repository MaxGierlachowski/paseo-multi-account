// A short-lived connection to the local daemon, made the way the paseo CLI makes it.
//
// The plugin SDK's PaseoApi cannot reopen an agent's session, which is the only way a running
// Claude process picks up another CLAUDE_CONFIG_DIR. The daemon's own "Reload agent" request
// (refresh_agent_request) does exactly that, and it is reached over loopback with the local
// credential the daemon writes to $PASEO_HOME/local-credential for local clients.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { paseoHome } from "./accounts.js";

const LockSchema = z.object({ listen: z.string().min(1) });

async function withDaemon<T>(work: (client: DaemonClient) => Promise<T>): Promise<T> {
  const home = paseoHome();
  const { listen } = LockSchema.parse(JSON.parse(await readFile(join(home, "paseo.pid"), "utf8")));
  if (listen.startsWith("/") || listen.includes("://")) {
    throw new Error(`Daemon listens on ${listen}; only host:port is supported`);
  }
  const token = (await readFile(join(home, "local-credential"), "utf8")).trim();
  const client = new DaemonClient({
    url: `ws://${listen}/ws`,
    clientId: "plugin-claude-accounts",
    clientType: "cli",
    localCredential: () => token,
    reconnect: { enabled: false },
    connectTimeoutMs: 5_000,
  });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.close().catch(() => {});
  }
}

export interface LiveAgent {
  id: string;
  provider: string;
  status: "initializing" | "idle" | "running" | "error";
  pendingPermissions: number;
}

/** Agents with a session the daemon currently holds open. */
export function liveAgents(): Promise<LiveAgent[]> {
  return withDaemon(async (client) => {
    const agents: LiveAgent[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.fetchAgents({
        filter: { statuses: ["initializing", "idle", "running", "error"] },
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      for (const { agent } of page.entries) {
        if (agent.archivedAt || agent.status === "closed") continue;
        agents.push({
          id: agent.id,
          provider: agent.provider,
          status: agent.status,
          pendingPermissions: agent.pendingPermissions?.length ?? 0,
        });
      }
      cursor = page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
    } while (cursor);
    return agents;
  });
}

/** The daemon's "Reload agent": closes the session and resumes it from its transcript. */
export function reloadAgents(agentIds: readonly string[]): Promise<{ reloaded: string[]; failed: string[] }> {
  return withDaemon(async (client) => {
    const reloaded: string[] = [];
    const failed: string[] = [];
    for (const agentId of agentIds) {
      try {
        await client.refreshAgent(agentId);
        reloaded.push(agentId);
      } catch (error) {
        console.warn({ err: error, agentId }, "Could not reload agent on the new Claude account");
        failed.push(agentId);
      }
    }
    return { reloaded, failed };
  });
}

export type NewProvider = {
  extends: string;
  label: string;
  enabled: boolean;
  env: Record<string, string>;
  options?: { extraArgs?: Record<string, string | null> };
};

/** Adds a provider through the daemon, which writes the config and reloads it. */
export function addProvider(id: string, provider: NewProvider): Promise<void> {
  return withDaemon(async (client) => {
    const { config } = await client.getDaemonConfig();
    if (config.providers?.[id]) throw new Error(`A provider named '${id}' already exists`);
    await client.patchDaemonConfig({ providers: { [id]: provider } });
  });
}

/** Removes a provider through the daemon, which writes the config and reloads it. */
export function removeProvider(id: string): Promise<void> {
  return withDaemon(async (client) => {
    const { config } = await client.getDaemonConfig();
    if (!config.providers?.[id]) throw new Error(`No provider named '${id}'`);
    await client.patchDaemonConfig({ removeProviders: [id] });
  });
}
