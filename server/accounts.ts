// Claude accounts, one per Claude login configured in Paseo.
//
// An account is a provider in `agents.providers` that extends "claude" and sets its own
// CLAUDE_CONFIG_DIR. The provider may be disabled: disabling hides it from the model pickers,
// while this plugin keeps using its config directory as an account behind the one built-in
// "claude" provider. The account a session runs on is chosen in ./switcher.ts, not here.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { UsageAccount, UsageScope } from "@getpaseo/plugin/server/usage";
import { discover } from "./usage.js";
import { readState, updateState } from "./state.js";
import { liveAgents } from "./daemon.js";

const ProviderSchema = z
  .object({
    extends: z.string().optional(),
    label: z.string().optional(),
    enabled: z.boolean().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

const ConfigSchema = z
  .object({
    agents: z
      .object({ providers: z.record(z.string(), ProviderSchema).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface ClaudeAccount {
  /** The provider ID that defines the account. */
  id: string;
  label: string;
  configDir: string;
}

export function paseoHome(): string {
  return process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(path);
}

async function claudeProviderEntries(): Promise<Array<[string, z.infer<typeof ProviderSchema>]>> {
  try {
    const config = ConfigSchema.parse(
      JSON.parse(await readFile(join(paseoHome(), "config.json"), "utf8")),
    );
    return Object.entries(config.agents?.providers ?? {}).filter(
      ([, provider]) => provider.extends === "claude",
    );
  } catch (error) {
    console.warn({ err: error }, "Could not read Paseo config; no Claude accounts configured");
    return [];
  }
}

/** Every configured Claude login, in config order, enabled or not. */
export async function claudeAccounts(): Promise<ClaudeAccount[]> {
  return (await claudeProviderEntries()).flatMap(([id, provider]) => {
    const configDir = provider.env?.CLAUDE_CONFIG_DIR?.trim();
    return configDir ? [{ id, label: provider.label ?? id, configDir: expandHome(configDir) }] : [];
  });
}

/** Providers whose sessions run Claude Code: the built-in one and everything extending it. */
export async function claudeFamily(): Promise<Set<string>> {
  return new Set(["claude", ...(await claudeProviderEntries()).map(([id]) => id)]);
}

/** The account new and reopened Claude sessions run on. */
export async function activeAccount(): Promise<ClaudeAccount | null> {
  const accounts = await claudeAccounts();
  const { activeAccountId } = await readState();
  return accounts.find((account) => account.id === activeAccountId) ?? accounts[0] ?? null;
}

/** The daemon's own login, which chats created before this plugin may have run on. */
export function defaultConfigDir(): string {
  return expandHome(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"));
}

function processEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/**
 * Keep a login's identity while its token is expired or the profile call fails.
 *
 * The built-in discovery keys a login by account + organization only when the profile
 * resolves; otherwise it falls back to a hash of the credential route, which is a different
 * card in the usage dialog. Every resolved profile is remembered per config directory, and a
 * fallback is swapped for the remembered identity.
 */
async function withStableIdentity(configDir: string, found: UsageAccount[]): Promise<UsageAccount[]> {
  const resolved = found.find((usage) => usage.label);
  if (resolved?.label) {
    const { identities } = await readState();
    const known = identities[configDir];
    if (known?.key !== resolved.key || known.label !== resolved.label) {
      const identity = { key: resolved.key, label: resolved.label };
      await updateState((state) => ({
        ...state,
        identities: { ...state.identities, [configDir]: identity },
      }));
    }
    return found;
  }
  const remembered = (await readState()).identities[configDir];
  return remembered
    ? found.map((usage) => ({ ...usage, key: remembered.key, label: remembered.label }))
    : found;
}

/** Run the built-in Claude discovery as if a Claude session were running on `account`. */
export async function discoverFor(account: ClaudeAccount): Promise<UsageAccount[]> {
  const found = await discover({
    kind: "session",
    provider: "claude",
    env: { ...processEnv(), CLAUDE_CONFIG_DIR: account.configDir },
  });
  return withStableIdentity(account.configDir, found);
}

export async function discoverAccounts(scope: UsageScope): Promise<UsageAccount[]> {
  if (scope.kind === "session") {
    // The built-in source already covers sessions of the built-in "claude" provider. Chats
    // created on a per-account provider before the switch are covered here; their env carries
    // the CLAUDE_CONFIG_DIR this plugin chose, so the account follows the switch.
    if (scope.provider === "claude" || !(await claudeFamily()).has(scope.provider)) return [];
    const configDir = scope.env.CLAUDE_CONFIG_DIR;
    const found = await discover({ kind: "session", provider: "claude", env: scope.env });
    const accounts = configDir ? await withStableIdentity(expandHome(configDir), found) : found;
    const label = (await claudeAccounts()).find(
      (account) => configDir && account.configDir === expandHome(configDir),
    )?.label;
    return accounts.map((account) => ({ ...account, harness: label ?? "Claude" }));
  }

  // Two accounts pointing at the same login collapse into one entry; the key is the
  // account + organization once the profile resolves.
  const active = await activeAccount();
  const shown = await accountsWithLiveClaudeChats();
  const byKey = new Map<string, UsageAccount>();
  for (const account of await claudeAccounts()) {
    // Paseo's built-in Claude source already has a card for these, under its own source ID.
    if (shown.has(account.id)) continue;
    const harness = account.id === active?.id ? `${account.label} · active` : account.label;
    let found: UsageAccount[];
    try {
      found = await discoverFor(account);
    } catch (error) {
      // One unreadable login must not hide the others.
      console.warn({ err: error, accountId: account.id }, "Could not read the Claude login");
      continue;
    }
    for (const usage of found) {
      const existing = byKey.get(usage.key);
      byKey.set(
        usage.key,
        existing ? { ...existing, harness: `${existing.harness}, ${harness}` } : { ...usage, harness },
      );
    }
  }
  return [...byKey.values()];
}

/**
 * Accounts an open chat of the built-in "claude" provider runs on. The built-in usage source
 * lists those logins from the session itself, so listing them here too shows them twice.
 * Chats on a per-account provider are not covered by the built-in source and don't count.
 */
async function accountsWithLiveClaudeChats(): Promise<Set<string>> {
  try {
    const [agents, { agents: openedOn }] = await Promise.all([liveAgents(), readState()]);
    return new Set(
      agents.flatMap((agent) => {
        const accountId = agent.provider === "claude" ? openedOn[agent.id] : undefined;
        return accountId ? [accountId] : [];
      }),
    );
  } catch (error) {
    // Without the daemon, list every account rather than risk hiding one.
    console.warn({ err: error }, "Could not list open chats; showing every Claude account");
    return new Set();
  }
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The provider a new account needs: `claude-<name>` extending "claude", with its own
 * ~/.claude-<name> config directory. Disabled, so the pickers keep showing one Claude.
 */
export async function newAccount(name: string): Promise<ClaudeAccount> {
  const base = slug(name);
  if (!base) throw new Error("Use letters or digits in the account name");
  const id = `claude-${base}`;
  if ((await claudeAccounts()).some((account) => account.id === id)) {
    throw new Error(`An account named '${name}' already exists`);
  }
  return { id, label: `Claude (${name.trim()})`, configDir: join(homedir(), `.claude-${base}`) };
}
