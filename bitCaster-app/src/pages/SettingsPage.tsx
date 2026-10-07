import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { Settings } from "@/components/settings/Settings";
import { WalletSetupModal } from "@/components/shared/WalletSetupModal";
import { useWalletStore, DEFAULT_MINT_URL } from "@/stores/wallet";
import { useSettingsStore } from "@/stores/settings";
import { useToastStore } from "@/stores/toast";
import { detectMintCapabilities, getMintIconUrl } from "@/lib/mints";
import { requestNotificationPermission } from "@/lib/webNotifications";
import {
  disconnectNostrIdentity,
  refreshNostrProfile,
  userConnectNostrSignerMode,
  userConnectNsecIdentity,
} from "@/lib/identityOps";
import {
  userAddAndSelectMint,
  userAddRelay,
  userRemoveMint,
  userRemoveRelay,
} from "@/lib/walletOps";
import type {
  SettingsState,
  MintConfig,
  NostrSignerMode,
  SettingsCategory,
  ThemeOption,
} from "@/types/settings";

const VALID_CATEGORIES: readonly SettingsCategory[] = ["general", "cashu", "nostr"];

function isValidCategory(value: string | null): value is SettingsCategory {
  return value !== null && (VALID_CATEGORIES as readonly string[]).includes(value);
}

const APP_VERSION = "0.1.0";

