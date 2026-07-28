import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { isDeepStrictEqual } from 'node:util'
import { format as formatWithPrettier, resolveConfig as resolvePrettierConfig } from 'prettier'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = resolve(SCRIPT_DIR, '..')
const OUTPUT_FILE = resolve(ROOT_DIR, 'test-vectors/nut-ctf-range-v1/vectors.json')
const HASH_TO_CURVE_DOMAIN = Buffer.from('Secp256k1_HashToCurve_Cashu_', 'utf8')
const ZERO_PARENT = '00'.repeat(32)
const CONDITION_ID = sha256Hex('bitcaster/nut-ctf-range-v1/condition')
const EXPIRY = '1800000000'
const FINAL_EXPIRY = '1800003600'
const FIELD_PRIME = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn
const GROUP_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const GENERATOR = Object.freeze({
  x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
})
const OUTPUT_MATERIAL = new Map()
const REFUND_PRIVATE_KEYS = new Map()

const KEYSETS = Object.freeze({
  collateral: createKeyset({
    keyMaterialLabel: 'collateral',
    input_fee_ppk: 200,
    unit: 'sat',
    final_expiry: null,
    outcome_collection: null,
    published_denominations: [
      '1',
      '2',
      '4',
      '8',
      '16',
      '32',
      '40',
      '41',
      '59',
      '60',
      '61',
      '64',
      '100',
      '101',
      '128',
      '202',
      '256',
    ],
    covers: ['YES', 'NO'],
  }),
  collateralRotated: createKeyset({
    keyMaterialLabel: 'collateral-rotated',
    input_fee_ppk: 200,
    unit: 'sat',
    final_expiry: null,
    outcome_collection: null,
    published_denominations: ['40', '59', '60', '100', '202'],
    covers: ['YES', 'NO'],
  }),
  yes: createKeyset({
    keyMaterialLabel: 'yes',
    input_fee_ppk: 500,
    unit: 'sat',
    final_expiry: Number(FINAL_EXPIRY),
    outcome_collection: 'YES',
    published_denominations: [
      '1',
      '2',
      '4',
      '5',
      '6',
      '7',
      '8',
      '16',
      '32',
      '39',
      '61',
      '64',
      '99',
      '100',
      '128',
      '256',
    ],
    covers: ['YES'],
  }),
  yesRotated: createKeyset({
    keyMaterialLabel: 'yes-rotated',
    input_fee_ppk: 500,
    unit: 'sat',
    final_expiry: Number(FINAL_EXPIRY),
    outcome_collection: 'YES',
    published_denominations: ['4', '6', '99'],
    covers: ['YES'],
  }),
  no: createKeyset({
    keyMaterialLabel: 'no',
    input_fee_ppk: 500,
    unit: 'sat',
    final_expiry: Number(FINAL_EXPIRY),
    outcome_collection: 'NO',
    published_denominations: ['1', '2', '4', '8', '16', '32', '64', '100', '128', '256'],
    covers: ['NO'],
  }),
})

function sha256(value) {
  return createHash('sha256').update(value).digest()
}

function sha256Hex(value) {
  return sha256(value).toString('hex')
}

function taggedHash(tag, message) {
  const tagHash = sha256(Buffer.from(tag, 'utf8'))
  return sha256(Buffer.concat([tagHash, tagHash, message]))
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('JCS numbers must be finite')
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    return `{${entries.join(',')}}`
  }
  throw new TypeError(`Unsupported JCS value type: ${typeof value}`)
}

function modulo(value, modulus = FIELD_PRIME) {
  const result = value % modulus
  return result >= 0n ? result : result + modulus
}

function powerMod(base, exponent) {
  let result = 1n
  let factor = modulo(base)
  let remaining = exponent
  while (remaining > 0n) {
    if ((remaining & 1n) === 1n) result = modulo(result * factor)
    factor = modulo(factor * factor)
    remaining >>= 1n
  }
  return result
}

function invert(value) {
  if (modulo(value) === 0n) throw new Error('cannot invert zero')
  return powerMod(value, FIELD_PRIME - 2n)
}

function addPoints(left, right) {
  if (left === null) return right
  if (right === null) return left
  if (left.x === right.x && modulo(left.y + right.y) === 0n) return null
  const slope =
    left.x === right.x && left.y === right.y
      ? modulo(3n * left.x * left.x * invert(2n * left.y))
      : modulo((right.y - left.y) * invert(right.x - left.x))
  const x = modulo(slope * slope - left.x - right.x)
  return { x, y: modulo(slope * (left.x - x) - left.y) }
}

function multiplyPoint(scalar, point) {
  let result = null
  let addend = point
  let remaining = modulo(scalar, GROUP_ORDER)
  while (remaining > 0n) {
    if ((remaining & 1n) === 1n) result = addPoints(result, addend)
    addend = addPoints(addend, addend)
    remaining >>= 1n
  }
  if (result === null) throw new Error('point multiplication produced infinity')
  return result
}

function scalarFromLabel(label) {
  const digest = BigInt(`0x${sha256Hex(`bitcaster/vector/scalar/${label}`)}`)
  return (digest % (GROUP_ORDER - 1n)) + 1n
}

function compressedPoint(point) {
  const prefix = point.y % 2n === 0n ? '02' : '03'
  return `${prefix}${point.x.toString(16).padStart(64, '0')}`
}

function pointFromCompressedHex(encoded) {
  if (!/^(02|03)[0-9a-f]{64}$/.test(encoded)) {
    throw new TypeError('compressed secp256k1 point must be lowercase 33-byte hex')
  }
  const x = BigInt(`0x${encoded.slice(2)}`)
  if (x >= FIELD_PRIME) throw new TypeError('compressed point x is outside the field')
  const rhs = modulo(x * x * x + 7n)
  let y = powerMod(rhs, (FIELD_PRIME + 1n) / 4n)
  if (modulo(y * y) !== rhs) throw new TypeError('compressed point is not on secp256k1')
  const expectedOdd = encoded.startsWith('03')
  if ((y % 2n === 1n) !== expectedOdd) y = FIELD_PRIME - y
  return { x, y }
}

function scalarBytes(scalar) {
  return Buffer.from(scalar.toString(16).padStart(64, '0'), 'hex')
}

function xorBytes(left, right) {
  if (left.length !== right.length) throw new Error('xor inputs must have equal length')
  return Buffer.from(left.map((value, index) => value ^ right[index]))
}

function schnorrSignDigest(privateKey, digest) {
  if (digest.length !== 32) throw new TypeError('BIP-340 digest must be 32 bytes')
  const publicPoint = multiplyPoint(privateKey, GENERATOR)
  const normalizedPrivateKey = publicPoint.y % 2n === 0n ? privateKey : GROUP_ORDER - privateKey
  const publicX = Buffer.from(publicPoint.x.toString(16).padStart(64, '0'), 'hex')
  const auxiliary = Buffer.alloc(32)
  const nonceInput = Buffer.concat([
    xorBytes(scalarBytes(normalizedPrivateKey), taggedHash('BIP0340/aux', auxiliary)),
    publicX,
    digest,
  ])
  const nonce = BigInt(`0x${taggedHash('BIP0340/nonce', nonceInput).toString('hex')}`) % GROUP_ORDER
  if (nonce === 0n) throw new Error('deterministic BIP-340 nonce is zero')
  const noncePoint = multiplyPoint(nonce, GENERATOR)
  const normalizedNonce = noncePoint.y % 2n === 0n ? nonce : GROUP_ORDER - nonce
  const nonceX = Buffer.from(noncePoint.x.toString(16).padStart(64, '0'), 'hex')
  const challenge =
    BigInt(
      `0x${taggedHash('BIP0340/challenge', Buffer.concat([nonceX, publicX, digest])).toString(
        'hex',
      )}`,
    ) % GROUP_ORDER
  const signatureScalar = modulo(normalizedNonce + challenge * normalizedPrivateKey, GROUP_ORDER)
  return Buffer.concat([nonceX, scalarBytes(signatureScalar)]).toString('hex')
}

