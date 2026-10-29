// Chooses the Claude account every Claude session runs on, and moves chats when it changes.
//
// The daemon asks plugins before it opens any agent session (create, resume, reload). For a
// Claude-family provider, this plugin sets CLAUDE_CONFIG_DIR to the active account there. The
// launch env is applied after the provider's own env, so chats created on a per-account
// provider follow the switch as well.
//
// Switching reloads every open Claude chat that runs on another account: idle ones at once,
// busy ones (mid-turn or waiting on a permission) when their turn ends. A reload closes the
// Claude process and resumes the same conversation, so the next message goes out on the new
// account with the whole history.
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import type { UsageReport } from "@getpaseo/plugin/server/usage";
import type { AccountView } from "../shared/rpc.js";
import {
  activeAccount,
  claudeAccounts,
  claudeFamily,
  defaultConfigDir,
  discoverFor,
  paseoHome,
  type ClaudeAccount,
} from "./accounts.js";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { liveAgents, reloadAgents, removeProvider } from "./daemon.js";
import { cancelLogin } from "./login.js";
import { readState, updateState } from "./state.js";
import { claudeSessionId, syncTranscript } from "./transcripts.js";
import { fetchUsage } from "./usage.js";
import type { UsageInput } from "../shared/input.js";

/** Chats to reload once their current turn ends. */
const deferred = new Set<string>();

export async function applyActiveAccount(
  request: PluginSessionOpenRequest,
): Promise<PluginSessionOpenRequest> {
  if (!(await claudeFamily()).has(request.provider)) return request;
  const account = await activeAccount();
  if (!account) return request;

  if (request.reason !== "create") {
    try {
      const sessionId = await claudeSessionId(request.agentId);
      if (sessionId) {
        const sources = [
          ...(await claudeAccounts()).map((a) => a.configDir),
          ...(await readState()).retiredConfigDirs,
          defaultConfigDir(),
        ];
        await syncTranscript(sessionId, account.configDir, sources);
      }
    } catch (error) {
      // Opening still goes ahead; Claude reports a missing conversation itself.
      console.warn({ err: error, agentId: request.agentId }, "Could not copy the Claude transcript");
    }
  }

  if (request.purpose === "interactive") {
    await updateState((state) => ({
      ...state,
      agents: { ...state.agents, [request.agentId]: account.id },
    }));
    deferred.delete(request.agentId);
  }
  return { ...request, env: { ...request.env, CLAUDE_CONFIG_DIR: account.configDir } };
}

export async function switchAccount(accountId: string) {
  const account = (await claudeAccounts()).find((candidate) => candidate.id === accountId);
  if (!account) throw new Error(`Unknown Claude account '${accountId}'`);
  const state = await updateState((current) => ({ ...current, activeAccountId: account.id }));
  usageCache.clear();

  const family = await claudeFamily();
  const stale = (await liveAgents()).filter(
    (agent) => family.has(agent.provider) && state.agents[agent.id] !== account.id,
  );
  const now: string[] = [];
  for (const agent of stale) {
    const busy =
      agent.status === "running" || agent.status === "initializing" || agent.pendingPermissions > 0;
    if (busy) deferred.add(agent.id);
    else now.push(agent.id);
  }
  const { reloaded, failed } = now.length ? await reloadAgents(now) : { reloaded: [], failed: [] };
  return { activeId: account.id, reloaded: reloaded.length, deferred: deferred.size, failed };
}

export function onTurnEnded(agentId: string): void {
  if (!deferred.has(agentId)) return;
  // Leave the daemon's turn bookkeeping first; a reload interrupts whatever it finds running.
  setTimeout(() => {
    void (async () => {
      const [account, state] = await Promise.all([activeAccount(), readState()]);
      if (!deferred.delete(agentId) || !account || state.agents[agentId] === account.id) return;
      await reloadAgents([agentId]);
    })().catch((error) => console.warn({ err: error, agentId }, "Deferred account reload failed"));
  }, 1_000);
}

export function onAgentGone(agentId: string): void {
  deferred.delete(agentId);
}

// The usage endpoint rate-limits hard (Retry-After in the tens of minutes), so the switcher
// UI reads through a short cache instead of calling it on every open.
const USAGE_TTL_MS = 120_000;
const usageCache = new Map<string, { at: number; view: Pick<AccountView, "email" | "usage"> }>();

