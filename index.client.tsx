import type { PluginClientContext } from "@getpaseo/plugin/client";
import { makeAccountSettings } from "./client/AccountSettings.js";
import { startHeaderButtons } from "./client/header-button.js";
import { AccountsStore } from "./client/store.js";

// A function declaration, not `const contribute = …; export default contribute`: the host's
// bundle interop reads the default export eagerly, before a const would be assigned.
export default function contribute(client: PluginClientContext) {
  const store = new AccountsStore(client.rpc);
  const { AccountSettingsScreen } = makeAccountSettings(store);
  const cleanups = [
    store.start(),
    // Settings is the one place every client reaches, the mobile apps included. Usage shows
    // in Paseo's own usage bar, fed by the usage source the server side registers.
    client.addSettingsScreen({
      id: "accounts",
      title: "Claude account",
      icon: "UserRound",
      Component: AccountSettingsScreen,
    }),
    client.addCommandCenterItem({
      id: "open-accounts",
      title: "Claude account: switch, add or sign in",
      icon: "UserRound",
      keywords: ["claude", "account", "usage", "switch", "login", "sign in", "add"],
      context: "global",
      onSelect: (context) => context.openSettings("accounts"),
    }),
    startHeaderButtons(client, store),
  ];
  return () => {
    for (const cleanup of cleanups.reverse()) void cleanup();
  };
}