function hashToCurveBytes(secretBytes) {
  const messageHash = sha256(Buffer.concat([HASH_TO_CURVE_DOMAIN, secretBytes]))
  for (let counter = 0; counter <= 0xffffffff; counter += 1) {
    const counterBytes = Buffer.alloc(4)
    counterBytes.writeUInt32LE(counter)
    const digest = sha256(Buffer.concat([messageHash, counterBytes]))
    const x = BigInt(`0x${digest.toString('hex')}`)
    if (x >= FIELD_PRIME) continue
    const rhs = modulo(x * x * x + 7n)
    let y = powerMod(rhs, (FIELD_PRIME + 1n) / 4n)
    if (modulo(y * y) !== rhs) continue
    if (y % 2n !== 0n) y = FIELD_PRIME - y
    return { x, y }
  }
  throw new Error('hash_to_curve counter exhausted')
}

function hashToCurvePoint(secret) {
  return hashToCurveBytes(Buffer.from(secret, 'utf8'))
}

function hashToCurve(secret) {
  return compressedPoint(hashToCurvePoint(secret))
}

function outcomeCollectionId(outcomeCollection) {
  const commitment = taggedHash(
    'Cashu_outcome_collection_id',
    Buffer.concat([Buffer.from(CONDITION_ID, 'hex'), Buffer.from(outcomeCollection, 'utf8')]),
  )
  return hashToCurveBytes(commitment).x.toString(16).padStart(64, '0')
}

function mintPrivateKey(keyMaterialLabel, amount) {
  return scalarFromLabel(`mint/${keyMaterialLabel}/${amount}`)
}

function mintPublicKey(keyMaterialLabel, amount) {
  return compressedPoint(multiplyPoint(mintPrivateKey(keyMaterialLabel, amount), GENERATOR))
}

function keysetIdPreimage(spec, keys, collectionId) {
  const sortedAmounts = [...spec.published_denominations].sort((left, right) =>
    BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0,
  )
  const keyPart = sortedAmounts.map((amount) => `${amount}:${keys[amount]}`).join(',')
  let preimage = `${keyPart}|unit:${spec.unit}`
  if (spec.input_fee_ppk !== 0) preimage += `|input_fee_ppk:${spec.input_fee_ppk}`
  if (spec.final_expiry !== null) preimage += `|final_expiry:${spec.final_expiry}`
  if (collectionId !== null) {
    preimage += `|condition_id:${CONDITION_ID}|outcome_collection_id:${collectionId}`
  }
  return preimage
}

function createKeyset(spec) {
  const publishedDenominations = Object.freeze([...spec.published_denominations])
  const keys = Object.freeze(
    Object.fromEntries(
      publishedDenominations.map((amount) => [
        amount,
        mintPublicKey(spec.keyMaterialLabel, amount),
      ]),
    ),
  )
  const collectionId =
    spec.outcome_collection === null ? null : outcomeCollectionId(spec.outcome_collection)
  return Object.freeze({
    id: `01${sha256Hex(keysetIdPreimage(spec, keys, collectionId))}`,
    key_material_label: spec.keyMaterialLabel,
    input_fee_ppk: spec.input_fee_ppk,
    unit: spec.unit,
    active: true,
    final_expiry: spec.final_expiry,
    condition_id: collectionId === null ? null : CONDITION_ID,
    outcome_collection: spec.outcome_collection,
    outcome_collection_id: collectionId,
    published_denominations: publishedDenominations,
    covers: Object.freeze([...spec.covers]),
    keys,
  })
}

function proofSignature(secret, keyset, amount) {
  return compressedPoint(
    multiplyPoint(mintPrivateKey(keyset.key_material_label, amount), hashToCurvePoint(secret)),
  )
}

function blindSignature(output) {
  const keyset = keysetById(output.id)
  return {
    amount: output.amount,
    id: output.id,
    C_: compressedPoint(
      multiplyPoint(
        mintPrivateKey(keyset.key_material_label, output.amount),
        pointFromCompressedHex(output.B_),
      ),
    ),
  }
}

function blindedMaterial(label) {
  const secret = sha256Hex(`bitcaster/vector/output-secret/${label}`)
  const blinding = scalarFromLabel(`blinding/${label}`)
  const point = addPoints(hashToCurvePoint(secret), multiplyPoint(blinding, GENERATOR))
  if (point === null) throw new Error('blinded point produced infinity')
  const material = {
    B_: compressedPoint(point),
    secret,
    blinding_factor: blinding.toString(16).padStart(64, '0'),
  }
  OUTPUT_MATERIAL.set(material.B_, material)
  return material
}

function blindedMessage(label, amount, keysetId) {
  const material = blindedMaterial(`blinded/${label}`)
  return {
    amount: Number(amount),
    id: keysetId,
    B_: material.B_,
  }
}

function poolEntry(label, index, role, amount, keysetId) {
  const material = blindedMaterial(`pool/${label}`)
  return {
    index: String(index),
    role,
    amount: String(amount),
    id: keysetId,
    B_: material.B_,
  }
}

function ctfReceiveHash(outputs) {
  const count = Buffer.alloc(4)
  count.writeUInt32LE(outputs.length)
  const entries = outputs.map((output) =>
    Buffer.from(canonicalJson(canonicalBlindedMessage(output)), 'utf8'),
  )
  return taggedHash('Cashu/ctf/convert/recv', Buffer.concat([count, ...entries])).toString('hex')
}

function ctfManifestHash(manifest) {
  const entries = manifest.map((entry) => Buffer.from(canonicalJson(entry), 'utf8'))
  return taggedHash('Cashu/ctf/convert/manifest', Buffer.concat(entries)).toString('hex')
}

function baseManifestHash(manifest) {
  const entries = manifest.map((entry) => Buffer.from(canonicalJson(entry), 'utf8'))
  return taggedHash('Cashu/PAY_TO_UNLOCK/manifest', Buffer.concat(entries)).toString('hex')
}

function selectionBitmap(entryCount, selectedIndices) {
  const bytes = Buffer.alloc(Math.ceil(entryCount / 8))
  for (const index of selectedIndices) {
    if (!Number.isInteger(index) || index < 0 || index >= entryCount) {
      throw new RangeError('selection index is outside the manifest')
    }
    bytes[Math.floor(index / 8)] |= 1 << (index % 8)
  }
  return bytes.toString('hex')
}

function selectedOutputs(manifest, selectedIndices) {
  const selected = new Set(selectedIndices)
  return manifest
    .filter((entry, index) => selected.has(index))
    .map(({ amount, id, B_ }) => ({ amount: Number(amount), id, B_ }))
}

function conditionSecret({
  nonceLabel,
  authorizationLabel,
  commitment,
  offerKeyset,
  expiry = EXPIRY,
  policy,
  extraTags = [],
}) {
  const refundPrivateKey = scalarFromLabel(`refund/${authorizationLabel}`)
  const refundPoint = compressedPoint(multiplyPoint(refundPrivateKey, GENERATOR))
  const refundXOnly = refundPoint.slice(2)
  REFUND_PRIVATE_KEYS.set(refundXOnly, refundPrivateKey)
  const tags = [
    ['offer_keyset', offerKeyset],
    ['expiry', expiry],
    ['refund', refundXOnly],
  ]
  if (policy !== undefined) {
    tags.push(
      ['rate_n', policy.rate_n],
      ['rate_d', policy.rate_d],
      ['min_receive', policy.min_receive],
      ['max_debit', policy.max_debit],
    )
  }
  tags.push(...extraTags)
  return JSON.stringify([
    'PAY_TO_UNLOCK',
    {
      nonce: sha256Hex(`bitcaster/vector/nonce/${nonceLabel}`),
      data: commitment,
      tags,
    },
  ])
}

function proof({ label, authorizationLabel, amount, keyset, commitment, policy }) {
  const secret = conditionSecret({
    nonceLabel: label,
    authorizationLabel,
    commitment,
    offerKeyset: keyset.id,
    policy,
  })
  return {
    amount: Number(amount),
    id: keyset.id,
    secret,
    C: proofSignature(secret, keyset, amount),
  }
}

function participantCanonical(record) {
  const inputs = [...record.inputs].sort(compareProofs).map(canonicalProof)
  const canonicalRecord = {
    inputs,
    outputs: record.outputs.map(canonicalBlindedMessage),
  }
  if (record.pool_manifest !== undefined) {
    canonicalRecord.pool_manifest = record.pool_manifest
    canonicalRecord.pool_selection = record.pool_selection.toLowerCase()
  }
  return canonicalJson(canonicalRecord)
}

