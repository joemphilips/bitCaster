// Regenerates `release5Reads` of merge-fill-v1.json. The script decodes the
// fixture payloads with the readers of the release 5 SDK (bitCaster commit
// e6a7b349ef39ecfda1d246b7f3c6e64794926c1f). CI does not run this script,
// because a CI checkout does not hold the release 5 tree.
//
// Run it with Node 22 from the bitCaster repository root, after `npm ci`:
//
//   export_dir="$(mktemp -d)"
//   git archive e6a7b349 bitcaster-client-sdk | tar -x -C "$export_dir"
//   ln -s "$PWD/node_modules" "$export_dir/node_modules"
//   node --experimental-strip-types \
//     bitcaster-client-sdk/test/fixtures/release5-merge-fill-reads.mjs \
//     "$export_dir/bitcaster-client-sdk" \
//     bitcaster-client-sdk/test/fixtures/merge-fill-v1.json
//
// The script prints the reads as JSON. The output must equal `release5Reads`.
// To update the fixture, replace `release5Reads` with the output, then run
// Prettier on the fixture.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [sdkRoot, fixturePath] = process.argv.slice(2)
if (sdkRoot === undefined || fixturePath === undefined) {
  throw new Error('usage: release5-merge-fill-reads.mjs <release 5 SDK root> <fixture path>')
}
const sdk = await import(pathToFileURL(join(sdkRoot, 'src', 'engineClient.ts')).href)
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
const reads = {
  submitOrderResponse: sdk.decodeSubmitOrderResponse(structuredClone(fixture.submitOrderResponse)),
  matchedDelta: sdk.decodeMatchedDelta(structuredClone(fixture.matchedDelta)),
}
process.stdout.write(`${JSON.stringify(reads, null, 2)}\n`)
