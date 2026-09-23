import Dexie from "dexie";
import {
  decodeDurableCustodyScopeInput,
  type DurableCustodyExactArtifact,
  type DurableCustodyRecord,
  type DurableCustodyScope,
} from "@bitcaster/client-sdk/durableCustody";
import { readDurableCustodyAuthenticatedTerminalMintRejection } from "@bitcaster/client-sdk/durableCustodyMintResult";
import type { EncryptedWalletBackupV2CommittedTerminalSealStore } from "@bitcaster/client-sdk/encryptedWalletBackupV2ProofSet";
import {
  decodeBrowserProofBackupAuthorityTableRow,
  requireBrowserProofBackupAuthorityForProof,
  type BrowserProofBackupAuthorityRow,
} from "./browser-proof-backup-authority";
import { BrowserDurableCustodyAdapter } from "./durable-custody-db";
import { decodeBrowserCustodyProofRow, type BrowserCustodyProofRow } from "./durable-custody-types";
import { browserWalletDatabaseName } from "../lib/browserWalletProfile";
import type { BitcasterDB } from "./proof-db";

type BrowserWalletScope = Extract<DurableCustodyScope, { scopeKind: "wallet" }>;

export interface BrowserEncryptedWalletBackupV2TerminalSealStoreProfile {
  readonly database: BitcasterDB;
  readonly scopeId: string;
}

/** Reads one committed losing CTF operation from the canonical browser custody store. */
export class BrowserEncryptedWalletBackupV2TerminalSealStore implements EncryptedWalletBackupV2CommittedTerminalSealStore {
  readonly #database: BitcasterDB;
  readonly #scope: BrowserWalletScope;
  readonly #custody: BrowserDurableCustodyAdapter;

  constructor(profile: BrowserEncryptedWalletBackupV2TerminalSealStoreProfile) {
    const scope = requireWalletScope(profile.scopeId);
    if (!(profile.database instanceof Dexie)) {
      throw new Error("browser terminal seal store database is invalid");
    }
    if (profile.database.name !== browserWalletDatabaseName(scope.scopeId)) {
      throw new Error("browser terminal seal store database is foreign");
    }
    this.#database = profile.database;
    this.#scope = scope;
    this.#custody = new BrowserDurableCustodyAdapter(profile.database);
  }

  async withCommittedTerminalRejection<T>(
    operationId: string,
    read: (value: {
      readonly record: DurableCustodyRecord;
      readonly exactRejection: DurableCustodyExactArtifact;
      readonly classifiedAtMs: number;
    }) => T,
  ): Promise<T> {
    requireOperationId(operationId);
    if (typeof read !== "function") {
      throw new Error("browser terminal seal callback is invalid");
    }
    return this.#database.transaction(
      "r",
      [
        this.#database.custodyOperations,
        this.#database.custodyArtifacts,
        this.#database.custodyProofs,
        this.#database.custodyProofBackupAuthorities,
      ],
      async () => {
        const snapshot = await this.#custody.readOperationSnapshot(this.#scope, operationId);
        if (snapshot === null) {
          throw new Error("browser terminal seal operation is missing");
        }
        const record = requireTerminalOperation(snapshot.record, this.#scope, operationId);
        const exactRejection = requireTerminalRejectionArtifact(record, snapshot.artifacts);
        readDurableCustodyAuthenticatedTerminalMintRejection({ record, exactRejection });
        const classifiedAtMs = await this.#readTerminalProofAuthorities(record);
        return read({ record, exactRejection, classifiedAtMs });
      },
    );
  }

