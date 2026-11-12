#!/usr/bin/env python3
"""Generate the recovery index v1 golden vectors.

This is an independent implementation of the recovery index format and of the
request signature. It does not use the SDK. The SDK tests check that the SDK
gives the same bytes.

Requirements: Python 3.11 or later and the `cryptography` package (for
ChaCha20-Poly1305 and a secp256k1 cross-check of the locator keys).

Usage:
  scripts/generate-recovery-index-v1-vectors.py --write
  scripts/generate-recovery-index-v1-vectors.py --check

After --write, format the fixture with prettier. --check compares the JSON
values, so the formatting does not matter.
"""

import hashlib
import hmac
import json
import pathlib
import sys

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305

OUTPUT = (
    pathlib.Path(__file__).resolve().parent.parent
    / "bitcaster-client-sdk/test/fixtures/recovery-index-v1.json"
)

P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (
    0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
    0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8,
)

DOMAIN = b"Cashu_Recovery_Index_v1"
MAGIC = b"CASHURI"
HEADER = MAGIC + bytes([0x01, 0x01])
REQUEST_TAG = "bitcaster/recovery-index/request/v1"
REQUEST_PATH = "/api/v1/recovery-index"
SEED = bytes(range(64))


# BIP340 reference arithmetic.
def point_add(a, b):
    if a is None:
        return b
    if b is None:
        return a
    if a[0] == b[0] and a[1] != b[1]:
        return None
    if a == b:
        lam = (3 * a[0] * a[0] * pow(2 * a[1], P - 2, P)) % P
    else:
        lam = ((b[1] - a[1]) * pow(b[0] - a[0], P - 2, P)) % P
    x = (lam * lam - a[0] - b[0]) % P
    return (x, (lam * (a[0] - x) - a[1]) % P)


def point_mul(point, scalar):
    result = None
    for i in range(256):
        if (scalar >> i) & 1:
            result = point_add(result, point)
        point = point_add(point, point)
    return result


def tagged_hash(tag, message):
    digest = hashlib.sha256(tag.encode()).digest()
    return hashlib.sha256(digest + digest + message).digest()


def x_only(secret):
    return point_mul(G, secret)[0].to_bytes(32, "big")


def bip340_sign(message, secret, aux):
    public = point_mul(G, secret)
    d = secret if public[1] % 2 == 0 else N - secret
    t = bytes(x ^ y for x, y in zip(d.to_bytes(32, "big"), tagged_hash("BIP0340/aux", aux)))
    k0 = int.from_bytes(tagged_hash("BIP0340/nonce", t + public[0].to_bytes(32, "big") + message), "big") % N
    nonce_point = point_mul(G, k0)
    k = k0 if nonce_point[1] % 2 == 0 else N - k0
    challenge = tagged_hash(
        "BIP0340/challenge",
        nonce_point[0].to_bytes(32, "big") + public[0].to_bytes(32, "big") + message,
    )
    e = int.from_bytes(challenge, "big") % N
    return nonce_point[0].to_bytes(32, "big") + ((k + e * d) % N).to_bytes(32, "big")


# ADR-051 keys.
def key_message(context, key_type):
    encoded = context.encode()
    return DOMAIN + bytes([len(encoded)]) + encoded + bytes([key_type])


def derive_keys(seed, context):
    encryption_key = hmac.new(seed, key_message(context, 0x00), hashlib.sha256).digest()
    scalar = int.from_bytes(hmac.new(seed, key_message(context, 0x01), hashlib.sha256).digest(), "big") % N
    assert scalar != 0
    public = x_only(scalar)
    cross_check = ec.derive_private_key(scalar, ec.SECP256K1()).public_key().public_numbers().x
    assert cross_check.to_bytes(32, "big") == public
    return encryption_key, scalar, public


# Deterministic CBOR (RFC 8949, section 4.2.1) for the types of the index.
def cbor_head(major, value):
    if value < 24:
        return bytes([major << 5 | value])
    for additional, size in ((24, 1), (25, 2), (26, 4), (27, 8)):
        if value < 1 << (8 * size):
            return bytes([major << 5 | additional]) + value.to_bytes(size, "big")
    raise ValueError("CBOR argument too large")


def cbor_uint(value):
    return cbor_head(0, value)


def cbor_bytes(value):
    return cbor_head(2, len(value)) + value


def cbor_text(value):
    encoded = value.encode()
    return cbor_head(3, len(encoded)) + encoded


def cbor_array(items):
    return cbor_head(4, len(items)) + b"".join(items)


def plaintext_map(version, mints, entries):
    mint_index = {mint: index for index, mint in enumerate(mints)}
    encoded_entries = []
    for entry in sorted(entries, key=lambda e: (mint_index[e["mintUrl"]], bytes.fromhex(e["keysetId"]))):
        items = [cbor_uint(mint_index[entry["mintUrl"]]), cbor_bytes(bytes.fromhex(entry["keysetId"]))]
        if entry["kind"] == "conditional":
            items.append(cbor_bytes(bytes.fromhex(entry["conditionId"])))
            items.append(cbor_bytes(bytes.fromhex(entry["outcomeCollectionId"])))
        encoded_entries.append(cbor_array(items))
    # Keys in bytewise order of their encodings: "v", "ver", "mints", "entries".
    return (
        cbor_head(5, 4)
        + cbor_text("v") + cbor_uint(1)
        + cbor_text("ver") + cbor_uint(version)
        + cbor_text("mints") + cbor_array([cbor_text(mint) for mint in mints])
        + cbor_text("entries") + cbor_array(encoded_entries)
    )


