---
title: '取引モデル'
description: 'CLOB 注文、認可、決済グループ、注文受付保護の仕組み。'
sidebar:
  order: 2
---

# 取引モデル

bitCaster は中央指値注文板（CLOB）を使用します。流動性提供者の提示注文は板に残ります。
公開注文は価格制限内で利用可能な流動性を取ります。内部の金額単位は msat です。
UI は sats で表示します。

公開マーケット板はプリミティブな outcome route を使用します。カテゴリカルマーケットでは `A / Not A`、`B / Not B` などの板を公開します。クライアントは `{conditionId}-{outcomeName}` のマーケット ID を使い、必要な token side を選択します。

## 初回リリースの公開範囲

公開サーバーが受け付ける注文は公開 FOK だけです。GUI と CLI は FOK を送信します。各公開試行は 1 件の one-shot capability を使用します。FOK は注文受付時の板の状態に基づきます。要求数量全体を確定するか、注文全体を取り消します。公開 FAK、GTC、GTD、継続、および残余注文の再認可は利用できません。

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
outcome route の価格です。価格の分母は `priceDenominator` です。
予測値は取得済みのプレビューに基づきます。二値マーケットの
`currentLatestTradePrice` は、同じプレビュー内の両ルートから最新の確定取引を使います。
反対側のルートの価格は `priceDenominator - price` に変換します。
アウトカムが3つ以上の場合、要求した primitive route の取引価格だけを使います。
別のアウトカムの取引では更新しません。クライアントは表示時に primitive route の
価格を選択したトークンの価格に変換します。予測値は確定済み
取引ではありません。全量を約定できない場合、執行見積もりは `null` です。
確定済み取引がない場合、現在価格は `null` です。資金提供は市場価格の記録を作りません。

GUI は 1 つの Buy/Sell フォームを使用します。入力した数量を、有効な価格範囲全体で
見積もります。Buy は `D - 1`、Sell は 1 を見積もり用の制限価格に使います。
ユーザーは取引代金の見積もりに同意し、手数料を別に確認します。
注文は、同意した代金の上限または下限と、見積もりの最悪約定価格を保持します。
エンジンは、約定を受け付ける前に現在の FOK 注文全体を確認します。
同じ条件または有利な条件では約定できます。不利な条件では注文全体を拒否します。

Buy は `maxQuotePaymentSubunits` を取引代金の上限に使います。
Sell は `minQuotePaymentSubunits` を手数料控除前の受取代金の下限に使います。
該当する値には、msat 単位の非負の整数を指定します。
反対側の値は `null` です。これらの制限は手数料を含みません。
エンジンの注文受付で確認する制限であり、ミントが独立して強制する制限ではありません。
CLI クライアントは、各約定に対してさらに狭い制限価格も指定できます。

`POST /api/v1/orders/capacity-preview` は、指定した制限価格内の最大数量を見積もります。
`marketId`、`side`、`tokenSide` を送信します。Auto では `price` を省略します。
Custom では整数の `price` を送信します。明示的な `null` は無効です。
Auto は `floor(D * 20 / 100)` tick を使い、制限を `1..D-1` に収めます。
対象はボットだけでなく、条件に合うすべての注文です。
クライアントは引き続きこの API を利用できます。
ブラウザのフォームは最大数量を表示せず、入力数量を確認して拒否理由を表示します。
この API の数量にはウォレット残高と手数料を含みません。流動性を予約するものではありません。

`ready` の結果には `referencePrice`、`effectiveLimitPrice`、
`maxFaceAmountSubunits`、`quotePaymentSubunits`、`worstPrice`、
`priceDenominator`、不透明な `previewRevision` が含まれます。
価格は、補集合を選択した場合も含め、選択したトークンの価格です。
数量がゼロの場合、額面と支払額はゼロで、最悪価格は null です。
約定可能な注文がない場合、基準価格は null です。このとき Auto の制限は null
ですが、Custom は指定した制限を保持します。厳しい Custom の制限では、基準価格が
あっても数量がゼロになる場合があります。
`market_unavailable` と `temporarily_unavailable` の値は null です。
これらは数量ゼロを意味しません。両プレビューは同じ rate limit 枠を共有します。

