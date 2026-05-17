/* tslint:disable */
/* eslint-disable */
/**
* @returns {Promise<void>}
*/
export function main_js(): Promise<void>;
/**
* Kormir error type
*/
export enum JsError {
/**
* Invalid argument given
*/
  InvalidArgument = 0,
/**
* Attempted to sign an event that was already signed
*/
  EventAlreadySigned = 1,
/**
* Event data was not found
*/
  NotFound = 2,
/**
* The storage failed to read/save the data
*/
  StorageFailure = 3,
/**
* User gave an invalid outcome
*/
  InvalidOutcome = 4,
/**
* An error that should never happen, if it does it's a bug
*/
  Internal = 5,
/**
* An error with creating or sending Nostr events
*/
  Nostr = 6,
}
/**
*/
export class Announcement {
  free(): void;
/**
*/
  readonly announcement_signature: string;
/**
*/
  readonly event_id: string;
/**
*/
  event_maturity_epoch: number;
/**
*/
  readonly oracle_nonces: (string)[];
/**
*/
  readonly oracle_public_key: string;
/**
*/
  readonly outcomes: (string)[];
/**
*/
  readonly value: any;
}
/**
*/
export class Attestation {
  free(): void;
/**
*/
  readonly oracle_public_key: string;
/**
*/
  readonly outcomes: (string)[];
/**
*/
  readonly signatures: (string)[];
/**
*/
  readonly value: any;
}
/**
*/
export class EventData {
  free(): void;
/**
*/
  readonly announcement: string;
/**
*/
  readonly announcement_event_id: string | undefined;
/**
*/
  readonly attestation: string | undefined;
/**
*/
  readonly attestation_event_id: string | undefined;
/**
*/
  event_maturity_epoch: number;
/**
*/
  readonly event_name: string;
/**
*/
  readonly observed_outcome: string | undefined;
/**
*/
  readonly outcomes: (string)[];
/**
*/
  readonly value: any;
}
/**
*/
export class Kormir {
  free(): void;
/**
* @returns {Promise<any>}
*/
  list_events(): Promise<any>;
/**
* @returns {string}
*/
  get_public_key(): string;
/**
* @param {string} event_id
* @param {string} outcome
* @returns {Promise<string>}
*/
  sign_enum_event(event_id: string, outcome: string): Promise<string>;
/**
* @param {string} event_id
* @param {(string)[]} outcomes
* @param {number} event_maturity_epoch
* @returns {Promise<string>}
*/
  create_enum_event(event_id: string, outcomes: (string)[], event_maturity_epoch: number): Promise<string>;
/**
* @param {string} str
* @returns {Promise<Attestation>}
*/
  static decode_attestation(str: string): Promise<Attestation>;
/**
* @param {string} event_id
* @param {bigint} outcome
* @returns {Promise<string>}
*/
  sign_numeric_event(event_id: string, outcome: bigint): Promise<string>;
/**
* @param {string} str
* @returns {Promise<Announcement>}
*/
  static decode_announcement(str: string): Promise<Announcement>;
/**
* @param {string} event_id
* @param {number} num_digits
* @param {boolean} is_signed
* @param {number} precision
* @param {string} unit
* @param {number} event_maturity_epoch
* @returns {Promise<string>}
*/
  create_numeric_event(event_id: string, num_digits: number, is_signed: boolean, precision: number, unit: string, event_maturity_epoch: number): Promise<string>;
/**
* @param {(string)[]} relays
* @returns {Promise<Kormir>}
*/
  static new(relays: (string)[]): Promise<Kormir>;
/**
* @param {string} str
* @returns {Promise<void>}
*/
  static restore(str: string): Promise<void>;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_announcement_free: (a: number) => void;
  readonly __wbg_attestation_free: (a: number) => void;
  readonly __wbg_eventdata_free: (a: number) => void;
  readonly __wbg_get_announcement_event_maturity_epoch: (a: number) => number;
  readonly __wbg_get_eventdata_event_maturity_epoch: (a: number) => number;
  readonly __wbg_set_announcement_event_maturity_epoch: (a: number, b: number) => void;
  readonly __wbg_set_eventdata_event_maturity_epoch: (a: number, b: number) => void;
  readonly announcement_announcement_signature: (a: number, b: number) => void;
  readonly announcement_event_id: (a: number, b: number) => void;
  readonly announcement_oracle_nonces: (a: number, b: number) => void;
  readonly announcement_oracle_public_key: (a: number, b: number) => void;
  readonly announcement_outcomes: (a: number, b: number) => void;
  readonly announcement_value: (a: number) => number;
  readonly attestation_oracle_public_key: (a: number, b: number) => void;
  readonly attestation_outcomes: (a: number, b: number) => void;
  readonly attestation_value: (a: number) => number;
  readonly eventdata_announcement_event_id: (a: number, b: number) => void;
  readonly eventdata_attestation: (a: number, b: number) => void;
  readonly eventdata_attestation_event_id: (a: number, b: number) => void;
  readonly eventdata_event_name: (a: number, b: number) => void;
  readonly eventdata_observed_outcome: (a: number, b: number) => void;
  readonly eventdata_value: (a: number) => number;
  readonly eventdata_announcement: (a: number, b: number) => void;
  readonly attestation_signatures: (a: number, b: number) => void;
  readonly eventdata_outcomes: (a: number, b: number) => void;
  readonly __wbg_kormir_free: (a: number) => void;
  readonly kormir_create_enum_event: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
  readonly kormir_create_numeric_event: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
  readonly kormir_decode_announcement: (a: number, b: number) => number;
  readonly kormir_decode_attestation: (a: number, b: number) => number;
  readonly kormir_get_public_key: (a: number, b: number) => void;
  readonly kormir_list_events: (a: number) => number;
  readonly kormir_new: (a: number, b: number) => number;
  readonly kormir_restore: (a: number, b: number) => number;
  readonly kormir_sign_enum_event: (a: number, b: number, c: number, d: number, e: number) => number;
  readonly kormir_sign_numeric_event: (a: number, b: number, c: number, d: number) => number;
  readonly main_js: () => void;
  readonly rustsecp256k1zkp_v0_10_0_default_error_callback_fn: (a: number, b: number) => void;
  readonly rustsecp256k1zkp_v0_10_0_default_illegal_callback_fn: (a: number, b: number) => void;
  readonly rustsecp256k1_v0_10_0_context_create: (a: number) => number;
  readonly rustsecp256k1_v0_10_0_context_destroy: (a: number) => void;
  readonly rustsecp256k1_v0_10_0_default_error_callback_fn: (a: number, b: number) => void;
  readonly rustsecp256k1_v0_10_0_default_illegal_callback_fn: (a: number, b: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_export_2: WebAssembly.Table;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly _dyn_core__ops__function__FnMut__A____Output___R_as_wasm_bindgen__closure__WasmClosure___describe__invoke__hde63078dad085ba2: (a: number, b: number, c: number, d: number) => void;
  readonly _dyn_core__ops__function__FnMut__A____Output___R_as_wasm_bindgen__closure__WasmClosure___describe__invoke__hd49328b02eda7772: (a: number, b: number, c: number) => void;
  readonly _dyn_core__ops__function__FnMut_____Output___R_as_wasm_bindgen__closure__WasmClosure___describe__invoke__h6e23e6acea90564f: (a: number, b: number) => void;
  readonly _dyn_core__ops__function__FnMut__A____Output___R_as_wasm_bindgen__closure__WasmClosure___describe__invoke__h02c7d9d8ab8173fa: (a: number, b: number, c: number) => void;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly wasm_bindgen__convert__closures__invoke2_mut__hd304671d96792a2a: (a: number, b: number, c: number, d: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {SyncInitInput} module
*
* @returns {InitOutput}
*/
export function initSync(module: SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {InitInput | Promise<InitInput>} module_or_path
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: InitInput | Promise<InitInput>): Promise<InitOutput>;
