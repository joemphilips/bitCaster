import assert from "node:assert/strict";
import { test } from "node:test";

import { Amount, OutputData } from "@cashu/cashu-ts";

import {
  probeExactOutputRestore,
  serializeOutputDataArray,
} from "../src/ctfSplit.ts";

const MINT_URL = "https://mint.example";
const KEYSET_ID = "009a1f293253e41e";
const VALID_POINT =
  "021179b095a67380ab3285424b563b7aab9818bd38068e1930641b3dceb364d422";
const KEY_POINT =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

test("exact-output restore probe distinguishes absent, corrupt, and restored raw NUT-09", async () => {
  const output = OutputData.createSingleRandomData(Amount.from(1), KEYSET_ID);
  const outputs = { keep: serializeOutputDataArray([output]) };
  const expected = output.blindedMessage;

  await withMockFetch(
    async (input) => {
      if (String(input).endsWith("/v1/restore")) {
        return jsonResponse({ outputs: [], signatures: [] });
      }
      throw new Error("unexpected request");
    },
    async () => {
      assert.deepEqual(await probe(outputs), { kind: "definitely-absent" });
    },
  );

  for (const raw of [
    {
      outputs: [],
      signatures: [{ id: KEYSET_ID, amount: 1, C_: VALID_POINT }],
    },
    {
      outputs: [{ ...expected, B_: `${expected.B_}ff` }],
      signatures: [{ id: KEYSET_ID, amount: 1, C_: VALID_POINT }],
    },
  ]) {
    await withMockFetch(
      async (input) => {
        if (String(input).endsWith("/v1/restore")) return jsonResponse(raw);
        throw new Error("unexpected request");
      },
      async () => {
        assert.deepEqual(await probe(outputs), { kind: "unavailable-or-corrupt" });
      },
    );
  }

  await withMockFetch(
    async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/restore")) {
        return jsonResponse({
          outputs: [expected],
          signatures: [{ id: KEYSET_ID, amount: 1, C_: VALID_POINT }],
        });
      }
      if (url.includes("/v1/keys/")) {
        return jsonResponse({
          keysets: [{ id: KEYSET_ID, unit: "sat", keys: { 1: KEY_POINT } }],
        });
      }
      throw new Error(`unexpected request: ${url}`);
    },
    async () => {
      const result = await probe(outputs);
      assert.equal(result.kind, "restored");
      if (result.kind !== "restored") return;
      assert.equal(result.proofs.keep.length, 1);
      assert.equal(result.proofs.keep[0]?.id, KEYSET_ID);
      assert.equal(
        result.proofs.keep[0]?.secret,
        Buffer.from(outputs.keep[0]!.secret, "hex").toString("utf8"),
      );
    },
  );
});

test("exact-output restore probe rejects output-amount substitution", async () => {
  const output = OutputData.createSingleRandomData(Amount.from(1), KEYSET_ID);
  await assertRawProbeCorrupt(
    { keep: serializeOutputDataArray([output]) },
    {
      outputs: [{ ...output.blindedMessage, amount: 2 }],
      signatures: [{ id: KEYSET_ID, amount: 2, C_: VALID_POINT }],
    },
  );
});

test("exact-output restore probe rejects signature-amount substitution", async () => {
  const output = OutputData.createSingleRandomData(Amount.from(1), KEYSET_ID);
  await assertRawProbeCorrupt(
    { keep: serializeOutputDataArray([output]) },
    {
      outputs: [output.blindedMessage],
      signatures: [{ id: KEYSET_ID, amount: 2, C_: VALID_POINT }],
    },
  );
});

