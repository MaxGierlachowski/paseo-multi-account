// Refreshes an account's login once, before chats move onto it.
//
// Claude Code refresh tokens are single-use. Switching reloads every idle chat at once, and on
// an account whose access token has expired each new Claude process would refresh with the
// same refresh token; the losers get the token rejected and Claude Code then deletes the login.
// So before a switch, one Claude Code process refreshes the token (`claude -p /cost` runs a
// local command and spends no quota), and the chats that reload afterwards find it fresh.
// The plugin still never writes credentials itself; Claude Code does.
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type { ClaudeAccount } from "./accounts.js";
import { claudeBinary } from "./login.js";
import { claudeKeychainAccount, resolveClaudeCredentials } from "./usage.js";
import type { UsageInput } from "../shared/input.js";
import { hashAccountKey } from "@getpaseo/plugin/server/usage";
import { join } from "node:path";

/** Refresh when the access token has this little time left. */
const REFRESH_MARGIN_MS = 5 * 60_000;
const REFRESH_TIMEOUT_MS = 60_000;

/** Where the account's login may live, the same way the built-in usage source looks for it. */
function credentialInputs(account: ClaudeAccount): UsageInput[] {
  const file: UsageInput = {
    route: { store: "claude", path: join(account.configDir, ".credentials.json") },
  };
  if (process.platform !== "darwin") return [file];
  const suffix = hashAccountKey(account.configDir.normalize("NFC")).slice(0, 8);
  return [
    {
      route: {
        store: "keychain",
        service: `Claude Code-credentials-${suffix}`,
        account: claudeKeychainAccount(),
      },
    },
    file,
  ];
}

/** null: no login at all; undefined: a login without an expiry. */
async function expiresAt(account: ClaudeAccount): Promise<number | null | undefined> {
  for (const input of credentialInputs(account)) {
    const credentials = await resolveClaudeCredentials(input);
    if (credentials) return credentials.expires;
  }
  return null;
}

function runRefresh(account: ClaudeAccount, binary: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(binary, ["-p", "/cost"], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: account.configDir },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      void terminateProcess(child);
      reject(new Error(`Refreshing the ${account.label} login timed out`));
    }, REFRESH_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const running = new Map<string, Promise<void>>();

/**
 * Makes sure `account` has a usable access token. Throws when the account has no login, or
 * when Claude Code's refresh was rejected (Claude Code then removed the login).
 */
export function ensureFreshLogin(account: ClaudeAccount): Promise<void> {
  const pending = running.get(account.id);
  if (pending) return pending;
  const work = (async () => {
    const before = await expiresAt(account);
    if (before === null) throw new Error(`${account.label} is not signed in. Sign it in first.`);
    if (before === undefined || before - Date.now() > REFRESH_MARGIN_MS) return;
    await runRefresh(account, await claudeBinary());
    const after = await expiresAt(account);
    if (after === null || (after !== undefined && after <= Date.now())) {
      throw new Error(`${account.label}'s login could not be refreshed. Sign it in again.`);
    }
  })();
  running.set(account.id, work);
  void work.finally(() => running.delete(account.id)).catch(() => {});
  return work;
}
