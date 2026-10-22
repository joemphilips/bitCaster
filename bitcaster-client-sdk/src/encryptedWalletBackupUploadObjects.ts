import {
  decodeEncryptedWalletBackupV2BundleObjectWire,
  encodeEncryptedWalletBackupV2BundleObjectWire,
  type EncryptedWalletBackupV2BundleObjectWire,
} from './encryptedWalletBackupV2Bundle.ts'
import {
  type EncryptedWalletBackupV2BundleDescriptor,
  ENCRYPTED_WALLET_BACKUP_V2_DESCRIPTOR_OBJECT_MAX,
} from './encryptedWalletBackupV2Descriptor.ts'
import { requireBytes } from './encryptedWalletBackupServerValidation.ts'
interface DescriptorEnvelope {
  readonly mutation: { readonly addedBundle: EncryptedWalletBackupV2BundleDescriptor | null }
}
const OBJECT_WIRE_MAX_BYTES = 300000
export function encodeGroupObjects(
  value: unknown,
  envelope: DescriptorEnvelope,
): readonly Uint8Array[] {
  if (!Array.isArray(value)) throw new Error('encrypted backup v2 upload objects are invalid')
  const added = envelope.mutation.addedBundle
  if (added === null) {
    if (value.length !== 0) throw new Error('encrypted backup v2 removal group has objects')
    return Object.freeze([])
  }
  if (value.length !== added.objects.length)
    throw new Error('encrypted backup v2 upload objects are invalid')
  return Object.freeze(value.map((item, index) => encodeOrderedObject(item, added, index)))
}

export function decodeGroupObjects(
  value: unknown,
  envelope: DescriptorEnvelope,
): EncryptedWalletBackupV2BundleObjectWire[] {
  if (!Array.isArray(value)) throw new Error('encrypted backup v2 upload objects are invalid')
  const added = envelope.mutation.addedBundle
  if (added === null) {
    if (value.length !== 0) throw new Error('encrypted backup v2 removal group has objects')
    return []
  }
  if (
    value.length !== added.objects.length ||
    value.length > ENCRYPTED_WALLET_BACKUP_V2_DESCRIPTOR_OBJECT_MAX
  )
    throw new Error('encrypted backup v2 upload objects are invalid')
  return value.map((item, index) => {
    const object = decodeEncryptedWalletBackupV2BundleObjectWire(
      requireBytes(item, 1, OBJECT_WIRE_MAX_BYTES, 'bundle object wire'),
      added,
    )
    assertObjectOrder(object, added, index)
    return object
  })
}

function encodeOrderedObject(
  value: unknown,
  descriptor: EncryptedWalletBackupV2BundleDescriptor,
  index: number,
): Uint8Array {
  const wire = encodeEncryptedWalletBackupV2BundleObjectWire(value, descriptor)
  assertObjectOrder(
    decodeEncryptedWalletBackupV2BundleObjectWire(wire, descriptor),
    descriptor,
    index,
  )
  return wire
}

function assertObjectOrder(
  object: EncryptedWalletBackupV2BundleObjectWire,
  descriptor: EncryptedWalletBackupV2BundleDescriptor,
  index: number,
): void {
  const expected = descriptor.objects[index]
  if (
    expected === undefined ||
    object.objectId !== expected.objectId ||
    object.digest !== expected.digest
  )
    throw new Error('encrypted backup v2 upload object order is invalid')
}
