/** Direct provider access is confined to fixtures that inspect real IndexedDB authority. */
import { withCreatorDocumentLock } from "@/lib/browserCreatorDocumentLock";
import { prepareEnumAnnouncement, prepareEnumAttestation } from "@/lib/kormir";
import * as provider from "@/lib/kormir-wasm-pkg/kormir_wasm";

async function load() {
  await provider.default();
  return provider;
}
export async function fixtureOracleCore(_relays: string[] = []) {
  const module = await load();
  return withCreatorDocumentLock(() => module.Kormir.new([]));
}
export async function installFixtureOracleKey(_relays: string[], key: string) {
  const module = await load();
  await withCreatorDocumentLock(() => module.Kormir.restore(key));
}
export async function restoreFixtureOracleKey(key: string) {
  await installFixtureOracleKey([], key);
}
export async function prepareFixtureAnnouncement(
  _relays: string[],
  eventId: string,
  outcomes: string[],
  maturity: number,
  title = eventId,
  description = title,
) {
  const module = await load();
  return withCreatorDocumentLock(async () => {
    const core = await module.Kormir.new([]);
    try {
      return await prepareEnumAnnouncement(core, eventId, outcomes, maturity, title, description);
    } finally {
      core.free();
    }
  });
}
export async function prepareFixtureAttestation(
  _relays: string[],
  eventId: string,
  outcome: string,
  announcement: string,
  announcementHex?: string,
) {
  const module = await load();
  return withCreatorDocumentLock(async () => {
    const core = await module.Kormir.new([]);
    try {
      return await prepareEnumAttestation(core, eventId, outcome, announcement, announcementHex);
    } finally {
      core.free();
    }
  });
}
