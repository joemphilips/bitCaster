import type { Proof } from "@cashu/cashu-ts";
import {
  deriveDurableCustodyProofId,
  DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX,
} from "@bitcaster/client-sdk/durableCustody";
import { decodeDurableCustodyProofMaterialRecord } from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import { normalizeUrl } from "../lib/url";
import {
  bindBrowserProofBackupAuthorityTerminalOperation,
  requireBrowserProofBackupAuthorityForProof,
} from "./browser-proof-backup-authority";
import { decodeBrowserCustodyProofRow } from "./durable-custody-db";
import {
  db,
  storedProofFromRow,
  storedProofRow,
  type BitcasterDB,
  type ProofOperationRecord,
} from "./proof-db";

const ORACLE_NOT_ATTESTED_OUTCOME_CODE = 13015;

/** Bind local and custody proofs to one committed losing CTF redeem operation. */
export async function bindBrowserCtfRedeemTerminalProofs(input: {
  readonly operationId: string;
  readonly mintUrl: string;
  readonly scopeId: string;
  readonly unit: "msat";
  readonly proofs: readonly Pick<Proof, "id" | "secret">[];
  readonly database?: BitcasterDB;
}): Promise<void> {
  const database = input.database ?? db;
  const requested = requireDistinctNamedProofs(input.proofs);
  const normalizedMint = normalizeUrl(input.mintUrl);
  await database.transaction(
    "rw",
    database.proofOperations,
    database.proofs,
    database.custodyProofs,
    database.custodyProofBackupAuthorities,
    async () => {
      const operation = await database.proofOperations.get(input.operationId);
      const classifiedAtMs = requireTerminalCtfRedeemOperation(
        operation,
        input.operationId,
        normalizedMint,
        requested,
      );
      const inventory = await requireInventoryProofs(database, requested);
      const custody = await matchingCustodyProofs(database, requested, {
        scopeId: input.scopeId,
        normalizedMint,
        unit: input.unit,
      });
      await bindInventoryProofs(database, inventory, input.operationId);
      await bindCustodyProofs(database, custody, input.operationId, classifiedAtMs);
    },
  );
}

function requireTerminalCtfRedeemOperation(
  operation: ProofOperationRecord | undefined,
  operationId: string,
  normalizedMint: string,
  requested: ReadonlyMap<string, NamedProof>,
): number {
  if (
    !operation ||
    operation.operationId !== operationId ||
    operation.kind !== "ctf-redeem" ||
    operation.state !== "Failed" ||
    operation.failureCode !== ORACLE_NOT_ATTESTED_OUTCOME_CODE ||
    normalizeUrl(operation.mintUrl) !== normalizedMint
  ) {
    throw new Error("browser CTF terminal operation is invalid");
  }
  const committed = requireDistinctNamedProofs(operation.inputs);
  if (!sameNamedProofs(committed, requested)) {
    throw new Error("browser CTF terminal operation inputs are invalid");
  }
  return requireTime(operation.updatedAt, "browser CTF terminal operation time");
}

async function requireInventoryProofs(
  database: BitcasterDB,
  requested: ReadonlyMap<string, NamedProof>,
): Promise<Map<string, ReturnType<typeof storedProofFromRow>>> {
  const rows = await database.proofs.bulkGet([...requested.values()].map(({ secret }) => secret));
  const inventory = new Map<string, ReturnType<typeof storedProofFromRow>>();
  for (const row of rows) {
    if (!row) throw new Error("browser CTF terminal proof inventory is incomplete");
    const proof = storedProofFromRow(row);
    const key = namedProofKey(proof);
    if (!requested.has(key) || inventory.has(key)) {
      throw new Error("browser CTF terminal proof inventory is invalid");
    }
    inventory.set(key, proof);
  }
  if (inventory.size !== requested.size) {
    throw new Error("browser CTF terminal proof inventory is incomplete");
  }
  return inventory;
}