function canonicalProof(input) {
  const { witness: _witness, ...withoutWitness } = input
  return { ...withoutWitness, amount: String(input.amount) }
}

function canonicalBlindedMessage(output) {
  return { ...output, amount: String(output.amount) }
}

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareProofs(left, right) {
  return compareOrdinal(left.id, right.id) || compareOrdinal(left.secret, right.secret)
}

function participantOrderKey(record) {
  const first = [...record.inputs].sort(compareProofs)[0]
  if (first === undefined) {
    throw new Error('participant must have at least one input')
  }
  return `${first.id}:${first.secret}`
}

function canonicalRequestBytes(request) {
  const participantBytes = request.participants.map((participant) =>
    Buffer.from(participantCanonical(participant), 'utf8'),
  )
  return Buffer.concat([
    decodeFixedHex(request.condition_id, 32, 'condition_id'),
    decodeFixedHex(request.parent_collection_id ?? ZERO_PARENT, 32, 'parent_collection_id'),
    ...participantBytes,
  ])
}

function decodeFixedHex(value, length, field) {
  if (!new RegExp(`^[0-9a-f]{${length * 2}}$`).test(value)) {
    throw new TypeError(`${field} must be lowercase ${length}-byte hex`)
  }
  return Buffer.from(value, 'hex')
}

function ctfRequestDigest(request) {
  return taggedHash('Cashu/ctf/convert/request', canonicalRequestBytes(request)).toString('hex')
}

function standardParticipant({ owner, offerKeyset, inputs, outputs }) {
  const commitment = ctfReceiveHash(outputs)
  const authorizationLabel = `${owner}/${commitment}`
  return {
    owner,
    record: {
      inputs: inputs.map(([label, amount]) =>
        proof({
          label: `${owner}/${label}`,
          authorizationLabel,
          amount,
          keyset: offerKeyset,
          commitment,
        }),
      ),
      outputs,
    },
    commitment,
    mode: 'standard',
  }
}

function buildManifest({ label, receiveKeyset, receiveAmounts, changeKeyset, changeAmounts }) {
  const manifest = []
  for (const amount of receiveAmounts) {
    manifest.push(
      poolEntry(`${label}/receive/${amount}`, manifest.length, 'receive', amount, receiveKeyset.id),
    )
  }
  for (const amount of changeAmounts) {
    manifest.push(
      poolEntry(`${label}/change/${amount}`, manifest.length, 'change', amount, changeKeyset.id),
    )
  }
  return manifest
}

function poolParticipant({ owner, offerKeyset, inputs, manifest, selectedIndices, policy }) {
  const commitment = ctfManifestHash(manifest)
  const authorizationLabel = `${owner}/${commitment}`
  return {
    owner,
    record: {
      inputs: inputs.map(([label, amount]) =>
        proof({
          label: `${owner}/${label}`,
          authorizationLabel,
          amount,
          keyset: offerKeyset,
          commitment,
          policy,
        }),
      ),
      outputs: selectedOutputs(manifest, selectedIndices),
      pool_manifest: manifest,
      pool_selection: selectionBitmap(manifest.length, selectedIndices),
    },
    commitment,
    mode: 'pool',
    policy,
  }
}

function keysetById(id) {
  const keyset = Object.values(KEYSETS).find((candidate) => candidate.id === id)
  if (keyset === undefined) {
    throw new Error(`Unknown fixture keyset: ${id}`)
  }
  return keyset
}

function sumAmounts(records, field, outcome) {
  let total = 0n
  for (const record of records) {
    for (const item of record[field]) {
      if (keysetById(item.id).covers.includes(outcome)) {
        total += BigInt(item.amount)
      }
    }
  }
  return total
}

function feeWeight(record) {
  return record.inputs.reduce(
    (total, input) => total + BigInt(keysetById(input.id).input_fee_ppk),
    0n,
  )
}

function allocateFees(participants, fee) {
  const rows = participants.map((participant) => {
    const weight = feeWeight(participant.record)
    const digest = sha256Hex(participantCanonical(participant.record))
    return {
      owner: participant.owner,
      authorization_artifact_digest: digest,
      input_fee_weight_ppk: weight,
      share: weight / 1000n,
      remainder: weight % 1000n,
    }
  })
  return allocateFeeRows(rows, fee)
}

function allocateFeeRows(rows, fee) {
  let unallocated = fee - rows.reduce((sum, row) => sum + row.share, 0n)
  const order = [...rows].sort((left, right) => {
    if (left.remainder !== right.remainder) {
      return left.remainder > right.remainder ? -1 : 1
    }
    return compareOrdinal(left.authorization_artifact_digest, right.authorization_artifact_digest)
  })
  for (const row of order) {
    if (unallocated === 0n) {
      break
    }
    row.share += 1n
    unallocated -= 1n
  }
  return rows.map((row) => ({
    owner: row.owner,
    authorization_artifact_digest: row.authorization_artifact_digest,
    input_fee_weight_ppk: row.input_fee_weight_ppk.toString(),
    fee_share: row.share.toString(),
  }))
}

function feeAllocationVector(id, weights) {
  const rows = weights.map((weight, index) => {
    const digest = sha256Hex(`fee-vector/${id}/${index}`)
    const parsedWeight = BigInt(weight)
    return {
      owner: `participant-${index}`,
      authorization_artifact_digest: digest,
      input_fee_weight_ppk: parsedWeight,
      share: parsedWeight / 1000n,
      remainder: parsedWeight % 1000n,
    }
  })
  const totalWeight = rows.reduce((sum, row) => sum + row.input_fee_weight_ppk, 0n)
  const fee = (totalWeight + 999n) / 1000n
  return {
    id,
    weights_ppk: weights.map(String),
    total_weight_ppk: totalWeight.toString(),
    total_fee: fee.toString(),
    allocation: allocateFeeRows(rows, fee),
  }
}

function feeAllocationVectors() {
  return [
    feeAllocationVector('just-below-one-thousand', [499, 500]),
    feeAllocationVector('exactly-one-thousand-tie', [500, 500]),
    feeAllocationVector('just-above-one-thousand', [500, 501]),
    feeAllocationVector('three-way-equal-remainder-tie', [500, 500, 500]),
  ]
}

function refundPublicKey(proofRecord) {
  const parsed = JSON.parse(proofRecord.secret)
  const refundTag = parsed?.[1]?.tags?.find((tag) => tag[0] === 'refund')
  if (!Array.isArray(refundTag) || refundTag.length !== 2) {
    throw new Error('fixture proof is missing one refund key')
  }
  return refundTag[1]
}

function refundTargetKeyset(offeredKeyset) {
  const candidates = Object.values(KEYSETS).filter(
    (candidate) =>
      candidate.id !== offeredKeyset.id &&
      candidate.active &&
      candidate.unit === offeredKeyset.unit &&
      candidate.condition_id === offeredKeyset.condition_id &&
      candidate.outcome_collection_id === offeredKeyset.outcome_collection_id,
  )
  const target = candidates[0]
  if (target === undefined) throw new Error(`rotated refund keyset missing for ${offeredKeyset.id}`)
  return target
}

