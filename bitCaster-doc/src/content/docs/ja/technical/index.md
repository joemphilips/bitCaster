---
title: 技術リファレンス
sidebar:
  order: 0
---

このセクションでは、bitCaster の公開技術動作を説明します。

初回リリースで公開できる注文は FAK だけです。各公開試行は 1 件の one-shot capability を使用します。一部約定では、確定した fill を決済し、残りを取り消します。約定がない FAK も取り消します。公開 GTC、GTD、FOK、継続、および残余注文の再認可は利用できません。

## 決済グループ

注文は `PAY_TO_UNLOCK` capability を使用します。注文受付ではミントへのネットワーク呼び出しは行いません。エンジンは 1 件以上の fill をアトミック決済グループにまとめ、そのグループに対して 1 件の複数当事者ミント conversion を送信します。

`fillId` は 1 件の実際の fill を識別します。`groupId` は 1 件のアトミック決済グループを識別します。確定したグループは正確なミント result entry を返します。クライアントは送信した operation と確定した result を保存して回復します。

エンジンは、注文に対してウォレットが認可した正確な input proof と公開 output manifest だけを受け取ります。ウォレット seed、output blinding factor、refund key、および通常の proof inventory は取得しません。プロトコル詳細は [NUT-CTF Range Settlement](/ja/technical/protocol/atomic-swap/) を参照してください。

## ポートフォリオ監視 API

認証済みの `GET /api/v1/portfolio` endpoint は、最初のポートフォリオ表示用の表示専用データを返します。レスポンスには、アクティブなウォレットの概要、最初の asset page、選択された value history が含まれます。これはカストディの証明や支出の承認には使用しません。

後続の page を読むには、返された asset cursor を `GET /api/v1/asset-monitoring/assets` と一緒に使用します。後続 page に portfolio endpoint を呼び出さないでください。private response は `Cache-Control: no-store` を使用します。API は無効な query には `400`、非アクティブな wallet には `409`、history read limit が上限の場合は `429`、有効な provider に bounded monitoring reader がない場合は `503` を返します。

決済が確定した後、owner-filtered の `SettlementGroupStateChanged` update はアクティブな portfolio を更新できます。このベストエフォートの表示 update は、カストディの証明や支出の承認には使用しません。
