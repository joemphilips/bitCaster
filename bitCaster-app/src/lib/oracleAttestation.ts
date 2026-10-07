import { type NDKKind } from "@nostr-dev-kit/ndk";
import { finalizeEvent } from "nostr-tools/pure";
import { hexToBytes } from "nostr-tools/utils";
import {
  BitcasterEngineClient,
  deriveDlcConditionId,
  verifyDlcOracleResolution,
  submitOracleAttestationViaEngine,
  type ConditionAttestationResponse,
} from "@bitcaster/client-sdk";
import {
  publishOracleOutcome,
  retryOraclePublication,
  type OraclePublicationBinding,
  type PreparedOracleAttestation,
  type VerifiedOraclePublicationEvidence,
  type OraclePublicationOptions,
} from "@bitcaster/client-sdk/oraclePublication";
import {
  createOracleExplanationTemplate,
  readSignedOracleEvent,
  verifyOracleResolutionExplanation,
  type OracleExplanationContext,
} from "@bitcaster/client-sdk/oracleResolutionExplanation";
import type { components } from "@/generated/api";
import {
  creatorOraclePublicationStore,
  useCreatorMarketsStore,
  type StoredCreatorMarket,
} from "@/stores/creatorMarkets";
import { useSettingsStore } from "@/stores/settings";
import {
  decodeOracleAnnouncement,
  decodeOracleAttestation,
  prepareEnumAttestation,
  prepareBrowserOracleMutation,
  type BrowserOracleMutation,
} from "./kormir";
import { browserOracleOwnerAuthority, reconcileLockedBrowserOracle } from "./browserOracleBackup";
import { resolveNsecIdentity } from "./identityOps";
import {
  boundedOracleRelay as boundedRelay,
  publishRetainedOracleEvent,
} from "./oracleRelayTransport";
export { publishRetainedOracleEvent } from "./oracleRelayTransport";
import { requestBrowserOracleBackup } from "./browserOracleBackupDelivery";
import { sha256Hex } from "./markets";
import { announcementContentFromTlv } from "@bitcaster/client-sdk/oracleAnnouncementEncoding";

export type OracleNostrEvent = components["schemas"]["OracleNostrEvent"];
type RegisteredAuthority = components["schemas"]["RegisteredConditionAuthority"];
type OracleAuthoritySource =
  | { readonly announcementTlvHex: string }
  | { readonly registeredAuthority: unknown };
// The additive read field uses the existing public wire event.
export type OracleAttestationReadPort = (conditionId: string) => Promise<
  | (ConditionAttestationResponse & {
      readonly attestationEvent: OracleNostrEvent;
    })
  | null
>;

export function oracleEventToWire(eventJson: string): OracleNostrEvent {
  const event = readSignedOracleEvent(eventJson, 89);
  return {
    id: event.id,
    pubkey: event.pubkey,
    createdAt: event.created_at,
    kind: 89,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig,
  };
}

export function oracleWireEventJson(event: OracleNostrEvent): string {
  const json = JSON.stringify({
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.createdAt,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
  });
  readSignedOracleEvent(json, 89);
  return json;
}

function artifactHex(content: string): string {
  if (content.length > 64 * 1024) throw new Error("Oracle artifact exceeds the local limit.");
  return Array.from(atob(content), (byte) => byte.charCodeAt(0).toString(16).padStart(2, "0")).join(
    "",
  );
}

/** Decode the original signed commitment. The attestation cannot supply authority. */
export async function retainedOracleAuthority(
  binding: OraclePublicationBinding,
  source: OracleAuthoritySource,
) {
  const event = readSignedOracleEvent(binding.announcementEventJson, 88);
  const hex = artifactHex(event.content);
  const announcement = await decodeOracleAnnouncement(hex);
  if (
    event.pubkey !== binding.oraclePubkey ||
    announcement.oraclePubkey !== binding.oraclePubkey ||
    announcement.eventId !== binding.oracleEventId ||
    JSON.stringify(announcement.outcomes) !== JSON.stringify(binding.outcomes) ||
    announcement.noncePoints.length !== 1 ||
    deriveDlcConditionId({
      eventId: announcement.eventId,
      outcomeCount: announcement.outcomes.length,
      oraclePublicKeys: [announcement.oraclePubkey],
    }) !== binding.conditionId
  )
    throw new Error("Original oracle announcement does not match this market.");
  const noncePoint = announcement.noncePoints[0]!.replace(/^(02|03)(?=[0-9a-f]{64}$)/, "");
  const announcementIdentity = await registeredAnnouncementIdentity(
    binding,
    event.content,
    noncePoint,
    source,
  );
  return {
    announcementEventId: event.id,
    outcomes: announcement.outcomes,
    threshold: 1,
    oracles: [
      {
        oraclePublicKey: announcement.oraclePubkey,
        noncePoint,
        announcementIdentity,
      },
    ],
  };
}

