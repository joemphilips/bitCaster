import { X, Copy, Check } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Nut16AnimatedQrEncoder, selectNut16QrPresentation } from "@bitcaster/client-sdk/nut16Qr";

interface TokenDisplayProps {
  token: string;
  amountSats: number;
  proofCount: number;
  onClose?: () => void;
  onReclaim?: () => void;
}

export function TokenDisplay({
  token,
  amountSats,
  proofCount,
  onClose,
  onReclaim,
}: TokenDisplayProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const presentation = useMemo(
    () => selectNut16QrPresentation({ token, proofCount }),
    [proofCount, token],
  );
  const animated = useMemo(() => {
    if (presentation.kind === "static") return null;
    const encoder = new Nut16AnimatedQrEncoder(token, proofCount);
    return { encoder, firstFrame: encoder.nextFrame() };
  }, [presentation.kind, proofCount, token]);
  const [animatedFrame, setAnimatedFrame] = useState<{
    readonly token: string;
    readonly value: string;
  } | null>(null);
  const frame =
    animated === null
      ? token
      : animatedFrame?.token === token
        ? animatedFrame.value
        : animated.firstFrame;

  useEffect(() => {
    if (animated === null) return;
    setAnimatedFrame({ token, value: animated.firstFrame });
    const timer = window.setInterval(
      () => setAnimatedFrame({ token, value: animated.encoder.nextFrame() }),
      250,
    );
    return () => {
      window.clearInterval(timer);
    };
  }, [animated, token]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

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
        <h2 className="text-lg font-semibold text-white">Send Ecash</h2>
        <div className="w-8" />
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col items-center justify-center max-w-md mx-auto w-full px-5">
        <div className="mb-6 flex items-center gap-2 text-emerald-400">
          <Check className="h-5 w-5" />
          <span className="text-sm font-semibold">{t("deposit.ecashTokenReady")}</span>
        </div>

        {/* QR Code */}
        <div className="bg-white p-4 rounded-2xl">
          <QRCodeSVG value={frame} size={256} level="L" />
        </div>

        {/* Amount */}
        <div className="mt-6 text-2xl font-bold text-white font-mono">
          ₿{amountSats.toLocaleString()}
        </div>

        {/* Token text + copy */}
        <div className="mt-4 w-full">
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-3 flex items-center gap-2">
            <span className="flex-1 text-xs text-slate-400 font-mono truncate">{token}</span>
            <button
              onClick={handleCopy}
              className="flex-shrink-0 p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
            >
              {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Instruction */}
        <p className="mt-4 text-sm text-slate-400 text-center">
          {t("deposit.ecashTokenReadyHint")}
        </p>
        {onReclaim ? (
          <button
            type="button"
            onClick={onReclaim}
            className="mt-5 rounded-lg border border-amber-400 px-4 py-2 text-sm font-semibold text-amber-200 transition-colors hover:bg-amber-400/10"
          >
            {t("deposit.reclaim")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
