---
title: "アトミック決済"
description: "bitCaster がマッチした条件付きトークン注文をミントで決済する方法。"
sidebar:
  order: 2
---

# アトミック決済

bitCaster は、マッチした注文を Cashu ミントで決済します。2 者間のスワップは実行しません。

注文時に、ウォレットは `PAY_TO_UNLOCK` capability で注文を認可します。マッチングエンジンは注文受付時にこの認可を確認します。この段階でミントへのネットワーク呼び出しは行いません。

注文がマッチすると、エンジンは 1 件以上の fill を作成します。各 `fillId` は 1 件の実際の fill を識別します。エンジンは 1 件以上の fill をアトミック決済グループに入れることができます。各 `groupId` はそのグループを識別します。`groupId` を fill の識別子として使わないでください。

エンジンは各決済グループに対して 1 件の複数当事者 conversion をミントに送信します。ミントはグループを 1 件の操作として完了します。グループは次の conversion 種別を使えます。

- **Complementary conversion。** 互換性がある条件付きトークンと担保のポジションを交換します。
- **Mint conversion。** conversion の一部として完全な条件付きトークンセットを作成します。

NUT は merge conversion も定義します。bitCaster はこのリリースで提供しません。

ミントがグループを確定すると、正確な result entry を返します。ウォレットは送信した operation と確定した result を保存します。ウォレットが停止または接続を失っても、後で正確な operation と result を回復できます。

## 取消と継続

取消は、まだ板に残る注文だけを取り消します。`PAY_TO_UNLOCK` capability を使用しません。capability を返金しません。

一部約定の後、残余注文を板に再度置くには、新しい capability が必要です。

## エンジンが確認できる情報

ウォレットは、注文を認可する正確な `PAY_TO_UNLOCK` proof を送信します。エンジンはその proof と secret を確認します。ウォレット seed、output blinding factor、refund key、および他の wallet proof は取得しません。

エンジンは、ウォレットが認可した output だけを使用できます。値を別の場所に移動できません。認可の期限を延長できません。エンジンが決済しない場合、認可された proof は refund が有効になるまで使用できません。

送信がない、または不確実な場合、ウォレットは永続的なエンジンとミントの authority で照合します。`PAY_TO_UNLOCK` capability は NUT の規則に従い、期限後も返金できます。

## 関連情報

ライフサイクルと信頼境界は、[技術決済プロトコル](/ja/technical/protocol/atomic-swap/)を参照してください。