async function registeredAnnouncementIdentity(
  binding: OraclePublicationBinding,
  content: string,
  noncePoint: string,
  source: OracleAuthoritySource,
): Promise<string> {
  if ("announcementTlvHex" in source) {
    if (announcementContentFromTlv(source.announcementTlvHex) !== content)
      throw new Error("Original announcement bytes do not match the signed announcement.");
    return sha256Hex(new Uint8Array(hexToBytes(source.announcementTlvHex)));
  }
  const value = source.registeredAuthority;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Registered oracle authority is unavailable.");
  const registered = value as Partial<RegisteredAuthority>;
  const oracle =
    Array.isArray(registered.oracles) && registered.oracles.length === 1
      ? registered.oracles[0]
      : undefined;
  if (
    registered.eventId !== binding.oracleEventId ||
    registered.threshold !== 1 ||
    JSON.stringify(registered.outcomes) !== JSON.stringify(binding.outcomes) ||
    !oracle ||
    typeof oracle !== "object" ||
    oracle.oraclePublicKey !== binding.oraclePubkey ||
    oracle.noncePoint !== noncePoint ||
    typeof oracle.announcementIdentity !== "string" ||
    !/^[0-9a-f]{64}$/.test(oracle.announcementIdentity)
  )
    throw new Error("Registered oracle authority does not match the original signed announcement.");
  return oracle.announcementIdentity;
}

export async function verifyRetainedOracleAttestation(
  binding: OraclePublicationBinding,
  outcome: string,
  artifact: PreparedOracleAttestation,
  source: OracleAuthoritySource,
): Promise<VerifiedOraclePublicationEvidence> {
  const authority = await retainedOracleAuthority(binding, source);
  const event = readSignedOracleEvent(artifact.eventJson, 89);
  const decoded = await decodeOracleAttestation(artifact.attestationHex);
  if (
    event.pubkey !== binding.oraclePubkey ||
    artifactHex(event.content) !== artifact.attestationHex ||
    event.tags.length !== 1 ||
    JSON.stringify(event.tags[0]) !== JSON.stringify(["e", authority.announcementEventId]) ||
    decoded.eventId !== binding.oracleEventId ||
    decoded.oraclePubkey !== binding.oraclePubkey ||
    decoded.outcomes.length !== 1 ||
    decoded.outcomes[0] !== outcome ||
    decoded.signatures.length !== 1
  )
    throw new Error("Saved oracle attestation does not match the original announcement.");
  verifyDlcOracleResolution(authority, {
    schemaVersion: 1,
    source: "dlc-oracle-attestation",
    resolvedOutcome: outcome,
    attestations: [
      {
        oraclePublicKey: decoded.oraclePubkey,
        signature: decoded.signatures[0]!,
      },
    ],
  });
  return {
    conditionId: binding.conditionId,
    oracleEventId: binding.oracleEventId,
    oraclePubkey: binding.oraclePubkey,
    outcome,
    announcementEventId: authority.announcementEventId,
    attestationEventId: event.id,
  };
}

async function withOracleEngine<T>(
  action: (client: BitcasterEngineClient) => Promise<T>,
  baseUrl = window.location.origin,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const client = new BitcasterEngineClient({
      baseUrl,
      fetchImpl: (input, init) =>
        fetch(input, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([init.signal, controller.signal])
            : controller.signal,
        }),
    });
    return await action(client);
  } finally {
    clearTimeout(timer);
  }
}

const readEngineAttestation: OracleAttestationReadPort = (conditionId) =>
  withOracleEngine((client) => client.getConditionAttestation(conditionId));

