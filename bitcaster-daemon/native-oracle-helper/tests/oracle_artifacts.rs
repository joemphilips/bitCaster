use std::io::Write;
use std::process::{Command, Stdio};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ddk_messages::oracle_msgs::{
    DigitDecompositionEventDescriptor, EventDescriptor, OracleAnnouncement, OracleAttestation,
};
use kormir::bitcoin::secp256k1::Secp256k1;
use kormir::lightning::io::Cursor;
use kormir::lightning::util::ser::{Readable, Writeable};
use kormir::nostr::{Event, EventBuilder, JsonUtil, Kind, Tag};
use serde_json::{json, Value};

use bitcaster_oracle_helper::{execute, MAX_INPUT_BYTES};

fn oracle_secret() -> String {
    "01".repeat(32)
}

fn nonce_seed() -> String {
    "02".repeat(32)
}

fn create_request(event_id: &str, outcomes: &[&str]) -> Value {
    json!({
        "version": 1,
        "action": "create-enum",
        "oracleSecretKeyHex": oracle_secret(),
        "nonceSeedHex": nonce_seed(),
        "reservedNonceIndex": 0,
        "eventId": event_id,
        "outcomes": outcomes,
        "eventMaturityEpoch": 1_800_000_000u32,
        "title": "Market title",
        "description": "Market description"
    })
}

fn invoke(request: Value) -> (Value, bool) {
    let input = serde_json::to_vec(&request).unwrap();
    let (output, success) = execute(&input);
    (serde_json::from_slice(&output).unwrap(), success)
}

fn create_artifacts(event_id: &str, outcomes: &[&str]) -> Value {
    let (response, success) = invoke(create_request(event_id, outcomes));
    assert!(success, "helper create request failed: {response}");
    assert_eq!(response["ok"], true);
    response
}

fn decode_tlv(hex_value: &str) -> (OracleAnnouncement, Vec<u8>) {
    let bytes = hex::decode(hex_value).unwrap();
    let mut cursor = Cursor::new(bytes.as_slice());
    let announcement =
        ddk_messages::ser_impls::read_as_tlv::<OracleAnnouncement, _>(&mut cursor).unwrap();
    assert_eq!(cursor.position(), bytes.len() as u64);
    let mut canonical = Vec::new();
    ddk_messages::ser_impls::write_as_tlv(&announcement, &mut canonical).unwrap();
    assert_eq!(canonical, bytes);
    (announcement, bytes)
}

fn assert_create_artifacts(event_id: &str, outcomes: &[&str]) {
    let response = create_artifacts(event_id, outcomes);
    assert_eq!(response["action"], "create-enum");
    assert_eq!(response["eventId"], event_id);
    let (announcement, tlv_bytes) = decode_tlv(response["announcementTlvHex"].as_str().unwrap());
    assert_eq!(announcement.oracle_event.event_id, event_id);
    assert_eq!(
        announcement.oracle_event.event_maturity_epoch,
        1_800_000_000
    );
    assert!(matches!(
        &announcement.oracle_event.event_descriptor,
        EventDescriptor::EnumEvent(descriptor)
            if descriptor.outcomes == outcomes.iter().map(|value| (*value).to_owned()).collect::<Vec<_>>()
    ));
    announcement.validate(&Secp256k1::new()).unwrap();
    assert_eq!(
        response["oraclePublicKeyHex"],
        announcement.oracle_public_key.to_string()
    );

    let nostr_json = response["announcementNostrEventJson"].as_str().unwrap();
    let event = Event::from_json(nostr_json).unwrap();
    assert_eq!(event.kind, Kind::Custom(88));
    assert_eq!(event.id.to_hex(), response["announcementNostrEventId"]);
    assert_eq!(event.pubkey.to_string(), response["oraclePublicKeyHex"]);
    event.verify().unwrap();
    assert!(event.tags.iter().any(|tag| {
        tag.as_slice().get(0).is_some_and(|part| part == "title")
            && tag
                .as_slice()
                .get(1)
                .is_some_and(|part| part == "Market title")
    }));
    assert!(event.tags.iter().any(|tag| {
        tag.as_slice()
            .get(0)
            .is_some_and(|part| part == "description")
            && tag
                .as_slice()
                .get(1)
                .is_some_and(|part| part == "Market description")
    }));
    let raw_announcement = BASE64.decode(&event.content).unwrap();
    assert_ne!(raw_announcement, tlv_bytes);
    let mut cursor = Cursor::new(raw_announcement.as_slice());
    let decoded_raw = OracleAnnouncement::read(&mut cursor).unwrap();
    assert_eq!(cursor.position(), raw_announcement.len() as u64);
    assert_eq!(decoded_raw, announcement);
}

fn sign_request(announcement: &Value, outcome: &str) -> Value {
    json!({
        "version": 1,
        "action": "sign-enum",
        "oracleSecretKeyHex": oracle_secret(),
        "nonceSeedHex": nonce_seed(),
        "reservedNonceIndex": 0,
        "eventId": announcement["eventId"],
        "chosenOutcome": outcome,
        "announcementTlvHex": announcement["announcementTlvHex"],
        "announcementNostrEventJson": announcement["announcementNostrEventJson"]
    })
}

