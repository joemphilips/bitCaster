import assert from 'node:assert/strict'
import test from 'node:test'
import { v2 as nip44 } from 'nostr-tools/nip44'
import { getPublicKey } from 'nostr-tools/pure'
import { hexToBytes } from 'nostr-tools/utils'
import { createPrivateNip78Content, decryptSelfNip44 } from '../src/privateNip78.ts'
import {
  ACTIVITY_LOG_D_TAG,
  decodeActivityLogPayload,
  encodeActivityLogPayload,
  type ActivityItem,
} from '../src/activityLog.ts'

const KEY = '11'.repeat(32)
const PUBLIC_KEY = getPublicKey(hexToBytes(KEY))
const ITEM: ActivityItem = {
  id: 'deposit-fixture',
  walletId: 'aa'.repeat(32),
  type: 'deposit',
  amountSubunits: 1237,
  baseAsset: 'sat',
  date: '2026-10-06T00:00:00.000Z',
  status: 'completed',
  txId: null,
  lightningInvoice: null,
}

test('private Activity content retains the browser envelope and real NIP-44 encryption', () => {
  const content = createPrivateNip78Content(
    KEY,
    ACTIVITY_LOG_D_TAG,
    encodeActivityLogPayload([ITEM]),
  )
  assert.equal(content.kind, 30078)
  assert.deepEqual(content.tags, [
    ['d', 'bitcaster:activity-log'],
    ['encrypted', 'nip44'],
  ])
  const conversation = nip44.utils.getConversationKey(hexToBytes(KEY), PUBLIC_KEY)
  assert.deepEqual(decodeActivityLogPayload(nip44.decrypt(content.content, conversation)), [ITEM])

  const browserContent = nip44.encrypt(encodeActivityLogPayload([ITEM]), conversation)
  assert.deepEqual(decodeActivityLogPayload(decryptSelfNip44(KEY, PUBLIC_KEY, browserContent)), [
    ITEM,
  ])
  assert.throws(() => decryptSelfNip44('22'.repeat(32), PUBLIC_KEY, browserContent))
  const tampered = Buffer.from(browserContent, 'base64')
  tampered[tampered.length - 1]! ^= 1
  assert.throws(() => decryptSelfNip44(KEY, PUBLIC_KEY, tampered.toString('base64')))
})