export async function verifiedEngineOracleEvidence(
  binding: OraclePublicationBinding,
  artifact: PreparedOracleAttestation,
  outcome: string,
  read = readEngineAttestation,
  announcementTlvHex?: string,
): Promise<VerifiedOraclePublicationEvidence> {
  const response = await read(binding.conditionId);
  if (
    response === null ||
    response.conditionId !== binding.conditionId ||
    response.attestedOutcome !== outcome ||
    !response.attestationEvent ||
    oracleWireEventJson(response.attestationEvent) !==
      oracleWireEventJson(oracleEventToWire(artifact.eventJson))
  )
    throw new Error("Matching verified engine attestation evidence is unavailable.");
  await verifyRetainedOracleAttestation(binding, outcome, artifact, {
    registeredAuthority: response.registeredAuthority,
  });
  if (announcementTlvHex) {
    const retained = await retainedOracleAuthority(binding, { announcementTlvHex });
    const registered = await retainedOracleAuthority(binding, {
      registeredAuthority: response.registeredAuthority,
    });
    if (retained.oracles[0]!.announcementIdentity !== registered.oracles[0]!.announcementIdentity)
      throw new Error("Registered announcement identity does not match the original bytes.");
  }
  return {
    conditionId: binding.conditionId,
    oracleEventId: binding.oracleEventId,
    oraclePubkey: binding.oraclePubkey,
    outcome,
    announcementEventId: readSignedOracleEvent(binding.announcementEventJson, 88).id,
    attestationEventId: readSignedOracleEvent(artifact.eventJson, 89).id,
  };
}

async function recoverAnnouncement(market: StoredCreatorMarket, relays: string[]) {
  const oracle = market.oracle;
  if (!oracle?.announcementEventId || !oracle.announcementHex)
    throw new Error(
      "Restore the original signed oracle announcement before resolving this market.",
    );
  if (oracle.announcementEventJson) return oracle.announcementEventJson;
  const json = await boundedRelay(relays, async (ndk) => {
    const event = await ndk.fetchEvent({
      ids: [oracle.announcementEventId!],
      kinds: [88 as NDKKind],
      limit: 1,
    });
    return event ? JSON.stringify(event.rawEvent()) : null;
  });
  if (
    !json ||
    readSignedOracleEvent(json, 88).id !== oracle.announcementEventId ||
    readSignedOracleEvent(json, 88).content !== announcementContentFromTlv(oracle.announcementHex)
  )
    throw new Error(
      "The original signed oracle announcement is unavailable. Retry recovery without changing the outcome.",
    );
  return json;
}

function browserOracleAdapters(
  binding: OraclePublicationBinding,
  announcementHex: string,
  relays: string[],
  store: ReturnType<typeof creatorOraclePublicationStore>,
  read: OracleAttestationReadPort,
  owner: typeof useCreatorMarketsStore,
  engineUrl: string,
  privateAdmission?: BrowserOracleMutation,
) {
  const requireSigner = () => {
    const settings = useSettingsStore.getState();
    const identity = resolveNsecIdentity(settings.nsecSecret);
    if (
      !identity ||
      settings.nostrSignerMode !== "nsec" ||
      identity.publicKey !== binding.oraclePubkey
    )
      throw new Error("Use the original oracle key to sign this outcome.");
    return identity;
  };
  return {
    store,
    async prepareAttestation(saved: OraclePublicationBinding, chosen: string) {
      privateAdmission?.requireCurrent();
      requireSigner();
      const admission = await prepareBrowserOracleMutation(saved.oraclePubkey);
      const result = await owner.getState().withOracleMutation((locked) =>
        admission.withCoreLocked(async (core) => {
          const reconciled = await reconcileLockedBrowserOracle(
            locked,
            saved,
            announcementHex,
            core,
          );
          if (reconciled.publication?.chosenOutcome !== chosen)
            throw new Error("The saved oracle outcome cannot change.");
          if (reconciled.publication.attestation) return reconciled.publication.attestation;
          const artifact = await prepareEnumAttestation(
            core,
            saved.oracleEventId,
            chosen,
            saved.announcementEventJson,
            announcementHex,
          );
          const exact = await reconcileLockedBrowserOracle(locked, saved, announcementHex, core, {
            ...reconciled.publication,
            attestation: { attestationHex: artifact.artifactHex, eventJson: artifact.eventJson },
          });
          if (!exact.publication?.attestation)
            throw new Error("Exact oracle preparation is unavailable.");
          return exact.publication.attestation;
        }),
      );
      admission.requireCurrent();
      privateAdmission?.requireCurrent();
      return result;
    },
    verifyAttestation: (
      saved: OraclePublicationBinding,
      chosen: string,
      artifact: PreparedOracleAttestation,
    ) =>
      verifyRetainedOracleAttestation(saved, chosen, artifact, {
        announcementTlvHex: announcementHex,
      }),
    publishRelay: async (json: string) => {
      privateAdmission?.requireCurrent();
      return { eventId: await publishRetainedOracleEvent(relays, json) };
    },
    async submitEngine(saved: OraclePublicationBinding, json: string) {
      privateAdmission?.requireCurrent();
      const artifact = {
        attestationHex: artifactHex(readSignedOracleEvent(json, 89).content),
        eventJson: json,
      };
      const outcome = (await decodeOracleAttestation(artifact.attestationHex)).outcomes[0]!;
      privateAdmission?.requireCurrent();
      // A lost response is reconciled by the verified read, not by an HTTP status.
      try {
        await withOracleEngine(
          (client) =>
            submitOracleAttestationViaEngine(client, binding.conditionId, oracleEventToWire(json)),
          engineUrl,
        );
      } catch {
        privateAdmission?.requireCurrent();
        return verifiedEngineOracleEvidence(saved, artifact, outcome, read, announcementHex);
      }
      privateAdmission?.requireCurrent();
      return verifiedEngineOracleEvidence(saved, artifact, outcome, read, announcementHex);
    },
    async prepareExplanation(context: OracleExplanationContext, text: string) {
      privateAdmission?.requireCurrent();
      const signer = requireSigner();
      return JSON.stringify(
        finalizeEvent(
          createOracleExplanationTemplate(context, text, Math.floor(Date.now() / 1000)),
          hexToBytes(signer.privateKeyHex),
        ),
      );
    },
  };
}

