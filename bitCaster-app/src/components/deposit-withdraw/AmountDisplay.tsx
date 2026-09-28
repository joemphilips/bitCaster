interface AmountDisplayProps {
  amountSats: number;
  amountLabel?: string;
}

export function AmountDisplay({ amountSats, amountLabel }: AmountDisplayProps) {
  const satsText =
    amountLabel ?? `${amountSats.toLocaleString(undefined, { maximumFractionDigits: 3 })} sats`;

  return (
    <div className="flex flex-col items-center justify-center py-8">
      <div className="text-5xl sm:text-6xl font-bold text-white font-mono tracking-tight">
        {satsText}
      </div>
    </div>
  );
}
