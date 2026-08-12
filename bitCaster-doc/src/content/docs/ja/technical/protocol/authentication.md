---
title: "認証"
description: "ウォレット identity を adapter から独立させた bitCaster のリクエスト認証。"
sidebar:
  order: 3
---

# 認証

マッチングエンジンは書き込みエンドポイントで認証を要求します。これはスパムを防ぎ、サービスがリクエストの所有権規則を適用できるようにします。契約で別途指定しない限り、読み取り専用エンドポイントは公開です。

現在の adapter は [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) HTTP authentication です。Nostr は authentication adapter です。汎用的なウォレット identity でも決済 identity でもありません。

## リクエスト本文のバインド

`POST`、`PUT`、`PATCH` リクエストでは、NIP-98 event に `payload` tag を含めます。値は正確なリクエスト本文の bytes に対する SHA-256 digest の小文字 16 進表記です。エンジンは受信した bytes から digest を計算し、不一致を拒否します。

このバインドは、取得された authentication event が fresh period 中に別の本文を認可することを防ぎます。`GET`、`DELETE`、本文がないリクエストでは `payload` tag を省略します。

multipart リクエストでは、送信する正確な bytes から digest を計算します。それらの bytes と一致する `Content-Type` boundary を保持します。サービスは digest を計算する前に 1 MiB より大きい本文を拒否します。

## ウォレットと決済の境界

認証は認証済みリクエストを証明します。peer の決済チャネルは作成しません。決済リクエストは別に、注文を認可する正確な `PAY_TO_UNLOCK` capability proof を含みます。ウォレットはその proof 操作に NUT-CTF 決済プロトコルを使用します。

## エラー応答

| Status | 意味 |
| --- | --- |
| `401 Unauthorized` | authentication token がない、不正、または期限切れです。 |
| `403 Forbidden` | token は有効ですが、リクエスターは resource に対して操作できません。 |