export function SettingsPage() {
  const { t } = useTranslation();
  const walletStore = useWalletStore();
  const settingsStore = useSettingsStore();
  const navigate = useNavigate();
  // Subscribe to the setter via a selector so we get the stable reference
  // zustand guarantees for actions — avoids re-running the deep-link effect
  // on every unrelated settings-store update.
  const openCategory = useSettingsStore((s) => s.openCategory);
  const [searchParams] = useSearchParams();
  const [walletDialog, setWalletDialog] = useState<{
    mode: "setup" | "replace";
    generation: number;
  } | null>(null);
  const [isWalletActionPending, setIsWalletActionPending] = useState(false);
  const [walletDialogError, setWalletDialogError] = useState<string | null>(null);
  const walletDialogGeneration = useRef(0);
  const walletActionGeneration = useRef<number | null>(null);
  useEffect(
    () => () => {
      walletDialogGeneration.current += 1;
    },
    [],
  );

  // Allow other parts of the app (e.g. the market creation wizard) to
  // deep-link to a specific category via /settings?category=nostr. Use
  // `openCategory` (non-toggling) rather than `setActiveCategory`, because
  // StrictMode double-invokes effects and a toggle cancels itself.
  useEffect(() => {
    const categoryParam = searchParams.get("category");
    if (isValidCategory(categoryParam)) {
      openCategory(categoryParam);
    }
  }, [searchParams, openCategory]);

  useEffect(() => {
    let robotsMeta = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const previousContent = robotsMeta?.content ?? null;
    const created = !robotsMeta;
    if (!robotsMeta) {
      robotsMeta = document.createElement("meta");
      robotsMeta.name = "robots";
      document.head.appendChild(robotsMeta);
    }
    robotsMeta.content = "noindex";
    return () => {
      if (created) {
        robotsMeta?.remove();
      } else if (robotsMeta && previousContent !== null) {
        robotsMeta.content = previousContent;
      }
    };
  }, []);

  // Map wallet mints → MintConfig[]
  const mintConfigs: MintConfig[] = walletStore.mints.map((m) => {
    const info = m.info as Record<string, unknown> | undefined;
    const { ctf } = detectMintCapabilities(info);
    return {
      url: m.url,
      name: info?.name as string | undefined,
      iconUrl: getMintIconUrl(m.url, info),
      isDefault: m.url === DEFAULT_MINT_URL,
      connectionStatus:
        walletStore.mintConnectionStatuses[m.url] === "connected"
          ? "connected"
          : walletStore.mintConnectionStatuses[m.url] === "failed"
            ? "error"
            : "disconnected",
      supportsCTF: ctf,
      addedDate: "",
    };
  });

  const settingsState: SettingsState = {
    general: {
      baseCurrency: settingsStore.baseCurrency,
      language: settingsStore.language,
      theme: settingsStore.theme,
      appVersion: APP_VERSION,
      likedMarketCloseNotifications: settingsStore.likedMarketCloseNotifications,
    },
    cashu: {
      mints: mintConfigs,
    },
    nostr: {
      signerMode: settingsStore.nostrSignerMode,
      signerSource: settingsStore.signerSource,
      signerBackupState: settingsStore.signerBackupState,
      canRevealLocalNsec:
        settingsStore.nostrSignerMode === "nsec" &&
        settingsStore.signerSource === "implicit-generated" &&
        !!settingsStore.nsecSecret,
      profile: settingsStore.nostrProfile,
      profileFetchStatus: settingsStore.nostrProfileFetchStatus,
      relays: settingsStore.relays,
    },
  };

  const handleAddMint = useCallback(
    async (url: string) => {
      const status = await walletStore.testMintConnection(url);
      if (status === "failed") {
        throw new Error("Failed to connect — mint is unreachable or invalid");
      }
      await userAddAndSelectMint(url);
    },
    [walletStore],
  );

  const handleMintClick = useCallback(
    (url: string) => {
      navigate(`/mint-details?mintUrl=${encodeURIComponent(url)}`);
    },
    [navigate],
  );

  const handleDisconnectNostr = useCallback(() => {
    disconnectNostrIdentity();
  }, []);

  const handleRemoveMint = useCallback((url: string) => {
    userRemoveMint(url);
  }, []);

  const closeWalletDialog = useCallback((generation: number) => {
    if (walletDialogGeneration.current !== generation) return;
    walletDialogGeneration.current += 1;
    setWalletDialog(null);
    setIsWalletActionPending(false);
    setWalletDialogError(null);
  }, []);

  const openWalletDialog = useCallback((mode: "setup" | "replace") => {
    const hasWallet = Boolean(useWalletStore.getState().mnemonic.trim());
    if (hasWallet !== (mode === "replace")) return;
    const generation = ++walletDialogGeneration.current;
    setWalletDialogError(null);
    setIsWalletActionPending(false);
    setWalletDialog({ mode, generation });
  }, []);

  const handleWalletAction = useCallback(
    async (words?: string[]) => {
      if (
        !walletDialog ||
        walletDialogGeneration.current !== walletDialog.generation ||
        walletActionGeneration.current !== null
      )
        return;
      const { mode, generation } = walletDialog;
      if (Boolean(useWalletStore.getState().mnemonic.trim()) !== (mode === "replace")) {
        closeWalletDialog(generation);
        return;
      }
      if (mode === "replace" && !words) return;
      walletActionGeneration.current = generation;
      setIsWalletActionPending(true);
      setWalletDialogError(null);
      const isCurrent = () => walletDialogGeneration.current === generation;
      try {
        if (words) {
          const result = await useWalletStore.getState().recoverFromMnemonic(words);
          if (!isCurrent()) return;
          if (!result.valid) {
            setWalletDialogError(result.error ?? t("wallet.replaceBlockedSafetyChecks"));
            return;
          }
        }
        if (mode === "setup") {
          await useWalletStore.getState().ensureImplicitWallet();
          if (!isCurrent()) return;
        }
        closeWalletDialog(generation);
      } catch {
        if (isCurrent())
          setWalletDialogError(
            t(mode === "setup" ? "wallet.setupFailed" : "wallet.replaceBlockedSafetyChecks"),
          );
      } finally {
        if (walletActionGeneration.current === generation) walletActionGeneration.current = null;
        if (isCurrent()) setIsWalletActionPending(false);
      }
    },
    [walletDialog, closeWalletDialog, t],
  );

  const handleThemeChange = useCallback(
    (theme: ThemeOption) => {
      settingsStore.setTheme(theme);
    },
    [settingsStore],
  );

  // P22 Link G3 — enabling the opt-in requests browser notification permission.
  // A denial keeps the opt-in OFF so the UI never claims an unusable state.
  const handleLikedMarketCloseNotificationsChange = useCallback(
    async (enabled: boolean): Promise<boolean> => {
      if (!enabled) {
        settingsStore.setLikedMarketCloseNotifications(false);
        return false;
      }
      const permission = await requestNotificationPermission();
      if (permission !== "granted") {
        settingsStore.setLikedMarketCloseNotifications(false);
        if (permission === "denied") {
          useToastStore.getState().addToast({
            type: "error",
            message: "Notifications are blocked in your browser settings.",
          });
        }
        return false;
      }
      settingsStore.setLikedMarketCloseNotifications(true);
      return true;
    },
    [settingsStore],
  );

  const handleSignerModeChange = useCallback(async (mode: NostrSignerMode): Promise<boolean> => {
    const result = await userConnectNostrSignerMode(mode);
    if (!result.ok) {
      useToastStore.getState().addToast({
        type: "error",
        message: result.error ?? "Failed to connect Nostr signer",
      });
    }
    return result.ok;
  }, []);

  const handleNsecSubmit = useCallback(
    async (nsec: string, passphrase?: string): Promise<boolean> => {
      const result = await userConnectNsecIdentity(nsec, passphrase);
      if (result.ok) {
        useToastStore.getState().addToast({
          type: "success",
          message: "Connected with private key",
        });
        return true;
      }
      useToastStore.getState().addToast({
        type: "error",
        message: result.error ?? "Invalid private key or connection failed",
      });
      return false;
    },
    [],
  );

  return (
    <>
      <Settings
        activeCategory={settingsStore.activeCategory}
        settings={settingsState}
        seedPhrase={walletStore.mnemonic}
        walletBackupState={walletStore.walletBackupState}
        localNsecSecret={
          settingsStore.nostrSignerMode === "nsec" &&
          settingsStore.signerSource === "implicit-generated"
            ? settingsStore.nsecSecret
            : null
        }
        onCategoryToggle={settingsStore.setActiveCategory}
        onThemeChange={handleThemeChange}
        onLikedMarketCloseNotificationsChange={handleLikedMarketCloseNotificationsChange}
        onAddMint={handleAddMint}
        onRemoveMint={handleRemoveMint}
        onMintClick={handleMintClick}
        onSignerModeChange={handleSignerModeChange}
        onNsecSubmit={handleNsecSubmit}
        onViewSeedPhrase={walletStore.acknowledgeWalletSeedReminder}
        onCreateWallet={() => openWalletDialog("setup")}
        onReplaceWallet={() => openWalletDialog("replace")}
        onConfirmWalletBackup={walletStore.markWalletBackupConfirmed}
        onConfirmSignerBackup={() => settingsStore.setSignerBackupState("confirmed")}
        onDisconnectNostr={handleDisconnectNostr}
        onRetryNostrProfile={refreshNostrProfile}
        onAddRelay={userAddRelay}
        onRemoveRelay={userRemoveRelay}
      />
      {walletDialog && (
        <WalletSetupModal
          key={walletDialog.generation}
          mode={walletDialog.mode}
          isCreating={isWalletActionPending}
          error={walletDialogError}
          onClose={() => closeWalletDialog(walletDialog.generation)}
          onCreateNew={() => void handleWalletAction()}
          onImportSeed={(words) => handleWalletAction(words)}
        />
      )}
    </>
  );
}