function refundMetadata(participant) {
  const fee = (feeWeight(participant.record) + 999n) / 1000n
  const inputTotal = participant.record.inputs.reduce(
    (sum, input) => sum + BigInt(input.amount),
    0n,
  )
  const offeredKeyset = keysetById(participant.record.inputs[0].id)
  const targetKeyset = refundTargetKeyset(offeredKeyset)
  const refundAmount = inputTotal - fee
  if (!targetKeyset.published_denominations.includes(refundAmount.toString())) {
    throw new Error(`rotated refund denomination missing: ${targetKeyset.id}:${refundAmount}`)
  }
  const refundKeys = new Set(participant.record.inputs.map(refundPublicKey))
  if (refundKeys.size !== 1) throw new Error('participant inputs do not share one refund key')
  const refundKey = [...refundKeys][0]
  const refundRequest = {
    inputs: participant.record.inputs,
    outputs: [
      blindedMessage(`${participant.owner}/refund/${refundKey}`, refundAmount, targetKeyset.id),
    ],
  }
  const canonicalRequest = {
    inputs: refundRequest.inputs.map(canonicalProof),
    outputs: refundRequest.outputs.map(canonicalBlindedMessage),
  }
  const canonical = canonicalJson(canonicalRequest)
  const outputMaterial = OUTPUT_MATERIAL.get(refundRequest.outputs[0].B_)
  if (outputMaterial === undefined) throw new Error('refund output material missing')
  const digest = taggedHash('Cashu/PAY_TO_UNLOCK/refund', Buffer.from(canonical, 'utf8'))
  const refundPrivateKey = REFUND_PRIVATE_KEYS.get(refundKey)
  if (refundPrivateKey === undefined) throw new Error('fixture refund private key missing')
  const signature = schnorrSignDigest(refundPrivateKey, digest)
  return {
    eligible_at: EXPIRY,
    asset_class: {
      offered_keyset_id: offeredKeyset.id,
      refund_target_keyset_id: targetKeyset.id,
      offered_keyset_at_refund: { active: false, still_spendable: true },
      refund_target_keyset_active: targetKeyset.active,
      unit: offeredKeyset.unit,
      condition_id: offeredKeyset.condition_id,
      outcome_collection: offeredKeyset.outcome_collection,
      outcome_collection_id: offeredKeyset.outcome_collection_id,
    },
    request_without_witness: refundRequest,
    request_with_witness: {
      inputs: refundRequest.inputs.map((input) => ({
        ...input,
        witness: JSON.stringify({ signatures: [signature] }),
      })),
      outputs: refundRequest.outputs,
    },
    output_material: outputMaterial,
    canonical_hex: Buffer.from(canonical, 'utf8').toString('hex'),
    digest: digest.toString('hex'),
    refund_public_key: refundKey,
    signature,
  }
}

function recoveryMetadata(participant) {
  const queriedOutputs =
    participant.mode === 'pool'
      ? participant.record.pool_manifest.map(({ amount, id, B_ }) => ({
          amount: Number(amount),
          id,
          B_,
        }))
      : participant.record.outputs
  const outputMaterial = queriedOutputs.map(({ B_ }) => {
    const material = OUTPUT_MATERIAL.get(B_)
    if (material === undefined) throw new Error('recovery output material missing')
    return material
  })
  const selectedByPoint = new Map(participant.record.outputs.map((output) => [output.B_, output]))
  const expectedEntries = queriedOutputs.map((output) => {
    const selected = selectedByPoint.get(output.B_)
    return selected === undefined
      ? { output, expected: 'MISSING' }
      : { output, expected: 'SIGNED', signature: blindSignature(selected) }
  })
  const expectedResponse = {
    outputs: participant.record.outputs,
    signatures: participant.record.outputs.map(blindSignature),
  }
  return {
    owner: participant.owner,
    nut07_Ys: participant.record.inputs.map((input) => hashToCurve(input.secret)),
    nut09_request: { outputs: queriedOutputs },
    nut09_expected_response: expectedResponse,
    nut09_expected_response_wire_json: JSON.stringify(expectedResponse),
    nut09_expected_entries: expectedEntries,
    output_material: outputMaterial,
    query_full_manifest_when_selection_unknown: participant.mode === 'pool',
    retain_unselected_material_until_definitive: participant.mode === 'pool',
    refund: refundMetadata(participant),
  }
}

function assertPublishedDenominations(participants) {
  for (const { record } of participants) {
    const entries = [...record.inputs, ...record.outputs, ...(record.pool_manifest ?? [])]
    for (const entry of entries) {
      if (!keysetById(entry.id).published_denominations.includes(String(entry.amount))) {
        throw new Error(`fixture denomination ${entry.id}:${entry.amount} is not published`)
      }
    }
  }
}

function finalizeScenario({ id, description, participants, expectedMatchShape }) {
  const ordered = [...participants].sort((left, right) =>
    compareOrdinal(participantOrderKey(left.record), participantOrderKey(right.record)),
  )
  const request = {
    condition_id: CONDITION_ID,
    parent_collection_id: ZERO_PARENT,
    participants: ordered.map((participant) => participant.record),
  }
  assertPublishedDenominations(ordered)
  const wireJson = JSON.stringify(request)
  const totalWeight = ordered.reduce((sum, participant) => sum + feeWeight(participant.record), 0n)
  const fee = (totalWeight + 999n) / 1000n
  const mintResponse = {
    signatures: ordered.map(({ record }) => record.outputs.map(blindSignature)),
  }
  const outcomes = ['YES', 'NO'].map((outcome) => {
    const inputs = sumAmounts(
      ordered.map(({ record }) => record),
      'inputs',
      outcome,
    )
    const outputs = sumAmounts(
      ordered.map(({ record }) => record),
      'outputs',
      outcome,
    )
    if (outputs !== inputs - fee) {
      throw new Error(`${id} violates ${outcome} conservation`)
    }
    return {
      outcome,
      input_total: inputs.toString(),
      output_total: outputs.toString(),
      fee: fee.toString(),
    }
  })
  return {
    id,
    description,
    expected_match_shape: expectedMatchShape,
    participant_order: ordered.map(({ owner }) => owner),
    participant_modes: ordered.map(({ owner, mode }) => ({ owner, mode })),
    participant_canonical_hex: ordered.map(({ owner, record }) => ({
      owner,
      canonical_hex: Buffer.from(participantCanonical(record), 'utf8').toString('hex'),
    })),
    request,
    wire_json: wireJson,
    wire_hex: Buffer.from(wireJson, 'utf8').toString('hex'),
    serialized_request_bytes: Buffer.byteLength(wireJson),
    request_canonical_hex: canonicalRequestBytes(request).toString('hex'),
    request_digest: ctfRequestDigest(request),
    mint_response: mintResponse,
    mint_response_wire_json: JSON.stringify(mintResponse),
    fee: {
      total_input_fee_weight_ppk: totalWeight.toString(),
      total_fee: fee.toString(),
      allocation: allocateFees(ordered, fee),
    },
    per_outcome_conservation: outcomes,
    commitments: ordered.map(({ owner, mode, commitment }) => ({
      owner,
      mode,
      commitment,
    })),
    recovery: ordered.map(recoveryMetadata),
  }
}

function standardTwoPartyScenario() {
  const aliceOutputs = [blindedMessage('standard/alice/yes', 100, KEYSETS.yes.id)]
  const bobOutputs = [blindedMessage('standard/bob/collateral', 100, KEYSETS.collateral.id)]
  return finalizeScenario({
    id: 'standard-two-party-complementary',
    description: 'Two exact participants exchange collateral and YES with one global fee unit.',
    expectedMatchShape: 'COMPLEMENTARY',
    participants: [
      standardParticipant({
        owner: 'alice',
        offerKeyset: KEYSETS.collateral,
        inputs: [['collateral-101', 101]],
        outputs: aliceOutputs,
      }),
      standardParticipant({
        owner: 'bob',
        offerKeyset: KEYSETS.yes,
        inputs: [['yes-100', 100]],
        outputs: bobOutputs,
      }),
    ],
  })
}

function standardMintScenario() {
  return finalizeScenario({
    id: 'standard-complementary-buy-mint',
    description: 'Two collateral buyers receive a complete YES/NO set in one MINT conversion.',
    expectedMatchShape: 'MINT',
    participants: [
      standardParticipant({
        owner: 'alice',
        offerKeyset: KEYSETS.collateral,
        inputs: [['collateral-41', 41]],
        outputs: [blindedMessage('mint/alice/yes', 100, KEYSETS.yes.id)],
      }),
      standardParticipant({
        owner: 'bob',
        offerKeyset: KEYSETS.collateral,
        inputs: [['collateral-60', 60]],
        outputs: [blindedMessage('mint/bob/no', 100, KEYSETS.no.id)],
      }),
    ],
  })
}

