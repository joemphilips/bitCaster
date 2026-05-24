# bitCaster Swap Protocol

Shared TypeScript primitives for the bitCaster peer-to-peer atomic swap protocol.

This package is source-imported by:

- `bitCaster-app`, for browser settlement.
- `bitcaster-wallet-service`, for bot/market-maker settlement.

Future `bitCaster-cli` clients should import this package instead of copying protocol code from the browser. Application-specific wallet persistence, HTTP clients, and UI state remain outside this package.
