import type { DatabaseSync } from 'node:sqlite'
import {
  deserializeDurableCustodyProofArtifact,
  serializeDurableCustodyProofArtifact,
} from '@bitcaster-market/client-sdk/durableCustodyProofMaterial'
import type { DurableCustodyMintKeysetAuthority } from '@bitcaster-market/client-sdk/durableCustodyMintResult'
import type { Proof } from '@cashu/cashu-ts'
import type { StoredProofAsset } from './state.ts'

export const WALLET_PROOF_IMPORT_SCHEMA_SQL = [
  `CREATE TABLE wallet_proof_import_roots (
    root_id TEXT PRIMARY KEY NOT NULL CHECK (length(root_id) BETWEEN 1 AND 256),
    scope_id TEXT NOT NULL REFERENCES custody_scopes(scope_id),
    normalized_mint TEXT NOT NULL CHECK (length(normalized_mint) BETWEEN 1 AND 2048),
    unit TEXT NOT NULL CHECK (unit = 'msat'),
    base_asset TEXT NOT NULL CHECK (base_asset = 'sat'),
    condition_id TEXT NOT NULL CHECK (length(condition_id) BETWEEN 1 AND 1024),
    outcome_set_id TEXT NOT NULL CHECK (length(outcome_set_id) BETWEEN 1 AND 1024),
    source_fingerprint TEXT NOT NULL CHECK (length(source_fingerprint) = 64 AND source_fingerprint NOT GLOB '*[^0-9a-f]*'),
    proof_count INTEGER NOT NULL CHECK (proof_count BETWEEN 1 AND 65536),
    page_count INTEGER NOT NULL CHECK (page_count = (proof_count + 31) / 32),
    source_body BLOB NOT NULL CHECK (length(source_body) BETWEEN 1 AND 16777216),
    state TEXT NOT NULL CHECK (state IN ('active', 'complete')),
    UNIQUE (scope_id, root_id)
  ) STRICT`,
  `CREATE TABLE wallet_proof_import_pages (
    scope_id TEXT NOT NULL,
    root_id TEXT NOT NULL,
    page_index INTEGER NOT NULL CHECK (page_index BETWEEN 0 AND 2047),
    proof_count INTEGER NOT NULL CHECK (proof_count BETWEEN 1 AND 32),
    expected_operation_id TEXT NOT NULL CHECK (length(expected_operation_id) BETWEEN 1 AND 16384),
    bound_operation_id TEXT CHECK (bound_operation_id IS NULL OR bound_operation_id = expected_operation_id),
    PRIMARY KEY (scope_id, root_id, page_index),
    UNIQUE (scope_id, expected_operation_id),
    FOREIGN KEY (scope_id, root_id) REFERENCES wallet_proof_import_roots(scope_id, root_id),
    FOREIGN KEY (scope_id, bound_operation_id) REFERENCES custody_operations(scope_id, operation_id)
  ) STRICT`,
  `CREATE INDEX wallet_proof_import_active_idx ON wallet_proof_import_roots(scope_id, root_id) WHERE state = 'active'`,
  `CREATE TABLE wallet_proof_import_recovery_cursors (
    scope_id TEXT PRIMARY KEY NOT NULL REFERENCES custody_scopes(scope_id),
    root_id TEXT,
    FOREIGN KEY (scope_id, root_id) REFERENCES wallet_proof_import_roots(scope_id, root_id)
  ) STRICT`,
  `CREATE TRIGGER wallet_proof_import_root_immutable BEFORE UPDATE OF root_id, scope_id, normalized_mint, unit, base_asset, condition_id, outcome_set_id, source_fingerprint, proof_count, page_count, source_body ON wallet_proof_import_roots BEGIN SELECT RAISE(ABORT, 'wallet import source is immutable'); END`,
  `CREATE TRIGGER wallet_proof_import_page_insert BEFORE INSERT ON wallet_proof_import_pages WHEN NOT EXISTS (
    SELECT 1 FROM wallet_proof_import_roots r WHERE r.scope_id = NEW.scope_id AND r.root_id = NEW.root_id
      AND r.state = 'active' AND NEW.page_index < r.page_count
      AND NEW.proof_count = min(32, r.proof_count - NEW.page_index * 32)
  ) BEGIN SELECT RAISE(ABORT, 'wallet import page is foreign'); END`,
  `CREATE TRIGGER wallet_proof_import_page_immutable BEFORE UPDATE OF scope_id, root_id, page_index, proof_count, expected_operation_id ON wallet_proof_import_pages BEGIN SELECT RAISE(ABORT, 'wallet import page is immutable'); END`,
  `CREATE TRIGGER wallet_proof_import_page_binding_immutable BEFORE UPDATE OF bound_operation_id ON wallet_proof_import_pages WHEN OLD.bound_operation_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'wallet import page binding is immutable'); END`,
  `CREATE TRIGGER wallet_proof_import_complete BEFORE UPDATE OF state ON wallet_proof_import_roots WHEN OLD.state = 'complete' OR NEW.state <> 'complete' OR
    (SELECT count(*) FROM wallet_proof_import_pages p JOIN custody_operations o ON o.scope_id = p.scope_id AND o.operation_id = p.bound_operation_id
      WHERE p.scope_id = NEW.scope_id AND p.root_id = NEW.root_id AND o.result_state = 'applied') <> NEW.page_count
    BEGIN SELECT RAISE(ABORT, 'wallet import is incomplete'); END`,
  ...['roots', 'pages'].map(
    (table) =>
      `CREATE TRIGGER wallet_proof_import_${table}_no_delete BEFORE DELETE ON wallet_proof_import_${table} BEGIN SELECT RAISE(ABORT, 'wallet import history is retained'); END`,
  ),
] as const