function mixedBetterPriceScenario() {
  const manifest = buildManifest({
    label: 'better-price/alice',
    receiveKeyset: KEYSETS.yes,
    receiveAmounts: [1, 2, 4, 8],
    changeKeyset: KEYSETS.collateral,
    changeAmounts: [1, 2, 4, 8, 16, 32, 64, 128],
  })
  const policy = {
    rate_n: '1',
    rate_d: '10',
    min_receive: '1',
    max_debit: '101',
  }
  return finalizeScenario({
    id: 'mixed-pool-standard-better-price',
    description:
      'A pool buyer receives 7 YES, returns 40 collateral change, and admits a better-than-limit gross debit of 61.',
    expectedMatchShape: 'COMPLEMENTARY',
    participants: [
      poolParticipant({
        owner: 'alice',
        offerKeyset: KEYSETS.collateral,
        inputs: [['collateral-101', 101]],
        manifest,
        selectedIndices: [0, 1, 2, 7, 9],
        policy,
      }),
      standardParticipant({
        owner: 'bob',
        offerKeyset: KEYSETS.yes,
        inputs: [['yes-7', 7]],
        outputs: [blindedMessage('better-price/bob/collateral', 60, KEYSETS.collateral.id)],
      }),
    ],
  })
}

function mixedFullFillScenario() {
  const manifest = buildManifest({
    label: 'full-fill/alice',
    receiveKeyset: KEYSETS.yes,
    receiveAmounts: [100],
    changeKeyset: KEYSETS.collateral,
    changeAmounts: [1],
  })
  return finalizeScenario({
    id: 'mixed-pool-standard-full-fill-zero-change',
    description:
      'A pool buyer spends its full authorization at the exact limit and selects no change entry.',
    expectedMatchShape: 'COMPLEMENTARY',
    participants: [
      poolParticipant({
        owner: 'alice',
        offerKeyset: KEYSETS.collateral,
        inputs: [['collateral-101', 101]],
        manifest,
        selectedIndices: [0],
        policy: {
          rate_n: '100',
          rate_d: '101',
          min_receive: '100',
          max_debit: '101',
        },
      }),
      standardParticipant({
        owner: 'bob',
        offerKeyset: KEYSETS.yes,
        inputs: [['yes-100', 100]],
        outputs: [blindedMessage('full-fill/bob/collateral', 100, KEYSETS.collateral.id)],
      }),
    ],
  })
}

function mixedPoolSellerScenario() {
  const manifest = buildManifest({
    label: 'pool-seller/alice',
    receiveKeyset: KEYSETS.collateral,
    receiveAmounts: [60],
    changeKeyset: KEYSETS.yes,
    changeAmounts: [39],
  })
  return finalizeScenario({
    id: 'mixed-pool-seller-standard-buyer',
    description:
      'A pool seller receives collateral at its exact rational limit and returns conditional change.',
    expectedMatchShape: 'COMPLEMENTARY',
    participants: [
      poolParticipant({
        owner: 'alice',
        offerKeyset: KEYSETS.yes,
        inputs: [['yes-100', 100]],
        manifest,
        selectedIndices: [0, 1],
        policy: {
          rate_n: '60',
          rate_d: '61',
          min_receive: '60',
          max_debit: '61',
        },
      }),
      standardParticipant({
        owner: 'bob',
        offerKeyset: KEYSETS.collateral,
        inputs: [['collateral-61', 61]],
        outputs: [blindedMessage('pool-seller/bob/yes', 61, KEYSETS.yes.id)],
      }),
    ],
  })
}

function fragmentedOneVsManyScenario() {
  const manifest = buildManifest({
    label: 'fragmented/alice',
    receiveKeyset: KEYSETS.yes,
    receiveAmounts: [1, 2, 4, 8, 16],
    changeKeyset: KEYSETS.collateral,
    changeAmounts: [1, 2, 4, 8, 16, 32, 64, 128, 256],
  })
  const policy = {
    rate_n: '1',
    rate_d: '10',
    min_receive: '2',
    max_debit: '203',
  }
  return finalizeScenario({
    id: 'mixed-pool-one-vs-many-fragmented-inputs',
    description:
      'One pool buyer locks five fixed proofs and settles once against two standard sellers.',
    expectedMatchShape: 'COMPLEMENTARY_1_VS_N',
    participants: [
      poolParticipant({
        owner: 'alice',
        offerKeyset: KEYSETS.collateral,
        inputs: [
          ['collateral-128', 128],
          ['collateral-64', 64],
          ['collateral-8', 8],
          ['collateral-2', 2],
          ['collateral-1', 1],
        ],
        manifest,
        selectedIndices: [2, 3, 7, 10, 11],
        policy,
      }),
      standardParticipant({
        owner: 'bob',
        offerKeyset: KEYSETS.yes,
        inputs: [['yes-7', 7]],
        outputs: [blindedMessage('fragmented/bob/collateral', 60, KEYSETS.collateral.id)],
      }),
      standardParticipant({
        owner: 'carol',
        offerKeyset: KEYSETS.yes,
        inputs: [['yes-5', 5]],
        outputs: [blindedMessage('fragmented/carol/collateral', 41, KEYSETS.collateral.id)],
      }),
    ],
  })
}

function rateVectors() {
  return [
    {
      id: 'buy-three-fifths-boundary',
      side: 'buy',
      price_fraction: { numerator: '3', denominator: '5' },
      tags: { rate_n: '5', rate_d: '3' },
      receive_total: '5',
      debit_total: '3',
      inequality: '5 * 3 >= 3 * 5',
      valid: true,
    },
    {
      id: 'buy-three-fifths-better',
      side: 'buy',
      price_fraction: { numerator: '3', denominator: '5' },
      tags: { rate_n: '5', rate_d: '3' },
      receive_total: '6',
      debit_total: '3',
      inequality: '6 * 3 >= 3 * 5',
      valid: true,
    },
    {
      id: 'sell-three-fifths-boundary',
      side: 'sell',
      price_fraction: { numerator: '3', denominator: '5' },
      tags: { rate_n: '3', rate_d: '5' },
      receive_total: '3',
      debit_total: '5',
      inequality: '3 * 5 >= 5 * 3',
      valid: true,
    },
    {
      id: 'sell-three-fifths-worse',
      side: 'sell',
      price_fraction: { numerator: '3', denominator: '5' },
      tags: { rate_n: '3', rate_d: '5' },
      receive_total: '2',
      debit_total: '5',
      inequality: '2 * 5 < 5 * 3',
      valid: false,
    },
  ]
}

function orderingVectors() {
  const proofs = ['_fixed', 'afixed', '!fixed', '0fixed'].map((secret) => ({
    id: KEYSETS.collateral.id,
    secret,
  }))
  return {
    comparison: 'unsigned ordinal Unicode code-unit order',
    unsorted_secrets: proofs.map(({ secret }) => secret),
    sorted_secrets: [...proofs].sort(compareProofs).map(({ secret }) => secret),
  }
}

function countLimitVectors() {
  return [
    { field: 'max_participants', limit: 32, actual: 32, valid: true },
    { field: 'max_participants', limit: 32, actual: 33, valid: false },
    { field: 'max_inputs', limit: 512, actual: 512, valid: true },
    { field: 'max_inputs', limit: 512, actual: 513, valid: false },
    { field: 'max_outputs', limit: 512, actual: 512, valid: true },
    { field: 'max_outputs', limit: 512, actual: 513, valid: false },
    { field: 'max_pool_entries', limit: 128, actual: 128, valid: true },
    { field: 'max_pool_entries', limit: 128, actual: 129, valid: false },
    { field: 'max_request_bytes', limit: 1048576, actual: 1048576, valid: true },
    { field: 'max_request_bytes', limit: 1048576, actual: 1048577, valid: false },
  ]
}

function largeAmountVector(id, amount, valid) {
  const point = compressedPoint(GENERATOR)
  const wireJson = `{"amount":${amount},"id":"${KEYSETS.collateral.id}","B_":"${point}"}`
  return {
    id,
    wire_json: wireJson,
    wire_hex: Buffer.from(wireJson, 'utf8').toString('hex'),
    amount_decimal: amount,
    valid_u64: valid,
    canonical_json: valid ? canonicalJson({ amount, id: KEYSETS.collateral.id, B_: point }) : null,
    requires_lossless_integer_tokenization: BigInt(amount) > BigInt(Number.MAX_SAFE_INTEGER),
  }
}

function largeAmountVectors() {
  return [
    largeAmountVector('largest-safe-plus-one', '9007199254740992', true),
    largeAmountVector('first-unsafe-integer', '9007199254740993', true),
    largeAmountVector('u64-maximum', '18446744073709551615', true),
    largeAmountVector('u64-overflow', '18446744073709551616', false),
  ]
}