export async function publishBrowserOracleOutcome(
  conditionId: string,
  outcome: string,
  explanation: string | undefined,
  relays: string[],
  store = useCreatorMarketsStore,
  read?: OracleAttestationReadPort,
  options: OraclePublicationOptions = { engineDelivery: "synchronize" },
) {
  if (!store.getState().hasOraclePersistence())
    throw new Error("Durable creator storage is unavailable.");
  let owner = await store.getState().readOracleOwner(conditionId);
  if (!owner) throw new Error("Creator oracle record is unavailable.");
  if (owner.kind === "created") {
    const market = owner.market;
    if (!market.oracle) throw new Error("Creator oracle record is unavailable.");
    const announcementEventJson = await recoverAnnouncement(
      market,
      market.oracle.destinations ? [...market.oracle.destinations.relayUrls] : relays,
    );
    await store.getState().retainOraclePreparation(conditionId, {
      ...market.oracle,
      oraclePubkey: readSignedOracleEvent(announcementEventJson, 88).pubkey,
      announcementEventJson,
    });
    owner = await store.getState().readOracleOwner(conditionId);
    if (!owner) throw new Error("Creator oracle record is unavailable.");
  }
  const { binding, announcementHex, destinations } = browserOracleOwnerAuthority(owner);
  const announcementEventJson = binding.announcementEventJson;
  const announcement = readSignedOracleEvent(announcementEventJson, 88);
  await retainedOracleAuthority(binding, { announcementTlvHex: announcementHex });
  const legacy = owner.kind === "created" ? owner.market.oracle : undefined;
  if (legacy && announcement.id !== legacy.announcementEventId)
    throw new Error("Original oracle preparation does not match this destination.");
  const engineUrl = destinations?.engineUrl ?? legacy?.engineBaseUrl ?? window.location.origin;
  const originalRelays = destinations ? [...destinations.relayUrls] : relays;
  const readOriginal =
    read ??
    ((id: string) => withOracleEngine((client) => client.getConditionAttestation(id), engineUrl));
  if (legacy?.attestationHex && (!legacy.attestationEventJson || !legacy.chosenOutcome)) {
    // An already-published legacy envelope must be recovered, never signed again.
    const response = legacy.attestationEventJson ? null : await readOriginal(conditionId);
    if ((!legacy.attestationEventJson && !response?.attestationEvent) || !legacy.attestedOutcome)
      throw new Error("Restore the exact previously signed attestation before retrying delivery.");
    const artifact = {
      attestationHex: legacy.attestationHex,
      eventJson: legacy.attestationEventJson ?? oracleWireEventJson(response!.attestationEvent),
    };
    await verifyRetainedOracleAttestation(binding, legacy.attestedOutcome, artifact, {
      announcementTlvHex: announcementHex,
    });
    const engineEvidence = response
      ? await verifiedEngineOracleEvidence(
          binding,
          artifact,
          legacy.attestedOutcome,
          async () => response,
          announcementHex,
        )
      : null;
    await store.getState().saveOraclePublication(conditionId, {
      binding,
      chosenOutcome: legacy.attestedOutcome,
      attestation: artifact,
      relayPublished: false,
      engineEvidence,
      explanationEventJson: null,
      explanationRelayPublished: false,
    });
  }
  const publicationStore = creatorOraclePublicationStore(store);
  let retained = await publicationStore.read(conditionId);
  if (retained && retained.chosenOutcome !== outcome)
    throw new Error("The saved oracle outcome cannot change.");
  if (retained === null && explanation !== undefined)
    await store.getState().saveOracleExplanationDraft(conditionId, explanation);
  const originalDraft = await store.getState().readOracleExplanationDraft(conditionId);
  const exactRetry = retained?.attestation !== null && retained?.attestation !== undefined;
  let privateAdmission: BrowserOracleMutation | undefined;
  if (!exactRetry) {
    privateAdmission = await prepareBrowserOracleMutation(binding.oraclePubkey);
    const admission = privateAdmission;
    await store.getState().withOracleMutation((locked) =>
      admission.withCoreLocked(async (core) => {
        await reconcileLockedBrowserOracle(locked, binding, announcementHex, core, {
          binding,
          chosenOutcome: outcome,
          attestation: null,
          relayPublished: false,
          engineEvidence: null,
          explanationEventJson: null,
          explanationRelayPublished: false,
        });
      }),
    );
    admission.requireCurrent();
    retained = await publicationStore.read(conditionId);
  }
  const adapters = browserOracleAdapters(
    binding,
    announcementHex,
    originalRelays,
    publicationStore,
    readOriginal,
    store,
    engineUrl,
    privateAdmission,
  );
  const result =
    exactRetry || retained?.attestation
      ? await retryOraclePublication(adapters, binding, options)
      : await publishOracleOutcome(
          adapters,
          binding,
          outcome,
          originalDraft?.trim() ? originalDraft : undefined,
          options,
        );
  privateAdmission?.requireCurrent();
  await store.getState().saveOraclePublicationFailures(conditionId, result.failures);
  privateAdmission?.requireCurrent();
  if (result.record.relayPublished) {
    // The signed result remains successful while its independent private backup is pending.
    requestBrowserOracleBackup(conditionId, { store });
  }
  return result;
}

