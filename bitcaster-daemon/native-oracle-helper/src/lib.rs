use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ddk_messages::oracle_msgs::EventDescriptor;
use kormir::bitcoin::bip32::{ChildNumber, Xpriv};
use kormir::bitcoin::secp256k1::{Secp256k1, SecretKey};
use kormir::bitcoin::Network;
use kormir::lightning::io::Cursor;
use kormir::lightning::util::ser::{Readable, Writeable};
use kormir::nostr::{Event, EventBuilder, EventId, JsonUtil, Kind, Tag};
use kormir::private_backup::{
    validate_enum_authority, validate_enum_authority_json, PrivateEnumAuthority,
};
use kormir::storage::{same_event, OracleEventData, Storage};
use kormir::{Oracle, OracleAnnouncement, OracleAttestation};
use serde::{Deserialize, Serialize};

pub const MAX_INPUT_BYTES: usize = 1024 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_EVENT_ID_BYTES: usize = 512;
const MAX_OUTCOME_BYTES: usize = 191;
const MAX_TITLE_BYTES: usize = 256 * 1024;
const MAX_DESCRIPTION_BYTES: usize = 256 * 1024;
const MAX_ANNOUNCEMENT_HEX_TEXT_BYTES: usize = 48 * 1024;
const MAX_NOSTR_EVENT_JSON_BYTES: usize = 256 * 1024;
const MAX_OUTCOMES: usize = 8;
const MAX_NONCE_INDEX: u32 = 1 << 31;

type HelperResult<T> = Result<T, Failure>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Failure {
    InvalidRequest,
    InvalidAnnouncement,
    NonceMismatch,
    InvalidOutcome,
    InternalFailure,
}

