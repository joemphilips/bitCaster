---
title: "Architecture Overview"
description: Technical overview of bitCaster's architecture, built with React 19, Vite PWA, cashu-ts, and NDK.
sidebar:
  order: 1
---

# Architecture Overview

bitCaster is a Progressive Web App built with React 19 and Vite. It uses `@cashu/cashu-ts` for Cashu ecash wallet operations, `@nostr-dev-kit/ndk` for Nostr connectivity and NIP-07 signing, and `@nostr-dev-kit/ndk-wallet` for Nostr Wallet Connect (NWC) pairing. The frontend communicates with Cashu mints for token issuance, swaps, and CTF operations, and with Nostr relays for oracle announcements and market metadata.

> This page is under construction. Content coming soon.
