import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import QrScanner from "qr-scanner";
import { useTranslation } from "react-i18next";
import { Nut16UrDecoderSession } from "@bitcaster/client-sdk/nut16Qr";

interface QrScannerProps {
  onDecode: (data: string) => void;
  onClose: () => void;
}

let activeScannerSession = false;

export function QrScannerView({ onDecode, onClose }: QrScannerProps) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const onDecodeRef = useRef(onDecode);
  const decoderRef = useRef<Nut16UrDecoderSession | null>(null);
  const completedRef = useRef(false);
  const [progress, setProgress] = useState(0);
  const [scanError, setScanError] = useState<string | null>(null);

  useEffect(() => {
    onDecodeRef.current = onDecode;
  }, [onDecode]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (activeScannerSession) {
      setScanError(t("deposit.scanAlreadyActive"));
      return;
    }
    activeScannerSession = true;
    decoderRef.current = new Nut16UrDecoderSession();
    const scanner = new QrScanner(
      video,
      (result: QrScanner.ScanResult) => {
        if (completedRef.current) return;
        const value = result.data.trim();
        if (!value.toLowerCase().startsWith("ur:")) {
          completedRef.current = true;
          scanner.stop();
          onDecodeRef.current(value);
          return;
        }
        const received = decoderRef.current?.receive(value);
        if (!received) return;
        setProgress(received.progress);
        if (received.status === "complete") {
          completedRef.current = true;
          scanner.stop();
          onDecodeRef.current(received.token);
        } else if (received.status === "rejected") {
          scanner.stop();
          setScanError(t("deposit.scanInvalid"));
        }
      },
      {
        returnDetailedScanResult: true,
        highlightScanRegion: true,
        highlightCodeOutline: true,
        onDecodeError: () => {},
      },
    );

    scannerRef.current = scanner;
    scanner.start();
    const timeout = window.setTimeout(() => {
      if (decoderRef.current?.expire()) {
        scanner.stop();
        setScanError(t("deposit.scanTimedOut"));
      }
    }, 120_001);

    return () => {
      window.clearTimeout(timeout);
      scanner.destroy();
      scannerRef.current = null;
      decoderRef.current = null;
      activeScannerSession = false;
    };
  }, [t]);

  return (
    <div className="fixed inset-0 z-[70] bg-slate-900 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4">
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
        <h2 className="text-lg font-semibold text-white">{t("deposit.scanQrCode")}</h2>
        <div className="w-8" />
      </div>

      {/* Camera viewfinder */}
      <div className="flex-1 flex items-center justify-center px-5">
        <div className="w-full max-w-md rounded-2xl overflow-hidden bg-black">
          <video ref={videoRef} className="w-full" />
        </div>
      </div>
      {progress > 0 ? (
        <p className="pb-4 text-center text-sm text-slate-300">{Math.round(progress * 100)}%</p>
      ) : null}
      {scanError ? (
        <p role="alert" className="pb-4 text-center text-sm text-red-300">
          {scanError}
        </p>
      ) : null}
    </div>
  );
}
