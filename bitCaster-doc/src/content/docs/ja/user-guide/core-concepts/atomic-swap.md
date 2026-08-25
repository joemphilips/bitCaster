---
title: "アトミック決済"
description: "bitCaster がマッチした条件付きトークン注文をミントで決済する方法。"
sidebar:
  order: 2
---

# アトミック決済

bitCaster は、マッチした注文を Cashu ミントで決済します。2 者間のスワップは実行しません。

初回リリースで公開サーバーが受け付ける注文は FAK と FOK です。GUI には FAK を表示します。CLI は FAK と FOK に対応します。各公開試行は 1 件の one-shot capability を使用します。一部約定では、確定した fill を決済し、残りを取り消します。約定がない FAK も取り消します。FOK は admission snapshot に基づき、要求数量全体を確定するか、注文全体を取り消します。公開 GTC、GTD、継続、および残余注文の再認可は利用できません。内部の custody-backed LMSR quote は GTC を使用します。これは公開クライアントの注文ではありません。

FAK または FOK 注文では、ウォレットは `PAY_TO_UNLOCK` capability で注文を認可します。マッチングエンジンは注文受付時にこの認可を確認します。この段階でミントへのネットワーク呼び出しは行いません。

注文がマッチすると、エンジンは 1 件以上の fill を作成します。各 `fillId` は 1 件の実際の fill を識別します。エンジンは 1 件以上の fill をアトミック決済グループに入れることができます。各 `groupId` はそのグループを識別します。`groupId` を fill の識別子として使わないでください。

エンジンは各決済グループに対して 1 件の複数当事者 conversion をミントに送信します。ミントはグループを 1 件の操作として完了します。グループは次の conversion 種別を使えます。

- **Complementary conversion。** 互換性がある条件付きトークンと担保のポジションを交換します。
- **Mint conversion。** conversion の一部として完全な条件付きトークンセットを作成します。

NUT は merge conversion も定義します。bitCaster はこのリリースで提供しません。

ミントがグループを確定すると、正確な result entry を返します。ウォレットは送信した operation と確定した result を保存します。ウォレットが停止または接続を失っても、後で正確な operation と result を回復できます。認識済みの FAK または FOK operation は operation facts と result を保存します。これらの記録はサーバーの再起動後も残ります。同じ client order ID を意図的に同じ operation facts で再利用すると、保存済みの result を返します。facts が変わると conflict を返します。

## 取消

取消は、まだ板に残る注文だけを取り消します。`PAY_TO_UNLOCK` capability を使用しません。capability を返金しません。

公開 FAK が一部約定した後、残りの数量は取り消されます。公開クライアントは残余注文を再認可しません。

## エンジンが確認できる情報

ウォレットは、注文を認可する正確な `PAY_TO_UNLOCK` proof を送信します。エンジンはその proof と secret を確認します。ウォレット seed、output blinding factor、refund key、および他の wallet proof は取得しません。

エンジンは、ウォレットが認可した output だけを使用できます。値を別の場所に移動できません。認可の期限を延長できません。エンジンが決済しない場合、認可された proof は refund が有効になるまで使用できません。

送信がない、または不確実な場合、ウォレットは永続的なエンジンとミントの authority で照合します。`PAY_TO_UNLOCK` capability は NUT の規則に従い、期限後も返金できます。

## 関連情報

ライフサイクルと信頼境界は、[技術決済プロトコル](/ja/technical/protocol/atomic-swap/)を参照してください。
