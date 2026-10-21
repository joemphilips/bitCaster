import "@testing-library/jest-dom/vitest";
// Initialize i18n so components that call useTranslation() get real translations
import "./src/i18n";

if (typeof HTMLDialogElement !== "undefined") {
  if (typeof HTMLDialogElement.prototype.showModal === "undefined") {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.open = true;
    };
  }
  if (typeof HTMLDialogElement.prototype.close === "undefined") {
    HTMLDialogElement.prototype.close = function close() {
      this.open = false;
    };
  }
}

// Polyfill matchMedia for jsdom and chart libraries that inspect device pixel
// ratio/media queries during module initialization.
if (typeof globalThis.matchMedia === "undefined") {
  globalThis.matchMedia = (() => ({
    matches: false,
    media: "",
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof globalThis.matchMedia;
}

// Polyfill ResizeObserver for jsdom
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof globalThis.ResizeObserver;
}

// Polyfill IntersectionObserver for jsdom
if (typeof globalThis.IntersectionObserver === "undefined") {
  globalThis.IntersectionObserver = class IntersectionObserver {
    readonly root = null;
    readonly rootMargin = "0px";
    readonly thresholds = [0];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof globalThis.IntersectionObserver;
}

// jsdom uses a different Uint8Array realm from Node's TextEncoder. Keep native
// UTF-8 encoding and encodeInto behavior, but return bytes owned by this realm.
const NativeTextEncoder = globalThis.TextEncoder;
globalThis.TextEncoder = class RealmTextEncoder extends NativeTextEncoder {
  override encode(input?: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(super.encode(input));
  }
};
