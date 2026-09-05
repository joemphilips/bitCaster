---
title: "取引モデル"
description: "CLOB 注文、認可、決済グループ、注文受付保護の仕組み。"
sidebar:
  order: 2
---

# 取引モデル

bitCaster は中央指値注文板（CLOB）を使用します。指値注文は板に残せます。クロスする注文は利用可能な流動性を取ります。すべてのプロダクト資産は sat です。

公開マーケット板はプリミティブな outcome route を使用します。カテゴリカルマーケットでは `A / Not A`、`B / Not B` などの板を公開します。クライアントは `{conditionId}-{outcomeName}` のマーケット ID を使い、必要な token side を選択します。

## 初回リリースの公開範囲

公開サーバーが受け付ける注文は公開 FOK だけです。GUI と CLI は FOK を送信します。各公開試行は 1 件の one-shot capability を使用します。FOK は注文受付時の板の状態に基づきます。要求数量全体を確定するか、注文全体を取り消します。公開 FAK、GTC、GTD、継続、および残余注文の再認可は利用できません。内部の custody-backed LMSR quote は GTC を使用します。これは公開クライアントの注文ではありません。

## 公開 FOK プレビュー

`POST /api/v1/orders/preview` は 1 件の FOK 注文をプレビューします。
`marketId`、`side`、`tokenSide`、`price`、`faceAmountSubunits` を送信します。
価格には選択したトークンの指値を使います。額面はマーケットの分母に対応する
取引単位の整数倍である必要があります。proof、owner、time-in-force は送信しません。

NIP-98 認証は任意です。認証済み subject は、subject ごとの rate limit と
自己取引の除外に使います。プレビューは読み取り専用です。資金や流動性を予約せず、
注文の認可や送信も行いません。最終受付では、ユーザーの指値を使って現在の板を
再確認します。不透明な `previewRevision` は表示用 metadata であり、認可ではありません。

レスポンスは全量約定の可否と、次のいずれかの理由を返します。`fillable`、
`insufficient_liquidity`、`price_limit`、`request_too_large`、
`market_unavailable`、`temporarily_unavailable` です。別途の流動性補助を勧めるのは
`subsidyMayHelp` が true の場合だけです。資金提供と取引には個別の同意が必要です。

`quotePaymentSubunits` は手数料を含まない正確な msat 単位の支払額です。
`averagePrice` と `worstPrice` は選択したトークンの価格です。
現在の `currentLatestTradePrice` と予測値の `projectedFinalPrice` は primitive
outcome route の価格です。価格の分母は `priceDenominator` です。予測値は確定済み
取引ではありません。全量を約定できない場合、執行見積もりは `null` です。
確定済み取引がない場合、現在価格は `null` です。資金提供は市場価格の記録を作りません。

UI は金額を sats で表示します。100 msat は 0.1 sats です。Buy の合計は、支払額、
決済入力手数料、送信元準備手数料、proof 集約手数料の合計です。Sell では担保の
総受取額と、決済入力手数料を差し引いた純受取額を示します。条件付きトークンの
準備手数料と集約手数料は別に示します。異なる資産の手数料を合算しません。
未使用の fee headroom は支払い済み手数料ではありません。手数料額や資産が変わった
場合、次の新規ウォレット処理を始める前に改めて同意を得ます。

無効な入力は HTTP `400` を返します。リクエスト本文の上限は 16 KiB です。
超過すると `413` を返します。rate limit または同時実行数の上限に達すると、
`Retry-After` を付けた `429` を返します。

## 注文の認可

ウォレットは公開 FOK 注文を送信するときに 1 件の `PAY_TO_UNLOCK` capability を提供します。エンジンは注文受付で capability を検証します。受付中にミントへのネットワーク呼び出しは行いません。

capability はその 1 回の試行で認可された range を対象にします。公開 FOK は板に残らず、残余注文も残しません。要求数量全体を約定できない場合、エンジンは注文全体を取り消します。この取消では capability を使用せず、返金も開始しません。

## Fill と決済グループ

マッチした数量ごとに 1 件の fill が作成されます。`fillId` はその実際の fill を識別します。

エンジンは 1 件以上の fill を 1 件のアトミック決済グループにまとめることができます。`groupId` は決済グループを識別します。ミントはグループに対して 1 件の複数当事者 conversion を受け取ります。現在のプロダクトは complementary conversion と mint conversion をサポートします。このリリースでは merge conversion を提供しません。

ミントが確定すると、正確な result entry を返します。クライアントは送信した operation と確定した result を保持します。クラッシュ後もこの正確な記録を回復できます。認識済みの FOK operation は operation facts と result を保存します。これらの記録はサーバーの再起動後も残ります。同じ client order ID を意図的に同じ operation facts で再利用すると、保存済みの result を返します。facts が変わると conflict を返します。結果が不確実な場合、クライアントは永続的なエンジンとミントの authority で照合します。

## Participation Score

Participation Score は公開注文の受付を保護します。成功した公開 one-shot capability binding は、`settlement-capability-v1` の下で 1 回だけ課金します。料金は `1 + InputCount + ceil(ManifestCount/16) + ceil(ArtifactByteCount/4096)` です。認証済みの invalid proof または DLEQ validation attempt は同じ料金を使用します。order、fill、settlement failure ごとの別料金はありません。source facts は検証済みの work facts と rule ID を持ちますが、計算済みの debit は持ちません。fill、取消、settlement failure、refund、recovery は Score を debit しません。内部の custody-backed LMSR quote はこの公開料金の対象外です。

## 信頼境界

エンジンは、注文を認可する正確な `PAY_TO_UNLOCK` proof を受け取ります。その secret と公開された blinded-output manifest を確認します。ウォレット seed、output blinding factor、refund key、および他の wallet proof は取得しません。

エンジンは、有効期限前に認可された selection だけを使用できます。manifest の外に値を移動できません。有効期限を延長できません。決済を保留した場合、認可された proof は refund が有効になるまで使用できません。

ミントは conversion を実行します。ウォレットは proof の材料を制御します。`PAY_TO_UNLOCK` capability は NUT の規則に従い、期限後に返金できます。

## オンチェーン CTF 取引所との比較

complementary、mint、merge という名前はオンチェーン CTF システムにもあります。実装は異なります。bitCaster は現在、complementary conversion と mint conversion だけを提供します。1 件のアトミック決済グループに対して 1 件のミント conversion を使用します。peer-to-peer 決済交換やオンチェーン operator transaction は使用しません。
