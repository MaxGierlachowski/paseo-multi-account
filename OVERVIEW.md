One Claude provider in the model pickers, any number of Claude logins behind it, and a switch for which login the next message goes out on. When one account runs out, switch and keep going in the same chat.

## Setup

Each account is a provider in `agents.providers` (`~/.paseo/config.json`, or `$PASEO_HOME/config.json`) that extends `claude` and sets its own `CLAUDE_CONFIG_DIR`. Set `"enabled": false` on these so the pickers show only the built-in **Claude** provider with each model once:

```json
"claude-work": {
  "extends": "claude",
  "label": "Claude (Work)",
  "enabled": false,
  "env": { "CLAUDE_CONFIG_DIR": "/Users/<you>/.claude-work" },
  "options": { "extraArgs": { "chrome": null } }
}
```

A disabled provider gets no client in Paseo 0.13.2, so chats created on it before stop opening: point their records in `$PASEO_HOME/agents/` at `"provider": "claude"` (top level, `runtimeInfo` and `persistence`) and they follow the switch like any other Claude chat. Installed plugins only run with `"pluginsEnabled": true`.

The easier way is **Settings → Plugins → Claude accounts → Add account**: give it a name ("Work") and it adds `claude-work` as above, with `~/.claude-work` as its config directory, through the daemon (which writes the config and reloads it), then starts signing it in.

## Signing in

Every account row has **Sign in** (when its login is missing or expired) or **Sign in again**. Either one runs `claude auth login` on the daemon's machine with that account's `CLAUDE_CONFIG_DIR`:

- Claude Code opens the sign-in page in that machine's browser. Finishing it there completes the login by itself; Settings notices within a couple of seconds.
- Settings also shows the manual sign-in link (open or copy it on any device, the phone included) and a **Code** field for the code that page shows.

One sign-in runs per account; starting it again replaces it, and one nobody finishes stops after 10 minutes. A wrong code shows Claude Code's own error. `server/login.ts` holds this.

## Removing

Every account that is not in use has **Remove** in Settings → Plugins → Claude accounts, behind a confirmation. It is not in the header menu, which only switches. Removing:

- refuses the account in use (switch first), and refuses while any chat record in `$PASEO_HOME/agents/` still names its provider directly, since that chat would stop opening;
- takes only the provider entry out of the Paseo config, through the daemon (`removeProviders`), which writes the config and reloads it;
- leaves the login and the config directory on disk, and keeps that directory in `retiredConfigDirs` in `claude-accounts.json`, so chats that ran on it still find their transcript when they reopen.

Adding the same name again reuses `~/.claude-<name>`, so the old login is still there; the sign-in that **Add** starts can then be cancelled.

## Switching

- **Settings → Plugins → Claude accounts → Claude account** lists each account with its usage and a **Use** button. It is built from the host's settings components and is the entry point that works on every client, including the mobile apps. The command center item "Claude account: switch, add or sign in" opens it.
- **A header button in every workspace with a Claude chat** shows the active account and opens a Paseo menu with one entry per account and its usage; picking one switches. It only switches: adding an account and signing in stay in Settings (an account that needs signing in is greyed out). Being a host menu, it looks exactly like Paseo's own menus. On narrow layouts it sits in the "…" overflow menu. A menu gives no toast, so the label changing to the new account is the confirmation; chats that fail to reload are logged to the console.
- **Paseo's own usage bar and dialog** list every login and marks the active one ("· active"). Paseo's usage dialog has no plugin extension point for buttons, so the switch itself lives in the places above.

Switching is global. Every open Claude chat on another account is reloaded: idle chats immediately, and chats that are mid-turn or waiting on a permission once that turn ends. A reload is Paseo's own "Reload agent": it closes the Claude process and resumes the same conversation, so the next message runs on the new account with the whole history. Chats that aren't open pick the active account up when they next open, and so do new chats.

## How it works

- `before("agent.session_open")` sets `CLAUDE_CONFIG_DIR` to the active account for every Claude-family session (`claude` and every provider extending it). Paseo applies the launch env after the provider's own env, so this wins.
- Claude Code stores a conversation under the login that ran it (`<CLAUDE_CONFIG_DIR>/projects/<cwd>/<session>.jsonl`, the `<session>/` folder beside it, and `file-history/<session>/`). Before a session reopens, the newest copy of that one session is copied into the target account; sources are never modified. The session ID comes from the agent's record in `$PASEO_HOME/agents/`.
- The plugin SDK cannot reopen a session, so reloads go through a loopback connection to the daemon with the local credential in `$PASEO_HOME/local-credential`, the way the `paseo` CLI connects (`server/daemon.ts`).
- State (the active account, the account each chat's live session was opened on, and the config directories of removed accounts) lives in `$PASEO_HOME/claude-accounts.json`. With no state, the first account in the config is active.

Usage and credentials are read the same way as the built-in source (macOS Keychain entry keyed to the config directory, falling back to `<CLAUDE_CONFIG_DIR>/.credentials.json`); the plugin itself never writes them, only `claude auth login` does. The plugin no longer draws its own usage bars: Paseo's native usage bar shows the usage source the server side registers. The settings screen caches usage for two minutes because the usage endpoint rate-limits hard.

`server/usage.ts`, `server/stores.ts` and `shared/input.ts` are copied unchanged from the built-in plugin of Paseo 0.12.0. Re-copy them after a Paseo update that changes the built-in source. `server/daemon.ts` uses `@getpaseo/client/internal/daemon-client` (reloads and `patchDaemonConfig` for new accounts), which is internal API: re-check it after a Paseo update.
