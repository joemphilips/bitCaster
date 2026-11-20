---
title: "NUT-CTF Range Settlement"
description: "bitCaster の条件付きトークン注文に対するミント調整型決済モデル。"
sidebar:
  order: 5
---

# NUT-CTF Range Settlement

bitCaster は NUT-CTF range settlement を使用します。2 者間の HTLC、peer ECDH、または adaptor signature プロトコルは使用しません。

初回リリースで公開サーバーが受け付ける注文は公開 FOK だけです。GUI と CLI は FOK を送信します。各公開試行は 1 件の one-shot capability を使用します。FOK は注文受付時の板の状態に基づきます。要求数量全体を確定するか、注文全体を取り消します。公開 FAK、GTC、GTD、継続、および残余注文の再認可は利用できません。

## 支払いの単位

bitCaster が受け付ける金銭用 Cashu トークンの単位は `msat` だけです。
API の支払額と受領額は msats で表します。GUI は sats で表示します。
1,000 msats は 1 sat です。`baseAsset: "sat"` は資産名です。
トークンの単位ではありません。

Participation Score の購入額は、正の 1,000 msats の倍数にしてください。
1,000 msats ごとに 1 Score ポイントを購入できます。
受領手数料によって購入した Score は減りません。
Score ポイントと受領額は別の値です。

## 条件付き outcome collection

ミントの outcome collection では、登録されたオラクル announcement の outcome 順序を使います。
ミントへのリクエストを作るためにラベルを並べ替えないでください。
たとえば announcement の順序が `Alpha, Beta, Gamma, Delta` の場合、
`Alpha` の補集合は `Beta|Gamma|Delta` です。

条件付き keyset を選ぶ前に、公開 announcement の署名と condition の登録内容を検証してください。
各 keyset を、送信する正確な collection 文字列とその collection ID に照合してください。
有効なオラクル署名は announcement の内容を認証します。
署名だけでは、ミントが登録した announcement の組や threshold は証明できません。
この確認には、設定済みミントの登録内容と、既存の登録済み authority がある場合はその情報を使ってください。

既存の proof、keyset ID、保存済みの署名付きリクエストを変更しないでください。
未完了の操作を再試行するときは、元のリクエストのバイト列を使ってください。

## 注文の認可

ウォレットは公開 FOK の 1 回の試行を 1 件の `PAY_TO_UNLOCK` capability で認可します。注文受付では capability を確認します。受付時にミントへのネットワーク呼び出しは行いません。

ウォレットは capability を注文リクエストに含めて送信します。
`POST /api/v1/{marketId}/orders` に `settlementCapabilityAdmission` を指定します。
この値は capability artifact と注文内容を持ち、その `marketId` はルートと一致します。
1 回のリクエストで capability を紐付けて注文を受け付けるか、エンジンは何も書き込みません。
拒否は課金されません。応答の `settlementCapability` は受け付けた注文の capability です。

認可はその試行で許可された range を対象とします。公開 FOK は板に残らず、残余注文も残しません。要求数量全体を約定できない場合、エンジンは注文全体を取り消します。この取消では capability を使用せず、返金も開始しません。

### 廃止した 2 段階のルート

エンジンは従来の 2 段階のルートを受け付けません。
このルートは `POST /api/v1/settlement-capabilities` を送り、その後に `settlementCapability` の参照を持つ注文リクエストを送りました。
以下の各リクエストには、`410` とその `code` を返します。エンジンは何も書き込まず、課金もしません。

| リクエスト | コード |
| --- | --- |
| `POST /api/v1/settlement-capabilities` | `settlement-capability-stage-route-removed` |
| `settlementCapability` だけを持つ `POST /api/v1/{marketId}/orders` | `order-reference-form-removed` |
| `POST /api/v1/conditions/{conditionId}/orders/batch` | `order-reference-form-removed` |

バッチのルートは `settlementCapability` の参照だけを受け付けていたため、これも廃止しました。
capability とその結果を読み取るルートは引き続き使用できます。
2 段階のルートで使った `stageIdempotencyKey` は、注文リクエストで競合します。