function mutationCase(baseScenario, id, mutation, rule, errorCode = null) {
  return {
    id,
    base_scenario: baseScenario.id,
    mutation,
    reject: { rule, error_code: errorCode },
  }
}

function invalidManifestCases(pool, poolRecord, fragmented, fragmentedPool) {
  return [
    {
      id: 'wrong-manifest-domain',
      base_scenario: pool.id,
      actual: baseManifestHash(poolRecord.pool_manifest),
      expected: ctfManifestHash(poolRecord.pool_manifest),
      reject: { rule: '6p', error_code: 15011 },
    },
    {
      id: 'bitmap-short',
      base_scenario: pool.id,
      actual: poolRecord.pool_selection.slice(0, 2),
      expected_byte_length: '2',
      reject: { rule: '7p', error_code: 15012 },
    },
    {
      id: 'bitmap-trailing-bit',
      base_scenario: pool.id,
      actual: `${poolRecord.pool_selection.slice(0, 2)}82`,
      manifest_entries: String(poolRecord.pool_manifest.length),
      reject: { rule: '7p', error_code: 15012 },
    },
    mutationCase(pool, 'bitmap-odd-length', 'remove one hex nibble', '7p', 15012),
    mutationCase(pool, 'bitmap-0x-prefix', 'prefix pool_selection with "0x"', '7p', 15012),
    mutationCase(pool, 'uppercase-selection-hex', 'uppercase pool_selection', '7p', 15012),
    mutationCase(
      pool,
      'selected-output-order-mismatch',
      'swap outputs[0] and outputs[1] while retaining the bitmap',
      '7p',
      15012,
    ),
    mutationCase(
      fragmented,
      'noncontiguous-manifest-index',
      'replace pool_manifest[3].index with "4"',
      'manifest canonical encoding',
      15011,
    ),
    mutationCase(
      fragmented,
      'duplicate-manifest-blinded-point',
      'copy pool_manifest[0].B_ to pool_manifest[1].B_',
      'base rule 9 and pool manifest uniqueness',
    ),
    mutationCase(
      fragmented,
      'altered-unselected-entry',
      'change an unselected manifest B_ without changing the condition data',
      '6p',
      15011,
    ),
    mutationCase(
      fragmented,
      'manifest-entry-unknown-field',
      'append an "extra" field to one PoolEntry and recompute its serialized request',
      'closed PoolEntry grammar',
      15011,
    ),
    mutationCase(
      fragmented,
      'receive-role-keyset-mismatch',
      'replace one receive entry id with the collateral offer_keyset',
      '8p participant role/keyset',
      15013,
    ),
    mutationCase(
      fragmented,
      'change-role-keyset-mismatch',
      'replace one change entry id with the YES receive keyset',
      '8p participant role/keyset',
      15013,
    ),
    mutationCase(
      fragmented,
      'pool-role-missing',
      'remove every change entry and recompute H_manifest',
      '8p both roles required',
      15013,
    ),
    mutationCase(
      fragmented,
      'unpublished-denomination',
      'replace a manifest amount with "3" and recompute H_manifest',
      '8p published signing key',
    ),
    {
      id: 'pool-entry-limit-exceeded',
      base_scenario: fragmented.id,
      max_pool_entries: String(fragmentedPool.pool_manifest.length - 1),
      actual_pool_entries: String(fragmentedPool.pool_manifest.length),
      reject: { rule: 'advertised max_pool_entries', error_code: null },
    },
  ]
}

function invalidPolicyCases(pool, fragmented) {
  return [
    mutationCase(
      pool,
      'forbidden-pool-tag',
      'append ["allow_change"] to every input condition',
      'pool tag grammar',
      15001,
    ),
    mutationCase(
      pool,
      'zero-rate-denominator',
      'replace every ["rate_d","10"] with ["rate_d","0"]',
      '9p',
      15014,
    ),
    {
      id: 'minimum-receive-not-met',
      base_scenario: fragmented.id,
      receive_total: '12',
      min_receive: '13',
      reject: { rule: '9p', error_code: 15014 },
    },
    {
      id: 'maximum-debit-exceeded',
      base_scenario: fragmented.id,
      debit_total: '103',
      max_debit: '102',
      reject: { rule: '9p', error_code: 15014 },
    },
    {
      id: 'rate-covenant-not-met',
      base_scenario: fragmented.id,
      receive_total: '12',
      debit_total: '103',
      rate_n: '2',
      rate_d: '10',
      inequality: '12 * 10 < 103 * 2',
      reject: { rule: '9p', error_code: 15014 },
    },
    mutationCase(
      fragmented,
      'nonminimal-policy-decimal',
      'replace rate_n "1" with "01"',
      'pool tag grammar',
      15001,
    ),
    mutationCase(
      fragmented,
      'negative-policy-decimal',
      'replace max_debit with "-1"',
      'pool tag grammar',
      15001,
    ),
    {
      id: 'rate-cross-product-overflow',
      receive_total: '340282366920938463463374607431768211455',
      debit_total: '2',
      rate_n: '340282366920938463463374607431768211455',
      rate_d: '2',
      reject: { rule: '9p checked u128 multiplication', error_code: 15014 },
    },
    {
      id: 'change-exceeds-input',
      input_total: '100',
      change_total: '101',
      reject: { rule: '9p checked debit subtraction', error_code: 15014 },
    },
  ]
}

function invalidAuthorityCases(fragmented, fragmentedPool) {
  return [
    {
      id: 'expiry-equals-final-expiry',
      expiry: FINAL_EXPIRY,
      earliest_final_expiry: FINAL_EXPIRY,
      reject: { rule: 'CTF-specific rule 5', error_code: null },
    },
    {
      id: 'zero-fee-participating-keyset',
      input_fee_ppk: 0,
      admission_control: false,
      reject: { rule: 'CTF-specific rule 4', error_code: null },
    },
    {
      id: 'attestation-already-recorded',
      attestation_recorded: true,
      reject: { rule: 'CTF-specific rule 2', error_code: 13042 },
    },
    {
      id: 'uncovered-outcome',
      outcome: 'NO',
      input_total: '203',
      output_total: '0',
      fee: '2',
      reject: { rule: 'CTF rule 10', error_code: 13041 },
    },
    {
      id: 'per-class-valid-but-per-outcome-invalid',
      per_class_conservation: true,
      per_outcome_conservation: false,
      reject: { rule: 'CTF rule 10 replaces base rule 10', error_code: 13041 },
    },
    {
      id: 'same-fixed-input-in-two-participants',
      base_scenario: fragmented.id,
      duplicated_secret: fragmentedPool.inputs[0].secret,
      reject: { rule: 'base rule 4', error_code: null },
    },
    mutationCase(
      fragmented,
      'same-condition-nonce-in-two-proofs',
      'copy one PAY_TO_UNLOCK nonce into another input condition',
      'per-proof nonce uniqueness',
      15001,
    ),
    mutationCase(
      fragmented,
      'mixed-pool-tags-across-inputs',
      'change max_debit on one input only',
      'participant condition equality',
      15001,
    ),
    mutationCase(
      fragmented,
      'proof-id-offer-keyset-mismatch',
      'replace one Proof.id without changing offer_keyset',
      'base rule 5',
    ),
    mutationCase(
      fragmented,
      'inactive-keyset',
      'mark the YES receive keyset inactive',
      'CTF rule 8',
      12002,
    ),
    mutationCase(
      fragmented,
      'duplicate-required-tag',
      'append a second expiry tag to every fixed input condition',
      'condition tag grammar',
      15001,
    ),
    mutationCase(
      fragmented,
      'unknown-condition-tag',
      'append ["unknown","1"] to every fixed input condition',
      'condition tag grammar',
      15001,
    ),
  ]
}

