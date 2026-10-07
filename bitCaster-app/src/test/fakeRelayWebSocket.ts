/** Offline socket fixture for installed NDK lifecycle tests. */
export class FakeRelayWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeRelayWebSocket[] = [];
  readyState = FakeRelayWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  sent: string[] = [];
  closeCount = 0;
  private listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(readonly url: string) {
    FakeRelayWebSocket.instances.push(this);
  }
  send(message: string): void {
    this.sent.push(message);
  }
  close(): void {
    this.closeCount += 1;
    this.readyState = FakeRelayWebSocket.CLOSED;
    this.onclose?.(new Event("close"));
  }
  open(): void {
    this.readyState = FakeRelayWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }
  remoteClose(): void {
    this.readyState = FakeRelayWebSocket.CLOSED;
    this.onclose?.(new Event("close"));
  }
  message(data: string): void {
    const event = new MessageEvent("message", { data });
    this.onmessage?.(event);
    for (const listener of this.listeners.get("message") ?? []) listener(event);
  }
  addEventListener(name: string, listener: (event: Event) => void): void {
    const entries = this.listeners.get(name) ?? new Set();
    entries.add(listener);
    this.listeners.set(name, entries);
  }
  removeEventListener(name: string, listener: (event: Event) => void): void {
    this.listeners.get(name)?.delete(listener);
  }
}
