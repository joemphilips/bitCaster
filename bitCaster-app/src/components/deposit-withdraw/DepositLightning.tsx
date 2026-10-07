import type { ReactNode } from "react";
import { X, Bitcoin } from "lucide-react";
import type { MintInfo } from "@/types/deposit-withdraw";
import { MintSelector } from "./MintSelector";
import { AmountDisplay } from "./AmountDisplay";
import { Numpad } from "./Numpad";
import {
  useWalletBackupPresentation,
  walletBackupPausesNewChanges,
} from "@/hooks/WalletBackupPresentation";
import { EncryptedWalletBackupRecoveryStatus } from "@/components/shell/EncryptedWalletBackupRecoveryStatus";

interface DepositLightningProps {
  mints: MintInfo[];
  selectedMintId: string;
  depositReminder?: ReactNode;
  statusMessage?: ReactNode;
  amountSats: number;
  amountLabel?: string;
  onMintChange?: (mintId: string) => void;
  onNumpadPress?: (key: string) => void;
  onCreateInvoice?: () => void;
  onClose?: () => void;
}

export function DepositLightning({
  mints,
  selectedMintId,
  depositReminder,
  statusMessage,
  amountSats,
  amountLabel,
  onMintChange,
  onNumpadPress,
  onCreateInvoice,
  onClose,
}: DepositLightningProps) {
  const walletBackup = useWalletBackupPresentation();
  return (
    <div className="fixed inset-0 z-[70] bg-slate-900 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4">
        <button
          onClick={() => onClose?.()}
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
        <h2 className="text-lg font-semibold text-white">Deposit Lightning</h2>
        <div className="p-1.5 text-slate-400">
          <Bitcoin className="w-5 h-5" />
        </div>
      </div>

      {/* Content */}
      <div data-testid="deposit-lightning-content" className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-md flex-col">
          {walletBackup && (
            <div className="px-5 pt-2">
              <EncryptedWalletBackupRecoveryStatus {...walletBackup} />
            </div>
          )}
          {statusMessage && <div className="px-5 pt-2">{statusMessage}</div>}
          {depositReminder && <div className="px-5 pt-2">{depositReminder}</div>}

          {/* Mint selector */}
          <div className="px-5 pt-2">
            <MintSelector
              mints={mints}
              selectedMintId={selectedMintId}
              onMintChange={onMintChange}
            />
          </div>

          {/* Amount */}
          <div className="flex flex-1 items-center justify-center">
            <AmountDisplay amountSats={amountSats} amountLabel={amountLabel} />
          </div>

          {/* Numpad */}
          <Numpad onPress={onNumpadPress} />

          {/* Action button */}
          <div className="px-5 py-6">
            <button
              onClick={() => onCreateInvoice?.()}
              disabled={amountSats === 0 || walletBackupPausesNewChanges(walletBackup)}
              className="w-full py-4 rounded-xl text-base font-bold uppercase tracking-wide transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-slate-200 text-slate-900 hover:bg-white active:bg-slate-300 disabled:hover:bg-slate-200"
            >
              Create Invoice
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