impl Failure {
    fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid-request",
            Self::InvalidAnnouncement => "invalid-announcement",
            Self::NonceMismatch => "nonce-mismatch",
            Self::InvalidOutcome => "invalid-outcome",
            Self::InternalFailure => "internal-failure",
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case", deny_unknown_fields)]
enum Request {
    ValidateAuthority {
        version: u8,
        #[serde(rename = "privateDtoJson")]
        private_dto_json: String,
        #[serde(rename = "expectedOraclePubkey")]
        expected_oracle_pubkey: String,
    },
    ExportEnumAuthority {
        version: u8,
        #[serde(rename = "oracleSecretKeyHex")]
        oracle_secret_key_hex: String,
        #[serde(rename = "nonceSeedHex")]
        nonce_seed_hex: String,
        #[serde(rename = "reservedNonceIndex")]
        reserved_nonce_index: u32,
        #[serde(rename = "announcementTlvHex")]
        announcement_tlv_hex: String,
        #[serde(rename = "announcementEventJson")]
        announcement_event_json: String,
        #[serde(rename = "signedOutcome")]
        signed_outcome: Option<String>,
        #[serde(rename = "attestationHex")]
        attestation_hex: Option<String>,
        #[serde(rename = "attestationEventJson")]
        attestation_event_json: Option<String>,
        #[serde(rename = "publicationRecordJson")]
        publication_record_json: Option<String>,
    },
    SignExplicitEnum {
        version: u8,
        #[serde(rename = "oracleSecretKeyHex")]
        oracle_secret_key_hex: String,
        #[serde(rename = "privateDtoJson")]
        private_dto_json: String,
        #[serde(rename = "chosenOutcome")]
        chosen_outcome: String,
    },
    VerifyEnum {
        version: u8,
        #[serde(rename = "eventId")]
        event_id: String,
        #[serde(rename = "oraclePublicKeyHex")]
        oracle_public_key_hex: String,
        #[serde(rename = "chosenOutcome")]
        chosen_outcome: String,
        #[serde(rename = "announcementTlvHex")]
        announcement_tlv_hex: String,
        #[serde(rename = "announcementNostrEventJson")]
        announcement_nostr_event_json: String,
        #[serde(rename = "attestationHex")]
        attestation_hex: String,
        #[serde(rename = "attestationNostrEventJson")]
        attestation_nostr_event_json: String,
    },
    CreateEnum {
        version: u8,
        #[serde(rename = "oracleSecretKeyHex")]
        oracle_secret_key_hex: String,
        #[serde(rename = "nonceSeedHex")]
        nonce_seed_hex: String,
        #[serde(rename = "reservedNonceIndex")]
        reserved_nonce_index: u32,
        #[serde(rename = "eventId")]
        event_id: String,
        outcomes: Vec<String>,
        #[serde(rename = "eventMaturityEpoch")]
        event_maturity_epoch: u32,
        title: String,
        description: String,
    },
    SignEnum {
        version: u8,
        #[serde(rename = "oracleSecretKeyHex")]
        oracle_secret_key_hex: String,
        #[serde(rename = "nonceSeedHex")]
        nonce_seed_hex: String,
        #[serde(rename = "reservedNonceIndex")]
        reserved_nonce_index: u32,
        #[serde(rename = "eventId")]
        event_id: String,
        #[serde(rename = "chosenOutcome")]
        chosen_outcome: String,
        #[serde(rename = "announcementTlvHex")]
        announcement_tlv_hex: String,
        #[serde(rename = "announcementNostrEventJson")]
        announcement_nostr_event_json: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorResponse {
    version: u8,
    ok: bool,
    code: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateEnumResponse {
    version: u8,
    ok: bool,
    action: &'static str,
    event_id: String,
    oracle_public_key_hex: String,
    announcement_tlv_hex: String,
    announcement_nostr_event_id: String,
    announcement_nostr_event_json: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SignEnumResponse {
    version: u8,
    ok: bool,
    action: &'static str,
    event_id: String,
    chosen_outcome: String,
    attestation_hex: String,
    attestation_nostr_event_id: String,
    attestation_nostr_event_json: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifyEnumResponse {
    version: u8,
    ok: bool,
    action: &'static str,
    event_id: String,
    oracle_public_key_hex: String,
    chosen_outcome: String,
    announcement_nostr_event_id: String,
    attestation_nostr_event_id: String,
    nonce_point_hex: String,
    oracle_signature_hex: String,
}

#[derive(Clone)]
struct RequestStorage {
    reserved_index: u32,
    expected_event_id: String,
    allocated: Arc<Mutex<bool>>,
    record: Arc<Mutex<Option<OracleEventData>>>,
}

impl RequestStorage {
    fn for_create(reserved_index: u32, expected_event_id: String) -> Self {
        Self {
            reserved_index,
            expected_event_id,
            allocated: Arc::new(Mutex::new(false)),
            record: Arc::new(Mutex::new(None)),
        }
    }

    fn for_sign(
        reserved_index: u32,
        announcement: OracleAnnouncement,
        announcement_event_id: String,
    ) -> Self {
        let event_id = announcement.oracle_event.event_id.clone();
        Self {
            reserved_index,
            expected_event_id: event_id.clone(),
            allocated: Arc::new(Mutex::new(true)),
            record: Arc::new(Mutex::new(Some(OracleEventData {
                event_id,
                announcement,
                indexes: vec![reserved_index],
                signatures: Vec::new(),
                announcement_event_id: Some(announcement_event_id),
                attestation_event_id: None,
                private_authority: Default::default(),
            }))),
        }
    }
}

impl Storage for RequestStorage {
    async fn compare_exchange_event(
        &self,
        expected: Option<OracleEventData>,
        next: OracleEventData,
    ) -> Result<bool, kormir::error::Error> {
        if next.event_id != self.expected_event_id {
            return Err(kormir::error::Error::StorageFailure);
        }
        let mut record = self
            .record
            .lock()
            .map_err(|_| kormir::error::Error::StorageFailure)?;
        let matches = match (record.as_ref(), expected.as_ref()) {
            (None, None) => true,
            (Some(current), Some(expected)) => same_event(current, expected)?,
            _ => false,
        };
        if matches {
            *record = Some(next);
        }
        Ok(matches)
    }

    async fn get_next_nonce_indexes(&self, count: usize) -> Result<Vec<u32>, kormir::error::Error> {
        if count != 1 {
            return Err(kormir::error::Error::StorageFailure);
        }
        let mut allocated = self
            .allocated
            .lock()
            .map_err(|_| kormir::error::Error::StorageFailure)?;
        if *allocated {
            return Err(kormir::error::Error::StorageFailure);
        }
        *allocated = true;
        Ok(vec![self.reserved_index])
    }

    async fn save_announcement(
        &self,
        announcement: OracleAnnouncement,
        indexes: Vec<u32>,
    ) -> Result<String, kormir::error::Error> {
        let event_id = announcement.oracle_event.event_id.clone();
        if event_id != self.expected_event_id || indexes != [self.reserved_index] {
            return Err(kormir::error::Error::StorageFailure);
        }
        let mut record = self
            .record
            .lock()
            .map_err(|_| kormir::error::Error::StorageFailure)?;
        if record.is_some() {
            return Err(kormir::error::Error::StorageFailure);
        }
        *record = Some(OracleEventData {
            event_id: event_id.clone(),
            announcement,
            indexes,
            signatures: Vec::new(),
            announcement_event_id: None,
            attestation_event_id: None,
            private_authority: Default::default(),
        });
        Ok(event_id)
    }

    async fn save_signatures(
        &self,
        event_id: String,
        signatures: Vec<(String, kormir::Signature)>,
    ) -> Result<OracleEventData, kormir::error::Error> {
        if event_id != self.expected_event_id || signatures.len() != 1 {
            return Err(kormir::error::Error::StorageFailure);
        }
        let mut record = self
            .record
            .lock()
            .map_err(|_| kormir::error::Error::StorageFailure)?;
        let Some(event) = record.as_mut() else {
            return Err(kormir::error::Error::NotFound);
        };
        if !event.signatures.is_empty() {
            return Err(kormir::error::Error::EventAlreadySigned);
        }
        event.signatures = signatures;
        Ok(event.clone())
    }

    async fn get_event(
        &self,
        event_id: String,
    ) -> Result<Option<OracleEventData>, kormir::error::Error> {
        if event_id != self.expected_event_id {
            return Ok(None);
        }
        self.record
            .lock()
            .map(|record| record.clone())
            .map_err(|_| kormir::error::Error::StorageFailure)
    }
}

pub fn error_response(code: &'static str) -> Vec<u8> {
    serde_json::to_vec(&ErrorResponse {
        version: 1,
        ok: false,
        code,
    })
    .unwrap_or_else(|_| b"{\"version\":1,\"ok\":false,\"code\":\"internal-failure\"}".to_vec())
}

pub fn execute(input: &[u8]) -> (Vec<u8>, bool) {
    if input.len() > MAX_INPUT_BYTES {
        return (error_response("invalid-request"), false);
    }
    let request = match serde_json::from_slice::<Request>(input) {
        Ok(request) => request,
        Err(_) => return (error_response("invalid-request"), false),
    };
    let runtime = match tokio::runtime::Builder::new_current_thread().build() {
        Ok(runtime) => runtime,
        Err(_) => return (error_response("internal-failure"), false),
    };
    let result = runtime.block_on(dispatch(request));
    match result {
        Ok(response) => match serde_json::to_vec(&response) {
            Ok(response) if response.len() <= MAX_OUTPUT_BYTES => (response, true),
            _ => (error_response("internal-failure"), false),
        },
        Err(failure) => (error_response(failure.code()), false),
    }
}

async fn dispatch(request: Request) -> HelperResult<serde_json::Value> {
    match request {
        Request::ValidateAuthority {
            version,
            private_dto_json,
            expected_oracle_pubkey,
        } => {
            if version != 1 {
                return Err(Failure::InvalidRequest);
            }
            let validated =
                validate_enum_authority_json(&private_dto_json, Some(&expected_oracle_pubkey))
                    .map_err(|_| Failure::InvalidAnnouncement)?;
            Ok(
                serde_json::json!({ "version": 1, "ok": true, "action": "validate-authority", "summary": validated.summary }),
            )
        }
        Request::ExportEnumAuthority {
            version,
            oracle_secret_key_hex,
            nonce_seed_hex,
            reserved_nonce_index,
            announcement_tlv_hex,
            announcement_event_json,
            signed_outcome,
            attestation_hex,
            attestation_event_json,
            publication_record_json,
        } => {
            if version != 1 {
                return Err(Failure::InvalidRequest);
            }
            validate_nonce_index(reserved_nonce_index)?;
            let signing_key = parse_secret(&oracle_secret_key_hex)?;
            let master = parse_nonce_master(&nonce_seed_hex, &signing_key)?;
            let nonce = master
                .derive_priv(
                    &Secp256k1::new(),
                    &[ChildNumber::from_hardened_idx(reserved_nonce_index)
                        .map_err(|_| Failure::InvalidRequest)?],
                )
                .map_err(|_| Failure::InternalFailure)?
                .private_key;
            let dto = PrivateEnumAuthority {
                schema_version: 1,
                announcement_tlv_hex,
                announcement_event_json,
                nonce_scalar_hex: Some(hex::encode(nonce.secret_bytes())),
                signed_outcome,
                attestation_hex,
                attestation_event_json,
                publication_record_json,
            };
            let pubkey = signing_key
                .x_only_public_key(&Secp256k1::new())
                .0
                .to_string();
            validate_enum_authority(&dto, Some(&pubkey))
                .map_err(|_| Failure::InvalidAnnouncement)?;
            let json = serde_json::to_string(&dto).map_err(|_| Failure::InternalFailure)?;
            Ok(
                serde_json::json!({ "version": 1, "ok": true, "action": "export-enum-authority", "privateDtoJson": json }),
            )
        }
        Request::SignExplicitEnum {
            version,
            oracle_secret_key_hex,
            private_dto_json,
            chosen_outcome,
        } => {
            sign_explicit_enum(
                version,
                &oracle_secret_key_hex,
                &private_dto_json,
                chosen_outcome,
            )
            .await
        }
        Request::VerifyEnum {
            version,
            event_id,
            oracle_public_key_hex,
            chosen_outcome,
            announcement_tlv_hex,
            announcement_nostr_event_json,
            attestation_hex,
            attestation_nostr_event_json,
        } => verify_enum(
            version,
            &event_id,
            &oracle_public_key_hex,
            &chosen_outcome,
            &announcement_tlv_hex,
            &announcement_nostr_event_json,
            &attestation_hex,
            &attestation_nostr_event_json,
        ),
        Request::CreateEnum {
            version,
            oracle_secret_key_hex,
            nonce_seed_hex,
            reserved_nonce_index,
            event_id,
            outcomes,
            event_maturity_epoch,
            title,
            description,
        } => {
            if version != 1 {
                return Err(Failure::InvalidRequest);
            }
            validate_nonce_index(reserved_nonce_index)?;
            validate_event_id(&event_id)?;
            validate_outcomes(&outcomes)?;
            validate_text(&title, MAX_TITLE_BYTES)?;
            validate_text(&description, MAX_DESCRIPTION_BYTES)?;

            let signing_key = parse_secret(&oracle_secret_key_hex)?;
            let nonce_master = parse_nonce_master(&nonce_seed_hex, &signing_key)?;
            let storage = RequestStorage::for_create(reserved_nonce_index, event_id.clone());
            let oracle = Oracle::new(storage, signing_key, nonce_master);
            let announcement = oracle
                .create_enum_event(event_id.clone(), outcomes, event_maturity_epoch)
                .await
                .map_err(|_| Failure::InternalFailure)?;
            let secp = Secp256k1::new();
            announcement
                .validate(&secp)
                .map_err(|_| Failure::InternalFailure)?;

            let mut tlv = Vec::new();
            ddk_messages::ser_impls::write_as_tlv(&announcement, &mut tlv)
                .map_err(|_| Failure::InternalFailure)?;
            let nostr_keys = oracle.nostr_keys();
            let mut builder =
                EventBuilder::new(Kind::Custom(88), BASE64.encode(announcement.encode()));
            if !title.is_empty() {
                builder = builder.tag(
                    Tag::parse(["title", title.as_str()]).map_err(|_| Failure::InvalidRequest)?,
                );
            }
            if !description.is_empty() {
                builder = builder.tag(
                    Tag::parse(["description", description.as_str()])
                        .map_err(|_| Failure::InvalidRequest)?,
                );
            }
            let nostr_event = builder
                .sign_with_keys(&nostr_keys)
                .map_err(|_| Failure::InternalFailure)?;
            nostr_event.verify().map_err(|_| Failure::InternalFailure)?;

            let response = CreateEnumResponse {
                version: 1,
                ok: true,
                action: "create-enum",
                event_id,
                oracle_public_key_hex: oracle.public_key().to_string(),
                announcement_tlv_hex: hex::encode(tlv),
                announcement_nostr_event_id: nostr_event.id.to_hex(),
                announcement_nostr_event_json: nostr_event.as_json(),
            };
            serde_json::to_value(response).map_err(|_| Failure::InternalFailure)
        }
        Request::SignEnum {
            version,
            oracle_secret_key_hex,
            nonce_seed_hex,
            reserved_nonce_index,
            event_id,
            chosen_outcome,
            announcement_tlv_hex,
            announcement_nostr_event_json,
        } => {
            if version != 1 {
                return Err(Failure::InvalidRequest);
            }
            validate_nonce_index(reserved_nonce_index)?;
            validate_event_id(&event_id)?;
            validate_text(&chosen_outcome, MAX_OUTCOME_BYTES)?;
            validate_hex_size(&announcement_tlv_hex, MAX_ANNOUNCEMENT_HEX_TEXT_BYTES)?;
            validate_text(&announcement_nostr_event_json, MAX_NOSTR_EVENT_JSON_BYTES)?;

            let signing_key = parse_secret(&oracle_secret_key_hex)?;
            let nonce_master = parse_nonce_master(&nonce_seed_hex, &signing_key)?;
            let announcement_bytes =
                hex::decode(&announcement_tlv_hex).map_err(|_| Failure::InvalidAnnouncement)?;
            if hex::encode(&announcement_bytes) != announcement_tlv_hex {
                return Err(Failure::InvalidAnnouncement);
            }
            let mut cursor = Cursor::new(&announcement_bytes);
            let announcement =
                ddk_messages::ser_impls::read_as_tlv::<OracleAnnouncement, _>(&mut cursor)
                    .map_err(|_| Failure::InvalidAnnouncement)?;
            if cursor.position() != announcement_bytes.len() as u64 {
                return Err(Failure::InvalidAnnouncement);
            }
            let mut canonical_tlv = Vec::new();
            ddk_messages::ser_impls::write_as_tlv(&announcement, &mut canonical_tlv)
                .map_err(|_| Failure::InvalidAnnouncement)?;
            if canonical_tlv != announcement_bytes {
                return Err(Failure::InvalidAnnouncement);
            }
            validate_announcement(&announcement, &event_id, &signing_key)?;
            validate_nonce_binding(&announcement, reserved_nonce_index, &nonce_master)?;
            let outcomes = enum_outcomes(&announcement)?;
            if !outcomes.contains(&chosen_outcome) {
                return Err(Failure::InvalidOutcome);
            }

            let nostr_event = Event::from_json(&announcement_nostr_event_json)
                .map_err(|_| Failure::InvalidAnnouncement)?;
            let nostr_keys = kormir::nostr::Keys::new(
                kormir::nostr::key::SecretKey::from_slice(&signing_key.secret_bytes())
                    .map_err(|_| Failure::InvalidRequest)?,
            );
            validate_announcement_event(&nostr_event, &announcement, &nostr_keys.public_key())?;

            let announcement_event_id = nostr_event.id.to_hex();
            let storage = RequestStorage::for_sign(
                reserved_nonce_index,
                announcement.clone(),
                announcement_event_id.clone(),
            );
            let oracle = Oracle::new(storage, signing_key, nonce_master);
            let attestation = oracle
                .sign_enum_event(event_id.clone(), chosen_outcome.clone())
                .await
                .map_err(map_sign_error)?;
            attestation
                .validate(&Secp256k1::new(), &announcement)
                .map_err(|_| Failure::NonceMismatch)?;
            let attestation_event_id = EventId::from_hex(&announcement_event_id)
                .map_err(|_| Failure::InvalidAnnouncement)?;
            let attestation_event = kormir::nostr_events::create_attestation_event(
                &oracle.nostr_keys(),
                &attestation,
                attestation_event_id,
            )
            .map_err(|_| Failure::InternalFailure)?;
            attestation_event
                .verify()
                .map_err(|_| Failure::InternalFailure)?;

            let response = SignEnumResponse {
                version: 1,
                ok: true,
                action: "sign-enum",
                event_id,
                chosen_outcome,
                attestation_hex: hex::encode(attestation.encode()),
                attestation_nostr_event_id: attestation_event.id.to_hex(),
                attestation_nostr_event_json: attestation_event.as_json(),
            };
            serde_json::to_value(response).map_err(|_| Failure::InternalFailure)
        }
    }
}

async fn sign_explicit_enum(
    version: u8,
    oracle_secret_key_hex: &str,
    private_dto_json: &str,
    chosen_outcome: String,
) -> HelperResult<serde_json::Value> {
    if version != 1 {
        return Err(Failure::InvalidRequest);
    }
    validate_text(&chosen_outcome, MAX_OUTCOME_BYTES)?;
    let signing_key = parse_secret(oracle_secret_key_hex)?;
    let pubkey = signing_key
        .x_only_public_key(&Secp256k1::new())
        .0
        .to_string();
    let validated = validate_enum_authority_json(private_dto_json, Some(&pubkey))
        .map_err(|_| Failure::InvalidAnnouncement)?;
    let dto: PrivateEnumAuthority =
        serde_json::from_str(private_dto_json).map_err(|_| Failure::InvalidAnnouncement)?;
    if dto.nonce_scalar_hex.is_none() {
        return Err(Failure::InvalidRequest);
    }
    if !validated.summary.outcomes.contains(&chosen_outcome)
        || dto
            .signed_outcome
            .as_ref()
            .is_some_and(|choice| choice != &chosen_outcome)
    {
        return Err(Failure::InvalidOutcome);
    }
    let event_id = validated.summary.event_id;
    let (attestation_hex, event_json) = match (dto.attestation_hex, dto.attestation_event_json) {
        (Some(hex), Some(json)) => (hex, json),
        (None, None) => {
            let announcement = validated.data.announcement.clone();
            let parent_id = validated
                .data
                .announcement_event_id
                .clone()
                .ok_or(Failure::InvalidAnnouncement)?;
            let storage = RequestStorage {
                reserved_index: 0,
                expected_event_id: event_id.clone(),
                allocated: Arc::new(Mutex::new(true)),
                record: Arc::new(Mutex::new(Some(validated.data))),
            };
            // Explicit authority never allocates or derives a nonce from this master.
            let oracle = Oracle::from_signing_key(storage, signing_key)
                .map_err(|_| Failure::InternalFailure)?;
            let attestation = oracle
                .sign_enum_event(event_id.clone(), chosen_outcome.clone())
                .await
                .map_err(map_sign_error)?;
            attestation
                .validate(&Secp256k1::new(), &announcement)
                .map_err(|_| Failure::NonceMismatch)?;
            let event = kormir::nostr_events::create_attestation_event(
                &oracle.nostr_keys(),
                &attestation,
                EventId::from_hex(&parent_id).map_err(|_| Failure::InvalidAnnouncement)?,
            )
            .map_err(|_| Failure::InternalFailure)?;
            (hex::encode(attestation.encode()), event.as_json())
        }
        _ => return Err(Failure::InvalidAnnouncement),
    };
    let event = Event::from_json(&event_json).map_err(|_| Failure::InvalidAnnouncement)?;
    serde_json::to_value(SignEnumResponse {
        version: 1,
        ok: true,
        action: "sign-explicit-enum",
        event_id,
        chosen_outcome,
        attestation_hex,
        attestation_nostr_event_id: event.id.to_hex(),
        attestation_nostr_event_json: event_json,
    })
    .map_err(|_| Failure::InternalFailure)
}

// Verification has no secret, nonce allocator, storage, signing, or publication path.
#[allow(clippy::too_many_arguments)]
fn verify_enum(
    version: u8,
    event_id: &str,
    oracle_public_key_hex: &str,
    chosen_outcome: &str,
    announcement_tlv_hex: &str,
    announcement_nostr_event_json: &str,
    attestation_hex: &str,
    attestation_nostr_event_json: &str,
) -> HelperResult<serde_json::Value> {
    if version != 1 {
        return Err(Failure::InvalidRequest);
    }
    validate_event_id(event_id)?;
    validate_text(chosen_outcome, MAX_OUTCOME_BYTES)?;
    validate_hex_size(announcement_tlv_hex, MAX_ANNOUNCEMENT_HEX_TEXT_BYTES)?;
    validate_hex_size(attestation_hex, MAX_ANNOUNCEMENT_HEX_TEXT_BYTES)?;
    validate_text(announcement_nostr_event_json, MAX_NOSTR_EVENT_JSON_BYTES)?;
    validate_text(attestation_nostr_event_json, MAX_NOSTR_EVENT_JSON_BYTES)?;
    let announcement_bytes =
        hex::decode(announcement_tlv_hex).map_err(|_| Failure::InvalidAnnouncement)?;
    let mut cursor = Cursor::new(&announcement_bytes);
    let announcement = ddk_messages::ser_impls::read_as_tlv::<OracleAnnouncement, _>(&mut cursor)
        .map_err(|_| Failure::InvalidAnnouncement)?;
    let mut canonical_announcement = Vec::new();
    ddk_messages::ser_impls::write_as_tlv(&announcement, &mut canonical_announcement)
        .map_err(|_| Failure::InvalidAnnouncement)?;
    let outcomes = enum_outcomes(&announcement)?;
    validate_outcomes(&outcomes).map_err(|_| Failure::InvalidAnnouncement)?;
    let [committed_nonce] = announcement.oracle_event.oracle_nonces.as_slice() else {
        return Err(Failure::InvalidAnnouncement);
    };
    if cursor.position() != announcement_bytes.len() as u64
        || canonical_announcement != announcement_bytes
        || announcement.oracle_event.event_id != event_id
        || announcement.oracle_public_key.to_string() != oracle_public_key_hex
        || !outcomes.iter().any(|outcome| outcome == chosen_outcome)
    {
        return Err(Failure::InvalidAnnouncement);
    }
    announcement
        .validate(&Secp256k1::verification_only())
        .map_err(|_| Failure::InvalidAnnouncement)?;
    let announcement_event = Event::from_json(announcement_nostr_event_json)
        .map_err(|_| Failure::InvalidAnnouncement)?;
    validate_announcement_event(
        &announcement_event,
        &announcement,
        &announcement_event.pubkey,
    )?;
    if announcement_event.pubkey.to_hex() != oracle_public_key_hex {
        return Err(Failure::InvalidAnnouncement);
    }
    let attestation_bytes =
        hex::decode(attestation_hex).map_err(|_| Failure::InvalidAnnouncement)?;
    let mut cursor = Cursor::new(&attestation_bytes);
    let attestation =
        OracleAttestation::read(&mut cursor).map_err(|_| Failure::InvalidAnnouncement)?;
    if cursor.position() != attestation_bytes.len() as u64
        || attestation.event_id != event_id
        || attestation.oracle_public_key != announcement.oracle_public_key
        || attestation.outcomes != [chosen_outcome]
        || attestation.signatures.len() != 1
        || attestation.encode() != attestation_bytes
    {
        return Err(Failure::InvalidAnnouncement);
    }
    attestation
        .validate(&Secp256k1::verification_only(), &announcement)
        .map_err(|_| Failure::InvalidAnnouncement)?;
    let event =
        Event::from_json(attestation_nostr_event_json).map_err(|_| Failure::InvalidAnnouncement)?;
    if event.kind != Kind::Custom(89)
        || event.pubkey != announcement_event.pubkey
        || event.content != BASE64.encode(attestation_bytes)
        || event.tags.as_slice() != [Tag::event(announcement_event.id)]
        || event.verify().is_err()
    {
        return Err(Failure::InvalidAnnouncement);
    }
    serde_json::to_value(VerifyEnumResponse {
        version: 1,
        ok: true,
        action: "verify-enum",
        event_id: event_id.to_owned(),
        oracle_public_key_hex: oracle_public_key_hex.to_owned(),
        chosen_outcome: chosen_outcome.to_owned(),
        announcement_nostr_event_id: announcement_event.id.to_hex(),
        attestation_nostr_event_id: event.id.to_hex(),
        nonce_point_hex: committed_nonce.to_string(),
        oracle_signature_hex: attestation.signatures[0].to_string(),
    })
    .map_err(|_| Failure::InternalFailure)
}

fn validate_nonce_index(index: u32) -> HelperResult<()> {
    if index >= MAX_NONCE_INDEX {
        return Err(Failure::InvalidRequest);
    }
    Ok(())
}

fn validate_event_id(event_id: &str) -> HelperResult<()> {
    if event_id.is_empty() || event_id.len() > MAX_EVENT_ID_BYTES {
        return Err(Failure::InvalidRequest);
    }
    Ok(())
}

fn validate_outcomes(outcomes: &[String]) -> HelperResult<()> {
    if !(2..=MAX_OUTCOMES).contains(&outcomes.len()) {
        return Err(Failure::InvalidRequest);
    }
    for (index, outcome) in outcomes.iter().enumerate() {
        if outcome.trim().is_empty() || outcome.len() > MAX_OUTCOME_BYTES {
            return Err(Failure::InvalidRequest);
        }
        if outcomes[..index].iter().any(|previous| previous == outcome) {
            return Err(Failure::InvalidRequest);
        }
    }
    Ok(())
}

fn validate_text(value: &str, max_bytes: usize) -> HelperResult<()> {
    if value.len() > max_bytes {
        return Err(Failure::InvalidRequest);
    }
    Ok(())
}

fn validate_hex_size(value: &str, max_bytes: usize) -> HelperResult<()> {
    if value.is_empty() || value.len() > max_bytes || value.len() % 2 != 0 {
        return Err(Failure::InvalidAnnouncement);
    }
    Ok(())
}

fn parse_secret(secret_hex: &str) -> HelperResult<SecretKey> {
    if secret_hex.len() != 64 {
        return Err(Failure::InvalidRequest);
    }
    let secret = hex::decode(secret_hex).map_err(|_| Failure::InvalidRequest)?;
    SecretKey::from_slice(&secret).map_err(|_| Failure::InvalidRequest)
}

fn parse_nonce_master(seed_hex: &str, signing_key: &SecretKey) -> HelperResult<Xpriv> {
    if seed_hex.len() != 64 {
        return Err(Failure::InvalidRequest);
    }
    let seed = hex::decode(seed_hex).map_err(|_| Failure::InvalidRequest)?;
    if seed.as_slice() == signing_key.secret_bytes() {
        return Err(Failure::InvalidRequest);
    }
    Xpriv::new_master(Network::Bitcoin, &seed).map_err(|_| Failure::InvalidRequest)
}

fn validate_announcement(
    announcement: &OracleAnnouncement,
    expected_event_id: &str,
    signing_key: &SecretKey,
) -> HelperResult<()> {
    if announcement.oracle_event.event_id != expected_event_id {
        return Err(Failure::InvalidAnnouncement);
    }
    let outcomes = enum_outcomes(announcement)?;
    validate_outcomes(&outcomes).map_err(|_| Failure::InvalidAnnouncement)?;
    let secp = Secp256k1::new();
    if announcement.oracle_public_key != signing_key.x_only_public_key(&secp).0 {
        return Err(Failure::InvalidAnnouncement);
    }
    announcement
        .validate(&secp)
        .map_err(|_| Failure::InvalidAnnouncement)
}

fn enum_outcomes(announcement: &OracleAnnouncement) -> HelperResult<Vec<String>> {
    match &announcement.oracle_event.event_descriptor {
        EventDescriptor::EnumEvent(descriptor) => Ok(descriptor.outcomes.clone()),
        EventDescriptor::DigitDecompositionEvent(_) => Err(Failure::InvalidAnnouncement),
    }
}

fn validate_nonce_binding(
    announcement: &OracleAnnouncement,
    index: u32,
    nonce_master: &Xpriv,
) -> HelperResult<()> {
    validate_nonce_index(index)?;
    let [committed_nonce] = announcement.oracle_event.oracle_nonces.as_slice() else {
        return Err(Failure::InvalidAnnouncement);
    };
    let secp = Secp256k1::new();
    let child = ChildNumber::from_hardened_idx(index).map_err(|_| Failure::InvalidRequest)?;
    let nonce_key = nonce_master
        .derive_priv(&secp, &[child])
        .map_err(|_| Failure::NonceMismatch)?;
    let derived_nonce = nonce_key.private_key.x_only_public_key(&secp).0;
    if &derived_nonce != committed_nonce {
        return Err(Failure::NonceMismatch);
    }
    Ok(())
}

fn validate_announcement_event(
    event: &Event,
    announcement: &OracleAnnouncement,
    expected_public_key: &kormir::nostr::PublicKey,
) -> HelperResult<()> {
    if event.kind != Kind::Custom(88)
        || &event.pubkey != expected_public_key
        || event.content != BASE64.encode(announcement.encode())
        || event.verify().is_err()
    {
        return Err(Failure::InvalidAnnouncement);
    }
    Ok(())
}

fn map_sign_error(error: kormir::error::Error) -> Failure {
    match error {
        kormir::error::Error::InvalidNonces => Failure::NonceMismatch,
        kormir::error::Error::InvalidOutcome => Failure::InvalidOutcome,
        kormir::error::Error::InvalidAnnouncement
        | kormir::error::Error::InvalidEventDescriptor
        | kormir::error::Error::NotFound => Failure::InvalidAnnouncement,
        _ => Failure::InternalFailure,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_enum_uses_only_public_artifacts_and_rejects_foreign_bindings() {
        let invoke = |request: serde_json::Value| {
            let (bytes, success) = execute(&serde_json::to_vec(&request).unwrap());
            (
                serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
                success,
            )
        };
        let (announcement, created) = invoke(serde_json::json!({
            "version": 1, "action": "create-enum", "oracleSecretKeyHex": "01".repeat(32),
            "nonceSeedHex": "02".repeat(32), "reservedNonceIndex": 0,
            "eventId": "verify-fixture", "outcomes": ["Yes", "No"],
            "eventMaturityEpoch": 2_000_000_000u32, "title": "Fixture", "description": "Fixture"
        }));
        assert!(created);
        let (attestation, signed) = invoke(serde_json::json!({
            "version": 1, "action": "sign-enum", "oracleSecretKeyHex": "01".repeat(32),
            "nonceSeedHex": "02".repeat(32), "reservedNonceIndex": 0,
            "eventId": "verify-fixture", "chosenOutcome": "Yes",
            "announcementTlvHex": announcement["announcementTlvHex"],
            "announcementNostrEventJson": announcement["announcementNostrEventJson"]
        }));
        assert!(signed);
        let request = serde_json::json!({
            "version": 1, "action": "verify-enum", "eventId": "verify-fixture",
            "oraclePublicKeyHex": announcement["oraclePublicKeyHex"], "chosenOutcome": "Yes",
            "announcementTlvHex": announcement["announcementTlvHex"],
            "announcementNostrEventJson": announcement["announcementNostrEventJson"],
            "attestationHex": attestation["attestationHex"],
            "attestationNostrEventJson": attestation["attestationNostrEventJson"]
        });
        let (verified, success) = invoke(request.clone());
        assert!(success);
        assert_eq!(verified["action"], "verify-enum");
        assert_eq!(
            verified["attestationNostrEventId"],
            attestation["attestationNostrEventId"]
        );
        assert_eq!(verified["noncePointHex"].as_str().unwrap().len(), 64);
        assert_eq!(verified["oracleSignatureHex"].as_str().unwrap().len(), 128);
        for (field, value) in [
            ("chosenOutcome", "No".to_owned()),
            ("eventId", "other".to_owned()),
            ("oraclePublicKeyHex", "00".repeat(32)),
            ("oracleSecretKeyHex", "01".repeat(32)),
        ] {
            let mut foreign = request.clone();
            foreign[field] = serde_json::Value::String(value);
            assert!(!invoke(foreign).1);
        }
    }

    #[test]
    fn nonce_index_stops_before_kormir_hardened_child_boundary() {
        assert_eq!(validate_nonce_index(MAX_NONCE_INDEX - 1), Ok(()));
        assert_eq!(
            validate_nonce_index(MAX_NONCE_INDEX),
            Err(Failure::InvalidRequest)
        );
        assert_eq!(validate_nonce_index(u32::MAX), Err(Failure::InvalidRequest));
    }

    #[test]
    fn helper_envelopes_and_metadata_limits_match_the_daemon_contract() {
        assert_eq!(MAX_INPUT_BYTES, 1024 * 1024);
        assert_eq!(MAX_OUTPUT_BYTES, 1024 * 1024);
        assert_eq!(MAX_TITLE_BYTES, 256 * 1024);
        assert_eq!(MAX_DESCRIPTION_BYTES, 256 * 1024);
        assert_eq!(MAX_NOSTR_EVENT_JSON_BYTES, 256 * 1024);
        assert_eq!(MAX_ANNOUNCEMENT_HEX_TEXT_BYTES, 48 * 1024);

        assert_eq!(
            validate_text(&"t".repeat(MAX_TITLE_BYTES), MAX_TITLE_BYTES),
            Ok(())
        );
        assert_eq!(
            validate_text(&"t".repeat(MAX_TITLE_BYTES + 1), MAX_TITLE_BYTES),
            Err(Failure::InvalidRequest)
        );
        assert_eq!(
            validate_text(&"d".repeat(MAX_DESCRIPTION_BYTES), MAX_DESCRIPTION_BYTES),
            Ok(())
        );
        assert_eq!(
            validate_text(
                &"d".repeat(MAX_DESCRIPTION_BYTES + 1),
                MAX_DESCRIPTION_BYTES
            ),
            Err(Failure::InvalidRequest)
        );
        assert_eq!(
            validate_text(
                &"{".repeat(MAX_NOSTR_EVENT_JSON_BYTES),
                MAX_NOSTR_EVENT_JSON_BYTES
            ),
            Ok(())
        );
        assert_eq!(
            validate_text(
                &"{".repeat(MAX_NOSTR_EVENT_JSON_BYTES + 1),
                MAX_NOSTR_EVENT_JSON_BYTES
            ),
            Err(Failure::InvalidRequest)
        );
    }

    #[test]
    fn enum_outcomes_accept_191_bytes_and_reject_192() {
        assert_eq!(
            validate_outcomes(&["A".repeat(MAX_OUTCOME_BYTES), "NO".to_owned()]),
            Ok(())
        );
        assert_eq!(
            validate_outcomes(&["A".repeat(MAX_OUTCOME_BYTES + 1), "NO".to_owned()]),
            Err(Failure::InvalidRequest)
        );
    }

    #[test]
    fn storage_returns_one_reserved_index_and_refuses_second_use() {
        let storage = RequestStorage::for_create(7, "event".to_owned());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            assert_eq!(storage.get_next_nonce_indexes(1).await.unwrap(), vec![7]);
            assert!(storage.get_next_nonce_indexes(1).await.is_err());
            assert!(storage.get_next_nonce_indexes(2).await.is_err());
        });
    }

    #[test]
    fn request_store_refuses_a_second_signature_for_the_event() {
        let request = serde_json::json!({
            "version": 1,
            "action": "create-enum",
            "oracleSecretKeyHex": "01".repeat(32),
            "nonceSeedHex": "02".repeat(32),
            "reservedNonceIndex": 0,
            "eventId": "duplicate-signing",
            "outcomes": ["YES", "NO"],
            "eventMaturityEpoch": 1_800_000_000u32,
            "title": "",
            "description": ""
        });
        let (response, created) = execute(&serde_json::to_vec(&request).unwrap());
        assert!(created);
        let response: serde_json::Value = serde_json::from_slice(&response).unwrap();
        let announcement_bytes =
            hex::decode(response["announcementTlvHex"].as_str().unwrap()).unwrap();
        let mut cursor = Cursor::new(announcement_bytes.as_slice());
        let announcement =
            ddk_messages::ser_impls::read_as_tlv::<OracleAnnouncement, _>(&mut cursor).unwrap();
        let event_id = announcement.oracle_event.event_id.clone();
        let storage = RequestStorage::for_sign(
            0,
            announcement,
            response["announcementNostrEventId"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
        let oracle = Oracle::new(
            storage,
            parse_secret(&"01".repeat(32)).unwrap(),
            parse_nonce_master(&"02".repeat(32), &parse_secret(&"01".repeat(32)).unwrap()).unwrap(),
        );
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            oracle
                .sign_enum_event(event_id.clone(), "YES".to_owned())
                .await
                .unwrap();
            assert!(matches!(
                oracle.sign_enum_event(event_id, "YES".to_owned()).await,
                Err(kormir::error::Error::EventAlreadySigned)
            ));
        });
    }
}