/** This optional read runs after first paint and never supplies trading authority. */
export async function readBrowserResolutionExplanation(
  conditionId: string,
  relays: string[],
  read = readEngineAttestation,
): Promise<string | null> {
  const response = await read(conditionId);
  if (!response?.attestationEvent || response.conditionId !== conditionId) return null;
  const eventJson = oracleWireEventJson(response.attestationEvent);
  const attestation = readSignedOracleEvent(eventJson, 89);
  const parent = attestation.tags.find((tag) => tag[0] === "e")?.[1];
  if (!parent) return null;
  return (
    (await boundedRelay(relays, async (ndk) => {
      const original = await ndk.fetchEvent({
        ids: [parent],
        authors: [attestation.pubkey],
        kinds: [88 as NDKKind],
        limit: 1,
      });
      if (!original) return null;
      const announcementEventJson = JSON.stringify(original.rawEvent());
      const decoded = await decodeOracleAnnouncement(
        artifactHex(readSignedOracleEvent(announcementEventJson, 88).content),
      );
      const binding = {
        conditionId,
        oracleEventId: decoded.eventId,
        oraclePubkey: attestation.pubkey,
        outcomes: decoded.outcomes,
        announcementEventJson,
      };
      await verifyRetainedOracleAttestation(
        binding,
        response.attestedOutcome,
        {
          attestationHex: artifactHex(attestation.content),
          eventJson,
        },
        { registeredAuthority: response.registeredAuthority },
      );
      const context = {
        oraclePubkey: attestation.pubkey,
        announcementEventJson,
        attestationEventJson: eventJson,
      };
      const events = await ndk.fetchEvents({
        kinds: [1111],
        authors: [attestation.pubkey],
        "#e": [attestation.id],
        limit: 12,
      });
      const candidates = [];
      for (const event of events) {
        if (candidates.length === 12) break;
        candidates.push(event);
      }
      for (const event of candidates.sort(
        (a, b) => (a.created_at ?? 0) - (b.created_at ?? 0) || a.id.localeCompare(b.id),
      )) {
        try {
          return verifyOracleResolutionExplanation(context, JSON.stringify(event.rawEvent()))
            .content;
        } catch {
          /* A foreign companion is not resolution evidence. */
        }
      }
      return null;
    })) ?? null
  );
}
