import { Amount, type Proof } from "@cashu/cashu-ts";
import {
  amountToNumber,
  sameCashuProofArtifact,
  type CashuProofArtifactLike,
} from "@bitcaster/client-sdk/proofSelection";

const FIELD_LENGTH_MAX = 4_096;
const SERIALIZED_PROOF_BYTES_MAX = 16_384;
const WITNESS_SIGNATURES_MAX = 64;

export function sameCashuProofSet(
  left: readonly CashuProofArtifactLike[],
  right: readonly CashuProofArtifactLike[],
): boolean {
  if (left.length !== right.length) return false;
  const rightBySecret = new Map(right.map((proof) => [proof.secret, proof]));
  return left.every((proof) =>
    sameCashuProofArtifact(proof, rightBySecret.get(proof.secret)),
  );
}

export function normalizeCashuProofs(
  candidate: unknown,
  label: string,
): Proof[] {
  if (!Array.isArray(candidate)) throw new Error(`${label} are invalid`);
  return candidate.map((value) => normalizeProof(value, label));
}

function normalizeProof(value: unknown, label: string): Proof {
  const proof = requireRecord(value, label);
  requireExactFields(proof, ["id", "amount", "secret", "C"], [
    "dleq",
    "p2pk_e",
    "witness",
  ]);
  const amount = amountToNumber(proof.amount as never);
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new Error(`${label} amount is invalid`);
  }
  const normalized: Proof = {
    id: requireText(proof.id, `${label} keyset id`),
    amount: Amount.from(amount),
    secret: requireText(proof.secret, `${label} secret`),
    C: requireText(proof.C, `${label} signature`),
    ...(proof.dleq === undefined ? {} : { dleq: normalizeDleq(proof.dleq) }),
    ...(proof.p2pk_e === undefined
      ? {}
      : { p2pk_e: requireText(proof.p2pk_e, `${label} P2PK E`) }),
    ...(proof.witness === undefined
      ? {}
      : { witness: normalizeWitness(proof.witness) }),
  };
  if (
    new TextEncoder().encode(JSON.stringify(normalized)).byteLength >
    SERIALIZED_PROOF_BYTES_MAX
  ) {
    throw new Error(`${label} is too large`);
  }
  return normalized;
}

function normalizeDleq(value: unknown): NonNullable<Proof["dleq"]> {
  const dleq = requireRecord(value, "proof DLEQ");
  requireExactFields(dleq, ["s", "e"], ["r"]);
  return {
    s: requireText(dleq.s, "proof DLEQ s"),
    e: requireText(dleq.e, "proof DLEQ e"),
    ...(dleq.r === undefined
      ? {}
      : { r: requireText(dleq.r, "proof DLEQ r") }),
  };
}

function normalizeWitness(value: unknown): NonNullable<Proof["witness"]> {
  if (typeof value === "string") return requireText(value, "proof witness");
  const witness = requireRecord(value, "proof witness");
  requireExactFields(witness, [], ["preimage", "signatures"]);
  const signatures =
    witness.signatures === undefined
      ? undefined
      : normalizeSignatures(witness.signatures);
  if (witness.preimage !== undefined) {
    return {
      preimage: requireText(witness.preimage, "proof preimage"),
      ...(signatures === undefined ? {} : { signatures }),
    };
  }
  return signatures === undefined ? {} : { signatures };
}

function normalizeSignatures(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > WITNESS_SIGNATURES_MAX) {
    throw new Error("proof witness signatures are invalid");
  }
  return value.map((signature) =>
    requireText(signature, "proof witness signature"),
  );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function requireExactFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    Object.keys(value).some((field) => !allowed.has(field)) ||
    required.some((field) => !Object.hasOwn(value, field))
  ) {
    throw new Error("proof fields are invalid");
  }
}

function requireText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > FIELD_LENGTH_MAX
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}
