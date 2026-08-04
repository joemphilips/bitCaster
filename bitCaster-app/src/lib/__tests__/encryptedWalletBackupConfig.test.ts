import { describe, expect, it, vi } from "vitest";
import {
  createEncryptedWalletBackupTransportFetch,
  resolveEncryptedWalletBackupConfiguration,
} from "../encryptedWalletBackupConfig";

describe("encrypted wallet backup configuration", () => {
  it("disables backup when all configuration is absent in every environment", () => {
    expect(resolveEncryptedWalletBackupConfiguration({ DEV: true })).toBeNull();
    expect(resolveEncryptedWalletBackupConfiguration({ PROD: true })).toBeNull();
    expect(() =>
      resolveEncryptedWalletBackupConfiguration({
        VITE_ENCRYPTED_BACKUP_REALM: "bitcaster.local",
      }),
    ).toThrow(/incomplete/);
  });

  it("permits a distinct transport origin only in development", () => {
    expect(
      resolveEncryptedWalletBackupConfiguration({
        DEV: true,
        VITE_ENCRYPTED_BACKUP_REALM: "bitcaster.local",
        VITE_ENCRYPTED_BACKUP_SIGNED_ORIGIN: "https://encrypted-backup.local",
        VITE_ENCRYPTED_BACKUP_TRANSPORT_ORIGIN: "http://localhost:7180",
      }),
    ).toEqual({
      realm: "bitcaster.local",
      signedOrigin: "https://encrypted-backup.local",
      transportOrigin: "http://localhost:7180",
    });
    expect(() =>
      resolveEncryptedWalletBackupConfiguration({
        DEV: true,
        VITE_ENCRYPTED_BACKUP_REALM: "bitcaster.local",
        VITE_ENCRYPTED_BACKUP_SIGNED_ORIGIN: "http://encrypted-backup.local",
      }),
    ).toThrow(/HTTPS/);
    expect(() =>
      resolveEncryptedWalletBackupConfiguration({
        VITE_ENCRYPTED_BACKUP_REALM: "bitcaster.local",
        VITE_ENCRYPTED_BACKUP_SIGNED_ORIGIN: "https://encrypted-backup.local",
        VITE_ENCRYPTED_BACKUP_TRANSPORT_ORIGIN: "http://backup.example",
      }),
    ).toThrow(/loopback/);
    expect(() =>
      resolveEncryptedWalletBackupConfiguration({
        PROD: true,
        VITE_ENCRYPTED_BACKUP_REALM: "bitcaster.local",
        VITE_ENCRYPTED_BACKUP_SIGNED_ORIGIN: "https://encrypted-backup.local",
        VITE_ENCRYPTED_BACKUP_TRANSPORT_ORIGIN: "https://backup.example",
      }),
    ).toThrow(/must match/);
    expect(() =>
      resolveEncryptedWalletBackupConfiguration({
        PROD: true,
        VITE_ENCRYPTED_BACKUP_REALM: "bitcaster.local",
        VITE_ENCRYPTED_BACKUP_SIGNED_ORIGIN: "https://encrypted-backup.local",
        VITE_ENCRYPTED_BACKUP_TRANSPORT_ORIGIN: "http://localhost:7180",
      }),
    ).toThrow(/must match/);
  });

  it("rewrites only an exact signed origin, preserves the request, and restores the signed response URL", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response("http://127.0.0.1:7180/v1/vault?cursor=a"));
    const transport = createEncryptedWalletBackupTransportFetch({
      signedOrigin: "https://encrypted-backup.local",
      transportOrigin: "http://127.0.0.1:7180",
      fetch,
    });
    const body = new Uint8Array([1, 2, 3]);
    const responseFromTransport = await transport(
      "https://encrypted-backup.local/v1/vault?cursor=a",
      {
        method: "POST",
        body: body as unknown as BodyInit,
      },
    );
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:7180/v1/vault?cursor=a", {
      method: "POST",
      body,
    });
    expect(responseFromTransport.url).toBe("https://encrypted-backup.local/v1/vault?cursor=a");
    await expect(transport("https://foreign.example/v1/vault", {})).rejects.toThrow(/origin/);
  });

  it("rejects redirects and foreign final transport origins before restoring the signed URL", async () => {
    let cancelled = 0;
    const transport = createEncryptedWalletBackupTransportFetch({
      signedOrigin: "https://encrypted-backup.local",
      transportOrigin: "http://localhost:7180",
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(response("http://foreign.example/v1/vault", () => (cancelled += 1))),
    });
    await expect(transport("https://encrypted-backup.local/v1/vault", {})).rejects.toThrow(
      /transport response/,
    );
    expect(cancelled).toBe(1);
  });
});

function response(url: string, onCancel?: () => void): Response {
  return {
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        if (onCancel === undefined) controller.close();
      },
      cancel: onCancel,
    }),
    url,
    redirected: false,
    type: "basic",
    ok: true,
  } as Response;
}
