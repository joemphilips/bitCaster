---
title: "NUT-CTF Range Settlement"
description: "bitCaster の条件付きトークン注文に対するミント調整型決済モデル。"
sidebar:
  order: 5
---

# NUT-CTF Range Settlement

bitCaster は NUT-CTF range settlement を使用します。2 者間の HTLC、peer ECDH、または adaptor signature プロトコルは使用しません。

初回リリースで公開サーバーが受け付ける注文は FAK と FOK です。GUI には FAK を表示します。CLI は FAK と FOK に対応します。各公開試行は 1 件の one-shot capability を使用します。一部約定では、確定した fill を決済し、残りを取り消します。約定がない FAK も取り消します。FOK は admission snapshot に基づき、要求数量全体を確定するか、注文全体を取り消します。公開 GTC、GTD、継続、および残余注文の再認可は利用できません。内部の custody-backed LMSR quote は GTC を使用します。これは公開クライアントの注文ではありません。

## 注文の認可

ウォレットは公開 FAK または FOK の 1 回の試行を 1 件の `PAY_TO_UNLOCK` capability で認可します。注文受付では capability を確認します。受付時にミントへのネットワーク呼び出しは行いません。

認可はその試行で許可された range を対象とします。公開継続は利用できません。板に残る注文を取り消しても、その注文だけを取り消します。capability の使用や返金は行いません。

## マッチングとグループ化

エンジンはマッチした数量ごとに fill を作成します。`fillId` は 1 件の実際の fill を識別します。

エンジンは 1 件以上の fill をアトミック決済グループにまとめます。`groupId` は 1 件のアトミック決済グループを識別します。グループは fill の代替ではなく、fill もグループの代替ではありません。

エンジンは、期限が来るまで互換性がある fill をグループに追加できます。conversion を送信する前にグループを確定します。

エンジンはグループに対して 1 件の複数当事者 conversion をミントに送信します。現在のプロダクトは complementary conversion と mint conversion をサポートします。ミントが conversion の結果を決定します。NUT は merge conversion も定義しますが、bitCaster はこのリリースで提供しません。

## 確定と回復

確定時に、ミントはグループの正確な result entry を返します。クライアントは送信した operation と result を保存します。これにより、クライアントはクラッシュ後に正確な operation と result を回復できます。

クライアントまたはネットワークの障害後は、送信がない、または不確実な場合があります。この場合、クライアントは永続的なエンジンとミントの authority で照合します。ローカルのリクエストだけから成功を判断してはいけません。`PAY_TO_UNLOCK` capability は NUT の定義に従い、期限後も返金可能です。

認識済みの FAK または FOK operation は operation facts と result を保存します。これらの記録はサーバーの再起動後も残ります。同じ client order ID を意図的に同じ operation facts で再利用すると、保存済みの result を返します。facts が変わると conflict を返します。

## 信頼境界

ウォレットは、注文を認可する正確な `PAY_TO_UNLOCK` input proof を送信します。このため、エンジンはその proof と secret を確認します。公開された blinded-output manifest も確認します。ウォレット seed、output blinding factor、refund key、および他の wallet proof は取得しません。

エンジンは、ウォレットが認可した output だけを選択できます。output を unblind できません。manifest の外に値を移動できません。他の wallet proof を使用できません。有効期限を延長できません。エンジンが決済を保留した場合、認可された proof は refund path が有効になるまで使用できません。

ミントは conversion を実行し、確定した result entry を返します。ウォレットは proof と blinding を制御する材料を保持します。Nostr authentication は現在の adapter を通じて認証済みリクエストを識別します。これは決済鍵の交換でも、汎用的なウォレット identity でもありません。

## 対象範囲

このプロダクトは sat 建て資産をサポートします。USD 資産は提供しません。Cashu は HTLC または P2PK 条件などの機能を提供できますが、bitCaster は現在の決済モデルでこれらを使用しません。
