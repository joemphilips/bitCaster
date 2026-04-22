---
title: 類似プラットフォームとの比較
---

## bitCasterとPredyxの比較

[Predyx](https://beta.predyx.com/)は、ビットコインネイティブの予測市場サービスですが、DEX というわけではなく従来の**サーバーサイドカストディ**モデルを使用する予測市場です。資金はPredyxのプラットフォーム上に置かれ、中央集権型取引所のような仕組みです。価格設定には**AMM（自動マーケットメーカー）**を使用しており、専任のマーケットメーカーなしで流動性を確保できますが、特にアウトカムが多い市場ではスプレッドが広くなる傾向があります。

bitCasterは根本的に異なるアプローチを取っています：

- **ecashによるベアラートークン** — ポジションはブラウザに保持される[Cashu条件付きトークン（CTF）](./user-guide/core-concepts/conditional-tokens/)のベアラートークンです。ミントは残高の確認、トランザクションの追跡、個別アカウントの凍結ができません。ただし、ecashは依然として[カストディアルモデル](https://bitcoin.design/guide/how-it-works/ecash/introduction/)です。ミントが基盤となるBitcoin準備金を保持するため、ミント運営者が資金を持ち逃げしたりトークン供給を水増ししたりしないことを信頼する必要があります。Predyxとの主な違いは、ecashカストディには強力なプライバシー（ブラインド署名によりミントがユーザーを追跡できない）がある点です。個人情報の流出や、特定個人のみ資金を凍結されるといったリスクがありません。
- **CLOBマッチング** — bitCasterは中央指値注文板を使用しており、マーケットメーカーがアクティブな場合、より狭いスプレッドを提供します。
- **プライバシー** — ecashトークンとLightningは公開のトランザクション痕跡を残しません。Predyxはサーバーサイドプラットフォームとして、ユーザーの活動を完全に把握しています。
- **オラクルの外注** — Predyx ではオラクルはマーケット作成者です。bitCaster ではオラクルはDLCのオラクルです。したがってその仕組みを利用する形で誰でもマーケットを作成でき、その際にオラクルを外部の主体に任せることができます。
- **オープンな仕様** — bitCasterはオープンプロトコル（[コンディショナルトークンフレームワーク](./user-guide/core-concepts/conditional-tokens/)、Nostr kind 88、DLC）上に構築されています。Predyxは独自システムを使用しています。

トレードオフ: Predyxは完全なカストディアルシステムで、bitCasterはDEXの一種です。したがって、すべてのDEXに特有のUX面での課題があります。
例えば、Atomic Swap のオーバーヘッドがあるため、bitCasterでは理論上Predyxに比べて取引には数秒のラグが生じます。

## bitCasterとPolymarketの比較

[Polymarket](https://polymarket.com)は取引量で最大の予測市場です。[ハイブリッドCLOB](https://docs.polymarket.com/developers/CLOB/introduction)を使用して**Polygon上でオンチェーン決済**を行っています。注文はオフチェーンでマッチングされますが、スマートコントラクトを通じてオンチェーンで決済されます。

bitCasterはいくつかの重要な点で異なります：

- **ブロックチェーン非依存** — bitCasterはBitcoin/LightningとCashu ecashを使用します。ガス代、L1からのブリッジ、Polygon上のUSDC保有は不要です。
- **プライバシー** — Polymarketのすべての取引は公開のPolygonトランザクションです。bitCasterのecashモデルでは、取引はデフォルトでプライベートです。
- **即時決済** — ecashトークンスワップはミント内で即座に決済されます。Polymarketの決済はPolygonのブロック時間に依存し、ブリッジ遅延が発生する場合があります。
- **オープンなマーケット作成** — Polymarketのマーケットはプラットフォームがキュレーションしています。bitCasterではNostrとDLCオラクル仕様を通じて誰でもマーケットを作成できます。
- **Bitcoinネイティブ** — bitCasterはsats建てで、[NWC（Nostr Wallet Connect）](https://nwc.dev/)を通じてLightningネットワークに接続します。PolymarketにはPolygon上のUSDCが必要です。

トレードオフ：Polymarketのオンチェーン決済は、すべての取引の完全な公開監査可能性を提供します。bitCasterのecashモデルは、その監査可能性と引き換えに、強力なプライバシー、ゼロガスコスト、即時決済を実現します。ecashは[カストディアルモデル](https://bitcoin.design/guide/how-it-works/ecash/introduction/)であることに注意してください。ユーザーはミント運営者がトークンを実際のBitcoinで裏付けていることを信頼しますが、Polymarketのオンチェーン透明性や従来の取引所のアカウントシステムとは異なり、ミントはユーザーを特定したり個別の残高を追跡したりすることができません。