function invalidRequestCases(fragmented) {
  return [
    mutationCase(
      fragmented,
      'condition-id-wrong-length',
      'remove one byte from condition_id',
      'CTF request grammar',
      13021,
    ),
    mutationCase(
      fragmented,
      'nonzero-parent-collection-v1',
      `replace parent_collection_id with ${'01'.padStart(64, '0')}`,
      'CTF multi-party rule 1',
    ),
    mutationCase(
      fragmented,
      'duplicate-selected-output',
      'copy outputs[0] over outputs[1] and update the bitmap',
      'base rule 9',
    ),
    mutationCase(
      fragmented,
      'changed-standard-receive-commitment',
      'change a standard output B_ without changing H_recv',
      'base rule 6 with CTF receive domain',
    ),
    {
      id: 'wrong-request-digest-domain',
      base_scenario: fragmented.id,
      actual_domain: 'Cashu/exchange/request',
      expected_domain: 'Cashu/ctf/convert/request',
      reject: { rule: 'CTF request digest domain', error_code: null },
    },
    {
      id: 'request-byte-limit-exceeded',
      base_scenario: fragmented.id,
      max_request_bytes: String(fragmented.serialized_request_bytes - 1),
      actual_request_bytes: String(fragmented.serialized_request_bytes),
      reject: { rule: 'advertised max_request_bytes', error_code: null },
    },
  ]
}

function invalidRefundAndRecoveryCases(fragmented) {
  return [
    {
      id: 'refund-before-expiry',
      now: String(BigInt(EXPIRY) - 1n),
      expiry: EXPIRY,
      reject: { rule: 'refund time gate', error_code: null },
    },
    {
      id: 'refund-to-wrong-asset-class',
      base_scenario: fragmented.id,
      mutation: 'refund a conditional YES proof to the regular collateral keyset',
      reject: { rule: 'exact offered asset-class refund', error_code: null },
    },
    mutationCase(
      fragmented,
      'refund-request-retains-input-witness',
      'include an existing settlement witness in the refund digest preimage',
      'witness-free refund canonicalization',
    ),
    mutationCase(
      fragmented,
      'refund-wrong-signature',
      'sign the refund digest with a key other than the condition refund key',
      'NUT-11 refund authorization',
    ),
    mutationCase(
      fragmented,
      'refund-self-preimage',
      'satisfy PAY_TO_UNLOCK with an unrelated preimage instead of refund authorization',
      'PAY_TO_UNLOCK refund path',
    ),
    mutationCase(
      fragmented,
      'refund-inactive-offer-keyset',
      'attempt exact-class refund after the offered keyset is no longer spendable',
      'refund keyset spendability',
      12002,
    ),
    {
      id: 'discard-unselected-before-definitive-recovery',
      base_scenario: fragmented.id,
      input_state: 'SPENT',
      selected_subset_known: false,
      nut09_full_manifest_queried: false,
      reject: { rule: 'pool discard-safety obligation', error_code: null },
    },
  ]
}

function invalidCases(scenarios) {
  const pool = scenarios.find(({ id }) => id === 'mixed-pool-standard-better-price')
  const fragmented = scenarios.find(({ id }) => id === 'mixed-pool-one-vs-many-fragmented-inputs')
  if (pool === undefined || fragmented === undefined) {
    throw new Error('invalid-case base scenario missing')
  }
  const poolRecord = pool.request.participants.find(
    (participant) => participant.pool_manifest !== undefined,
  )
  const fragmentedPool = fragmented.request.participants.find(
    (participant) => participant.pool_manifest !== undefined,
  )
  if (poolRecord === undefined || fragmentedPool === undefined) {
    throw new Error('pool-mode base participant missing')
  }
  return [
    ...invalidManifestCases(pool, poolRecord, fragmented, fragmentedPool),
    ...invalidPolicyCases(pool, fragmented),
    ...invalidAuthorityCases(fragmented, fragmentedPool),
    ...invalidRequestCases(fragmented),
    ...invalidRefundAndRecoveryCases(fragmented),
  ]
}

function poolRecord(request) {
  const record = request.participants.find((participant) => participant.pool_manifest !== undefined)
  if (record === undefined) throw new Error('invalid wire fixture needs a pool participant')
  return record
}

function invalidWireCase(baseScenario, id, mutate, rule, errorCode = null) {
  const request = structuredClone(baseScenario.request)
  mutate(request)
  const wireJson = JSON.stringify(request)
  if (wireJson === baseScenario.wire_json)
    throw new Error(`invalid wire mutation had no effect: ${id}`)
  return {
    id,
    base_scenario: baseScenario.id,
    wire_json: wireJson,
    wire_sha256: sha256Hex(wireJson),
    serialized_request_bytes: Buffer.byteLength(wireJson),
    reject: { rule, error_code: errorCode },
  }
}

function invalidWireVectors(scenarios) {
  const pool = scenarioById(scenarios, 'mixed-pool-standard-better-price')
  const fragmented = scenarioById(scenarios, 'mixed-pool-one-vs-many-fragmented-inputs')
  return [
    invalidWireCase(
      pool,
      'wire-bitmap-short',
      (request) => {
        poolRecord(request).pool_selection = poolRecord(request).pool_selection.slice(0, 2)
      },
      '7p',
      15012,
    ),
    invalidWireCase(
      pool,
      'wire-bitmap-trailing-bit',
      (request) => {
        poolRecord(request).pool_selection = `${poolRecord(request).pool_selection.slice(0, 2)}82`
      },
      '7p',
      15012,
    ),
    invalidWireCase(
      pool,
      'wire-selected-output-order',
      (request) => {
        poolRecord(request).outputs.reverse()
      },
      '7p',
      15012,
    ),
    invalidWireCase(
      fragmented,
      'wire-uppercase-bitmap',
      (request) => {
        poolRecord(request).pool_selection = poolRecord(request).pool_selection.toUpperCase()
      },
      'canonical bitmap encoding',
      15012,
    ),
    invalidWireCase(
      fragmented,
      'wire-nonzero-parent',
      (request) => {
        request.parent_collection_id = '01'.padStart(64, '0')
      },
      'CTF multi-party rule 1',
    ),
    invalidWireCase(
      fragmented,
      'wire-short-condition-id',
      (request) => {
        request.condition_id = request.condition_id.slice(2)
      },
      'CTF request grammar',
      13021,
    ),
    invalidWireCase(
      fragmented,
      'wire-unknown-manifest-field',
      (request) => {
        poolRecord(request).pool_manifest[0].extra = 'forbidden'
      },
      'closed PoolEntry grammar',
      15011,
    ),
    invalidWireCase(
      fragmented,
      'wire-altered-unselected-entry',
      (request) => {
        poolRecord(request).pool_manifest[1].B_ = compressedPoint(
          multiplyPoint(scalarFromLabel('invalid/unselected'), GENERATOR),
        )
      },
      '6p',
      15011,
    ),
    invalidWireCase(
      pool,
      'wire-standard-receive-mismatch',
      (request) => {
        const standard = request.participants.find(
          (participant) => participant.pool_manifest === undefined,
        )
        standard.outputs[0].B_ = compressedPoint(
          multiplyPoint(scalarFromLabel('invalid/standard-output'), GENERATOR),
        )
      },
      'base rule 6 with CTF receive domain',
    ),
  ]
}

function digestSensitivity(scenario) {
  const mutated = structuredClone(scenario.request)
  const participant = mutated.participants.find(
    (candidate) => candidate.pool_selection !== undefined,
  )
  if (participant === undefined) {
    throw new Error('digest sensitivity needs a pool participant')
  }
  const bytes = Buffer.from(participant.pool_selection, 'hex')
  bytes[0] ^= 0x01
  participant.pool_selection = bytes.toString('hex')
  return {
    base_scenario: scenario.id,
    original_request_digest: scenario.request_digest,
    changed_selection: participant.pool_selection,
    changed_request_digest: ctfRequestDigest(mutated),
    digests_differ: ctfRequestDigest(mutated) !== scenario.request_digest,
  }
}

function parentCollectionEquivalence(scenario) {
  const omitted = structuredClone(scenario.request)
  delete omitted.parent_collection_id
  return {
    base_scenario: scenario.id,
    omitted_request_canonical_hex: canonicalRequestBytes(omitted).toString('hex'),
    explicit_zero_request_canonical_hex: scenario.request_canonical_hex,
    omitted_request_digest: ctfRequestDigest(omitted),
    explicit_zero_request_digest: scenario.request_digest,
    canonical_bytes_equal:
      canonicalRequestBytes(omitted).toString('hex') === scenario.request_canonical_hex,
    digests_equal: ctfRequestDigest(omitted) === scenario.request_digest,
  }
}