async function matchingCustodyProofs(
  database: BitcasterDB,
  requested: ReadonlyMap<string, NamedProof>,
  identity: { scopeId: string; normalizedMint: string; unit: "msat" },
): Promise<readonly TerminalCustodyProof[]> {
  const proofs = [...requested.values()];
  const keys = proofs.map(
    (proof) =>
      [
        identity.scopeId,
        deriveDurableCustodyProofId({
          scopeId: identity.scopeId,
          normalizedMint: identity.normalizedMint,
          unit: identity.unit,
          keysetId: proof.id,
          secret: proof.secret,
        }),
      ] as [string, string],
  );
  const [rawProofs, rawAuthorities] = await Promise.all([
    database.custodyProofs.bulkGet(keys),
    database.custodyProofBackupAuthorities.bulkGet(keys),
  ]);
  const matches: TerminalCustodyProof[] = [];
  for (const [index, proof] of proofs.entries()) {
    const rawProof = rawProofs[index];
    const rawAuthority = rawAuthorities[index];
    if (!rawProof || !rawAuthority) {
      throw new Error("browser CTF terminal custody proof is incomplete");
    }
    const custody = decodeBrowserCustodyProofRow(rawProof);
    const material = decodeDurableCustodyProofMaterialRecord(custody).proof;
    if (
      custody.scopeId !== identity.scopeId ||
      custody.normalizedMint !== identity.normalizedMint ||
      custody.unit !== identity.unit ||
      namedProofKey(material) !== namedProofKey(proof)
    ) {
      throw new Error("browser CTF terminal custody proof is invalid");
    }
    matches.push({
      custody,
      authority: requireBrowserProofBackupAuthorityForProof(rawAuthority, custody),
    });
  }
  return matches;
}

function bindInventoryProofs(
  database: BitcasterDB,
  inventory: ReadonlyMap<string, ReturnType<typeof storedProofFromRow>>,
  operationId: string,
): Promise<void> {
  const changed = [...inventory.values()].map((proof) => {
    if (proof.terminalOperationId === operationId) return storedProofRow(proof);
    if (proof.terminalOperationId !== undefined) {
      throw new Error("browser CTF terminal proof operation conflicts");
    }
    return storedProofRow({ ...proof, terminalOperationId: operationId });
  });
  return database.proofs.bulkPut(changed);
}

async function bindCustodyProofs(
  database: BitcasterDB,
  matches: readonly TerminalCustodyProof[],
  operationId: string,
  classifiedAtMs: number,
): Promise<void> {
  await database.custodyProofBackupAuthorities.bulkPut(
    matches.map(({ authority }) =>
      bindBrowserProofBackupAuthorityTerminalOperation(authority, operationId, classifiedAtMs),
    ),
  );
}

interface TerminalCustodyProof {
  readonly custody: ReturnType<typeof decodeBrowserCustodyProofRow>;
  readonly authority: ReturnType<typeof requireBrowserProofBackupAuthorityForProof>;
}

interface NamedProof {
  readonly id: string;
  readonly secret: string;
}

function requireDistinctNamedProofs(
  value: readonly Pick<Proof, "id" | "secret">[],
): Map<string, NamedProof> {
  if (value.length < 1 || value.length > DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX) {
    throw new Error("browser CTF terminal proofs are invalid");
  }
  const named = new Map<string, NamedProof>();
  for (const proof of value) {
    const namedProof = requireNamedProof(proof);
    const key = namedProofKey(namedProof);
    if (named.has(key)) throw new Error("browser CTF terminal proofs are duplicated");
    named.set(key, namedProof);
  }
  return named;
}

function requireNamedProof(value: Pick<Proof, "id" | "secret">): NamedProof {
  if (
    typeof value.id !== "string" ||
    value.id.length < 1 ||
    typeof value.secret !== "string" ||
    value.secret.length < 1
  ) {
    throw new Error("browser CTF terminal proof is invalid");
  }
  return { id: value.id, secret: value.secret };
}

function namedProofKey(value: Pick<Proof, "id" | "secret">): string {
  return `${value.id}\u0000${value.secret}`;
}

function sameNamedProofs(
  left: ReadonlyMap<string, NamedProof>,
  right: ReadonlyMap<string, NamedProof>,
): boolean {
  return left.size === right.size && [...left.keys()].every((key) => right.has(key));
}

function requireTime(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} is invalid`);
  }
  return value as number;
}
