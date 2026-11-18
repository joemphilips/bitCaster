import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { AlertCircle, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ParticipationScoreHelp } from "@/components/shared/ParticipationScoreHelp";
import type { BrowserCtfRangeOrderErrorCode } from "@/lib/browserCtfRangeOrderCoordinator";
import { retryBrowserCtfRangeOrderRecovery } from "@/lib/browserCtfRangeRecoveryRetry";
import { browserWalletScopeIdFromMnemonic } from "@/lib/browserWalletProfile";
import { useWalletStore } from "@/stores/wallet";
import { readCtfRangePreparation } from "@/stores/ctf-range-order-db";
import {
  acknowledgeBrowserCtfRangeMessage,
  pageActiveBrowserCtfRangeMessages,
  type BrowserCtfRangeMessage,
  type BrowserCtfRangeMessageCursor,
} from "@/stores/ctf-range-order-messages";
import { marketLabel, useMarketTitles } from "@/hooks/useMarketTitles";
import { readCtfRangeOrderFunds, refusedOrderAlertFunds } from "@/lib/ctfRangeOrderFunds";
import { withFundsSentence } from "@/lib/orderFailureText";
import { assertNever } from "@/lib/enumDiscipline";

const VISIBLE_MESSAGE_LIMIT = 8;

/** Alerts whose text names Participation Score, so the term's help goes next to them. */
const PARTICIPATION_SCORE_MESSAGE_CODES: ReadonlySet<BrowserCtfRangeOrderErrorCode> = new Set([
  "score-top-up-required",
  "score-top-up-cancelled",
  "settlement-capability-score-required",
] as const);

/**
 * An order alert names its market in plain words, as the failure panel does.
 * Other alerts name the wallet operation.
 */
function AlertSubject({
  message,
  marketId,
  titles,
}: {
  message: BrowserCtfRangeMessage;
  marketId: string | undefined;
  titles: ReadonlyMap<string, string>;
}) {
  const { t } = useTranslation();
  switch (message.kind) {
    case "order":
      return marketId === undefined ? null : (
        <p className="mt-1 text-xs opacity-75">
          {t("settlementProgress.orderOnMarket", { market: marketLabel(marketId, titles) })}
        </p>
      );
    case "funds":
      return (
        <p className="mt-1 truncate font-mono text-xs opacity-75" title={message.operationId}>
          {t("walletRecovery.operation", { operationId: message.operationId })}
        </p>
      );
    default:
      return assertNever(message.kind);
  }
}

function namesMarket(kind: BrowserCtfRangeMessage["kind"]): boolean {
  switch (kind) {
    case "order":
      return true;
    case "funds":
      return false;
    default:
      return assertNever(kind);
  }
}

/** A refused order request ends with its funds sentence, which names the fees. */
function alertText(
  t: (key: string, options?: Record<string, unknown>) => string,
  message: BrowserCtfRangeMessage,
  funds: "pending" | "refunded" | undefined,
): string {
  const text = t(`walletRecovery.errors.${message.code}`);
  return funds === undefined ? text : withFundsSentence(t, text, funds);
}

/**
 * The market of each order alert, from its journal operation, and the funds of
 * each refused order request whose refund follows.
 */
async function readOrderAlertFacts(
  scopeId: string,
  messages: readonly BrowserCtfRangeMessage[],
): Promise<{
  orderMarkets: Readonly<Record<string, string>>;
  orderFunds: Readonly<Record<string, "pending" | "refunded">>;
}> {
  const orderMarkets: Record<string, string> = {};
  const orderFunds: Record<string, "pending" | "refunded"> = {};
  for (const message of messages) {
    if (!namesMarket(message.kind)) continue;
    try {
      if (!Object.hasOwn(orderMarkets, message.operationId)) {
        const record = await readCtfRangePreparation(scopeId, message.operationId);
        if (record !== null) orderMarkets[message.operationId] = record.orderRouteId;
      }
      const funds = refusedOrderAlertFunds(
        message.code,
        await readCtfRangeOrderFunds(scopeId, message.operationId),
      );
      if (funds !== null) orderFunds[message.operationId] = funds;
    } catch {
      // Without its journal record, the alert shows no market and no funds.
    }
  }
  return { orderMarkets, orderFunds };
}

export function DurableWalletErrors() {
  const mnemonic = useWalletStore((state) => state.mnemonic);
  const scopeId = browserWalletScopeIdFromMnemonic(mnemonic);
  return scopeId === null ? null : <WalletAlertPage key={scopeId} scopeId={scopeId} />;
}

function WalletAlertPage({ scopeId }: { scopeId: string }) {
  const { t } = useTranslation();
  const [after, setAfter] = useState<BrowserCtfRangeMessageCursor>();
  const titles = useMarketTitles();
  const page = useLiveQuery(async () => {
    const result = await pageActiveBrowserCtfRangeMessages({
      scopeId,
      limit: VISIBLE_MESSAGE_LIMIT,
      ...(after ? { after } : {}),
    });
    return { ...result, ...(await readOrderAlertFacts(scopeId, result.messages)) };
  }, [scopeId, after]);
  if (!page || (page.messages.length === 0 && after === undefined)) return null;

  return (
    <section className="mb-4 space-y-2" aria-label={t("walletRecovery.title")}>
      {page.messages.map((message) => (
        <div
          key={`${message.operationId}:${message.revision}:${message.code}`}
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-200"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {message.kind === "order"
                ? t("walletRecovery.orderFailure")
                : t("walletRecovery.fundsRecovery")}
            </p>
            <div className="flex items-center gap-2">
              <p>
                {message.code === "order-attempt-ended" && message.fundsReleased === true
                  ? t("walletRecovery.fundsReleased")
                  : alertText(t, message, page.orderFunds[message.operationId])}
              </p>
              {PARTICIPATION_SCORE_MESSAGE_CODES.has(message.code) && <ParticipationScoreHelp />}
            </div>
            {message.mintError !== undefined && (
              <p className="mt-1 font-mono text-xs opacity-75">
                {t("walletRecovery.mintCode", { code: message.mintError.code })}
              </p>
            )}
            <AlertSubject
              message={message}
              marketId={page.orderMarkets[message.operationId]}
              titles={titles}
            />
            {message.retryable === true && (
              <button
                type="button"
                className="mt-1 text-sm underline"
                onClick={() =>
                  void retryBrowserCtfRangeOrderRecovery({
                    scopeId,
                    operationId: message.operationId,
                  })
                }
              >
                {t("walletRecovery.retry")}
              </button>
            )}
          </div>
          <button
            type="button"
            className="rounded p-1 hover:bg-rose-100 dark:hover:bg-rose-900/50"
            aria-label={t("walletRecovery.dismiss")}
            onClick={() =>
              void acknowledgeBrowserCtfRangeMessage({
                scopeId,
                operationId: message.operationId,
                revision: message.revision,
                code: message.code,
                acknowledgedAtMs: Date.now(),
              })
            }
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ))}
      {page.nextCursor !== null && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t("walletRecovery.morePending")}
        </p>
      )}
      {(after !== undefined || page.nextCursor !== null) && (
        <div className="flex gap-3">
          {after !== undefined && (
            <button type="button" className="text-sm underline" onClick={() => setAfter(undefined)}>
              {t("walletRecovery.firstAlerts")}
            </button>
          )}
          {page.nextCursor !== null && (
            <button
              type="button"
              className="text-sm underline"
              onClick={() => setAfter(page.nextCursor!)}
            >
              {t("common.next")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