function expiryVectors() {
  return [
    {
      id: 'before-keyset-final-expiry',
      prepared_at: '1799913600',
      expiry: EXPIRY,
      earliest_final_expiry: FINAL_EXPIRY,
      max_expiry_seconds: '86400',
      valid: true,
    },
    {
      id: 'equal-to-keyset-final-expiry',
      prepared_at: '1799917200',
      expiry: FINAL_EXPIRY,
      earliest_final_expiry: FINAL_EXPIRY,
      max_expiry_seconds: '86400',
      valid: false,
    },
    {
      id: 'beyond-advertised-lifetime',
      prepared_at: '1799913599',
      expiry: EXPIRY,
      earliest_final_expiry: null,
      max_expiry_seconds: '86400',
      valid: false,
    },
  ]
}

function recoveryClassificationVectors() {
  return [
    {
      id: 'restored-selected-outputs',
      output_state: 'RESTORED',
      input_states: ['SPENT', 'SPENT'],
      now_relative_to_expiry: 'before',
      classification: 'CONFIRMED',
    },
    {
      id: 'all-unspent-before-expiry',
      output_state: 'MISSING',
      input_states: ['UNSPENT', 'UNSPENT'],
      now_relative_to_expiry: 'before',
      classification: 'WAIT',
    },
    {
      id: 'all-unspent-after-expiry',
      output_state: 'MISSING',
      input_states: ['UNSPENT', 'UNSPENT'],
      now_relative_to_expiry: 'after',
      classification: 'REFUND_EXACT_OFFERED_ASSET_CLASS',
    },
    {
      id: 'pending-input',
      output_state: 'MISSING',
      input_states: ['PENDING'],
      now_relative_to_expiry: 'after',
      classification: 'RECONCILING_RETAIN_AUTHORITY',
    },
    {
      id: 'mixed-input-states',
      output_state: 'MISSING',
      input_states: ['SPENT', 'UNSPENT'],
      now_relative_to_expiry: 'after',
      classification: 'RECONCILING_RETAIN_AUTHORITY',
    },
    {
      id: 'unknown-or-malformed-input-state',
      output_state: 'MISSING',
      input_states: ['UNKNOWN', 'MALFORMED'],
      now_relative_to_expiry: 'after',
      classification: 'RECONCILING_RETAIN_AUTHORITY',
    },
    {
      id: 'spent-input-with-missing-output',
      output_state: 'MISSING',
      input_states: ['SPENT'],
      now_relative_to_expiry: 'after',
      classification: 'RECONCILING_RETAIN_AUTHORITY',
    },
  ]
}

function retryVectors(scenario, differentScenario) {
  return [
    {
      id: 'identical-request-retry',
      original_request_digest: scenario.request_digest,
      retry_request_digest: ctfRequestDigest(scenario.request),
      result: 'RETURN_CACHED_RESPONSE',
      expected_response: scenario.mint_response,
      expected_response_wire_json: scenario.mint_response_wire_json,
    },
    {
      id: 'different-request-digest',
      original_request_digest: scenario.request_digest,
      retry_request_digest: differentScenario.request_digest,
      result: 'CACHE_MISS_VALIDATE_AS_NEW_REQUEST',
    },
  ]
}

function keysetVectors() {
  return Object.fromEntries(
    Object.entries(KEYSETS).map(([name, keyset]) => {
      const { key_material_label: _keyMaterialLabel, ...published } = keyset
      return [name, published]
    }),
  )
}

function scenarioById(scenarios, id) {
  const scenario = scenarios.find((candidate) => candidate.id === id)
  if (scenario === undefined) {
    throw new Error(`fixture scenario is missing: ${id}`)
  }
  return scenario
}

function buildVectors() {
  const scenarios = [
    standardTwoPartyScenario(),
    standardMintScenario(),
    mixedBetterPriceScenario(),
    mixedFullFillScenario(),
    mixedPoolSellerScenario(),
    fragmentedOneVsManyScenario(),
  ]
  const largestRequest = Math.max(
    ...scenarios.map(({ serialized_request_bytes }) => serialized_request_bytes),
  )
  const betterPrice = scenarioById(scenarios, 'mixed-pool-standard-better-price')
  const fullFill = scenarioById(scenarios, 'mixed-pool-standard-full-fill-zero-change')
  return {
    format: 'bitcaster.nut-ctf-range-v1.conformance',
    format_version: 1,
    dialect: {
      nut_ctf_settle: {
        pull_request: 412,
        commit: 'dc5cfd5339cbbf9d257cd77ae3e95d1e9635cddc',
      },
      nut_exchange: {
        pull_request: 410,
        commit: '9b23df875e060870c1726ef61b4417fb4ee1878b',
      },
    },
    encoding: {
      json: 'Wire Proof and BlindedMessage amounts are JSON numbers. Canonical Proof and BlindedMessage amounts, plus wire/canonical PoolEntry amounts and indices, are minimal decimal strings.',
      condition_id: 'lowercase hex decoded to exactly 32 bytes in request canonical bytes',
      parent_collection_id:
        'omitted canonicalizes to 32 zero bytes; explicit value is lowercase hex decoded to exactly 32 bytes',
      participant:
        'one full JCS object; inputs sorted by (id, secret); outputs and pool_manifest retain declared order; pool_selection is lowercase canonical hex',
      participant_order: 'lexicographic minimum (id, secret) input tuple per participant',
      ctf_receive_domain: 'Cashu/ctf/convert/recv',
      ctf_manifest_domain: 'Cashu/ctf/convert/manifest',
      ctf_request_domain: 'Cashu/ctf/convert/request',
      refund_domain: 'Cashu/PAY_TO_UNLOCK/refund',
      bitmap: 'ceil(manifest length / 8) bytes, lowercase hex, bit i is LSB-first',
    },
    condition: {
      condition_id: CONDITION_ID,
      parent_collection_id: ZERO_PARENT,
      authorization_expiry: EXPIRY,
      earliest_final_expiry: FINAL_EXPIRY,
      outcomes: ['YES', 'NO'],
    },
    keysets: keysetVectors(),
    sample_mint_info: {
      'CTF-split-merge': {
        supported: true,
        version: 1,
        max_participants: 32,
        max_inputs: 512,
        max_outputs: 512,
        max_request_bytes: 1048576,
        idempotent_retries: true,
        max_expiry_seconds: 86400,
        partial_fill: true,
        max_pool_entries: 128,
      },
    },
    fixture_largest_request_bytes: largestRequest,
    rate_vectors: rateVectors(),
    ordering_vectors: orderingVectors(),
    count_limit_vectors: countLimitVectors(),
    large_amount_vectors: largeAmountVectors(),
    fee_allocation_vectors: feeAllocationVectors(),
    expiry_vectors: expiryVectors(),
    recovery_classification_vectors: recoveryClassificationVectors(),
    scenarios,
    request_digest_sensitivity: digestSensitivity(betterPrice),
    parent_collection_equivalence: parentCollectionEquivalence(betterPrice),
    retry_vectors: retryVectors(fullFill, betterPrice),
    invalid_cases: invalidCases(scenarios),
    invalid_wire_vectors: invalidWireVectors(scenarios),
  }
}

async function serializeVectors() {
  const prettierConfig = (await resolvePrettierConfig(OUTPUT_FILE)) ?? {}
  return formatWithPrettier(JSON.stringify(buildVectors()), {
    ...prettierConfig,
    parser: 'json',
  })
}

function checkVectors(expected) {
  let actual
  try {
    actual = readFileSync(OUTPUT_FILE, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('NUT-CTF range vector file is missing')
    }
    throw error
  }
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(
      `NUT-CTF range vectors are stale (expected sha256=${sha256Hex(expected)}, actual sha256=${sha256Hex(actual)})`,
    )
  }
}

async function main() {
  const mode = process.argv[2] ?? '--check'
  const serialized = await serializeVectors()
  if (mode === '--write') {
    mkdirSync(dirname(OUTPUT_FILE), { recursive: true })
    writeFileSync(OUTPUT_FILE, serialized)
    process.stdout.write(`wrote ${OUTPUT_FILE} (${Buffer.byteLength(serialized)} bytes)\n`)
    return
  }
  if (mode === '--check') {
    checkVectors(serialized)
    process.stdout.write(`verified ${OUTPUT_FILE} (${Buffer.byteLength(serialized)} bytes)\n`)
    return
  }
  throw new Error('usage: generate-nut-ctf-range-v1.mjs [--write|--check]')
}

await main()