export interface WalletProofImportSource {
  readonly rootId: string
  readonly scopeId: string
  readonly mintUrl: string
  readonly asset: Extract<StoredProofAsset, { kind: 'Outcome' }>
  readonly fingerprint: string
  readonly proofs: readonly Proof[]
  readonly keysets: readonly DurableCustodyMintKeysetAuthority[]
}

export function encodeWalletProofImportSource(source: WalletProofImportSource): Uint8Array {
  const body = Buffer.from(
    JSON.stringify({
      version: 1,
      proofs: source.proofs.map(serializeDurableCustodyProofArtifact),
      keysets: source.keysets.map(decodeKeyset),
    }),
  )
  if (body.length > 16 * 1024 * 1024)
    throw new Error('wallet proof import source exceeds artifact bound')
  return body
}

export class WalletProofImportSqlite {
  readonly database: DatabaseSync
  constructor(database: DatabaseSync) {
    this.database = database
  }

  save(source: WalletProofImportSource, operationIds: readonly string[]): void {
    const body = encodeWalletProofImportSource(source)
    this.database
      .prepare(
        `INSERT INTO wallet_proof_import_roots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      )
      .run(
        source.rootId,
        source.scopeId,
        source.mintUrl,
        source.asset.unit,
        source.asset.baseAsset,
        source.asset.conditionId,
        source.asset.outcomeSetId,
        source.fingerprint,
        source.proofs.length,
        operationIds.length,
        body,
      )
    operationIds.forEach((operationId, index) =>
      this.database
        .prepare(`INSERT INTO wallet_proof_import_pages VALUES (?, ?, ?, ?, ?, NULL)`)
        .run(
          source.scopeId,
          source.rootId,
          index,
          Math.min(32, source.proofs.length - index * 32),
          operationId,
        ),
    )
  }

  load(scopeId: string, rootId: string): WalletProofImportSource | null {
    const row = this.database
      .prepare(`SELECT * FROM wallet_proof_import_roots WHERE scope_id = ? AND root_id = ?`)
      .get(scopeId, rootId)
    if (row === undefined) return null
    const body = row.source_body
    if (!(body instanceof Uint8Array) || body.length > 16 * 1024 * 1024)
      throw new Error('wallet proof import source is invalid')
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
    if (
      !objectHasKeys(value, 'keysets,proofs,version') ||
      value.version !== 1 ||
      !Array.isArray(value.proofs) ||
      !Array.isArray(value.keysets)
    )
      throw new Error('wallet proof import source is invalid')
    const proofs = value.proofs.map(deserializeDurableCustodyProofArtifact)
    const keysets = value.keysets.map(decodeKeyset)
    if (proofs.length !== row.proof_count || keysets.length < 1 || keysets.length > 256)
      throw new Error('wallet proof import manifest is incomplete')
    return {
      rootId,
      scopeId,
      mintUrl: text(row.normalized_mint),
      fingerprint: text(row.source_fingerprint),
      proofs,
      keysets,
      asset: {
        kind: 'Outcome',
        unit: 'msat',
        baseAsset: 'sat',
        conditionId: text(row.condition_id),
        outcomeSetId: text(row.outcome_set_id),
      },
    }
  }

  assertPages(source: WalletProofImportSource, operationIds: readonly string[]): void {
    const rows = this.database
      .prepare(
        `SELECT * FROM wallet_proof_import_pages WHERE scope_id = ? AND root_id = ? ORDER BY page_index`,
      )
      .all(source.scopeId, source.rootId)
    if (
      rows.length !== operationIds.length ||
      rows.some(
        (row, index) =>
          row.page_index !== index ||
          row.expected_operation_id !== operationIds[index] ||
          row.proof_count !== Math.min(32, source.proofs.length - index * 32),
      )
    )
      throw new Error('wallet proof import page manifest is incomplete')
  }

  bindPage(scopeId: string, rootId: string, pageIndex: number, operationId: string): void {
    const row = this.database
      .prepare(
        `SELECT bound_operation_id FROM wallet_proof_import_pages WHERE scope_id = ? AND root_id = ? AND page_index = ? AND expected_operation_id = ?`,
      )
      .get(scopeId, rootId, pageIndex, operationId)
    if (row === undefined) throw new Error('wallet proof import page manifest is missing')
    if (row.bound_operation_id === operationId) return
    this.database
      .prepare(
        `UPDATE wallet_proof_import_pages SET bound_operation_id = ? WHERE scope_id = ? AND root_id = ? AND page_index = ?`,
      )
      .run(operationId, scopeId, rootId, pageIndex)
  }

  complete(scopeId: string, rootId: string): boolean {
    const result = this.database
      .prepare(
        `UPDATE wallet_proof_import_roots SET state = 'complete' WHERE scope_id = ? AND root_id = ? AND state = 'active'`,
      )
      .run(scopeId, rootId)
    return result.changes === 1
  }
}

function objectHasKeys(value: unknown, keys: string): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === keys
  )
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error('wallet proof import text is invalid')
  return value
}

function decodeKeyset(value: unknown): DurableCustodyMintKeysetAuthority {
  if (
    !objectHasKeys(value, 'canonicalMintUrl,finalExpiry,id,identity,inputFeePpk,keys,unit') ||
    value.unit !== 'msat' ||
    !Number.isSafeInteger(value.inputFeePpk) ||
    Number(value.inputFeePpk) < 0 ||
    (value.finalExpiry !== null &&
      (!Number.isSafeInteger(value.finalExpiry) || Number(value.finalExpiry) < 0)) ||
    !objectHasKeys(value.identity, 'conditionId,kind,outcomeCollection,outcomeCollectionId') ||
    value.identity.kind !== 'conditional' ||
    value.keys === null ||
    typeof value.keys !== 'object' ||
    Array.isArray(value.keys)
  )
    throw new Error('wallet proof import keyset is invalid')
  const keys = Object.fromEntries(
    Object.entries(value.keys).map(([amount, key]) => {
      if (!/^[1-9][0-9]*$/.test(amount) || !/^(02|03)[0-9a-f]{64}$/.test(text(key)))
        throw new Error('wallet proof import keyset keys are invalid')
      return [amount, text(key)]
    }),
  )
  if (Object.keys(keys).length < 1 || Object.keys(keys).length > 256)
    throw new Error('wallet proof import keyset keys are invalid')
  return {
    canonicalMintUrl: text(value.canonicalMintUrl),
    id: text(value.id),
    unit: 'msat',
    keys,
    inputFeePpk: Number(value.inputFeePpk),
    finalExpiry: value.finalExpiry === null ? null : Number(value.finalExpiry),
    identity: {
      kind: 'conditional',
      conditionId: text(value.identity.conditionId),
      outcomeCollection: text(value.identity.outcomeCollection),
      outcomeCollectionId: text(value.identity.outcomeCollectionId),
    },
  }
}
