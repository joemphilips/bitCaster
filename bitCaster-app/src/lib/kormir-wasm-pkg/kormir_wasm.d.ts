/* tslint:disable */
/* eslint-disable */

export class Announcement {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly announcement_signature: string;
    readonly event_id: string;
    readonly oracle_nonces: string[];
    readonly oracle_public_key: string;
    readonly outcomes: string[];
    readonly value: any;
    event_maturity_epoch: number;
}

export class Attestation {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly event_id: string;
    readonly oracle_public_key: string;
    readonly outcomes: string[];
    readonly signatures: string[];
    readonly value: any;
}

export class EventData {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly announcement: string;
    readonly announcement_event_id: string | undefined;
    readonly attestation: string | undefined;
    readonly attestation_event_id: string | undefined;
    readonly event_name: string;
    readonly observed_outcome: string | undefined;
    readonly outcomes: string[];
    readonly value: any;
    event_maturity_epoch: number;
}

export enum JsError {
    InvalidArgument = 0,
    EventAlreadySigned = 1,
    NotFound = 2,
    StorageFailure = 3,
    InvalidOutcome = 4,
    Internal = 5,
    Nostr = 6,
}

export class Kormir {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static create_announcement_nostr_event_json(nsec: string, announcement_hex: string, title: string, description: string): string;
    static create_attestation_nostr_event_json(nsec: string, attestation_hex: string, announcement_event_id: string): string;
    create_enum_event(event_id: string, outcomes: string[], event_maturity_epoch: number, title: string, description: string): Promise<string>;
    static decode_announcement(str: string): Promise<Announcement>;
    static decode_attestation(str: string): Promise<Attestation>;
    get_public_key(): string;
    list_events(): Promise<any>;
    static new(relays: string[]): Promise<Kormir>;
    static restore(str: string): Promise<void>;
    sign_enum_event(event_id: string, outcome: string): Promise<string>;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_announcement_free: (a: number, b: number) => void;
    readonly __wbg_attestation_free: (a: number, b: number) => void;
    readonly __wbg_eventdata_free: (a: number, b: number) => void;
    readonly __wbg_get_announcement_event_maturity_epoch: (a: number) => number;
    readonly __wbg_get_eventdata_event_maturity_epoch: (a: number) => number;
    readonly __wbg_set_announcement_event_maturity_epoch: (a: number, b: number) => void;
    readonly __wbg_set_eventdata_event_maturity_epoch: (a: number, b: number) => void;
    readonly announcement_announcement_signature: (a: number) => [number, number];
    readonly announcement_event_id: (a: number) => [number, number];
    readonly announcement_oracle_nonces: (a: number) => [number, number];
    readonly announcement_oracle_public_key: (a: number) => [number, number];
    readonly announcement_outcomes: (a: number) => [number, number];
    readonly announcement_value: (a: number) => any;
    readonly attestation_event_id: (a: number) => [number, number];
    readonly attestation_oracle_public_key: (a: number) => [number, number];
    readonly attestation_outcomes: (a: number) => [number, number];
    readonly attestation_signatures: (a: number) => [number, number];
    readonly attestation_value: (a: number) => any;
    readonly eventdata_announcement: (a: number) => [number, number];
    readonly eventdata_announcement_event_id: (a: number) => [number, number];
    readonly eventdata_attestation: (a: number) => [number, number];
    readonly eventdata_attestation_event_id: (a: number) => [number, number];
    readonly eventdata_event_name: (a: number) => [number, number];
    readonly eventdata_observed_outcome: (a: number) => [number, number];
    readonly eventdata_outcomes: (a: number) => [number, number];
    readonly eventdata_value: (a: number) => any;
    readonly __wbg_kormir_free: (a: number, b: number) => void;
    readonly kormir_create_announcement_nostr_event_json: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly kormir_create_attestation_nostr_event_json: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly kormir_create_enum_event: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => any;
    readonly kormir_decode_announcement: (a: number, b: number) => any;
    readonly kormir_decode_attestation: (a: number, b: number) => any;
    readonly kormir_get_public_key: (a: number) => [number, number];
    readonly kormir_list_events: (a: number) => any;
    readonly kormir_new: (a: number, b: number) => any;
    readonly kormir_restore: (a: number, b: number) => any;
    readonly kormir_sign_enum_event: (a: number, b: number, c: number, d: number, e: number) => any;
    readonly rustsecp256k1zkp_v0_10_0_default_error_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1zkp_v0_10_0_default_illegal_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_10_0_context_create: (a: number) => number;
    readonly rustsecp256k1_v0_10_0_context_destroy: (a: number) => void;
    readonly rustsecp256k1_v0_10_0_default_error_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_10_0_default_illegal_callback_fn: (a: number, b: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h3562bd6c9b3b21b1: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h2f5ba8bb4de46f76: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h161a1786752a0847: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h3b0d0e3aed8f0326: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h3b0d0e3aed8f0326_3: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h07296c2edf232334: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
