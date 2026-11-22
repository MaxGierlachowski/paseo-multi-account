// Linux keeps a Claude login only in <CLAUDE_CONFIG_DIR>/.credentials.json (no Keychain).
// These tests run the plugin's credential, usage and switching paths as if on Linux, against
// temporary PASEO_HOME and CLAUDE_CONFIG_DIR folders holding FAKE credentials. Nothing here
// talks to the network: every API call goes to a stubbed fetch.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import { claudeAccounts, discoverAccounts, type ClaudeAccount } from "../server/accounts.js";
import { listAccounts, switchAccount } from "../server/switcher.js";
import { discover, fetchUsage } from "../server/usage.js";
import { credentialInputs, ensureFreshLogin, expiresAt } from "../server/warmup.js";
import type { UsageInput } from "../shared/input.js";

const HOUR = 60 * 60_000;
const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const realFetch = globalThis.fetch;
const savedEnv = { HOME: process.env.HOME, PASEO_HOME: process.env.PASEO_HOME };

let root: string;
let paseoHome: string;
let fetchCalls: string[];

/** A credentials file the way Claude Code writes it on Linux. The token is fake. */
function fakeCredentials(token: string, expiresAt: number) {
  return {
    claudeAiOauth: {
      accessToken: token,
      refreshToken: `${token}-refresh`,
      expiresAt,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_5x",
    },
  };
}

async function writeCredentials(configDir: string, content: unknown) {
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, ".credentials.json"),
    typeof content === "string" ? content : JSON.stringify(content),
    { mode: 0o600 },
  );
}

/** The stub answers per fake token, like the real profile and usage endpoints would. */
const profiles: Record<string, { uuid: string; email: string }> = {};

