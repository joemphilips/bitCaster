import { beforeEach, describe, expect, it } from "vitest";
import { usePaymentRequestInbox } from "../paymentRequestInbox";

beforeEach(() => {
  usePaymentRequestInbox.setState({ entries: {}, pending: {} });
});

describe("payment request inbox wallet scope", () => {
  it("stores the scope that created a pending request", () => {
    usePaymentRequestInbox
      .getState()
      .registerPending("request-a", "https://mint.example", "scope-a");

    expect(usePaymentRequestInbox.getState().pending["request-a"]).toMatchObject({
      id: "request-a",
      mintUrl: "https://mint.example",
      walletScopeId: "scope-a",
    });
  });

  it("refuses to complete a pending request under another wallet scope", () => {
    const inbox = usePaymentRequestInbox.getState();
    inbox.registerPending("request-a", "https://mint.example", "scope-a");

    inbox.markReceived("request-a", 42, "sat", "scope-b");

    expect(usePaymentRequestInbox.getState().pending["request-a"]?.walletScopeId).toBe("scope-a");
    expect(usePaymentRequestInbox.getState().entries["request-a"]).toBeUndefined();
  });

  it("records a completed request with the matching wallet scope", () => {
    const inbox = usePaymentRequestInbox.getState();
    inbox.registerPending("request-a", "https://mint.example", "scope-a");

    inbox.markReceived("request-a", 42, "sat", "scope-a");

    expect(usePaymentRequestInbox.getState().pending["request-a"]).toBeUndefined();
    expect(usePaymentRequestInbox.getState().entries["request-a"]).toMatchObject({
      id: "request-a",
      walletScopeId: "scope-a",
      amountSubunits: 42,
      baseAsset: "sat",
    });
  });
});
