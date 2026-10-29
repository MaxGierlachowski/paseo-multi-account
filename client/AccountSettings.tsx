// The account switcher as a settings screen (Settings → Plugins → Claude accounts). Built from
// the host's own settings components, so it looks like the rest of Settings and works on every
// client, including the mobile apps. Usage itself shows in Paseo's own usage bar; this screen
// switches accounts, adds and removes them, and signs them in again.
import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import {
  ExternalLink,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  type SettingsInputHandle,
} from "@getpaseo/plugin/client/ui";
import type { AccountView, LoginView } from "../shared/rpc.js";
import type { AccountsStore } from "./store.js";
import { shortName, switchResultMessage, usageDetail } from "./format.js";

type Colors = PluginTheme["colors"];

/** How often an open sign-in checks whether the browser finished it on its own. */
const LOGIN_POLL_MS = 2_000;

function ActiveBadge({ colors }: { colors: Colors }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <Icon name="Check" size={14} color={colors.accent} />
      <Text style={{ color: colors.accent, fontSize: 12, fontWeight: "600" }}>In use</Text>
    </View>
  );
}

function SmallButton({ colors, label, onPress, disabled, primary, danger }: {
  colors: Colors;
  label: string;
  onPress(): void;
  disabled?: boolean;
  primary?: boolean;
  /** Outlined in the danger colour, for removing. */
  danger?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={{
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 6,
        borderWidth: primary ? 0 : 1,
        borderColor: danger ? colors.statusDanger : colors.border,
        backgroundColor: primary ? colors.accent : "transparent",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text
        style={{
          color: primary ? colors.accentForeground : danger ? colors.statusDanger : colors.foreground,
          fontSize: 12,
          fontWeight: "600",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** Whether the account's login is missing or no longer accepted. */
function needsSignIn(account: AccountView): boolean {
  return account.usage?.status === "unavailable";
}

function LoginRows({ store, account, login, colors, onChange }: {
  store: AccountsStore;
  account: AccountView;
  login: LoginView;
  colors: Colors;
  onChange(view: LoginView | null): void;
}) {
  const toast = useToast();
  const code = useRef("");
  const input = useRef<SettingsInputHandle>(null);
  const name = shortName(account);
  const changed = useRef(onChange);
  changed.current = onChange;

  // The browser on the daemon's machine can finish the sign-in without a code; notice that.
  useEffect(() => {
    if (login.status !== "waiting") return;
    const timer = setInterval(() => {
      store
        .loginStatus(account.id)
        .then((view) => {
          if (view.status !== login.status || view.url !== login.url) changed.current(view);
        })
        .catch(() => {});
    }, LOGIN_POLL_MS);
    return () => clearInterval(timer);
  }, [store, account.id, login.status, login.url]);

  async function submit() {
    if (!code.current.trim()) return;
    onChange({ ...login, status: "verifying", message: null });
    try {
      onChange(await store.submitLoginCode(account.id, code.current));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      onChange({ ...login, status: "waiting" });
    }
    code.current = "";
    input.current?.replaceText("");
  }

  async function cancel() {
    await store.cancelLogin(account.id).catch(() => {});
    onChange(null);
  }

  if (login.status === "failed") {
    return (
      <SettingsAction
        label={`Signing in to ${name} failed`}
        error={login.message ?? "Unknown error"}
        actionLabel="Dismiss"
        onPress={() => onChange(null)}
      />
    );
  }

  const verifying = login.status === "verifying";
  return (
    <>
      <SettingsRow
        label={`Sign in to ${name}`}
        hint="A sign-in page opened in the browser on the computer running Paseo. Finish it there, or open the link on any device and paste the code it shows below."
      >
        {login.url ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <ExternalLink href={login.url}>Open sign-in page</ExternalLink>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Copy sign-in link"
              hitSlop={8}
              onPress={() =>
                void copyText(login.url!).then(
                  () => toast.show("Sign-in link copied", { variant: "success" }),
                  () => toast.error("Could not copy the link"),
                )
              }
            >
              <Icon name="Copy" size={14} color={colors.foregroundMuted} />
            </Pressable>
          </View>
        ) : (
          <ActivityIndicator size="small" color={colors.foregroundMuted} />
        )}
      </SettingsRow>
      <SettingsInput
        ref={input}
        label="Code"
        placeholder="Paste the code from the sign-in page"
        onChangeText={(text) => {
          code.current = text;
        }}
        disabled={verifying}
      />
      <SettingsRow label={verifying ? "Checking the code…" : ""}>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <SmallButton colors={colors} label="Cancel" onPress={() => void cancel()} />
          <SmallButton
            colors={colors}
            label="Submit code"
            primary
            disabled={verifying}
            onPress={() => void submit()}
          />
        </View>
      </SettingsRow>
    </>
  );
}

export function makeAccountSettings(store: AccountsStore) {
  function AccountSettingsScreen({ theme }: PluginSurfaceProps) {
    const { colors } = theme;
    const toast = useToast();
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const [switching, setSwitching] = useState<string | null>(null);
    const [logins, setLogins] = useState<Record<string, LoginView>>({});
    const [adding, setAdding] = useState(false);
    const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
    const [removing, setRemoving] = useState<string | null>(null);
    const newName = useRef("");
    const nameInput = useRef<SettingsInputHandle>(null);

    // Pick up a sign-in already running on the daemon, e.g. one started on another client.
    const accountIds = snapshot.accounts.map((account) => account.id).join("\n");
    useEffect(() => {
      for (const accountId of accountIds.split("\n").filter(Boolean)) {
        store
          .loginStatus(accountId)
          .then((view) => {
            if (view.status === "waiting" || view.status === "verifying") {
              setLogins((current) => ({ ...current, [accountId]: current[accountId] ?? view }));
            }
          })
          .catch(() => {});
      }
    }, [accountIds]);

    function setLogin(accountId: string, view: LoginView | null) {
      const keep = view && view.status !== "idle" && view.status !== "succeeded";
      setLogins((current) => {
        const next = { ...current };
        if (keep) next[accountId] = view;
        else delete next[accountId];
        return next;
      });
      if (view?.status === "succeeded") {
        const account = store.getSnapshot().accounts.find((candidate) => candidate.id === accountId);
        toast.show(`Signed in to ${account ? shortName(account) : accountId}`, { variant: "success" });
        void store.refresh({ usage: true, force: true });
      }
    }

    async function signIn(accountId: string) {
      setLogin(accountId, { accountId, status: "waiting", url: null, message: null });
      try {
        setLogin(accountId, await store.startLogin(accountId));
      } catch (error) {
        setLogin(accountId, {
          accountId,
          status: "failed",
          url: null,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    async function use(account: AccountView) {
      setSwitching(account.id);
      try {
        const result = await store.switchTo(account.id);
        toast.show(switchResultMessage(shortName(account), result), {
          variant: result.failed.length ? "warning" : "success",
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setSwitching(null);
      }
    }

    async function remove(account: AccountView) {
      setRemoving(account.id);
      try {
        await store.removeAccount(account.id);
        toast.show(`Removed ${shortName(account)}`, { variant: "success" });
        setConfirmRemove(null);
        setLogin(account.id, null);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setRemoving(null);
      }
    }

    async function add() {
      const name = newName.current.trim();
      if (!name) return;
      setAdding(true);
      try {
        const accountId = await store.addAccount(name);
        newName.current = "";
        nameInput.current?.replaceText("");
        await signIn(accountId);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setAdding(false);
      }
    }

    const refresh = (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Refresh usage"
        onPress={() => void store.refresh({ usage: true, force: true })}
        hitSlop={8}
      >
        {snapshot.loading ? (
          <ActivityIndicator size="small" color={colors.foregroundMuted} />
        ) : (
          <Icon name="RefreshCw" size={14} color={colors.foregroundMuted} />
        )}
      </Pressable>
    );

    return (
      <>
        <SettingsSection
          title="Claude account"
          info="Switching reopens open Claude chats on the chosen account and keeps their history. A chat that is mid-turn moves when its turn ends."
          trailing={refresh}
        >
          <SettingsCard>
            {snapshot.error ? <SettingsRow label="Could not load accounts" error={snapshot.error} /> : null}
            {snapshot.accounts.length === 0 && !snapshot.loading ? (
              <SettingsRow label="No Claude accounts yet" hint="Add one below." />
            ) : null}
            {snapshot.accounts.map((account) => {
              const subtitle = [account.email, account.usage?.planLabel].filter(Boolean).join(" · ");
              const hint = [subtitle, usageDetail(account)].filter(Boolean).join("\n");
              const login = logins[account.id];
              return (
                <Fragment key={account.id}>
                  <SettingsRow label={shortName(account)} hint={hint}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      {login ? null : (
                        <SmallButton
                          colors={colors}
                          label={needsSignIn(account) ? "Sign in" : "Sign in again"}
                          primary={needsSignIn(account)}
                          onPress={() => void signIn(account.id)}
                        />
                      )}
                      {account.active ? (
                        <ActiveBadge colors={colors} />
                      ) : (
                        <>
                          <SmallButton
                            colors={colors}
                            label="Use"
                            primary={!needsSignIn(account)}
                            disabled={switching !== null}
                            onPress={() => void use(account)}
                          />
                          <SmallButton
                            colors={colors}
                            label="Remove"
                            danger
                            disabled={removing !== null || confirmRemove === account.id}
                            onPress={() => setConfirmRemove(account.id)}
                          />
                        </>
                      )}
                    </View>
                  </SettingsRow>
                  {confirmRemove === account.id && !account.active ? (
                    <SettingsRow
                      label={`Remove ${shortName(account)}?`}
                      hint={`Removes it from the Paseo config. Its login and ${account.configDir} stay on disk, so chats that ran on it keep their history.`}
                    >
                      <View style={{ flexDirection: "row", gap: 8 }}>
                        <SmallButton
                          colors={colors}
                          label="Cancel"
                          disabled={removing !== null}
                          onPress={() => setConfirmRemove(null)}
                        />
                        <SmallButton
                          colors={colors}
                          label={removing === account.id ? "Removing…" : "Remove"}
                          danger
                          disabled={removing !== null}
                          onPress={() => void remove(account)}
                        />
                      </View>
                    </SettingsRow>
                  ) : null}
                  {login ? (
                    <LoginRows
                      store={store}
                      account={account}
                      login={login}
                      colors={colors}
                      onChange={(view) => setLogin(account.id, view)}
                    />
                  ) : null}
                </Fragment>
              );
            })}
          </SettingsCard>
        </SettingsSection>
        <SettingsSection
          title="Add account"
          info="Adds a Claude login with its own config directory (~/.claude-<name>) to the Paseo config, then signs it in. It stays out of the model pickers; switch to it here."
        >
          <SettingsCard>
            <SettingsInput
              ref={nameInput}
              label="Name"
              hint='Shown as "Claude (<name>)", e.g. Work or Personal'
              placeholder="Work"
              onChangeText={(text) => {
                newName.current = text;
              }}
              disabled={adding}
            />
            <SettingsAction
              label="Add and sign in"
              actionLabel={adding ? "Adding…" : "Add"}
              disabled={adding}
              onPress={() => void add()}
            />
          </SettingsCard>
        </SettingsSection>
      </>
    );
  }

  return { AccountSettingsScreen };
}