この数量は 1 件の公開 FOK 注文に対する上限です。注文の最小約定数量によっては、
これより小さいすべての数量が約定できるとは限りません。入力した数量には
引き続き `/orders/preview` を使い、その手数料を別に計算します。

注文は、残高確認、残高追加、準備、送信、回復を通じて、同意した取引代金の制限と
各約定の制限価格を保持します。両方の制限内で全量を約定するか、全く約定しないかの
どちらかです。これらの制限は流動性を予約せず、約定を保証しません。制限内で約定できなくなった場合は、新しい
プレビューを確認し、新しい試行に同意します。GUI は注文を自動で再試行しません。
ウォレットや Nostr の設定、または取引に使う identity の変更後も、新しい
プレビューと確認が必要です。

UI は金額を sats で表示します。100 msat は 0.1 sats です。Buy の合計は、支払額、
決済入力手数料、送信元準備手数料、proof 集約手数料の合計です。Sell では担保の
総受取額と、決済入力手数料および通常の現金で支払う準備費用を差し引いた純受取額を示します。条件付きトークンの
準備手数料と集約手数料は別に示します。異なる資産の手数料を合算しません。
未使用の fee headroom は支払い済み手数料ではありません。手数料額、資産、準備方式が変わった
場合、次の新規ウォレット処理を始める前に改めて同意を得ます。
Sell では、保有する条件付きトークンと通常の現金を使って、売却数量の全体を準備できます。
準備手数料は現金で支払います。売却前にその現金が必要です。将来の売却代金では支払えません。
この準備処理で不足するシェアを新しく作成してはいけません。
価格保護は手数料への同意を代替しません。手数料への同意は、確認した価格制限を
持つ注文に適用します。

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

Participation Score は公開注文の受付を保護します。成功した公開 one-shot capability binding は、`settlement-capability-v1` の下で 1 回だけ課金します。料金は `1 + InputCount + ceil(ManifestCount/16) + ceil(ArtifactByteCount/4096)` です。認証済みの invalid proof または DLEQ validation attempt は同じ料金を使用します。order、fill、settlement failure ごとの別料金はありません。fill、取消、settlement failure、refund、recovery は Score を debit しません。この料金は公開クライアントの capability に適用します。

Score が不足すると、daemon は支払いを送信します。delivery state が `credited` になるまで待ってから、注文 capability を準備します。再試行には同じ delivery identity を使用します。ミントが支払いを受け取った後も、Score の反映が遅れることがあります。待機時間の上限に達しても、その支払いは回復できます。pending の delivery は、支払いの失敗を示すものではありません。

## 信頼境界

エンジンは、注文を認可する正確な `PAY_TO_UNLOCK` proof を受け取ります。その secret と公開された blinded-output manifest を確認します。ウォレット seed、output blinding factor、refund key、および他の wallet proof は取得しません。

エンジンは、有効期限前に認可された selection だけを使用できます。manifest の外に値を移動できません。有効期限を延長できません。決済を保留した場合、認可された proof は refund が有効になるまで使用できません。

ミントは conversion を実行します。ウォレットは proof の材料を制御します。`PAY_TO_UNLOCK` capability は NUT の規則に従い、期限後に返金できます。

## オンチェーン CTF 取引所との比較

complementary、mint、merge という名前はオンチェーン CTF システムにもあります。実装は異なります。bitCaster は現在、complementary conversion と mint conversion だけを提供します。1 件のアトミック決済グループに対して 1 件のミント conversion を使用します。peer-to-peer 決済交換やオンチェーン operator transaction は使用しません。
