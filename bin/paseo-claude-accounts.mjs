#!/usr/bin/env node
// Drives the Claude accounts plugin from a shell or another program, through the local Paseo
// daemon: the same RPCs the Settings screen uses, so adding, switching, removing and signing in
// accounts works without the app. Connects like the paseo CLI does for a local daemon: the
// address from $PASEO_HOME/paseo.pid and the local credential from $PASEO_HOME/local-credential.
// Prints JSON on stdout; errors go to stderr with exit code 1.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const USAGE = `Usage: paseo-claude-accounts [--home <dir>] [--plugin <id>] <command>

Commands:
  list [--usage] [--force]                   Accounts, the active one, and optionally usage
  add <name> [--id <id>] [--config-dir <dir>] Add an account (provider entry + config dir)
  switch <id>                                Make <id> the account Claude sessions run on
  remove <id>                                Remove a non-active account's provider entry
  login start <id>                           Start \`claude auth login\`; prints the sign-in URL
  login code <id>                            Send the code shown after sign-in (read from stdin)
  login status <id>                          State of the running sign-in
  login cancel <id>                          Stop the running sign-in

Options:
  --home <dir>    Paseo home (default: $PASEO_HOME or ~/.paseo)
  --plugin <id>   Runtime plugin ID (default: claude-accounts-usage)`;

function parse(argv) {
  const options = {};
  const positional = [];
  const flags = new Set(["usage", "force", "help"]);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "-h") options.help = true;
    else if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2);
      if (flags.has(key)) options[key] = true;
      else {
        const value = inline ?? argv[++index];
        if (value === undefined) throw new Error(`--${key} needs a value`);
        options[key] = value;
      }
    } else positional.push(arg);
  }
  return { options, positional };
}

async function readStdin() {
  if (process.stdin.isTTY) process.stderr.write("Code: ");
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
    if (data.includes("\n")) break;
  }
  return data.split("\n")[0].trim();
}

/** The RPC method and input for a command line. */
async function request(positional, options) {
  const [command, ...rest] = positional;
  const need = (value, what) => {
    if (!value) throw new Error(`Missing ${what}\n\n${USAGE}`);
    return value;
  };
  switch (command) {
    case "list":
      return ["accounts.list", { usage: options.usage === true, force: options.force === true }];
    case "add":
      return [
        "accounts.add",
        {
          name: need(rest[0], "account name"),
          ...(options.id ? { id: options.id } : {}),
          ...(options["config-dir"] ? { configDir: options["config-dir"] } : {}),
        },
      ];
    case "switch":
      return ["accounts.switch", { accountId: need(rest[0], "account ID") }];
    case "remove":
      return ["accounts.remove", { accountId: need(rest[0], "account ID") }];
    case "login": {
      const [action, accountId] = rest;
      need(accountId, "account ID");
      if (action === "code") {
        // From stdin, so the code never shows up in a process list or shell history.
        const code = await readStdin();
        return ["accounts.login.code", { accountId, code: need(code, "code on stdin") }];
      }
      if (["start", "status", "cancel"].includes(action)) {
        return [`accounts.login.${action}`, { accountId }];
      }
      throw new Error(`Unknown login action '${action ?? ""}'\n\n${USAGE}`);
    }
    default:
      throw new Error(command ? `Unknown command '${command}'\n\n${USAGE}` : USAGE);
  }
}

async function connect(home) {
  let listen;
  try {
    ({ listen } = JSON.parse(await readFile(join(home, "paseo.pid"), "utf8")));
  } catch {
    throw new Error(`No running Paseo daemon found in ${home} (paseo.pid is missing)`);
  }
  if (typeof listen !== "string" || listen.startsWith("/") || listen.includes("://")) {
    throw new Error(`Daemon listens on ${listen}; only host:port is supported`);
  }
  const token = (await readFile(join(home, "local-credential"), "utf8")).trim();
  const client = new DaemonClient({
    url: `ws://${listen}/ws`,
    clientId: "paseo-claude-accounts-cli",
    clientType: "cli",
    localCredential: () => token,
    reconnect: { enabled: false },
    connectTimeoutMs: 5_000,
  });
  await client.connect();
  return client;
}

async function main() {
  const { options, positional } = parse(process.argv.slice(2));
  if (options.help || positional.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const [method, input] = await request(positional, options);
  const home = options.home || process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
  const client = await connect(home);
  try {
    const output = await client.invokePluginRpc(
      options.plugin || "claude-accounts-usage",
      method,
      input,
    );
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    await client.close().catch(() => {});
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
