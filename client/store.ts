// One account list per client, shared by the settings screen and the header buttons.
import type { PluginCommandCapabilities } from "@getpaseo/plugin/client";
import {
  addAccountRpc,
  cancelLoginRpc,
  listAccountsRpc,
  loginStatusRpc,
  removeAccountRpc,
  startLoginRpc,
  submitLoginCodeRpc,
  switchAccountRpc,
  type AccountView,
  type LoginView,
} from "../shared/rpc.js";

export interface AccountsSnapshot {
  accounts: AccountView[];
  activeId: string | null;
  providers: string[];
  loading: boolean;
  error: string | null;
}

export interface SwitchResult {
  activeId: string;
  reloaded: number;
  deferred: number;
  failed: string[];
}

const USAGE_REFRESH_MS = 5 * 60_000;

export class AccountsStore {
  private snapshot: AccountsSnapshot = {
    accounts: [],
    activeId: null,
    providers: [],
    loading: true,
    error: null,
  };
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly rpc: PluginCommandCapabilities["rpc"]) {}

  start(): () => void {
    void this.refresh({ usage: true });
    this.timer = setInterval(() => void this.refresh({ usage: true }), USAGE_REFRESH_MS);
    return () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.listeners.clear();
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AccountsSnapshot => this.snapshot;

  active(): AccountView | null {
    return this.snapshot.accounts.find((account) => account.id === this.snapshot.activeId) ?? null;
  }

  async refresh(options: { usage?: boolean; force?: boolean } = {}): Promise<void> {
    this.set({ loading: true });
    try {
      const result = await this.rpc(listAccountsRpc, options);
      // A list without usage keeps the usage already shown rather than blanking the bars.
      const previous = new Map(this.snapshot.accounts.map((account) => [account.id, account]));
      const accounts = result.accounts.map((account) =>
        account.usage || !previous.get(account.id)
          ? account
          : { ...account, usage: previous.get(account.id)!.usage },
      );
      this.set({ ...result, accounts, loading: false, error: null });
    } catch (error) {
      this.set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async switchTo(accountId: string): Promise<SwitchResult> {
    // Show the choice at once; the daemon side reloads chats in the background of this call.
    this.set({
      activeId: accountId,
      accounts: this.snapshot.accounts.map((account) => ({ ...account, active: account.id === accountId })),
    });
    try {
      return await this.rpc(switchAccountRpc, { accountId });
    } finally {
      await this.refresh();
    }
  }

  /** Adds the account's provider to the Paseo config and returns its ID. */
  async addAccount(name: string): Promise<string> {
    const { accountId } = await this.rpc(addAccountRpc, { name });
    await this.refresh();
    return accountId;
  }

  /** Removes a non-active account from the Paseo config; its login and folder stay. */
  async removeAccount(accountId: string): Promise<void> {
    try {
      await this.rpc(removeAccountRpc, { accountId });
    } finally {
      await this.refresh();
    }
  }

  startLogin(accountId: string): Promise<LoginView> {
    return this.rpc(startLoginRpc, { accountId });
  }

  submitLoginCode(accountId: string, code: string): Promise<LoginView> {
    return this.rpc(submitLoginCodeRpc, { accountId, code });
  }

  loginStatus(accountId: string): Promise<LoginView> {
    return this.rpc(loginStatusRpc, { accountId });
  }

  cancelLogin(accountId: string): Promise<LoginView> {
    return this.rpc(cancelLoginRpc, { accountId });
  }

  private set(patch: Partial<AccountsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}
