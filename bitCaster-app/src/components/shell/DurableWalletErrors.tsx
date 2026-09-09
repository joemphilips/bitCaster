import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { AlertCircle, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { browserWalletScopeIdFromMnemonic } from "@/lib/browserWalletProfile";
import { useWalletStore } from "@/stores/wallet";
import {
  acknowledgeBrowserCtfRangeMessage,
  pageActiveBrowserCtfRangeMessages,
  type BrowserCtfRangeMessageCursor,
} from "@/stores/ctf-range-order-messages";

const VISIBLE_MESSAGE_LIMIT = 8;

export function DurableWalletErrors() {
  const mnemonic = useWalletStore((state) => state.mnemonic);
  const scopeId = browserWalletScopeIdFromMnemonic(mnemonic);
  return scopeId === null ? null : <WalletAlertPage key={scopeId} scopeId={scopeId} />;
}

function WalletAlertPage({ scopeId }: { scopeId: string }) {
  const { t } = useTranslation();
  const [after, setAfter] = useState<BrowserCtfRangeMessageCursor>();
  const page = useLiveQuery(
    () => pageActiveBrowserCtfRangeMessages({
      scopeId, limit: VISIBLE_MESSAGE_LIMIT, ...(after ? { after } : {}),
    }),
    [scopeId, after],
  );
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
            <p>{t(`walletRecovery.errors.${message.code}`)}</p>
            <p className="mt-1 truncate font-mono text-xs opacity-75" title={message.operationId}>
              {t("walletRecovery.operation", { operationId: message.operationId })}
            </p>
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
      <div className="flex gap-3">
        {after !== undefined && (
          <button type="button" className="text-sm underline" onClick={() => setAfter(undefined)}>
            {t("walletRecovery.firstAlerts")}
          </button>
        )}
        {page.nextCursor !== null && (
          <button type="button" className="text-sm underline" onClick={() => setAfter(page.nextCursor!)}>
            {t("common.next")}
          </button>
        )}
      </div>
    </section>
  );
}