2 段階のルートを使うクライアントは注文できません。
これには CLI リリース `cli-v0.1.0-afaa6cc6aa6b` と `cli-v0.1.0-4fe7f6e6c08f`、
および同じ時期のアプリをまだ実行しているブラウザのタブが含まれます。
最新の CLI リリースをダウンロードするか、ブラウザのアプリを再読み込みしてください。
現在のウォレットは、古いクライアントが同じウォレットプロファイルに残した注文記録を読み取ります。
その注文を作成できるリクエストは送信しません。
認可の有効期限の後に、ロックされた資金を返金します。

## Capability API のエラー

capability を読み取るルート、注文リクエスト、および廃止したステージのルートは、以下のエラーを返します。

capability API のアプリケーションエラーは、RFC 9457 の
`application/problem+json` で返ります。クライアントは HTTP ステータスと
`code` を使ってください。`title` や `detail` の文言で判定しないでください。
コードにはすべて `settlement-capability-` という接頭辞が付きます。
`type` は `/errors/` に完全なコードを続けた値です。

| HTTP | コードの接尾辞 | 意味 |
| --- | --- | --- |
| 400 | `invalid-request` | リクエスト項目が無効です。 |
| 400 | `invalid-artifact` | capability artifact が無効、または未対応です。 |
| 400 | `policy-rejected` | capability が受付ポリシーを満たしていません。 |
| 402 | `score-required` | Participation Score が不足しています。 |
| 404 | `not-found` | この呼び出し元は capability または結果を取得できません。 |
| 409 | `conflict` | capability の識別情報または状態が競合しています。 |
| 409 | `market-unavailable` | 市場はこの capability を受け付けません。 |
| 410 | `stage-route-removed` | 廃止したステージのルートです。何も書き込みません。 |
| 413 | `request-too-large` | リクエストがサイズまたは件数の上限を超えています。 |
| 429 | `admission-limited` | 処理中の受付が上限に達しています。 |
| 429 | `capacity-exhausted` | このユーザー、この市場、またはサービス全体の capability の上限に達しています。 |
| 503 | `admission-unavailable` | 決済受付を一時的に利用できません。 |

容量不足の応答には、従来どおり `limitCode` と診断用の `traceId` が含まれます。
`limitCode` は上限の範囲と種類を示します（例：`owner-active-count`）。
存在しない結果と他のユーザーの結果は、同じ 404 応答になります。
認証、フレームワークの入力検証、リクエストサイズ制限、レート制限による応答は、
本文の形式が異なる場合があります。

これらは API リクエストのエラーです。決済グループの状態ではありません。
エラーだけを根拠に返金やローカル記録の削除を行わないでください。
応答が不確かな場合は、元の操作と capability を保持してください。
再試行では元のリクエストを変更しないでください。

capability を読み取れても、ウォレットの復旧が完了したとは限りません。
注文が受け付けられていない場合も、認可が終端状態になるまで復旧を継続してください。
未使用の認可は、元の有効期限を過ぎ、mint が必要な復旧情報を確認した後に返金できます。

## 注文送信エラー

単一注文の送信でも、アプリケーションエラーは Problem Details を返します。
`type` は `/errors/` に `code` を続けた値です。メッセージの文言ではなくコードを使用してください。

| HTTP | コード | 意味 |
| --- | --- | --- |
| 400 | `order-invalid-request` | 注文のリクエスト項目が無効です。 |
| 400 | `order-invalid-comment` | 添付コメントが無効です。 |
| 403 | `market-closed` | 送信前に市場が閉鎖されています。 |
| 404 | `order-market-not-found` | 市場が登録されていません。 |
| 404 | `order-capability-not-found` | この呼び出し元は capability を利用できません。 |
| 409 | `order-capability-route-mismatch` | ルートが紐付け済みの注文と異なります。 |
| 409 | `order-capability-not-current` | capability がこの注文の現在の認可ではありません。 |
| 409 | `order-book-conflict` | 元のリクエストを変更せずに再試行してください。 |
| 409 | `order-processing-conflict` | 送信内容が現在の注文状態と競合しています。 |
| 409 | `order-market-closed` | 送信中に市場が閉鎖されました。 |
| 410 | `order-reference-form-removed` | 本文が廃止した `settlementCapability` の参照だけを持ちます。 |
| 503 | `order-admission-unavailable` | 注文受付を一時的に利用できません。 |
| 503 | `order-processing-unavailable` | 注文処理を一時的に利用できません。 |
| 503 | `order-quotes-refreshing` | 提示価格の準備ができていません。注文は受け付け前に拒否されました。 |

