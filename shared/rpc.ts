// Contracts between the client UI (account switcher) and the daemon side.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const UsageWindowViewSchema = z.object({
  id: z.string(),
  label: z.string(),
  shortLabel: z.string().nullable(),
  usedPct: z.number().nullable(),
  resetsAt: z.string().nullable(),
});

const UsageViewSchema = z.object({
  status: z.enum(["available", "unavailable", "error"]),
  planLabel: z.string().nullable(),
  windows: z.array(UsageWindowViewSchema),
  message: z.string().nullable(),
});

export const AccountViewSchema = z.object({
  id: z.string(),
  label: z.string(),
  configDir: z.string(),
  email: z.string().nullable(),
  active: z.boolean(),
  usage: UsageViewSchema.nullable(),
});

export type AccountView = z.infer<typeof AccountViewSchema>;
export type UsageWindowView = z.infer<typeof UsageWindowViewSchema>;

export const listAccountsRpc = defineRpc({
  name: "accounts.list",
  input: z.object({ usage: z.boolean().optional(), force: z.boolean().optional() }),
  output: z.object({
    accounts: z.array(AccountViewSchema),
    activeId: z.string().nullable(),
    /** Provider IDs whose chats run on the active account. */
    providers: z.array(z.string()),
  }),
});

export const switchAccountRpc = defineRpc({
  name: "accounts.switch",
  input: z.object({ accountId: z.string().min(1) }),
  output: z.object({
    activeId: z.string(),
    /** Idle chats reopened on the new account right away. */
    reloaded: z.number(),
    /** Busy chats that move over when their current turn ends. */
    deferred: z.number(),
    failed: z.array(z.string()),
  }),
});

export const AddAccountInputSchema = z.object({
  /** Shown as "Claude (<name>)"; also the source of the provider ID and config directory. */
  name: z.string().trim().min(1).max(40),
});

export const addAccountRpc = defineRpc({
  name: "accounts.add",
  input: AddAccountInputSchema,
  output: z.object({ accountId: z.string(), configDir: z.string() }),
});

/** Removes a non-active account from the Paseo config. Its login and config directory stay. */
export const removeAccountRpc = defineRpc({
  name: "accounts.remove",
  input: z.object({ accountId: z.string().min(1) }),
  output: z.object({ accountId: z.string() }),
});

export const LoginViewSchema = z.object({
  accountId: z.string(),
  status: z.enum(["idle", "waiting", "verifying", "succeeded", "failed"]),
  /** The sign-in page; open it in any browser, then paste the code it shows. */
  url: z.string().nullable(),
  message: z.string().nullable(),
});

export type LoginView = z.infer<typeof LoginViewSchema>;

const AccountIdInput = z.object({ accountId: z.string().min(1) });

export const startLoginRpc = defineRpc({
  name: "accounts.login.start",
  input: AccountIdInput,
  output: LoginViewSchema,
});

export const submitLoginCodeRpc = defineRpc({
  name: "accounts.login.code",
  input: AccountIdInput.extend({ code: z.string().trim().min(1) }),
  output: LoginViewSchema,
});

export const loginStatusRpc = defineRpc({
  name: "accounts.login.status",
  input: AccountIdInput,
  output: LoginViewSchema,
});

export const cancelLoginRpc = defineRpc({
  name: "accounts.login.cancel",
  input: AccountIdInput,
  output: LoginViewSchema,
});
