import { useState, useCallback, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type {
  DepositWithdrawMode,
  DepositWithdrawView,
  MethodType,
  MintInfo,
} from "@/types/deposit-withdraw";
import type { MeltQuoteResponse } from "@cashu/cashu-ts";
import { useWalletStore } from "@/stores/wallet";
import { useActivityLogStore } from "@/stores/activity-log";
import { useLiveQuery } from "dexie-react-hooks";
import { createMeltQuote, meltProofs } from "@/lib/cashu";
import {
  executeBrowserBearerWithdrawal,
  browserBearerReclaimFeeDisclosure,
  classifyBrowserBearerWithdrawal,
  reclaimBrowserBearerWithdrawal,
  resumeBrowserBearerWithdrawal,
} from "@/lib/browserBearerWithdrawal";
import type { DurableOutgoingCashuTransfer } from "@bitcaster/client-sdk/durableOutgoingCashuTransfer";
import {
  createBrowserDurableBolt11MintQuote,
  hideBrowserDurableBolt11MintQuote,
  subscribeActiveBrowserDurableBolt11MintQuote,
} from "@/lib/browserDurableBolt11MintQuote";
import type { DurableBolt11MintQuote } from "@bitcaster/client-sdk/durableBolt11MintQuote";
import {
  ingressReceiveCashuToken,
  userCreatePaymentRequest,
  type IngressReceiveCashuTokenResult,
} from "@/lib/walletOps";
import { useToastStore } from "@/stores/toast";
import {
  getUnitProofs,
  getProofs,
  addProofs,
  removeProofs,
  isCtfProof,
  type StoredProof,
} from "@/stores/proof-db";
import { usePaymentRequestInbox } from "@/stores/paymentRequestInbox";
import { safeHostname } from "@/lib/url";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import {
  cashuAmountToMarketSubunits,
  collateralScaleForUnit,
  defaultCollateralUnit,
  parseCashuProofUnit,
  type CashuProofUnit,
  type MarketBaseAsset,
} from "@bitcaster/client-sdk/marketUnits";
import { formatBtc } from "@/lib/format";

export type ExtendedView =
  | DepositWithdrawView
  | "invoice-display"
  | "token-display"
  | "melt-confirm"
  | "scanner"
  | "payment-request-display"
  | "success";

export type InvoiceStatus = "pending" | "paid" | "expired" | "error";

function depositInputAmountToActivitySubunits(amount: number, baseAsset: MarketBaseAsset): number {
  const unit = defaultCollateralUnit(baseAsset);
  const amountSubunits = amount * collateralScaleForUnit(unit);
  if (!Number.isSafeInteger(amountSubunits)) {
    throw new Error(`Amount exceeds safe integer range for ${unit}: ${amount}`);
  }
  return amountSubunits;
}

export interface DepositWithdrawState {
  mode: DepositWithdrawMode;
  currentView: ExtendedView;
  mints: MintInfo[];
  selectedMintId: string;
  amountSats: number;
  amountLabel: string;
  amountFiat: string;
  fiatSymbol: string;
  showFiatPrimary: boolean;
  lightningInput: string;
  isLoading: boolean;
  error: string | null;

  // Result state
  bolt11: string | null;
  invoiceStatus: InvoiceStatus;
  /** Bolt11 expiry as unix-seconds. Drives the live countdown in the UI. */
  invoiceExpiresAtSec: number | undefined;
  ecashToken: string | null;
  bearerWithdrawal: DurableOutgoingCashuTransfer | null;
  meltQuote: MeltQuoteResponse | null;
  meltIsPaying: boolean;

  // Payment request state
  paymentRequestEncoded: string | null;
  paymentRequestStatus: "waiting" | "received";

  // Success state
  successAmount: number;
  /** Product base asset of the displayed success amount. */
  successUnit: MarketBaseAsset;

  // Handlers
  onSelectMethod: (method: MethodType) => void;
  onNumpadPress: (key: string) => void;
  onMintChange: (mintId: string) => void;
  onToggleCurrency: () => void;
  onCreateInvoice: () => void;
  /** Discard the active mint quote and immediately request a fresh one for the
   *  same amount/mint/unit (one-click re-quote after expiry / failure). */
  onRegenerateInvoice: () => void;
  onSendEcash: () => void;
  onReclaimEcash: () => void;
  onPaste: () => void;
  onScan: () => void;
  onRequest: () => void;
  onScanQR: () => void;
  onScanResult: (data: string) => void;
  onLightningInputChange: (value: string) => void;
  onConfirmMelt: () => void;
  onBack: () => void;
  onClose: () => void;
}

/**
 * Surface a toast when ingress had to register an unknown mint before redeeming.
 * The actual wallet mutation lives in walletOps so untrusted input cannot call
 * the user-facing add-and-activate mint path by accident.
 */
function toastNewMintIfAdded(result: IngressReceiveCashuTokenResult): void {
  if (!result.added) return;
  useToastStore.getState().addToast({
    message: `Added new mint: ${safeHostname(result.mintUrl)}`,
    type: "info",
  });
}

export function useDepositWithdrawState(
  mode: DepositWithdrawMode,
  onDismiss: () => void,
): DepositWithdrawState {
  const { t } = useTranslation();
  const storeMints = useWalletStore((s) => s.mints);
  const activeMintUrl = useWalletStore((s) => s.activeMintUrl);
  const walletMnemonic = useWalletStore((s) => s.mnemonic);

  // Reactive balances for all mints via a single live query
  const mintUrls = storeMints.map((m) => m.url);
  const balancesByMint = useLiveQuery(
    async () => {
      const proofs = await getProofs();
      const map: Record<string, number> = {};
      for (const p of proofs.filter((proof) => !isCtfProof(proof))) {
        const unit = requireCashuProofUnit(p.unit);
        map[p.mintUrl] =
          (map[p.mintUrl] ?? 0) + cashuAmountToMarketSubunits(amountToNumber(p.amount), unit);
      }
      return map;
    },
    [mintUrls.join(","), walletMnemonic],
    {} as Record<string, number>,
  );

  // Build MintInfo[] from store mints with live balances
  const mintsWithBalance: MintInfo[] = storeMints.map((m) => ({
    id: m.url,
    name: ((m.info as Record<string, unknown>)?.name as string) ?? safeHostname(m.url),
    url: m.url,
    balanceSats: balancesByMint[m.url] ?? 0,
  }));

  const [currentView, setCurrentView] = useState<ExtendedView>("chooser");
  const [selectedMintId, setSelectedMintId] = useState(activeMintUrl);
  const [amountString, setAmountString] = useState("");
  const [showFiatPrimary, setShowFiatPrimary] = useState(false);
  const [lightningInput, setLightningInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Result state
  const [bolt11, setBolt11] = useState<string | null>(null);
  const [invoiceStatus, setInvoiceStatus] = useState<InvoiceStatus>("pending");
  const [invoiceExpiresAtSec, setInvoiceExpiresAtSec] = useState<number | undefined>();
  const [ecashToken, setEcashToken] = useState<string | null>(null);
  const [bearerWithdrawal, setBearerWithdrawal] = useState<DurableOutgoingCashuTransfer | null>(
    null,
  );
  const [meltQuote, setMeltQuote] = useState<MeltQuoteResponse | null>(null);
  const [meltIsPaying, setMeltIsPaying] = useState(false);

  // Payment request state
  const [paymentRequestEncoded, setPaymentRequestEncoded] = useState<string | null>(null);
  const [paymentRequestStatus, setPaymentRequestStatus] = useState<"waiting" | "received">(
    "waiting",
  );

  // Success state
  const [successAmount, setSuccessAmount] = useState(0);
  const [successUnit, setSuccessUnit] = useState<MarketBaseAsset>("sat");

  // Track which view opened the scanner so we can process results correctly
  const scanReturnViewRef = useRef<ExtendedView>("deposit-ecash");

  const mintQuoteRef = useRef<DurableBolt11MintQuote | null>(null);
  // Synchronous double-click guard. `setIsLoading(true)` is one render late;
  // a rapid second click would otherwise create a second quote & leak the
  // first's polling subscription.
  const inflightRef = useRef(false);
  const unsubRef = useRef<(() => void) | null>(null);
  const mintQuotePresentationGenerationRef = useRef(0);
  const bearerPresentationGenerationRef = useRef(0);
  const mintQuoteDisposedRef = useRef(false);
  const userSelectedMintRef = useRef(false);

  // PaymentRequest id of the request currently displayed in the
  // "Waiting for payment…" view. A non-null value subscribes us to the
  // global inbox store so we react the moment a matching DM is redeemed —
  // even if the DM arrives before this hook mounted.
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const inboxEntry = usePaymentRequestInbox((s) =>
    pendingRequestId ? s.entries[pendingRequestId] : undefined,
  );

  // Cleanup WebSocket/polling on unmount. The NIP-17 listener is
  // global (see App.tsx::startNip17Listener) so we do NOT stop it here.
  useEffect(() => {
    mintQuoteDisposedRef.current = false;
    return () => {
      mintQuoteDisposedRef.current = true;
      mintQuotePresentationGenerationRef.current += 1;
      unsubRef.current?.();
      unsubRef.current = null;
      const quote = mintQuoteRef.current;
      mintQuoteRef.current = null;
      if (quote) void hideBrowserDurableBolt11MintQuote(quote.quoteRecordId);
    };
  }, []);

  useEffect(() => {
    if (!activeMintUrl) return;
    const userChoseMint = userSelectedMintRef.current;
    const selectedMintStillExists =
      !!selectedMintId && storeMints.some((mint) => mint.url === selectedMintId);
    if (!userChoseMint || !selectedMintStillExists) {
      userSelectedMintRef.current = false;
      if (selectedMintId !== activeMintUrl) {
        setSelectedMintId(activeMintUrl);
      }
    }
  }, [activeMintUrl, selectedMintId, storeMints]);

  // React to the global inbox flipping our pending request to "received".
  useEffect(() => {
    if (!pendingRequestId || !inboxEntry) return;
    setPaymentRequestStatus("received");
    setSuccessAmount(inboxEntry.amountSubunits);
    setSuccessUnit(inboxEntry.baseAsset);
    const handle = setTimeout(() => {
      usePaymentRequestInbox.getState().clear(pendingRequestId);
      setPendingRequestId(null);
      onDismiss();
    }, 2000);
    return () => clearTimeout(handle);
  }, [pendingRequestId, inboxEntry, onDismiss]);

  const amountSats = parseInt(amountString || "0", 10);
  const amountLabel = formatBtc(amountSats);

  const onSelectMethod = useCallback(
    (method: MethodType) => {
      if (mode === "deposit") {
        setCurrentView(method === "ecash" ? "deposit-ecash" : "deposit-lightning");
      } else {
        setCurrentView(method === "ecash" ? "send-ecash" : "pay-lightning");
        if (method === "ecash") {
          const presentationGeneration = ++bearerPresentationGenerationRef.current;
          const requestedMintId = selectedMintId;
          void resumeBrowserBearerWithdrawal(selectedMintId)
            .then(async (transfer) => {
              if (
                presentationGeneration !== bearerPresentationGenerationRef.current ||
                transfer?.mintUrl !== requestedMintId
              ) {
                return;
              }
              if (transfer?.token === null || transfer === null) return;
              if (transfer.deliveryState === "reclaim-prepared") {
                setBearerWithdrawal(transfer);
                setEcashToken(null);
                const disclosure = browserBearerReclaimFeeDisclosure(transfer);
                setError(
                  disclosure === null
                    ? t("deposit.reclaimPrepared")
                    : t("deposit.reclaimFeeDisclosure", disclosure),
                );
                return;
              }
              const classified = await classifyBrowserBearerWithdrawal({ transfer });
              if (presentationGeneration !== bearerPresentationGenerationRef.current) return;
              setBearerWithdrawal(classified);
              switch (classified.deliveryState) {
                case "delivery-pending":
                  const token = classified.token;
                  if (
                    token === null ||
                    token.unspentProofs === null ||
                    token.unspentProofs.length !== token.proofs.length
                  ) {
                    setEcashToken(null);
                    setError(t("deposit.reclaimOriginalHidden"));
                    return;
                  }
                  setEcashToken(token.encodedToken);
                  setAmountString(classified.requestedAmount);
                  setCurrentView("token-display");
                  return;
                case "bearer-partial":
                  setEcashToken(null);
                  setError(t("deposit.reclaimOriginalHidden"));
                  return;
                default:
                  return;
              }
            })
            .catch((reason: Error) => {
              if (presentationGeneration === bearerPresentationGenerationRef.current) {
                setError(reason.message);
              }
            });
        }
      }
    },
    [mode, selectedMintId, t],
  );

  const onNumpadPress = useCallback((key: string) => {
    setAmountString((prev) => {
      if (key === "backspace") {
        return prev.length <= 1 ? "" : prev.slice(0, -1);
      }
      // Prevent leading zeros
      if (prev === "" && key === "0") return "";
      return prev + key;
    });
  }, []);

  const onMintChange = useCallback((mintId: string) => {
    userSelectedMintRef.current = true;
    bearerPresentationGenerationRef.current += 1;
    setSelectedMintId(mintId);
  }, []);

  const onToggleCurrency = useCallback(() => {
    setShowFiatPrimary((prev) => !prev);
  }, []);

  const stopActiveMintQuote = useCallback(async () => {
    mintQuotePresentationGenerationRef.current += 1;
    unsubRef.current?.();
    unsubRef.current = null;
    const quote = mintQuoteRef.current;
    mintQuoteRef.current = null;
    if (quote) await hideBrowserDurableBolt11MintQuote(quote.quoteRecordId);
  }, []);

  const handlePaidInvoice = useCallback(
    (quote: DurableBolt11MintQuote, requested: number, baseAsset: MarketBaseAsset) => {
      setInvoiceStatus("paid");
      const requestedSubunits = depositInputAmountToActivitySubunits(requested, baseAsset);
      useActivityLogStore.getState().addActivity({
        type: "deposit",
        baseAsset,
        amountSats: requestedSubunits,
        status: "completed",
        lightningInvoice: quote.invoiceRequest,
      });
      setSuccessAmount(requestedSubunits);
      setSuccessUnit(baseAsset);
      setCurrentView("success");
    },
    [],
  );

  const handleInvoiceWaitResult = useCallback(
    (
      r: { status: string; error?: Error },
      quote: DurableBolt11MintQuote,
      requested: number,
      baseAsset: MarketBaseAsset,
    ) => {
      if (mintQuoteRef.current?.quoteRecordId !== quote.quoteRecordId) return;
      switch (r.status) {
        case "PAID":
          handlePaidInvoice(quote, requested, baseAsset);
          return;
        case "EXPIRED":
          setInvoiceStatus("expired");
          setError("The Lightning invoice expired before payment arrived.");
          void stopActiveMintQuote();
          return;
        case "ERROR":
          setInvoiceStatus("error");
          setError(r.error?.message ?? "Mint quote recovery failed.");
          return;
        default:
          throw new Error("Unhandled BOLT11 mint quote result");
      }
    },
    [handlePaidInvoice, stopActiveMintQuote],
  );

  const onCreateInvoice = useCallback(async () => {
    if (amountSats <= 0) return;
    if (inflightRef.current) return;
    inflightRef.current = true;
    setIsLoading(true);
    setError(null);
    setInvoiceStatus("pending");
    const requested = amountSats;
    const mintUrl = selectedMintId;
    const baseAsset = "sat" as const;
    const quoteAmount = depositInputAmountToActivitySubunits(requested, baseAsset);
    const presentationGeneration = mintQuotePresentationGenerationRef.current;
    try {
      await useWalletStore.getState().ensureImplicitWallet();
      if (
        mintQuoteDisposedRef.current ||
        presentationGeneration !== mintQuotePresentationGenerationRef.current
      ) {
        return;
      }
      const created = await createBrowserDurableBolt11MintQuote({
        amount: quoteAmount,
        mintUrl,
        unit: defaultCollateralUnit(baseAsset),
      });
      if (
        mintQuoteDisposedRef.current ||
        presentationGeneration !== mintQuotePresentationGenerationRef.current
      ) {
        await hideBrowserDurableBolt11MintQuote(created.quote.quoteRecordId);
        return;
      }
      mintQuoteRef.current = created.quote;
      setBolt11(created.invoiceRequest);
      setInvoiceExpiresAtSec(created.quote.expiryUnixSeconds ?? undefined);
      setCurrentView("invoice-display");
      const unsub = await subscribeActiveBrowserDurableBolt11MintQuote({
        quote: created.quote,
        onResult: (result) => handleInvoiceWaitResult(result, created.quote, requested, baseAsset),
        options: {
          onTransientError: (error) => {
            if (
              !mintQuoteDisposedRef.current &&
              mintQuoteRef.current?.quoteRecordId === created.quote.quoteRecordId
            ) {
              setError(error.message);
            }
          },
        },
      });
      if (
        mintQuoteDisposedRef.current ||
        presentationGeneration !== mintQuotePresentationGenerationRef.current
      ) {
        unsub();
        await hideBrowserDurableBolt11MintQuote(created.quote.quoteRecordId);
        return;
      }
      unsubRef.current = unsub;
    } catch (e) {
      if (
        !mintQuoteDisposedRef.current &&
        presentationGeneration === mintQuotePresentationGenerationRef.current
      ) {
        setInvoiceStatus("error");
        setError((e as Error).message);
      }
      inflightRef.current = false;
    } finally {
      if (
        !mintQuoteDisposedRef.current &&
        presentationGeneration === mintQuotePresentationGenerationRef.current
      ) {
        setIsLoading(false);
      }
    }
  }, [amountSats, selectedMintId, handleInvoiceWaitResult]);

  const onRegenerateInvoice = useCallback(() => {
    void stopActiveMintQuote().finally(() => {
      inflightRef.current = false;
      setBolt11(null);
      setInvoiceExpiresAtSec(undefined);
      setInvoiceStatus("pending");
      setError(null);
      void onCreateInvoice();
    });
  }, [onCreateInvoice, stopActiveMintQuote]);

  const onPaste = useCallback(async () => {
    setError(null);
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;

      // Detect if it's an ecash token or a lightning invoice
      if (currentView === "deposit-ecash") {
        setIsLoading(true);
        const received = await ingressReceiveCashuToken(text, "paste");
        toastNewMintIfAdded(received);
        const receivedBaseAsset = received.baseAsset;
        useActivityLogStore.getState().addActivity({
          type: "deposit",
          baseAsset: receivedBaseAsset,
          amountSats: received.amountSubunits,
          status: "completed",
        });
        setIsLoading(false);
        setSuccessAmount(received.amountSubunits);
        setSuccessUnit(receivedBaseAsset);
        setCurrentView("success");
      } else if (currentView === "pay-lightning") {
        setLightningInput(text);
        // Auto-create melt quote if it looks like a bolt11 invoice
        if (text.toLowerCase().startsWith("lnbc") || text.toLowerCase().startsWith("lntb")) {
          setIsLoading(true);
          const quote = await createMeltQuote(text, selectedMintId);
          setMeltQuote(quote);
          setCurrentView("melt-confirm");
          setIsLoading(false);
        }
      }
    } catch (e) {
      setError((e as Error).message);
      setIsLoading(false);
    }
  }, [currentView, selectedMintId]);

  const onSendEcash = useCallback(async () => {
    if (amountSats <= 0) return;
    setIsLoading(true);
    setError(null);
    try {
      const transfer = await executeBrowserBearerWithdrawal({
        amount: amountSats,
        mintUrl: selectedMintId,
      });
      if (transfer.token === null) throw new Error("Withdrawal token was not durably admitted");
      setBearerWithdrawal(transfer);
      setEcashToken(transfer.token.encodedToken);
      setCurrentView("token-display");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, [amountSats, selectedMintId]);

  const onReclaimEcash = useCallback(async () => {
    if (bearerWithdrawal === null) return;
    setEcashToken(null);
    setCurrentView("send-ecash");
    setIsLoading(true);
    try {
      const classified = await reclaimBrowserBearerWithdrawal({ transfer: bearerWithdrawal });
      setBearerWithdrawal(classified);
      switch (classified.deliveryState) {
        case "bearer-spent":
          setEcashToken(null);
          setError(t("deposit.reclaimSpent"));
          setCurrentView("send-ecash");
          return;
        case "bearer-partial":
          setEcashToken(null);
          setError(t("deposit.reclaimOriginalHidden"));
          setCurrentView("send-ecash");
          return;
        case "delivery-pending":
          setError(t("deposit.reclaimUncertain"));
          return;
        case "reclaim-prepared": {
          const disclosure = browserBearerReclaimFeeDisclosure(classified);
          setError(
            disclosure === null
              ? t("deposit.reclaimPrepared")
              : t("deposit.reclaimFeeDisclosure", disclosure),
          );
          return;
        }
        case "reclaimed":
          setEcashToken(null);
          setCurrentView("send-ecash");
          return;
        default:
          setError(t("deposit.reclaimUnavailable"));
      }
    } catch (reason) {
      const persisted = await resumeBrowserBearerWithdrawal(bearerWithdrawal.mintUrl).catch(
        () => null,
      );
      if (persisted?.transferId === bearerWithdrawal.transferId) {
        setBearerWithdrawal(persisted);
        if (persisted.deliveryState !== "delivery-pending") setEcashToken(null);
      }
      setError((reason as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, [bearerWithdrawal, t]);

  const onLightningInputChange = useCallback(
    async (value: string) => {
      setLightningInput(value);
      // Auto-create melt quote when a bolt11 invoice is detected
      const trimmed = value.trim().toLowerCase();
      if (trimmed.startsWith("lnbc") || trimmed.startsWith("lntb")) {
        setIsLoading(true);
        setError(null);
        try {
          const quote = await createMeltQuote(value.trim(), selectedMintId);
          setMeltQuote(quote);
          setCurrentView("melt-confirm");
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setIsLoading(false);
        }
      }
    },
    [selectedMintId],
  );

  const onConfirmMelt = useCallback(async () => {
    if (!meltQuote) return;
    setMeltIsPaying(true);
    setError(null);
    try {
      const proofs = await getUnitProofs(selectedMintId, { unit: "sat" });
      const { paid, change } = await meltProofs(meltQuote, proofs, selectedMintId);

      if (!paid) {
        setError("Payment failed");
        return;
      }

      // Remove spent proofs, add change
      await removeProofs(proofs.map((p) => p.secret));
      if (change.length > 0) {
        const changeStored: StoredProof[] = change.map((p) => ({
          ...p,
          mintUrl: selectedMintId,
          baseAsset: "sat",
          unit: "sat",
        }));
        await addProofs(changeStored);
      }

      useActivityLogStore.getState().addActivity({
        type: "withdrawal",
        baseAsset: "sat",
        amountSats: amountToNumber(meltQuote.amount),
        status: "completed",
        lightningInvoice: lightningInput,
      });
      setSuccessAmount(amountToNumber(meltQuote.amount));
      setSuccessUnit("sat");
      setCurrentView("success");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMeltIsPaying(false);
    }
  }, [meltQuote, selectedMintId]);

  const onScan = useCallback(() => {
    scanReturnViewRef.current = currentView;
    setCurrentView("scanner");
  }, [currentView]);

  const onScanResult = useCallback(
    async (data: string) => {
      setError(null);
      const trimmed = data.trim();

      // Detect cashu token
      if (trimmed.toLowerCase().startsWith("cashu")) {
        setIsLoading(true);
        try {
          const received = await ingressReceiveCashuToken(trimmed, "scan");
          toastNewMintIfAdded(received);
          const receivedBaseAsset = received.baseAsset;
          useActivityLogStore.getState().addActivity({
            type: "deposit",
            baseAsset: receivedBaseAsset,
            amountSats: received.amountSubunits,
            status: "completed",
          });
          setSuccessAmount(received.amountSubunits);
          setSuccessUnit(receivedBaseAsset);
          setCurrentView("success");
        } catch (e) {
          setError((e as Error).message);
          setCurrentView(scanReturnViewRef.current);
        } finally {
          setIsLoading(false);
        }
        return;
      }

      // Detect bolt11 invoice
      if (trimmed.toLowerCase().startsWith("lnbc") || trimmed.toLowerCase().startsWith("lntb")) {
        setIsLoading(true);
        try {
          const quote = await createMeltQuote(trimmed, selectedMintId);
          setMeltQuote(quote);
          setLightningInput(trimmed);
          setCurrentView("melt-confirm");
        } catch (e) {
          setError((e as Error).message);
          setCurrentView(scanReturnViewRef.current);
        } finally {
          setIsLoading(false);
        }
        return;
      }

      // Detect payment request
      if (trimmed.toLowerCase().startsWith("creq")) {
        // TODO: handle paying a scanned payment request
        setError("Paying payment requests from scan is not yet supported");
        setCurrentView(scanReturnViewRef.current);
        return;
      }

      // Unknown format
      setError("Unrecognized QR code format");
      setCurrentView(scanReturnViewRef.current);
    },
    [selectedMintId],
  );

  const onRequest = useCallback(async () => {
    setError(null);

    try {
      const paymentRequest = userCreatePaymentRequest(selectedMintId);

      setPaymentRequestEncoded(paymentRequest.encoded);
      setPaymentRequestStatus("waiting");
      setCurrentView("payment-request-display");
      // Hand receive-detection off to the continuous listener. The
      // useEffect above flips status to 'received' when the global inbox
      // gets an entry keyed by this id.
      setPendingRequestId(paymentRequest.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [selectedMintId]);

  const onBack = useCallback(() => {
    if (currentView === "scanner") {
      setCurrentView(scanReturnViewRef.current);
    } else if (currentView === "payment-request-display") {
      setPendingRequestId(null);
      setCurrentView("deposit-ecash");
    } else {
      setCurrentView("chooser");
    }
    setError(null);
  }, [currentView]);

  const onClose = useCallback(() => {
    setPendingRequestId(null);
    void stopActiveMintQuote().finally(onDismiss);
  }, [onDismiss, stopActiveMintQuote]);

  return {
    mode,
    currentView,
    mints: mintsWithBalance,
    selectedMintId,
    amountSats,
    amountLabel,
    amountFiat: "$0.00", // Fiat conversion not yet implemented
    fiatSymbol: "$",
    showFiatPrimary,
    lightningInput,
    isLoading,
    error,
    bolt11,
    invoiceStatus,
    invoiceExpiresAtSec,
    ecashToken,
    bearerWithdrawal,
    meltQuote,
    meltIsPaying,
    paymentRequestEncoded,
    paymentRequestStatus,
    successAmount,
    successUnit,
    onSelectMethod,
    onNumpadPress,
    onMintChange,
    onToggleCurrency,
    onCreateInvoice,
    onRegenerateInvoice,
    onSendEcash,
    onReclaimEcash,
    onPaste,
    onScan,
    onRequest,
    onScanQR: onScan,
    onScanResult,
    onLightningInputChange,
    onConfirmMelt,
    onBack,
    onClose,
  };
}

function requireCashuProofUnit(value: string | null | undefined): CashuProofUnit {
  const unit = parseCashuProofUnit(value);
  if (!unit) throw new Error(`Unsupported Cashu proof unit '${value ?? ""}'`);
  return unit;
}