def padded_size(length):
    size = 4096
    while size < length:
        size *= 2
    assert size <= 65536
    return size


def keyset_id(label):
    return "01" + hashlib.sha256(label.encode()).hexdigest()


def hash_hex(label):
    return hashlib.sha256(label.encode()).hexdigest()


def document_vector(name, context, version, nonce, mints, entries, full):
    encryption_key, _, _ = derive_keys(SEED, context)
    cbor = plaintext_map(version, mints, entries)
    plaintext = cbor + bytes(padded_size(len(cbor)) - len(cbor))
    sealed = ChaCha20Poly1305(encryption_key).encrypt(nonce, plaintext, HEADER)
    document = HEADER + nonce + sealed
    vector = {
        "name": name,
        "context": context,
        "writtenVersion": version,
        "nonce": nonce.hex(),
        "mints": mints,
        "entries": entries,
        "cborLength": len(cbor),
        "plaintextLength": len(plaintext),
        "documentLength": len(document),
        "cborSha256": hashlib.sha256(cbor).hexdigest(),
        "documentSha256": hashlib.sha256(document).hexdigest(),
    }
    if full:
        vector["cbor"] = cbor.hex()
        vector["document"] = document.hex()
    return vector


def request_vector(name, realm, method, secret, body, expected_version, issued_at):
    public = x_only(secret)
    message = (
        bytes([len(realm.encode())]) + realm.encode()
        + bytes([len(method)]) + method.encode()
        + bytes([len(REQUEST_PATH)]) + REQUEST_PATH.encode()
        + public
        + hashlib.sha256(body).digest()
        + expected_version.to_bytes(8, "big")
        + issued_at.to_bytes(8, "big")
    )
    digest = tagged_hash(REQUEST_TAG, message)
    return {
        "name": name,
        "realm": realm,
        "method": method,
        "requestPublicKey": public.hex(),
        "body": body.hex(),
        "expectedVersion": expected_version,
        "issuedAt": issued_at,
        "digest": digest.hex(),
        "auxRand": "00" * 32,
        "signature": bip340_sign(digest, secret, bytes(32)).hex(),
    }


def build():
    regular = {"kind": "regular", "mintUrl": "https://mint.example.com", "keysetId": keyset_id("regular")}
    conditional = {
        "kind": "conditional",
        "mintUrl": "https://mint.example.com",
        "keysetId": keyset_id("conditional"),
        "conditionId": hash_hex("condition"),
        "outcomeCollectionId": hash_hex("outcome collection"),
    }
    local_regular = {"kind": "regular", "mintUrl": "http://127.0.0.1:3338", "keysetId": keyset_id("local regular")}
    path_regular = {"kind": "regular", "mintUrl": "https://mint.example.com/cashu", "keysetId": keyset_id("path regular")}
    path_conditional = dict(conditional, mintUrl="https://mint.example.com/cashu")
    many = [
        {"kind": "regular", "mintUrl": "https://mint.example.com", "keysetId": keyset_id(f"keyset {i}")}
        for i in range(120)
    ]
    keys = []
    for context in ("bitcaster-production", "bitcaster-staging", "bitcaster-local", "bitcaster-test"):
        encryption_key, scalar, public = derive_keys(SEED, context)
        keys.append(
            {
                "context": context,
                "encryptionKey": encryption_key.hex(),
                "locatorSecretKey": scalar.to_bytes(32, "big").hex(),
                "locatorPublicKey": public.hex(),
            }
        )
    _, local_scalar, _ = derive_keys(SEED, "bitcaster-local")
    return {
        "description": (
            "ADR-051 recovery index v1 and ADR-034 request signature golden vectors. "
            "scripts/generate-recovery-index-v1-vectors.py produces them with an "
            "independent implementation."
        ),
        "seed": SEED.hex(),
        "keys": keys,
        "documents": [
            document_vector(
                "one mint with a regular and a conditional keyset",
                "bitcaster-test", 7, bytes.fromhex("000102030405060708090a0b"),
                ["https://mint.example.com"], [conditional, regular], True,
            ),
            document_vector(
                "two mints",
                "bitcaster-local", 1, bytes.fromhex("0c0b0a090807060504030201"),
                ["http://127.0.0.1:3338", "https://mint.example.com/cashu"],
                [path_conditional, local_regular, path_regular], True,
            ),
            document_vector(
                "120 entries at the 8 KiB step with the largest version",
                "bitcaster-production", 9007199254740991, bytes.fromhex("ffffffffffffffffffffffff"),
                ["https://mint.example.com"], many, False,
            ),
        ],
        "requests": [
            request_vector(
                "ADR-034 pinned engine vector",
                "bitcaster-test", "PUT", 3, b"recovery index body", 7, 1700000000,
            ),
            request_vector(
                "seed-derived read",
                "bitcaster-local", "GET", local_scalar, b"", 0, 1800000000,
            ),
        ],
    }


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("--write", "--check"):
        sys.exit(__doc__)
    vectors = build()
    if sys.argv[1] == "--write":
        OUTPUT.write_text(json.dumps(vectors, indent=2) + "\n")
        return
    if json.loads(OUTPUT.read_text()) != vectors:
        sys.exit(f"{OUTPUT} is not current")


if __name__ == "__main__":
    main()