#[test]
fn creates_binary_and_categorical_announcements_with_distinct_wire_encodings() {
    assert_create_artifacts("binary-market", &["YES", "NO"]);
    assert_create_artifacts("categorical-market", &["ALPHA", "BETA", "GAMMA"]);
}

#[test]
fn signs_one_outcome_and_binds_kind_89_to_the_exact_kind_88_event() {
    let announcement_response = create_artifacts("signed-market", &["YES", "NO"]);
    let request = sign_request(&announcement_response, "YES");
    let (response, success) = invoke(request);
    assert!(success, "helper sign request failed: {response}");
    assert_eq!(response["action"], "sign-enum");
    assert_eq!(response["eventId"], "signed-market");
    assert_eq!(response["chosenOutcome"], "YES");

    let (announcement, _) = decode_tlv(
        announcement_response["announcementTlvHex"]
            .as_str()
            .unwrap(),
    );
    let attestation_bytes = hex::decode(response["attestationHex"].as_str().unwrap()).unwrap();
    let mut attestation_cursor = Cursor::new(attestation_bytes.as_slice());
    let attestation = OracleAttestation::read(&mut attestation_cursor).unwrap();
    assert_eq!(
        attestation_cursor.position(),
        attestation_bytes.len() as u64
    );
    attestation
        .validate(&Secp256k1::new(), &announcement)
        .unwrap();
    assert_eq!(attestation.event_id, "signed-market");
    assert_eq!(attestation.outcomes, vec!["YES"]);

    let kind88_id = announcement_response["announcementNostrEventId"]
        .as_str()
        .unwrap();
    let event = Event::from_json(response["attestationNostrEventJson"].as_str().unwrap()).unwrap();
    assert_eq!(event.kind, Kind::Custom(89));
    assert_eq!(event.id.to_hex(), response["attestationNostrEventId"]);
    assert_eq!(
        event.pubkey.to_string(),
        announcement_response["oraclePublicKeyHex"]
    );
    event.verify().unwrap();
    assert!(event.tags.iter().any(|tag| {
        tag.as_slice().get(0).is_some_and(|part| part == "e")
            && tag.as_slice().get(1).is_some_and(|part| part == kind88_id)
    }));
    let nostr_attestation = BASE64.decode(&event.content).unwrap();
    assert_eq!(nostr_attestation, attestation_bytes);
}

#[test]
fn rejects_out_of_range_index_wrong_nonce_and_wrong_signing_key() {
    let announcement = create_artifacts("nonce-market", &["YES", "NO"]);

    let mut out_of_range = sign_request(&announcement, "YES");
    out_of_range["reservedNonceIndex"] = json!(1u32 << 31);
    let (response, success) = invoke(out_of_range);
    assert!(!success);
    assert_eq!(response["code"], "invalid-request");

    let mut wrong_index = sign_request(&announcement, "YES");
    wrong_index["reservedNonceIndex"] = json!(1);
    let (response, success) = invoke(wrong_index);
    assert!(!success);
    assert_eq!(response["code"], "nonce-mismatch");

    let mut wrong_nonce = sign_request(&announcement, "YES");
    wrong_nonce["nonceSeedHex"] = json!("03".repeat(32));
    let (response, success) = invoke(wrong_nonce);
    assert!(!success);
    assert_eq!(response["code"], "nonce-mismatch");

    let mut wrong_key = sign_request(&announcement, "YES");
    wrong_key["oracleSecretKeyHex"] = json!("04".repeat(32));
    let (response, success) = invoke(wrong_key);
    assert!(!success);
    assert_eq!(response["code"], "invalid-announcement");
}

#[test]
fn rejects_reusing_the_signing_key_as_nonce_seed() {
    let mut request = create_request("shared-key-rejected", &["YES", "NO"]);
    request["nonceSeedHex"] = json!(oracle_secret());
    let (response, success) = invoke(request);
    assert!(!success);
    assert_eq!(response["code"], "invalid-request");
}

#[test]
fn rejects_invalid_outcomes_and_untrusted_announcement_events() {
    let announcement = create_artifacts("validation-market", &["YES", "NO"]);
    let (response, success) = invoke(sign_request(&announcement, "MAYBE"));
    assert!(!success);
    assert_eq!(response["code"], "invalid-outcome");

    let mut foreign_event_request = sign_request(&announcement, "YES");
    let mut foreign_event = EventBuilder::new(
        Kind::Custom(88),
        BASE64.encode({
            let (announcement, _) =
                decode_tlv(announcement["announcementTlvHex"].as_str().unwrap());
            announcement.encode()
        }),
    );
    foreign_event = foreign_event.tag(Tag::parse(["title", "Market title"]).unwrap());
    let foreign_event = foreign_event
        .sign_with_keys(&kormir::nostr::Keys::generate())
        .unwrap();
    foreign_event_request["announcementNostrEventJson"] = json!(foreign_event.as_json());
    let (response, success) = invoke(foreign_event_request);
    assert!(!success);
    assert_eq!(response["code"], "invalid-announcement");
}