test("exact-output restore probe contains key and proof-construction failures", async () => {
  const output = OutputData.createSingleRandomData(Amount.from(1), KEYSET_ID);
  const outputs = { keep: serializeOutputDataArray([output]) };
  const expected = output.blindedMessage;

  for (const responseFor of [
    (url: string) =>
      url.endsWith("/v1/restore")
        ? jsonResponse({
            outputs: [expected],
            signatures: [{ id: KEYSET_ID, amount: 1, C_: VALID_POINT }],
          })
        : new Response("keys unavailable", { status: 503 }),
    (url: string) =>
      url.endsWith("/v1/restore")
        ? jsonResponse({
            outputs: [expected],
            signatures: [{ id: KEYSET_ID, amount: 1, C_: "not-a-point" }],
          })
        : jsonResponse({
            keysets: [{ id: KEYSET_ID, unit: "sat", keys: { 1: KEY_POINT } }],
          }),
  ]) {
    await withMockFetch(
      async (input) => responseFor(String(input)),
      async () => {
        assert.deepEqual(await probe(outputs), {
          kind: "unavailable-or-corrupt",
        });
      },
    );
  }
});

test("exact-output restore probe aborts the underlying NUT-09 fetch", async () => {
  const output = OutputData.createSingleRandomData(Amount.from(1), KEYSET_ID);
  const outputs = { keep: serializeOutputDataArray([output]) };
  let observedAbort = false;

  await withMockFetch(
    async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            reject(init.signal?.reason ?? new Error("aborted"));
          },
          { once: true },
        );
      }),
    async () => {
      const result = await probeExactOutputRestore(MINT_URL, outputs, {
        requestTimeoutMs: 5,
        responseBodyBytesLimit: 64 * 1024,
        signal: AbortSignal.timeout(100),
      });
      assert.deepEqual(result, { kind: "unavailable-or-corrupt" });
      assert.equal(observedAbort, true);
    },
  );
});

test("exact-output restore probe preserves persisted group and output order", async () => {
  const send = [
    OutputData.createSingleRandomData(Amount.from(1), KEYSET_ID),
    OutputData.createSingleRandomData(Amount.from(2), KEYSET_ID),
  ];
  const keep = [OutputData.createSingleRandomData(Amount.from(1), KEYSET_ID)];
  const outputs = {
    send: serializeOutputDataArray(send),
    keep: serializeOutputDataArray(keep),
  };
  const raw = [...send, ...keep].map((output) => output.blindedMessage);

  await withMockFetch(
    async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/restore")) {
        return jsonResponse({
          outputs: [...raw].reverse(),
          signatures: [...raw].reverse().map((output) => ({
            id: output.id,
            amount: output.amount,
            C_: VALID_POINT,
          })),
        });
      }
      if (url.includes("/v1/keys/")) {
        return jsonResponse({
          keysets: [
            {
              id: KEYSET_ID,
              unit: "sat",
              keys: { 1: KEY_POINT, 2: KEY_POINT },
            },
          ],
        });
      }
      throw new Error(`unexpected request: ${url}`);
    },
    async () => {
      const result = await probe(outputs);
      assert.equal(result.kind, "restored");
      if (result.kind !== "restored") return;
      assert.deepEqual(Object.keys(result.proofs), ["send", "keep"]);
      assert.deepEqual(
        result.proofs.send.map((proof) => proof.amount),
        [1, 2],
      );
      assert.deepEqual(
        result.proofs.send.map((proof) => proof.secret),
        outputs.send.map((output) =>
          Buffer.from(output.secret, "hex").toString("utf8"),
        ),
      );
    },
  );
});

function probe(outputs: Parameters<typeof probeExactOutputRestore>[1]) {
  return probeExactOutputRestore(MINT_URL, outputs, {
    requestTimeoutMs: 1_000,
    responseBodyBytesLimit: 64 * 1024,
    signal: AbortSignal.timeout(2_000),
  });
}

async function assertRawProbeCorrupt(
  outputs: Parameters<typeof probeExactOutputRestore>[1],
  raw: unknown,
): Promise<void> {
  await withMockFetch(
    async (input) => {
      if (String(input).endsWith("/v1/restore")) return jsonResponse(raw);
      throw new Error("key fetch must not run");
    },
    async () => {
      assert.deepEqual(await probe(outputs), {
        kind: "unavailable-or-corrupt",
      });
    },
  );
}

async function withMockFetch(
  fetch: typeof globalThis.fetch,
  run: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