function stubFetch(mode: "ok" | "network-down" | "usage-500" = "ok") {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    fetchCalls.push(href);
    if (mode === "network-down") throw new TypeError("fetch failed");
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const profile = profiles[auth.replace(/^Bearer /, "")];
    if (!profile) return new Response("{}", { status: 401 });
    if (href.endsWith("/api/oauth/profile")) {
      return Response.json({
        account: { uuid: profile.uuid, email: profile.email },
        organization: { uuid: `org-${profile.uuid}` },
      });
    }
    if (href.endsWith("/api/oauth/usage")) {
      if (mode === "usage-500") return new Response("down", { status: 500 });
      return Response.json({
        five_hour: { utilization: 12, resets_at: "2030-01-01T05:00:00Z" },
        seven_day: { utilization: 40, resets_at: "2030-01-07T00:00:00Z" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function writePaseoConfig(providers: Record<string, unknown>) {
  await writeFile(
    join(paseoHome, "config.json"),
    JSON.stringify({ version: 1, agents: { providers } }, null, 2),
  );
}

function provider(slug: string, configDir: string) {
  return {
    extends: "claude",
    label: `Claude (${slug})`,
    enabled: false,
    env: { CLAUDE_CONFIG_DIR: configDir },
  };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "pma-linux-"));
  paseoHome = join(root, "paseo");
  await mkdir(paseoHome, { recursive: true });
  // Point every home the plugin might touch at the temp folder, never at the real one.
  process.env.HOME = join(root, "home");
  process.env.PASEO_HOME = paseoHome;
  Object.defineProperty(process, "platform", { ...realPlatform, value: "linux" });
  // The plugin logs every degraded read; the tests below provoke them on purpose.
  mock.method(console, "warn", () => {});
});

after(async () => {
  mock.restoreAll();
  Object.defineProperty(process, "platform", realPlatform);
  globalThis.fetch = realFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  fetchCalls = [];
  stubFetch("ok");
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("credential location on Linux", () => {
  test("the platform is simulated as linux", () => {
    assert.equal(process.platform, "linux");
  });

  test("warmup reads only <CLAUDE_CONFIG_DIR>/.credentials.json, never the Keychain", () => {
    const account: ClaudeAccount = { id: "claude-a", label: "A", configDir: "/srv/accounts/a" };
    assert.deepEqual(credentialInputs(account, "linux"), [
      { route: { store: "claude", path: "/srv/accounts/a/.credentials.json" } },
    ]);
    // macOS still looks in the Keychain first.
    assert.equal(credentialInputs(account, "darwin")[0]?.route.store, "keychain");
  });

  test("expiresAt reads the expiry from the file, null when there is no login", async () => {
    const configDir = join(root, "expiry");
    const account: ClaudeAccount = { id: "claude-x", label: "X", configDir };
    assert.equal(await expiresAt(account, "linux"), null);
    const expiry = Date.now() + 3 * HOUR;
    await writeCredentials(configDir, fakeCredentials("fake-token-expiry", expiry));
    assert.equal(await expiresAt(account, "linux"), expiry);
  });

  test("a fresh login needs no refresh, so no claude process is started", async () => {
    const configDir = join(root, "fresh");
    await writeCredentials(configDir, fakeCredentials("fake-token-fresh", Date.now() + 3 * HOUR));
    // Resolves without looking for a `claude` binary (none is installed in the test env).
    await ensureFreshLogin({ id: "claude-fresh", label: "Fresh", configDir });
  });

  test("a missing login refuses the switch with a clear message", async () => {
    await assert.rejects(
      ensureFreshLogin({ id: "claude-none", label: "None", configDir: join(root, "none") }),
      /not signed in/,
    );
  });

  test("session discovery resolves the account from the credentials file", async () => {
    const configDir = join(root, "discover");
    profiles["fake-token-discover"] = { uuid: "u-discover", email: "discover@example.com" };
    await writeCredentials(configDir, fakeCredentials("fake-token-discover", Date.now() + HOUR));
    const found = await discover(
      { kind: "session", provider: "claude", env: { CLAUDE_CONFIG_DIR: configDir, HOME: root } },
      { platform: "linux" },
    );
    assert.equal(found.length, 1);
    assert.equal(found[0]?.label, "discover@example.com");
    assert.deepEqual(found[0]?.input, {
      route: { store: "claude", path: join(configDir, ".credentials.json") },
      accountKey: "u-discover.org-u-discover",
    });
  });

  test("an expired login is still listed, without calling the profile API", async () => {
    const configDir = join(root, "expired");
    await writeCredentials(configDir, fakeCredentials("fake-token-expired", Date.now() - HOUR));
    const found = await discover(
      { kind: "session", provider: "claude", env: { CLAUDE_CONFIG_DIR: configDir, HOME: root } },
      { platform: "linux" },
    );
    assert.equal(found.length, 1);
    assert.equal(found[0]?.label, undefined);
    assert.deepEqual(fetchCalls, []);
    const report = await fetchUsage(found[0]!.input as UsageInput);
    assert.equal(report.status, "unavailable");
  });

  test("usage is read with the token from the file", async () => {
    const configDir = join(root, "usage");
    profiles["fake-token-usage"] = { uuid: "u-usage", email: "usage@example.com" };
    await writeCredentials(configDir, fakeCredentials("fake-token-usage", Date.now() + HOUR));
    const input: UsageInput = {
      route: { store: "claude", path: join(configDir, ".credentials.json") },
    };
    const report = await fetchUsage(input);
    assert.equal(report.status, "available");
    if (report.status !== "available") return;
    assert.equal(report.planLabel, "Max 5x");
    assert.deepEqual(
      report.windows.map((window) => [window.id, window.usedPct]),
      [
        ["five_hour", 12],
        ["weekly", 40],
      ],
    );
  });
});

describe("accounts from provider entries, on Linux", () => {
  let alpha: string;
  let beta: string;
  let broken: string;

  before(async () => {
    alpha = join(root, "accounts", "alpha");
    beta = join(root, "accounts", "beta");
    broken = join(root, "accounts", "broken");
    profiles["fake-token-alpha"] = { uuid: "u-alpha", email: "alpha@example.com" };
    await writeCredentials(alpha, fakeCredentials("fake-token-alpha", Date.now() + 3 * HOUR));
    await mkdir(beta, { recursive: true }); // beta has never signed in
    await writeCredentials(broken, "{ this is not json");
    await writePaseoConfig({
      "claude-alpha": provider("alpha", alpha),
      "claude-beta": provider("beta", beta),
      "claude-broken": provider("broken", broken),
      // Not accounts: another provider family, and a Claude provider without its own dir.
      "codex-extra": { extends: "codex", label: "Codex extra", enabled: true },
      "claude-nodir": { extends: "claude", label: "No dir", enabled: false },
    });
  });

  test("every provider extending claude with a CLAUDE_CONFIG_DIR is an account", async () => {
    assert.deepEqual(
      (await claudeAccounts()).map((account) => [account.id, account.configDir]),
      [
        ["claude-alpha", alpha],
        ["claude-beta", beta],
        ["claude-broken", broken],
      ],
    );
  });

  test("list shows every account; missing or invalid credentials read as not logged in", async () => {
    const { accounts, activeId } = await listAccounts({ usage: true, force: true });
    assert.equal(activeId, "claude-alpha"); // the first account until one is chosen
    const byId = Object.fromEntries(accounts.map((account) => [account.id, account]));
    assert.equal(byId["claude-alpha"]?.email, "alpha@example.com");
    assert.equal(byId["claude-alpha"]?.usage?.status, "available");
    assert.equal(byId["claude-alpha"]?.usage?.windows.length, 2);
    for (const id of ["claude-beta", "claude-broken"]) {
      assert.equal(byId[id]?.usage?.status, "unavailable", id);
      assert.equal(byId[id]?.usage?.message, "Not logged in", id);
    }
  });

  test("a network failure keeps every account listed, with the reason instead of usage", async () => {
    // A token the profile cache has not seen, so the profile call happens too.
    profiles["fake-token-alpha-2"] = { uuid: "u-alpha", email: "alpha@example.com" };
    await writeCredentials(alpha, fakeCredentials("fake-token-alpha-2", Date.now() + 3 * HOUR));
    stubFetch("network-down");
    const { accounts } = await listAccounts({ usage: true, force: true });
    assert.equal(accounts.length, 3);
    const alphaView = accounts.find((account) => account.id === "claude-alpha");
    assert.equal(alphaView?.usage?.status, "error");
    assert.equal(alphaView?.usage?.windows.length, 0);
    assert.match(alphaView?.usage?.message ?? "", /fetch failed/);
  });

  test("a failing usage API keeps the account listed and switchable", async () => {
    profiles["fake-token-alpha-3"] = { uuid: "u-alpha", email: "alpha@example.com" };
    await writeCredentials(alpha, fakeCredentials("fake-token-alpha-3", Date.now() + 3 * HOUR));
    stubFetch("usage-500");
    const { accounts } = await listAccounts({ usage: true, force: true });
    const alphaView = accounts.find((account) => account.id === "claude-alpha");
    assert.equal(alphaView?.email, "alpha@example.com");
    assert.equal(alphaView?.usage?.status, "error");
    assert.match(alphaView?.usage?.message ?? "", /500/);
  });

  test("the usage source lists signed-in accounts and skips the rest", async () => {
    stubFetch("network-down");
    const found = await discoverAccounts({ kind: "global" });
    // alpha's login exists (identity remembered from before); beta and broken have none.
    assert.equal(found.length, 1);
    assert.equal(found[0]?.label, "alpha@example.com");
  });

  test("switching works at config level without a reachable daemon", async () => {
    await writeCredentials(beta, fakeCredentials("fake-token-beta", Date.now() + 3 * HOUR));
    // No paseo.pid in the temp PASEO_HOME, so open chats cannot be listed; the switch holds.
    const result = await switchAccount("claude-beta");
    assert.deepEqual(result, { activeId: "claude-beta", reloaded: 0, deferred: 0, failed: [] });
    const state = JSON.parse(await readFile(join(paseoHome, "claude-accounts.json"), "utf8"));
    assert.equal(state.activeAccountId, "claude-beta");
    assert.equal((await listAccounts({})).activeId, "claude-beta");
  });

  test("switching to an account without a login is refused and keeps the active one", async () => {
    await assert.rejects(switchAccount("claude-broken"), /not signed in/);
    assert.equal((await listAccounts({})).activeId, "claude-beta");
    await assert.rejects(switchAccount("claude-unknown"), /Unknown Claude account/);
  });

  test("a missing or unreadable Paseo config means no accounts, not a crash", async () => {
    await writeFile(join(paseoHome, "config.json"), "{ not json");
    assert.deepEqual(await claudeAccounts(), []);
    assert.deepEqual((await listAccounts({ usage: true })).accounts, []);
    await rm(join(paseoHome, "config.json"));
    assert.deepEqual(await claudeAccounts(), []);
  });
});