注文リクエストでは、capability API の `settlement-capability-` のコードも返ることがあります。
たとえば `402` の `settlement-capability-score-required` や `409` の `settlement-capability-conflict` です。
400,000 バイトを超える本文は、認証の前に `413` になります。
`order-submit` のレート制限と受付の上限は `429` を返します。

クライアントは応答ごとに 1 つの結果を使います。

- 文書化された拒否は何も書き込みません。`400`、`402`、`404` の `order-market-not-found` と `settlement-capability-not-found`、
  `409` の `order-processing-conflict`、`order-market-closed`、`settlement-capability-conflict`、`settlement-capability-market-unavailable`、`413`、`429` です。
  ウォレットは拒否を記録します。予約済み資金は、認可の有効期限の後に返金で戻ります。
- `403` の `market-closed`、`404` の `order-capability-not-found`、`409` の `order-capability-route-mismatch` と `order-capability-not-current` は、
  注文がすでに存在する再送リクエストへの応答の場合もあります。クライアントはこれらを結果不明として扱います。
- `order-quotes-refreshing` と `order-book-conflict` は受け付け前の拒否で、何も確定しません。
  送信フローで待っている間だけ、クライアントは
  [気配値の更新を待つ](/ja/technical/architecture/trading-model/#気配値の更新を待つ)の上限内で同一のリクエストを再送します。
  待機が終わり、すべての送信がこれらの拒否を受けた場合、クライアントは拒否を記録します。
- その他の応答はすべて結果が不明です。たとえばタイムアウト、`order-admission-unavailable`、
  `order-processing-unavailable`、一般的な `503` です。クライアントは注文を再送しません。
  下記の注文照会で注文を読み取ります。

すべての競合にこの再送の規則を適用しないでください。
`order-quotes-refreshing` は、たとえばサービスの起動直後に返ることがあります。SDK は `403` と `503` に対して元の操作を保持します。
エラーは返金完了の証拠でも、ウォレット記録を削除する許可でもありません。
受付済みリクエストの同一再送には、以前の受付結果を返します。
存在しない capability と他のユーザーの capability は同じ応答になります。
板が表示されていても、注文をすぐに受け付けられるとは限りません。
提示価格の準備が一時的に整っていない場合、`order-processing-unavailable` を返すことがあります。
この応答だけでは、流動性不足や追加資金の必要性は判断できません。
注文が受け付けられていないことも証明しません。元の操作を保持し、状態を確認してください。
受付済みの注文でも、結果を返せない場合はこの応答になることがあります。
その注文の決済は進む可能性があります。この応答だけを理由に代わりの注文を作成しないでください。
CLI はこの応答の後に注文を自動で再送しません。
プロトコル上の再試行では、元のリクエスト、同意内容、認可の有効期限を保持する必要があります。

入金でも、共通の市場閉鎖チェックは `market-closed` を返します。
フレームワークのエラー本文は別の形式の場合があります。

## 注文照会

`GET /api/v1/conditions/{conditionId}/orders/by-client-order-id?clientOrderId=` は、
認証済みの所有者の受付済み注文を 1 件読み取ります。応答は `orderId`、`marketId`、
`status` (`accepted` または `processed`)、`settlementCapability`、`artifactDigest` を持ちます。
存在しない注文、他の所有者の注文、注文が受け付けられていない capability は、同じ `404` の `order-not-found` になります。
この照会はステージ、検証、受付を行いません。主体ごとの専用のレート制限 `order-lookup` (1 分あたり 30 回) があります。

結果が不明な応答の後や再起動の後、ウォレットはこの照会だけを使います。
注文を作成できるリクエストは送信しません。

- 見つかった注文は、`artifactDigest` がローカルの capability artifact のダイジェストと一致する場合だけ有効です。
  その場合、ウォレットは送信済みの注文として記録します。
- 認可の有効期限より前に見つからない場合は、最終結果ではありません。
  ウォレットは 5 秒後に再度読み取り、読み取るたびに待ち時間を 2 倍にします。上限は 60 秒です。
  照会への `429` は読み取りとして数えません。次の読み取りは少なくとも `Retry-After` まで待ちます。
- 認可の有効期限の時刻以降は、ウォレットはミントを照会し (NUT-09 と NUT-07)、未使用の入力を返金します。

## 取消しと読み取りのエラー

これらの注文エンドポイントも同じアプリケーション Problem Details 形式を使用します。

| HTTP | コード | 意味 |
| --- | --- | --- |
| 400 | `order-invalid-request` | ルート、条件、またはバッチ取消しのリクエストが無効です。 |
| 404 | `order-market-not-found` | バッチ取消しの市場が登録されていません。 |
| 404 | `order-not-found` | このリクエストでは注文を利用できません。 |
| 409 | `order-cancellation-conflict` | 取消し中に注文状態が変化しました。 |
| 429 | `order-batch-limited` | アプリケーションのバッチ取消しのレート制限に達しました。 |

取消しでは、存在しない注文、他のユーザーの注文、ルートが違う注文に同じ `404` を返します。
すでに終了した注文の取消しは成功します。市場閉鎖後もバッチ取消しを利用できます。
バッチ取消しの確定後に通知用の読み取りが失敗しても、取消しの成功結果は変わりません。

注文状態の読み取りでは、不在またはルート違いの注文に `404`、
他のユーザーが所有する注文に `403` を返します。後者は認可の応答であり、
`market-closed` エラーではありません。SDK は状態読み取りの `404` に `null`、
取消しの `404` に `false` を返します。市場が未登録の場合、注文一覧と板の読み取りは
引き続き空データを成功応答として返します。これは読み取り失敗とは異なります。
フレームワークのエラー本文は別の形式の場合があります。

capability をバインドしても、注文が受け付けられたことにはなりません。
注文が受け付けられるまで、注文状態の読み取りは `404` と `order-not-found` を返します。
この応答は早期返金を許可しません。元の認可と復旧ルールを保持してください。
注文送信の結果が確定して取得可能になった後は、ライブ通知が失敗しても、
その結果が注文送信エラーに変わることはありません。

## マーケット資金提供の配信エラー

`POST /api/v1/cashu-deliveries/{deliveryId}` は内容を固定した配信を送信します。
同じパスへの `GET` は保存済みの状態を読み取ります。リクエストの失敗は、資金を
受領していないことの証明ではありません。回復のため、元の配信 ID、トークン、
変更できないリクエストを保持してください。結果が不明な支払いを別の支払いで置き換えないでください。
エンジンは配信を受け付けた後、応答の前にクライアントが切断しても配信を完了します。
後の状態読み取りがその結果を返します。

次のアプリケーションエラーは `application/problem+json` を使います。
`type` は `/errors/{code}` です。`detail` の文言ではなく、HTTP ステータスと `code` を使ってください。

| HTTP | Code | 意味 |
| --- | --- | --- |
| 400 | `cashu-delivery-invalid-request` | 配信 ID またはメタデータが無効です。 |
| 403 | `cashu-delivery-forbidden` | 認証済み主体はこの配信にアクセスできません。 |
| 409 | `cashu-delivery-conflict` | 保存済み状態と競合するか、配信が拒否されています。 |
| 400 | `market-funding-invalid-request` | 資金提供の金額、単位、トークン構造、ミントとの対応付け、または商品との対応付けが無効です。 |
| 404 | `market-funding-market-not-found` | 資金提供先のマーケットが見つかりません。 |
| 403 | `market-closed` | マーケットは新しい資金提供を受け付けていません。 |
| 500 | `cashu-delivery-state-unavailable` | 受付後の配信状態を読み取れませんでした。 |
| 502 | `cashu-delivery-recipient-unavailable` | 受領先を利用できません。 |
| 502 | `cashu-delivery-invalid-receipt` | 受領先の受領記録を検証できませんでした。 |
| 404 | `cashu-delivery-not-found` | 状態ハンドラーが配信を見つけられませんでした。 |

マーケットの締切だけを理由に、保存済み配信の同一内容での再試行が無効になることはありません。成功応答は
保存済みの配信状態を保持します。拒否済み配信の状態読み取りは `409` を返します。
存在しない配信は `404`、別の主体の配信は `403` を返します。
ルート制約、フレームワークの検証、認証、レート制限、Score 固有の失敗は別の
エラー本文を使う場合があります。同じ HTTP ステータスの全応答にこれらのコードが付くわけではありません。

SDK の配信メソッドはエラー本文を破棄します。受領先が bearer トークンを応答に
含める可能性があるためです。SDK はステータスだけのエラーを返し、自動再試行を
行いません。SDK の各配信リクエストは、既定で最大 30 秒待ちます。
状態メソッドは `404` に対して `null` を返します。この SDK の動作は、
API の構造化エラー形式とは別です。

## マッチングとグループ化

エンジンはマッチした数量ごとに fill を作成します。`fillId` は 1 件の実際の fill を識別します。

エンジンは 1 件以上の fill をアトミック決済グループにまとめます。`groupId` は 1 件のアトミック決済グループを識別します。グループは fill の代替ではなく、fill もグループの代替ではありません。

エンジンは、期限が来るまで互換性がある fill をグループに追加できます。conversion を送信する前にグループを確定します。

エンジンはグループに対して 1 件の複数当事者 conversion をミントに送信します。現在のプロダクトは complementary conversion、mint conversion、merge conversion をサポートします。merge conversion は、売り注文と補集合のアウトカムの売り注文を担保に変換します。ミントが conversion の結果を決定します。

## 確定と回復

API と決済通知は、送信前に認可が期限切れになった場合に
`ExpiredBeforeSubmission` を返します。`RejectedBeforeSubmission` は、
別の理由でミントリクエストを確定する前にグループを停止したことを示します。
どちらも `frozenAt` は null です。ウォレットの回復完了や返金の許可を意味しません。
クライアントは権威のある注文状態を読み取ります。読み取りに失敗した場合は、
回復用の記録を保持します。確定結果の回復を開始する状態は `Confirmed` だけです。

全量を予約した FOK 注文の注文状態は、グループの決済中は `matched` です。
注文送信の応答も `matched` を返します。
`filledAmountSubunits` は予約済みの量で、`remainingAmountSubunits` は `0` です。
グループが `Confirmed` になると、注文状態は `filled` になります。
グループが別の終了状態になった場合、注文状態は `failed` です。
全量を予約できない FOK 注文は `cancelled` です。

確定時に、ミントはグループの正確な result entry を返します。クライアントは送信した operation と result を保存します。これにより、クライアントはクラッシュ後に正確な operation と result を回復できます。

クライアントまたはネットワークの障害後は、送信がない、または不確実な場合があります。この場合、クライアントは永続的なエンジンとミントの authority で照合します。ローカルのリクエストだけから成功を判断してはいけません。`PAY_TO_UNLOCK` capability は NUT の定義に従い、期限後も返金可能です。

認識済みの FOK operation は operation facts と result を保存します。これらの記録はサーバーの再起動後も残ります。同じ client order ID を意図的に同じ operation facts で再利用すると、保存済みの result を返します。facts が変わると conflict を返します。

## 信頼境界

ウォレットは、注文を認可する正確な `PAY_TO_UNLOCK` input proof を送信します。このため、エンジンはその proof と secret を確認します。公開された blinded-output manifest も確認します。ウォレット seed、output blinding factor、refund key、および他の wallet proof は取得しません。

エンジンは、ウォレットが認可した output だけを選択できます。output を unblind できません。manifest の外に値を移動できません。他の wallet proof を使用できません。有効期限を延長できません。エンジンが決済を保留した場合、認可された proof は refund path が有効になるまで使用できません。

ミントは conversion を実行し、確定した result entry を返します。ウォレットは proof と blinding を制御する材料を保持します。Nostr authentication は現在の adapter を通じて認証済みリクエストを識別します。これは決済鍵の交換でも、汎用的なウォレット identity でもありません。

## 対象範囲

このプロダクトは sat 建て資産をサポートします。USD 資産は提供しません。Cashu は HTLC または P2PK 条件などの機能を提供できますが、bitCaster は現在の決済モデルでこれらを使用しません。