  async #readTerminalProofAuthorities(record: DurableCustodyRecord): Promise<number> {
    const operation = record.operation;
    const proofIds = operation.exactRequest.inputProofIds;
    if (
      proofIds.length === 0 ||
      new Set(proofIds).size !== proofIds.length ||
      operation.reservation.inputs.length !== proofIds.length ||
      operation.reservation.inputs.some(({ proofId }, index) => proofId !== proofIds[index]) ||
      operation.proofStorage.lineage.predecessorProofIds.length !== proofIds.length ||
      operation.proofStorage.lineage.predecessorProofIds.some(
        (proofId, index) => proofId !== proofIds[index],
      )
    ) {
      throw new Error("browser terminal seal input proof authority is invalid");
    }
    const keys = proofIds.map((proofId) => [this.#scope.scopeId, proofId] as [string, string]);
    const [rawProofs, rawAuthorities] = await Promise.all([
      this.#database.custodyProofs.bulkGet(keys),
      this.#database.custodyProofBackupAuthorities.bulkGet(keys),
    ]);
    let classifiedAtMs: number | undefined;
    for (const [index, proofId] of proofIds.entries()) {
      const rawProof = rawProofs[index];
      const rawAuthority = rawAuthorities[index];
      if (!rawAuthority) {
        throw new Error("browser terminal seal input proof authority is incomplete");
      }
      const tableRow = decodeBrowserProofBackupAuthorityTableRow(rawAuthority);
      if ("recordKind" in tableRow) {
        if (
          rawProof !== undefined ||
          tableRow.scopeId !== this.#scope.scopeId ||
          tableRow.proofId !== proofId ||
          (tableRow.recordKind === "completed-local-removal" &&
            tableRow.terminalOperationId !== operation.operationId)
        ) {
          throw new Error("browser terminal seal removed predecessor authority is invalid");
        }
        // A completed sibling no longer has a body. It cannot classify the retained inputs.
        continue;
      }
      if (!rawProof) {
        throw new Error("browser terminal seal input proof authority is incomplete");
      }
      const proof = decodeBrowserCustodyProofRow(rawProof);
      const authority = requireBrowserProofBackupAuthorityForProof(tableRow, proof);
      requireTerminalProof(proof, authority, this.#scope.scopeId, proofId, operation);
      if (classifiedAtMs === undefined) {
        classifiedAtMs = authority.updatedAtMs;
      } else if (authority.updatedAtMs !== classifiedAtMs) {
        throw new Error("browser terminal seal classification time is unstable");
      }
    }
    if (classifiedAtMs === undefined) {
      throw new Error("browser terminal seal classification time is missing");
    }
    return classifiedAtMs;
  }
}

function requireWalletScope(scopeId: string): BrowserWalletScope {
  const decoded = decodeDurableCustodyScopeInput(scopeId);
  if (decoded.scopeKind !== "wallet") {
    throw new Error("browser terminal seal store requires a wallet scope");
  }
  return { ...decoded, scopeId };
}

function requireOperationId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 16 * 1024) {
    throw new Error("browser terminal seal operation id is invalid");
  }
}

function requireTerminalOperation(
  record: DurableCustodyRecord,
  scope: BrowserWalletScope,
  operationId: string,
): DurableCustodyRecord {
  if (
    record.scope.scopeKind !== "wallet" ||
    record.scope.scopeId !== scope.scopeId ||
    record.operation.operationId !== operationId ||
    record.operation.semanticKind !== "ctf-redeem" ||
    record.operation.state !== "aborted" ||
    record.operation.terminalMintRejection === null ||
    record.operation.terminalMintRejection.code !== 13015
  ) {
    throw new Error("browser terminal seal operation authority is invalid");
  }
  return record;
}

function requireTerminalRejectionArtifact(
  record: DurableCustodyRecord,
  artifacts: readonly {
    reference: { artifactId: string };
    artifact: DurableCustodyExactArtifact;
  }[],
): DurableCustodyExactArtifact {
  const reference = record.operation.terminalMintRejection?.exactRejection;
  if (reference === undefined) {
    throw new Error("browser terminal seal rejection artifact reference is missing");
  }
  const matches = artifacts.filter(
    ({ reference: candidate }) => candidate.artifactId === reference.artifactId,
  );
  if (matches.length !== 1) {
    throw new Error("browser terminal seal rejection artifact is invalid");
  }
  return matches[0]!.artifact;
}

function requireTerminalProof(
  proof: BrowserCustodyProofRow,
  authority: BrowserProofBackupAuthorityRow,
  scopeId: string,
  proofId: string,
  operation: DurableCustodyRecord["operation"],
): void {
  const expected = operation.reservation.inputs.find((input) => input.proofId === proofId);
  if (
    proof.scopeId !== scopeId ||
    proof.proofId !== proofId ||
    proof.assetKind !== "conditional" ||
    proof.unit !== "msat" ||
    proof.selectability !== "verified-losing" ||
    proof.reservationOperationId !== null ||
    expected === undefined ||
    proof.keysetId !== expected.keysetId ||
    proof.curve !== expected.curve ||
    authority.scopeId !== scopeId ||
    authority.proofId !== proofId ||
    authority.proofRevision !== proof.revision ||
    authority.proofState !== "verified-losing" ||
    authority.terminalOperationId !== operation.operationId ||
    authority.recordUpdatedAtUnixSeconds !== Math.floor(authority.updatedAtMs / 1_000)
  ) {
    throw new Error("browser terminal seal input proof authority is invalid");
  }
}
