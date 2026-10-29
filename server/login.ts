// Signs a Claude account in (or back in) from Settings, without a terminal.
//
// Runs `claude auth login` with the account's CLAUDE_CONFIG_DIR. Claude Code opens the sign-in
// page in the daemon machine's browser and finishes on its own when that page redirects back;
// it also prints a manual URL whose page shows a code instead. Settings shows that URL and a
// field for the code, which is written to the process's stdin, so signing in works from any
// client, the mobile apps included. One login runs per account; starting another replaces it.
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type { LoginView } from "../shared/rpc.js";
import { claudeAccounts } from "./accounts.js";

interface LoginSession {
  child: ChildProcessWithoutNullStreams;
  view: LoginView;
  output: string;
  timer: ReturnType<typeof setTimeout>;
  changed: Set<() => void>;
}

/** A sign-in nobody finishes is stopped after this long. */
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const URL_WAIT_MS = 15_000;
const CODE_WAIT_MS = 30_000;

const sessions = new Map<string, LoginSession>();
const onSuccess = new Set<(accountId: string) => void>();

export function onLoginSucceeded(listener: (accountId: string) => void): () => void {
  onSuccess.add(listener);
  return () => onSuccess.delete(listener);
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The daemon may run without a login shell's PATH, so also try the usual install locations. */
async function claudeBinary(): Promise<string> {
  const home = homedir();
  const candidates = [
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    join(home, "brew", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ].map((dir) => join(dir, "claude"));
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  throw new Error("Claude Code is not installed: no `claude` binary found on PATH");
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "\n");
}

function idleView(accountId: string): LoginView {
  return { accountId, status: "idle", url: null, message: null };
}

/** The last meaningful line Claude Code printed, for showing a failure. */
function lastLine(output: string): string | null {
  // The verdict lands on the prompt's line: "Paste code here if prompted > Login failed: …".
  const lines = output
    .split("\n")
    .map((line) => line.replace(/^.*Paste code here if prompted >/, "").trim())
    .filter(Boolean);
  return lines.at(-1) ?? null;
}

function update(session: LoginSession, patch: Partial<LoginView>): void {
  session.view = { ...session.view, ...patch };
  for (const listener of session.changed) listener();
}

/** Resolves once `ready` holds for the session, it ends, or `ms` pass. */
function waitFor(session: LoginSession, ready: (view: LoginView) => boolean, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      session.changed.delete(check);
      resolve();
    };
    const check = () => {
      if (ready(session.view) || session.view.status === "succeeded" || session.view.status === "failed") done();
    };
    const timer = setTimeout(done, ms);
    session.changed.add(check);
    check();
  });
}

export async function startLogin(accountId: string): Promise<LoginView> {
  const account = (await claudeAccounts()).find((candidate) => candidate.id === accountId);
  if (!account) throw new Error(`Unknown Claude account '${accountId}'`);
  await cancelLogin(accountId);

  const child = spawnProcess(await claudeBinary(), ["auth", "login"], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: account.configDir },
    stdio: "pipe",
  });
  const session: LoginSession = {
    child,
    view: { accountId, status: "waiting", url: null, message: null },
    output: "",
    timer: setTimeout(() => {
      update(session, { status: "failed", message: "Sign-in timed out; start it again" });
      void terminateProcess(child);
    }, LOGIN_TIMEOUT_MS),
    changed: new Set(),
  };
  sessions.set(accountId, session);

  const read = (chunk: Buffer) => {
    session.output += stripAnsi(chunk.toString("utf8"));
    const url = /https:\/\/\S+\/oauth\/authorize\?\S+/.exec(session.output)?.[0] ?? null;
    if (url && url !== session.view.url) update(session, { url });
  };
  child.stdout.on("data", read);
  child.stderr.on("data", read);
  child.on("error", (error) => {
    clearTimeout(session.timer);
    update(session, { status: "failed", message: error.message });
  });
  child.on("close", (code) => {
    clearTimeout(session.timer);
    if (session.view.status === "failed") return;
    if (code === 0) {
      update(session, { status: "succeeded", url: null, message: lastLine(session.output) });
      for (const listener of onSuccess) listener(accountId);
    } else {
      update(session, {
        status: "failed",
        message: lastLine(session.output) ?? `claude auth login exited with ${code}`,
      });
    }
  });

  await waitFor(session, (view) => view.url !== null, URL_WAIT_MS);
  return session.view;
}

export async function submitLoginCode(accountId: string, code: string): Promise<LoginView> {
  const session = sessions.get(accountId);
  if (!session || session.view.status !== "waiting") {
    throw new Error("No sign-in is waiting for a code; start it again");
  }
  update(session, { status: "verifying", message: null });
  session.child.stdin.write(`${code.trim()}\n`);
  await waitFor(session, () => false, CODE_WAIT_MS);
  // No verdict yet: let the user try the code again rather than leave the form locked.
  if (loginStatus(accountId).status === "verifying") update(session, { status: "waiting" });
  return session.view;
}

export function loginStatus(accountId: string): LoginView {
  return sessions.get(accountId)?.view ?? idleView(accountId);
}

export async function cancelLogin(accountId: string): Promise<LoginView> {
  const session = sessions.get(accountId);
  if (!session) return idleView(accountId);
  sessions.delete(accountId);
  clearTimeout(session.timer);
  if (session.child.exitCode === null && session.child.signalCode === null) {
    session.view = { ...session.view, status: "failed", message: "Cancelled" };
    await terminateProcess(session.child).catch(() => {});
  }
  return idleView(accountId);
}

export async function cancelAllLogins(): Promise<void> {
  await Promise.all([...sessions.keys()].map((accountId) => cancelLogin(accountId)));
}
