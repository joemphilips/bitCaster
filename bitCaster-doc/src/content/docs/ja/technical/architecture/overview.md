---
title: "アーキテクチャ概要"
description: "React 19、Vite PWA、cashu-ts、NDKで構築されたbitCasterのアーキテクチャの技術概要"
sidebar:
  order: 1
---

# アーキテクチャ概要

bitCasterはReact 19とViteで構築されたプログレッシブウェブアプリです。Cashu ecashウォレット操作に`@cashu/cashu-ts`、Nostr接続とNIP-07署名に`@nostr-dev-kit/ndk`、Nostr Wallet Connect（NWC）ペアリングに`@nostr-dev-kit/ndk-wallet`を使用しています。フロントエンドはトークン発行、スワップ、CTF操作のためにCashuミントと通信し、オラクルアナウンスメントとマーケットメタデータのためにNostrリレーと通信します。

> このページは作成中です。コンテンツは近日公開予定です。