function usageView(report: UsageReport): AccountView["usage"] {
  if (report.status === "available") {
    return {
      status: "available",
      planLabel: report.planLabel ?? null,
      windows: report.windows.map((window) => ({
        id: window.id,
        label: window.label,
        shortLabel: window.shortLabel ?? null,
        usedPct: window.usedPct ?? null,
        resetsAt: window.resetsAt ?? null,
      })),
      message: null,
    };
  }
  if (report.status === "error") {
    return { status: "error", planLabel: null, windows: [], message: report.error };
  }
  const problem = report.problem;
  const message =
    problem.kind === "expired"
      ? "Login expired; open Claude Code on this account to refresh it"
      : problem.kind === "rejected"
        ? `Login rejected (${problem.status})`
        : problem.detail;
  return { status: "unavailable", planLabel: null, windows: [], message };
}

async function readUsage(account: ClaudeAccount, force: boolean) {
  const cached = usageCache.get(account.id);
  if (!force && cached && Date.now() - cached.at < USAGE_TTL_MS) return cached.view;
  const [login] = await discoverFor(account);
  let view: Pick<AccountView, "email" | "usage">;
  if (!login) {
    view = {
      email: null,
      usage: { status: "unavailable", planLabel: null, windows: [], message: "Not logged in" },
    };
  } else {
    let usage: AccountView["usage"];
    try {
      usage = usageView(await fetchUsage(login.input as UsageInput));
    } catch (error) {
      usage = {
        status: "error",
        planLabel: null,
        windows: [],
        message: error instanceof Error ? error.message : String(error),
      };
    }
    view = { email: login.label ?? null, usage };
  }
  usageCache.set(account.id, { at: Date.now(), view });
  return view;
}

export async function listAccounts(options: { usage?: boolean; force?: boolean }) {
  const [accounts, active, family] = await Promise.all([
    claudeAccounts(),
    activeAccount(),
    claudeFamily(),
  ]);
  const views: AccountView[] = await Promise.all(
    accounts.map(async (account) => ({
      id: account.id,
      label: account.label,
      configDir: account.configDir,
      active: account.id === active?.id,
      ...(options.usage
        ? await readUsage(account, options.force ?? false)
        : { email: usageCache.get(account.id)?.view.email ?? null, usage: null }),
    })),
  );
  return { accounts: views, activeId: active?.id ?? null, providers: [...family] };
}

/** After a sign-in the cached "Not logged in" or "Login expired" is wrong. */
export function forgetUsage(accountId: string): void {
  usageCache.delete(accountId);
}

/** How many agent records, archived ones included, still name `provider` directly. */
async function agentsOnProvider(provider: string): Promise<number> {
  const root = join(paseoHome(), "agents");
  let count = 0;
  for (const directory of await readdir(root).catch(() => [] as string[])) {
    for (const file of await readdir(join(root, directory)).catch(() => [] as string[])) {
      if (!file.endsWith(".json")) continue;
      try {
        const record = JSON.parse(await readFile(join(root, directory, file), "utf8"));
        if (record?.provider === provider) count++;
      } catch {
        // Unreadable records are the daemon's business.
      }
    }
  }
  return count;
}

/**
 * Removes an account from the Paseo config. Only its provider entry goes: the login and the
 * config directory stay on disk, and the directory stays a transcript source so chats that ran
 * on it keep their history.
 */
export async function removeAccount(accountId: string): Promise<{ accountId: string }> {
  const account = (await claudeAccounts()).find((candidate) => candidate.id === accountId);
  if (!account) throw new Error(`No Claude account '${accountId}'`);
  if ((await activeAccount())?.id === accountId) {
    throw new Error("This account is in use. Switch to another account first.");
  }
  const stranded = await agentsOnProvider(accountId);
  if (stranded) {
    throw new Error(
      `${stranded} chat${stranded === 1 ? " is" : "s are"} still created on '${accountId}' and would stop opening. Point them at "claude" first.`,
    );
  }
  await cancelLogin(accountId).catch(() => {});
  await updateState((state) => ({
    ...state,
    retiredConfigDirs: [...new Set([...state.retiredConfigDirs, account.configDir])],
  }));
  await removeProvider(accountId);
  forgetUsage(accountId);
  return { accountId };
}
