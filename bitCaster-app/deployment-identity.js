import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

const unavailable = Object.freeze({ error: "deployment-identity-unavailable" });

// Capture only the public marker. Never infer identity from environment settings.
export function captureDeploymentIdentity(packageRoot) {
  let descriptor;
  try {
    descriptor = openSync(
      join(packageRoot, "deployment-identity.json"),
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
    if (!fstatSync(descriptor).isFile()) return null;
    const buffer = Buffer.alloc(1025);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length === 0 || length > 1024) return null;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    // JSON.parse alone accepts duplicate keys. Tokenize complete JSON strings so
    // escaped keys and overwritten nested values cannot hide an extra property.
    const tokens =
      text.match(
        /"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g,
      ) ?? [];
    const keys = tokens
      .filter((token, index) => token.startsWith('"') && tokens[index + 1] === ":")
      .map((token) => JSON.parse(token));
    if (
      keys.length !== 3 ||
      new Set(keys).size !== 3 ||
      keys.some((key) => !["schemaVersion", "component", "buildId"].includes(key)) ||
      value.schemaVersion !== 1 ||
      value.component !== "frontend" ||
      typeof value.buildId !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.buildId)
    )
      return null;
    return Object.freeze({ schemaVersion: 1, component: "frontend", buildId: value.buildId });
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        /* Identity remains unavailable on read failure. */
      }
    }
  }
}

export function deploymentIdentityHandler(identity) {
  return (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.status(identity === null ? 503 : 200).json(identity ?? unavailable);
  };
}
