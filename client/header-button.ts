// A header button in every workspace with a Claude chat, showing the active account. It opens a
// host menu with one entry per account, so switching looks exactly like the rest of Paseo.
// Adding accounts and signing in stay in Settings → Plugins → Claude accounts.
import type { PaseoApi } from "@getpaseo/client";
import type {
  PluginButton,
  PluginButtonMenuEntry,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import type { AccountView } from "../shared/rpc.js";
import type { AccountsStore } from "./store.js";
import { shortName, usageSummary } from "./format.js";

type AgentSnapshot = Awaited<ReturnType<PaseoApi["agents"]["list"]>>["entries"][number]["agent"];

// The host only accepts button ids matching /^[a-z][a-z0-9-]*$/; workspace ids are `wks_…`.
function buttonId(key: string): string {
  return `claude-account-${key.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
}

interface ChatRef {
  workspaceId: string;
  provider: string;
}

export function startHeaderButtons(client: PluginClientContext, store: AccountsStore): () => void {
  const chats = new Map<string, ChatRef>();
  // One header button per workspace that holds a Claude chat.
  const headers = new Map<string, PluginButtonRegistration>();
  let disposed = false;

  function menuEntry(account: AccountView): PluginButtonMenuEntry {
    const signedOut = account.usage?.status === "unavailable";
    const detail = signedOut ? "sign in via Settings" : usageSummary(account);
    return {
      kind: "item",
      id: buttonId(account.id),
      title: detail ? `${shortName(account)} · ${detail}` : shortName(account),
      icon: account.active ? "Check" : undefined,
      disabled: account.active || signedOut,
      behavior: {
        kind: "action",
        onPress: () =>
          store.switchTo(account.id).then(
            (result) => {
              if (result.failed.length) console.warn("Claude accounts: could not reload", result.failed);
            },
            (error) => console.warn("Claude accounts: switch failed", error),
          ),
      },
    };
  }

  function headerButton(): PluginButton {
    const { accounts } = store.getSnapshot();
    const active = store.active();
    return {
      title: active ? `Claude account: ${shortName(active)}` : "Claude account",
      icon: "UserRound",
      label: active ? shortName(active) : undefined,
      visible: accounts.length > 1,
      behavior: { kind: "menu", items: accounts.map(menuEntry) },
    };
  }

  function sync(): void {
    if (disposed) return;
    const family = new Set(store.getSnapshot().providers);
    const workspaces = new Set(
      [...chats.values()].filter((chat) => family.has(chat.provider)).map((chat) => chat.workspaceId),
    );
    for (const [workspaceId, header] of headers) {
      if (!workspaces.has(workspaceId)) {
        header.remove();
        headers.delete(workspaceId);
      }
    }
    const next = headerButton();
    for (const workspaceId of workspaces) {
      const existing = headers.get(workspaceId);
      if (existing) existing.update(next);
      else headers.set(workspaceId, client.addHeaderButton({ id: buttonId(workspaceId), workspaceId, button: next }));
    }
  }

  function track(agent: AgentSnapshot): void {
    if (agent.archivedAt || !agent.workspaceId) {
      chats.delete(agent.id);
      return;
    }
    chats.set(agent.id, { workspaceId: agent.workspaceId, provider: agent.provider });
  }

  const unsubscribeStore = store.subscribe(sync);
  const unsubscribeAgents = client.paseo.agents.subscribe((update) => {
    if (update.kind === "upsert") track(update.agent);
    else chats.delete(update.agentId);
    sync();
  });

  let release: (() => Promise<void>) | null = null;
  client.paseo.agents
    .list({ subscribe: {} })
    .then((result) => {
      release = () => result.subscription.release();
      if (disposed) void release();
      for (const { agent } of result.entries) track(agent);
      sync();
    })
    .catch((error) => console.warn("Claude accounts: could not list chats", error));

  return () => {
    disposed = true;
    unsubscribeStore();
    unsubscribeAgents();
    void release?.();
    for (const registration of headers.values()) registration.remove();
    headers.clear();
  };
}
