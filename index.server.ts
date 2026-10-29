import type { PluginServerContext } from "@getpaseo/plugin/server";
import { inputSchema } from "./shared/input.js";
import {
  addAccountRpc,
  cancelLoginRpc,
  listAccountsRpc,
  loginStatusRpc,
  removeAccountRpc,
  startLoginRpc,
  submitLoginCodeRpc,
  switchAccountRpc,
} from "./shared/rpc.js";
import { discoverAccounts, newAccount } from "./server/accounts.js";
import { addProvider } from "./server/daemon.js";
import {
  cancelAllLogins,
  cancelLogin,
  loginStatus,
  onLoginSucceeded,
  startLogin,
  submitLoginCode,
} from "./server/login.js";
import {
  applyActiveAccount,
  forgetUsage,
  listAccounts,
  onAgentGone,
  onTurnEnded,
  removeAccount,
  switchAccount,
} from "./server/switcher.js";
import { fetchUsage } from "./server/usage.js";

export default function contribute(server: PluginServerContext) {
  server.registerUsageSource({
    id: "claude-accounts",
    label: "Claude accounts",
    icon: "icon.svg",
    input: inputSchema,
    discover: (scope) => discoverAccounts(scope),
    fetch: fetchUsage,
  });

  const cleanups = [
    server.before("agent.session_open", async ({ request }) => applyActiveAccount(request)),
    server.on("agent.turn_ended", ({ agent }) => onTurnEnded(agent.id)),
    server.on("agent.closed", ({ agent }) => onAgentGone(agent.id)),
    server.on("agent.archived", ({ agent }) => onAgentGone(agent.id)),
    onLoginSucceeded(forgetUsage),
    () => void cancelAllLogins(),
  ];

  server.handle(listAccountsRpc, (input) => listAccounts(input));
  server.handle(switchAccountRpc, ({ accountId }) => switchAccount(accountId));
  server.handle(addAccountRpc, async ({ name }) => {
    const account = await newAccount(name);
    await addProvider(account.id, {
      extends: "claude",
      label: account.label,
      enabled: false,
      env: { CLAUDE_CONFIG_DIR: account.configDir },
      // The same options as the hand-made accounts in the config.
      options: { extraArgs: { chrome: null } },
    });
    return { accountId: account.id, configDir: account.configDir };
  });
  server.handle(removeAccountRpc, ({ accountId }) => removeAccount(accountId));
  server.handle(startLoginRpc, ({ accountId }) => startLogin(accountId));
  server.handle(submitLoginCodeRpc, ({ accountId, code }) => submitLoginCode(accountId, code));
  server.handle(loginStatusRpc, ({ accountId }) => loginStatus(accountId));
  server.handle(cancelLoginRpc, ({ accountId }) => cancelLogin(accountId));

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
