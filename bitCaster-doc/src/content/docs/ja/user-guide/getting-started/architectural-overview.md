---
title: "アーキテクチャ"
description: "bitCasterの構成要素がどのように連携するか"
sidebar:
  order: 2
---

bitCasterは、オープンプロトコルで通信する4つの独立したサービスで構成されています。

![Architecture diagram showing Oracle, Cashu Mint, bitCaster App, and Matching Engine](../../../../../assets/architecture.svg)


各ユーザーはブラウザでアプリの独自インスタンスを実行します。すべてのユーザーは同じ共有インフラストラクチャに接続します。

## Cashuミント

ミントはシステムの中核です。
通常のecashトークンと特定のマーケット結果にロックされた条件付きecashトークンの両方を発行します。
イベントが解決されると、ミントは自動的に決済を行います：勝利トークンはsatsに償還可能になり、敗北トークンは期限切れになります。

ミントは[CDK](https://github.com/cashubtc/cdk)（Cashu Development Kit）に予測市場用の[NUT-CTF](https://github.com/joemphilips/nuts/blob/nuts_for_prediction_markets/CTF.md)拡張を加えて動作します。

## bitCasterアプリ

ユーザー向けのプログレッシブウェブアプリ（PWA）です。完全にブラウザ内で動作し、トークンをローカルに保持します。アプリはすべてのトークン操作（ミンティング、スワップ、償還）についてミントと直接通信し、注文板アクセスについてはマッチングエンジンと通信します。

## オラクル

オラクルは、現実世界のイベントを告知し、後にその結果を証明する[Discreet Log Contracts（DLC）](https://www.dci.mit.edu/projects/discreet-log-contracts)のエンティティです。オラクルはアナウンスメントとアテステーションをNostrイベントとして公開し、公開検証可能にします。bitCasterアプリはNostrネットワークから直接オラクルのアナウンスメントを読み取ることができます。特別なサーバーは不要です。

重要なことに、オラクルはbitCasterから完全に独立しています。アプリやecashについて知る必要はありません。DLCプロトコルを使用して現実世界の事実を証明するだけです。

## マッチングエンジン

マッチングエンジンは各マーケットの中央指値注文板（CLOB）を維持します。買い注文と売り注文をマッチングし、リアルタイムの価格更新をブロードキャストします。これが唯一の中央集権的なコンポーネントです。注文マッチングは本質的に単一のシーケンサーの恩恵を受けるコーディネーション問題であるため、存在しています。
