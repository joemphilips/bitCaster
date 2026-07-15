import Dexie from "dexie";
import type { BitcasterDB } from "./proof-db";

export function requireGuiDexieWriteTransaction(
  database: BitcasterDB,
  message: string,
): void {
  const transaction = Dexie.currentTransaction;
  if (
    !transaction ||
    transaction.db !== database ||
    transaction.mode !== "readwrite"
  ) {
    throw new Error(message);
  }
}
