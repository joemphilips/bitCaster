import { bls12_381 } from "@noble/curves/bls12-381.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/curves/utils.js";

export const CANONICAL_BLS_KEYSET_ID = `02${"22".repeat(32)}`;
export const BLS_G1_GENERATOR = bytesToHex(
  bls12_381.G1.Point.BASE.toBytes(true),
);

export function canonicalKeysetId(discriminator: number): string {
  if (
    !Number.isInteger(discriminator) ||
    discriminator < 0 ||
    discriminator > 255
  ) {
    throw new Error("Cashu test keyset discriminator is invalid");
  }
  return `00${discriminator.toString(16).padStart(2, "0").repeat(7)}`;
}

export function canonicalSecpPoint(discriminator: number): string {
  if (
    !Number.isInteger(discriminator) ||
    discriminator < 1 ||
    discriminator > 255
  ) {
    throw new Error("Cashu test point discriminator is invalid");
  }
  const privateKey = new Uint8Array(32);
  privateKey[31] = discriminator;
  return bytesToHex(secp256k1.getPublicKey(privateKey, true));
}