#[test]
fn rejects_numeric_announcements() {
    let announcement_response = create_artifacts("numeric-rejected", &["YES", "NO"]);
    let mut sign_request = sign_request(&announcement_response, "YES");
    let (mut announcement, _) = decode_tlv(
        announcement_response["announcementTlvHex"]
            .as_str()
            .unwrap(),
    );
    announcement.oracle_event.event_descriptor =
        EventDescriptor::DigitDecompositionEvent(DigitDecompositionEventDescriptor {
            base: 2,
            is_signed: false,
            unit: "value".to_owned(),
            precision: 0,
            nb_digits: 1,
        });
    let mut numeric_tlv = Vec::new();
    ddk_messages::ser_impls::write_as_tlv(&announcement, &mut numeric_tlv).unwrap();
    sign_request["announcementTlvHex"] = json!(hex::encode(numeric_tlv));
    let (response, success) = invoke(sign_request);
    assert!(!success);
    assert_eq!(response["code"], "invalid-announcement");
}

#[test]
fn rejects_noncanonical_and_trailing_announcement_tlv_bytes() {
    let announcement = create_artifacts("invalid-tlv", &["YES", "NO"]);

    let mut noncanonical_request = sign_request(&announcement, "YES");
    let mut noncanonical_tlv =
        hex::decode(announcement["announcementTlvHex"].as_str().unwrap()).unwrap();
    noncanonical_tlv[0] ^= 1;
    noncanonical_request["announcementTlvHex"] = json!(hex::encode(noncanonical_tlv));
    let (response, success) = invoke(noncanonical_request);
    assert!(!success);
    assert_eq!(response["code"], "invalid-announcement");

    let mut trailing_request = sign_request(&announcement, "YES");
    let mut trailing_tlv =
        hex::decode(announcement["announcementTlvHex"].as_str().unwrap()).unwrap();
    trailing_tlv.push(0);
    trailing_request["announcementTlvHex"] = json!(hex::encode(trailing_tlv));
    let (response, success) = invoke(trailing_request);
    assert!(!success);
    assert_eq!(response["code"], "invalid-announcement");
}

#[test]
fn rejects_invalid_secret_encoding_and_trailing_json() {
    let mut invalid_key = create_request("invalid-key", &["YES", "NO"]);
    invalid_key["oracleSecretKeyHex"] = json!("zz".repeat(32));
    let (response, success) = invoke(invalid_key);
    assert!(!success);
    assert_eq!(response["code"], "invalid-request");

    let mut input = serde_json::to_vec(&create_request("trailing-json", &["YES", "NO"])).unwrap();
    input.extend_from_slice(b" {}");
    let (response, success) = execute(&input);
    assert!(!success);
    assert_eq!(
        serde_json::from_slice::<Value>(&response).unwrap()["code"],
        "invalid-request"
    );
}

#[test]
fn rejects_unknown_fields_oversized_requests_and_never_echoes_secrets() {
    let mut request = create_request("invalid-request", &["YES", "NO"]);
    request["unexpected"] = json!("must be rejected");
    request["oracleSecretKeyHex"] = json!("ab".repeat(32));
    let input = serde_json::to_vec(&request).unwrap();
    let (response, success) = execute(&input);
    assert!(!success);
    let response_text = String::from_utf8(response).unwrap();
    assert!(response_text.contains("invalid-request"));
    assert!(!response_text.contains(&"ab".repeat(32)));

    let (response, success) = execute(&vec![b' '; MAX_INPUT_BYTES + 1]);
    assert!(!success);
    assert_eq!(
        serde_json::from_slice::<Value>(&response).unwrap()["code"],
        "invalid-request"
    );
}

#[test]
fn helper_process_emits_only_a_fixed_error_for_secret_input() {
    let secret = "ab".repeat(32);
    let input = json!({
        "version": 1,
        "action": "create-enum",
        "oracleSecretKeyHex": secret,
        "nonceSeedHex": nonce_seed(),
        "reservedNonceIndex": 1u32 << 31,
        "eventId": "bad-index",
        "outcomes": ["YES", "NO"],
        "eventMaturityEpoch": 1_800_000_000u32,
        "title": "",
        "description": ""
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_bitcaster-oracle-helper"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&input).unwrap())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    assert!(output.stderr.is_empty());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("invalid-request"));
    assert!(!stdout.contains(&secret));

    let argument_output = Command::new(env!("CARGO_BIN_EXE_bitcaster-oracle-helper"))
        .arg(&secret)
        .output()
        .unwrap();
    assert!(!argument_output.status.success());
    assert!(argument_output.stderr.is_empty());
    let argument_stdout = String::from_utf8(argument_output.stdout).unwrap();
    assert!(argument_stdout.contains("invalid-request"));
    assert!(!argument_stdout.contains(&secret));
}
