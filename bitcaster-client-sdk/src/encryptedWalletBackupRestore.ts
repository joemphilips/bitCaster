export function compareEncryptedWalletBackupRestoreTupleText(
  left: string,
  right: string,
): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const count = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < count; index += 1) {
    if (leftBytes[index] !== rightBytes[index])
      return leftBytes[index]! - rightBytes[index]!;
  }
  return leftBytes.length - rightBytes.length;
}

export function groupEncryptedWalletBackupRestoreRecordsByMintUnit<
  T extends Readonly<{ mint: string; unit: string }>,
>(records: readonly T[]): readonly (readonly T[])[] {
  const groups = new Map<string, T[]>();
  for (const record of records) {
    const key = `${record.mint}\0${record.unit}`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return Object.freeze(
    [...groups.values()].map((group) => Object.freeze([...group])),
  );
}
