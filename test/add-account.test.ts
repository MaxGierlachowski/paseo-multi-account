// The add-account contract external callers (such as agentbox) rely on.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, mock, test } from "node:test";
import { newAccount } from "../server/accounts.js";
import { AddAccountInputSchema } from "../shared/rpc.js";

const saved = { HOME: process.env.HOME, PASEO_HOME: process.env.PASEO_HOME };
let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "pma-add-"));
  process.env.HOME = join(root, "home");
  process.env.PASEO_HOME = join(root, "paseo");
  await mkdir(process.env.PASEO_HOME, { recursive: true });
  await writeFile(
    join(process.env.PASEO_HOME, "config.json"),
    JSON.stringify({
      agents: {
        providers: {
          "claude-work": {
            extends: "claude",
            label: "Claude (Work)",
            enabled: false,
            env: { CLAUDE_CONFIG_DIR: "/srv/accounts/work" },
          },
        },
      },
    }),
  );
  mock.method(console, "warn", () => {});
});

after(async () => {
  mock.restoreAll();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

test("by default an account is claude-<name> in ~/.claude-<name>", async () => {
  assert.deepEqual(await newAccount("Side Project"), {
    id: "claude-side-project",
    label: "Claude (Side Project)",
    configDir: join(root, "home", ".claude-side-project"),
  });
});

test("a caller can choose the provider ID and the config directory", async () => {
  assert.deepEqual(
    await newAccount("Personal", { id: "personal", configDir: "/srv/accounts/personal" }),
    { id: "personal", label: "Claude (Personal)", configDir: "/srv/accounts/personal" },
  );
});

test("IDs and directories already in use are refused", async () => {
  await assert.rejects(newAccount("Work"), /already exists/);
  await assert.rejects(
    newAccount("Other", { id: "other", configDir: "/srv/accounts/work" }),
    /already uses/,
  );
});

test("the RPC input only accepts Paseo provider IDs and absolute directories", () => {
  const ok = AddAccountInputSchema.safeParse({ name: "A", id: "acct-2", configDir: "/x/y" });
  assert.equal(ok.success, true);
  for (const id of ["2acct", "Acct", "acct_2", "claude", "codex"]) {
    assert.equal(AddAccountInputSchema.safeParse({ name: "A", id }).success, false, id);
  }
  assert.equal(AddAccountInputSchema.safeParse({ name: "A", configDir: "rel/dir" }).success, false);
});
