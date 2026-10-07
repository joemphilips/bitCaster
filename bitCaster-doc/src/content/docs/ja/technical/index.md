---
title: 技術リファレンス
sidebar:
  order: 0
---

このセクションでは、bitCaster の公開技術動作を説明します。

## 独自クライアントと自動化

独自の GUI や TUI、スクリプト、取引用 AI エージェントの操作用インターフェースとして
CLI を利用できます。コマンドは、プログラムが読み取れる JSON の結果を返します。
例えば、`bitcaster-cli order book <market-id>` は公開注文板を取得します。
`bitcaster-cli config set --engine-url <url>` でエンジンの URL を設定します。
`bitcaster-cli market comments <condition-id>` は公開コメントを JSON で取得します。
この読み取りにウォレットは不要です。

`bitcaster-cli market history <condition-id> --timeframe 7d` で価格履歴を取得します。
どちらのコマンドも `--minimum-event-order <event-order>` と `--refresh` を受け付けます。
ソース位置は不透明な値です。値を変えずに渡してください。
現在のソース位置を対象に読み取るには、`--refresh` を使ってください。
JSON の結果は `snapshotEventOrder` を保持します。
価格履歴の結果は、サーバーの評価時刻 `asOf` も保持します。
ウォレット、署名者、デーモンは不要です。

```bash
bitcaster-cli market comments <condition-id> --minimum-event-order <event-order>
bitcaster-cli market history <condition-id> --timeframe 7d --refresh
```

現在の対応状況は `bitcaster-cli --help` と各コマンドの `--help` で確認してください。
CLI は、まだ Web アプリのすべての操作には対応していません。
アプリケーションの全機能を同等に利用できる設計を目指しています。
ブラウザの描画や保存方式を CLI で再現するという意味ではありません。
CLI クライアントにも、同じ公開認可ルールと決済ルールが適用されます。

### ネイティブウォレットのプロファイルを選択・インポートする

各コマンドの `--datadir` で、ネイティブウォレットのプロファイルを選びます。
既存のウォレットに上書きせず、新しいディレクトリにインポートしてください。

```bash
bitcaster-cli --datadir ./wallet-new daemon init --wallet-seed-hex-file ./wallet-seed.hex --nostr-secret-key-hex-file ./nostr-secret-key.hex
bitcaster-cli --datadir ./wallet-new signer show
bitcaster-cli --datadir ./wallet-old signer show
```

シードファイルには、64 バイトを小文字の16進数128文字で記載します。
署名鍵ファイルには、32 バイトを小文字の16進数64文字で記載します。
サイズ制限内の通常ファイルを使い、所有者だけがアクセスできるようにしてください。
シンボリックリンクや、コマンド引数に書いた秘密情報は使用しません。
秘密情報のファイル操作には、POSIX の所有者・権限チェックが必要です。
古いプロファイルと未完了の処理は保持してください。
ディレクトリを選んでも、資金の移動や別のプロファイルの置き換えは行いません。
`daemon init` は鍵をインポートします。ミントから資金を復旧する操作ではありません。

決定的に生成されたプルーフを復旧する場合、先に選択中のプロファイルのデーモンを停止します。

```bash
bitcaster-cli --datadir ./wallet-new wallet recover-seed --wallet-seed-hex-file ./wallet-seed.hex --recovery-id recovery-001 --mint https://mint.example --unit msat --acknowledge-seed-disclosure
```

プロファイルに設定されたミントを指定します。後の実行でも同じ復旧 ID を使ってください。
この確認オプションは、シードから生成したプルーフ候補をミントに開示することへの同意です。
実行中や未完了のウォレット処理がある場合、復旧を拒否することがあります。
既存ウォレットをその場で置き換える操作ではありません。
スキャンが完了しても、失ったすべてのトークンを復旧できた保証にはなりません。

### Nostr 署名鍵を管理し、プロフィールを読む

ログイン用署名鍵は、ウォレットシードや支払いの受取アドレスとは別です。
公開ステータスから現在のリビジョンを確認します。

```bash
bitcaster-cli signer show
bitcaster-cli signer import --key-file ./nostr-key.txt --expected-revision <revision>
bitcaster-cli signer export --output-file ./new-nostr-backup.txt
bitcaster-cli signer profile
```

インポートは、所有者だけがアクセスできる通常ファイルの秘密鍵16進数、`nsec`、`ncryptsec` に対応します。
`ncryptsec` の復号パスワードは、別の `--key-passphrase-file` で指定します。
秘密鍵やパスワードをコマンド引数に書かないでください。
エクスポートは、新しい所有者専用ファイルに秘密の `nsec` を保存します。上書きはしません。
通常の出力には公開ステータスを表示し、秘密鍵は表示しません。
インポート、生成、接続、切断の前にデーモンを停止してください。
これらの変更には `signer show` のリビジョンが必要です。未完了の処理がある場合は拒否されることがあります。
ウォレットシードは置き換えません。

`signer show` はオフラインで使えます。編集用フラグを付けずに `signer profile` を実行すると、
選択中の署名鍵と設定済みリレーで公開情報を再取得します。キャッシュしたプロフィールは返しません。
別の `signer refresh` コマンドはありません。
プロフィールを読む前に、切断中の署名鍵を接続し、リレーを設定してください。
プロフィールが見つからない場合も、有効な結果です。表示名は本人確認の証明ではありません。

任意のプロフィール用フラグで、公開する kind-0 メタデータを編集できます。

```bash
bitcaster-cli signer profile --name "Alice" --about "About Alice" --picture "https://example.com/alice.png"
bitcaster-cli signer profile --about ""
```

指定したフィールドだけを変更します。空文字列を指定すると、そのフィールドを空にします。
別の `display_name` を含む、他のメタデータは変更しません。
プロフィールの編集時は、デーモンを停止する必要はありません。
署名前に、選択したすべてのリレーからの取得を完了する必要があります。
最新のプロフィールを解釈できない場合や取得が未完了の場合、編集を拒否します。
出力では、リレーの受け入れ、拒否、応答なしを区別します。
応答がないことは、そのイベントが拒否された証拠ではありません。
受け入れ後は、次の編集のために署名済みの公開プロフィールを保持します。
ローカルへの保存に失敗した場合は、公開の結果と区別して表示します。
保存が正常に完了した後は、再読み込み後も、リレーの古い応答によって次の編集で
保存済みの情報を失うことを防ぎます。他のクライアントからの同時変更は防げません。
プロフィール編集の `--dry-run` は、通信、秘密情報のロック解除、公開を行わず、入力を検証します。

`--dry-run` は、署名鍵の変更や秘密鍵の出力をせず、予定する操作を表示します。
インポートの dry-run でも、秘密情報の入力ファイルは読み取り、検証します。

### ミントとリレーの設定を保存する

```bash
bitcaster-cli mint list
bitcaster-cli mint add https://mint.example
bitcaster-cli mint select https://mint.example
bitcaster-cli mint remove https://other-mint.example
bitcaster-cli relay list
bitcaster-cli relay add wss://relay.example
bitcaster-cli relay remove wss://relay.example
```

ミントの追加は、そのミントの選択も行います。追加と選択では msat 単位への対応を確認します。
最後のミントを削除することはできません。
ミント URL を保存しても、そのミントでの取引に対応するという意味ではありません。
初回リリースの取引には、対応する bitCaster のミントを使います。
変更するのは保存済みの設定です。保有資金や復旧先は変更しません。
CLI が起動したデーモンが動作中なら、再起動して適用します。
それ以外の場合は、デーモンを自分で再起動してください。
設定結果の `--expected-revision` を指定すると、古い状態に対する編集を拒否できます。
`--dry-run` は編集内容を検証・表示します。設定の保存やデーモンの再起動は行いません。

リレー一覧を明示的に `[]` にすると、Nostr リレー通信を行わない設定になります。
代わりの公開リレーは選びません。ミントやエンジンとの通信を無効にする設定ではありません。
公開プロフィールの再取得と、リレー経由の受け取りには、設定済みリレーが必要です。

### お気に入りのマーケットを保存する

```bash
bitcaster-cli market liked
bitcaster-cli market liked --local
bitcaster-cli market like <condition-id>
bitcaster-cli market unlike <condition-id>
```

アウトカムルート ID ではなく、コンディション ID を指定します。
`liked` は、マーケット情報を取得できなくても、保存済み ID の一覧を省略しません。
`--local` は、リレーやエンジンへのリクエストを送らずに、保存済み ID を読みます。
指定しない場合は、ブックマークの同期やマーケット情報の取得を行うことがあります。
like と unlike は、リレーへの投稿に失敗してもローカルの変更を保持します。
同じ操作を繰り返しても、お気に入りを逆の状態に切り替えません。
`--dry-run` は予定する操作を表示します。編集やネットワークリクエストは行いません。
お気に入りは、設定済み Nostr リレーで公開される場合があります。
ブックマークや設定は、ウォレットのプルーフや未完了の支払いのバックアップではありません。

### 保有資産とポートフォリオの見積もりを読む

設定済みのネイティブウォレットで、ローカルの保有資産と任意の評価額を確認します。

```bash
bitcaster-cli wallet positions
bitcaster-cli wallet portfolio --timeframe 1W --page-size 100
bitcaster-cli wallet assets --cursor <nextCursor> --page-size 100
```

`wallet positions` は、ウォレットの条件付きトークンの保有記録を読みます。
`wallet portfolio` は、`localHoldings` と、それとは別の `monitoring` を返します。
監視状態は `available`、`disabled`、`unavailable` のいずれかです。
監視が無効または利用不可でも、ローカル残高がゼロになったわけではありません。
評価額を取得できても、支出の許可や売却代金の保証にはなりません。

ポートフォリオのレスポンスには、資産の最初のページが含まれます。
続きは、その `nextCursor` を `wallet assets` に渡して取得します。
カーソルは変更しないでください。`nextCursor` が `null` なら終了です。
名前が `Sats` で終わるフィールドの単位は sats です。`Msat` で終わるものは msat です。
金額を合計する前に単位をそろえてください。1,000 msat は 1 sat です。

### Wallet Activity を読む

選択中のウォレットに保存された表示用履歴を取得します。

```bash
bitcaster-cli wallet activity --page-size 25
bitcaster-cli wallet activity --cursor <nextCursor> --page-size 25
```

このローカル読み取りはオフラインで動作します。ミント、エンジン、リレーには接続しません。
ページサイズの既定値は 25 件、最大値は 50 件です。
`nextCursor` は変更せずに渡してください。`null` なら終了です。
カーソルはこのウォレットとプロファイルに属します。別のプロファイルでは使用できません。
ページは追加順で、新しい項目から返します。最初のページで取得対象を固定します。
その後に追加された項目を取得するには、カーソルを指定せずに再開してください。
ページの取得中に、既存の項目の状態が変わる場合があります。

JSON レスポンスは次の形式です。

```json
{
  "ok": true,
  "result": {
    "items": [
      {
        "id": "example-deposit-id",
        "walletId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "type": "deposit",
        "amountSubunits": 1234,
        "baseAsset": "sat",
        "date": "2026-10-06T00:00:00.000Z",
        "status": "completed",
        "txId": null,
        "lightningInvoice": null
      }
    ],
    "nextCursor": null,
    "hasMore": false
  }
}
```

`amountSubunits` は msat 単位の整数です。`baseAsset` が `sat` の場合も同じです。
例の金額は 1.234 sats です。`id` は変化しない表示用の識別子です。
種類には `deposit`、`withdrawal`、`Buy`、`Sell`、`payout_claimed` があります。
状態は `pending`、`completed`、`Failed` です。大文字と小文字を区別します。
`txId` と `lightningInvoice` は、取得できない場合は `null` です。
該当する場合の任意フィールドには、`marketId`、`marketTitle`、`positionId`、
`failureReason`、`tradeDetails` があります。欠落した値を推測しないでください。
確定した取引の詳細には、既知の場合の `orderId`、`fillId`、`outcomeId`、
`tokenSide`、`faceAmountSubunits`、`divisibility` が含まれます。

完了した入金と Claim は、検証済みの受取額を表示します。
完了した Lightning 出金は、手数料を除いた支払い元本を表示します。
送信した Cashu トークンは、すべての proof が使用されるか、回収が完了するまで保留状態です。
トークン全体を回収すると、出金は元本ゼロの `Failed` になり、
理由は `Cancelled; funds reclaimed` と表示されます。
一部を回収した場合、完了金額は受取人が使用した元本だけです。
回収手数料はこの金額に含めません。自分の資金の回収では入金項目を作りません。
ボットへの資金提供と Score の送金は、この出金履歴の対象外です。
復旧では同じ操作の識別子を再利用します。再試行で項目は増えません。

「請求の払戻金を復元」は、新たにウォレットへ反映した払戻金の proof だけを表示します。
`claimRecovery` オブジェクトには、`kind: "retained-claim-payout"`、
`originalOperationId`、`originalStatus: "Failed"`、
`originalFailureCode: 13015` が含まれます。完了状態は復旧を表します。
元の Claim は失敗のままです。既に保持している proof や使用済みの proof では、
新たな受取項目を作りません。そのため、検証済みの過去の払戻金総額が、
復旧による受取額より大きい場合があります。
元の記録に支払い時刻がない場合、`date` は完了をローカルで初めて確認した時刻です。
ミントが処理した時刻の証明ではありません。

独自の GUI や TUI では、`wallet activity --page-size 25` を呼び出し、
`result.items` を `id` で識別して表示できます。
利用者が続きを要求したら `nextCursor` を渡してください。
新しい履歴を表示するには、最初のページから更新します。
`--wallet-id <wallet-id>` で、選択中のウォレットを明示的に確認できます。
ネイティブの履歴には、ブラウザーのキャッシュにある 500 件の制限はありません。
Activity は支出を許可する情報ではなく、全期間の完全な監査履歴でもありません。
資金や復旧状態は、ウォレット残高や操作のコマンドで確認してください。

### 暗号化した Activity をリレーと同期する

```bash
bitcaster-cli wallet activity-sync
bitcaster-cli wallet activity-sync --limit 50 --publish
```

既定のコマンドは、選択中のウォレットの Activity を取り込みます。
有効な Nostr 署名者と設定済みのリレーを使います。
`--wallet-id <wallet-id>` で対象のウォレットを明示的に確認できます。
ローカルの `wallet activity` コマンドはリレーに接続しません。

公開には `--publish` が必要です。ローカルの対象範囲と、
リレーで確認したスナップショットを統合します。
`--limit` はローカルの 1～500 件を選択します。既定値は 100 件です。
保持済みのローカル履歴は削除しません。
リレーの各エンベロープは最大 500 件です。設定できるリレーは最大 16 個です。

公開時には、確認済みの他のウォレットや旧形式の項目を保持します。
保持できないスナップショットは公開しません。
不明なフィールド、不完全なリレー応答、リモートイベントの変更、
公開時刻より古くないリモート時刻、統合後の上限超過は、公開を拒否する理由になります。
暗号化する平文の上限は 65,535 バイトです。
上限に収めるために他のウォレットの項目を削除しません。

`importedRows`、`queryComplete`、`window` と `publication` は別々に確認してください。
公開が拒否されたり失敗したりしても、取り込みは成功する場合があります。
`window.localTruncated` は選択した範囲を表し、ローカルデータの削除を意味しません。
`publication.status` は `not-requested`、`refused`、`acknowledged`、`partial`、
`failed` のいずれかです。`publication.reason` は拒否の理由を示します。
`publication.acknowledgedRelayCount` は受領応答を返したリレーの数です。
受領応答は、永続保存や履歴の完全性を証明しません。

最後の読み取りから公開までの間や、公開後に、別のクライアントがイベントを
置き換える可能性があります。公開を試みた場合は、
`publication.remainingReadPublishRace` がこの制限を示します。
`completeHistory` は常に false です。
この暗号化された表示用の履歴は、支出用 proof のバックアップでも、
資金の復旧を許可する情報でもありません。

### マーケットとウォレットの値を継続して読む

設定済みのデーモンを起動してから、次のいずれかを実行します。

```bash
bitcaster-cli market watch <condition-id> <another-condition-id>
bitcaster-cli market watch --liked
bitcaster-cli wallet watch
```

`market watch` は、異なるコンディション ID を最大 200 件受け付けます。
アウトカムルート ID は指定しません。
`market.snapshot` イベントには、マーケットと各アウトカムの注文板が含まれます。
`--liked` は、監視の開始時に、ローカルのお気に入り一覧を確定します。
ブックマークを編集しても、監視対象は変わりません。変更を適用するには監視を再開してください。
`--liked` と明示的な ID は併用できません。保存済み ID が 200 件を超える場合は、省略せずに拒否します。
保存済み一覧が空なら、`market.liked.selection` の `state: "empty"` を返して終了します。
open から closed への変化を観測すると、`market.closed` を返します。
観測した変化であり、すべての終了履歴や償還の完了を証明するものではありません。
マーケットの監視には、接続中の署名鍵が必要です。資産監視が無効なら、署名鍵が切断中でも
ローカルウォレットの監視を利用できます。
`wallet watch` は、選択中のウォレットの `wallet.snapshot` イベントを返します。
各スナップショットは、ローカルの保有資産と任意の評価額を分けて表示します。
監視が無効なら、ポートフォリオの取得や価格更新の購読リクエストを送りません。
監視が利用不可でも、ローカルの保有資産の変化は表示します。
評価額の更新購読には、200 コンディションの上限があります。
超過すると評価額は利用不可になります。保有資産を削除したり、一部だけのポートフォリオを最新として表示したりはしません。

出力の各行は 1 個の JSON オブジェクトです。
イベントには `type: "event"`、`event` 名、`data` が含まれます。
一部のイベントには、内部構造を解釈しない `sourceRevision` も含まれます。
接続イベントは `market.connection` または `wallet.connection` です。
状態は `connected` または `reconnecting` です。これは接続状態であり、決済完了ではありません。
再接続後は、新しいスナップショットを使ってください。古い価格を最新として使い続けないでください。
複数の更新が 1 個のスナップショットにまとめられることがあります。
このストリームは、すべての取引を記録するログではありません。

Ctrl+C で監視を終了します。注文やウォレット操作は取り消しません。
`type: "error"` の行が返ると、コマンドは終了コード 1 で終了します。
`type: "complete"` はストリームの終了を示します。支払いの完了ではありません。
出力にプルーフの秘密情報は含まれませんが、非公開のウォレット情報が含まれる場合があります。
保存した出力は、他のウォレット記録と同じように保護してください。

### 支払いリクエストで受け取る

`wallet request create` は、設定済みミント向けに、金額を固定しない msat のリクエストを保存します。
返された `encoded` を送信者に渡してください。受取アドレスはログイン用署名鍵ではなく、
ウォレットシードに属します。署名鍵が切断中でも、リクエストのコマンドは利用できます。
リレー経由の受け取りには、設定済みリレーと起動中のデーモンが必要です。
`wallet request status <request-id>` または `wallet request watch <request-id>` で確認します。
ウォレットへの反映が確定するのは `credited` の場合だけです。`pending` は完了ではありません。
未完了の受取記録には `wallet request recover <request-id>` を使います。
監視を停止しても、リクエストや受信処理は取り消しません。
受け取りの手順は [Ecash](/ja/user-guide/core-concepts/ecash/) を参照してください。

### ウォレットなしで注文を見積もる

次のコマンドには、カタログが返す公開マーケット ID を指定します。

```bash
bitcaster-cli order capacity --market <market-id> --side Buy
bitcaster-cli order preview --market <market-id> --side Buy --amount-msat 1000
```

`--amount-msat` は注文の額面金額です。支払予算ではありません。
選択したアウトカムの No ポジションには `--token-side Complement` を追加します。
売却の見積もりには `--side Sell` を指定します。
明示的な価格上限または下限には、マーケットの価格単位で `--price` を指定します。
`--price` を省略すると、サーバーが Auto の制限価格を返します。
CLI はその価格を取得してから、指定数量の注文を見積もります。
注文板が変わっても、制限価格を緩めません。

プレビューの出力には `request` と `preview` が含まれます。
リクエストの公開フィールド `faceAmountSubunits` の単位は msat です。
Auto の制限価格を取得できない場合、`preview` は `null` です。
`capacity` には、利用可能な数量に関するサーバーのレスポンスが保持されます。
数量の見積もりコマンドは、公開 capacity レスポンスをそのまま返します。
これらの見積もりは流動性を予約しません。ウォレットの準備手数料も含みません。
ウォレットの資金やシェアが十分にあることも保証しません。

### 手数料を承認して注文を送信する

公開注文板の見積もりは、ウォレットを調べません。
`order fee-preview` を使うと、ウォレットの準備手数料と、任意のプルーフ統合手数料も確認できます。
このコマンドには設定済みのネイティブウォレットが必要です。資金は使いません。

```bash
bitcaster-cli order fee-preview --market <market-id> --outcome <outcome-id> --side Buy --price 420 --amount-msat 1000 > fees.json
```

`ok` が `true` であることを確認してください。
`result.request` と `result.feeFacts` を確認してください。
request は、同意した取引代金の制限を手数料とは別に保持します。
Buy は `maxQuotePaymentSubunits`、Sell は `minQuotePaymentSubunits` を使います。
反対側の値は `null` です。金額の単位は msat です。
制限を明示する場合は、手数料の見積もりと注文の送信の両方で、
Buy に `--max-quote-payment-msat`、Sell に `--min-quote-payment-msat` を指定します。
非負の安全な整数を使ってください。反対側のフラグは指定しないでください。
各手数料には対象資産が指定されています。異なる資産の手数料を、すべて通常の現金であるかのように合計しないでください。
成功した JSON 出力は、変更せずに保存してください。
その注文内容と手数料を承認するには、同じ注文にファイルを渡します。

```bash
bitcaster-cli order submit --market <market-id> --outcome <outcome-id> --side Buy --price 420 --amount-msat 1000 --fee-consent-file fees.json
```

価格と金額は例です。推奨する取引条件ではありません。
注文内容や手数料の計画が変わると、ウォレットは拒否します。
手数料の増加を自動で承認しません。拒否された場合は、新しい見積もりを確認してから承認してください。
明示的な `--price` は、指定した制限価格のままです。
省略すると、Auto が見積もり用の制限価格を決めます。その後の変化によって再承認が必要になることがあります。
見積もりは流動性の予約ではありません。送信時に拒否されることもあります。
約定ごとの制限価格だけでは、見積もりの合計額を保護できません。
承認した合計額の制限は、同じ額または有利な額を許可します。
不利な額になった場合は、FOK 注文全体を拒否します。手数料は、この制限とは別です。

署名付き取引コメントを付けるには、`--comment` と `--market-url` を一緒に指定します。
クエリやフラグメントを含まない、正確な Web マーケット URL を使ってください。
コメントは注文に添付されます。独立したコメント投稿ではありません。
`--dry-run` は、デーモンへの接続や支払いをせずにリクエストを表示します。
注文が約定できることや、ウォレットが準備できることは保証しません。

送信結果が不確定な場合は、返された識別子を保存してください。
別の注文を開始する前に、状態や復旧状況を確認してください。
注文の失敗は、それ以前のウォレット準備が取り消されたことを意味しません。

### マーケットに資金を提供する

確定した資金提供額は、ウォレットなしで取得できます。

```bash
bitcaster-cli market funding <condition-id>
```

`ammBotBudgetSubunits` は、確定した資金提供額です。単位は msat です。
ボットの現金残高や、約定できる取引量ではありません。
`fundingRevision` は内部構造を解釈しない文字列、または `null` です。数値として解析しないでください。
このレスポンスは、ボットの新しい注文が利用可能になったことを保証しません。

設定済みのネイティブウォレットで、資金提供を見積もって実行します。

```bash
bitcaster-cli market funding-quote <condition-id> --amount-msat 8000
bitcaster-cli market fund begin <condition-id> --amount-msat 8000 --max-wallet-debit-msat 8002
```

金額は msat 単位の例です。8,000 msat は 8 sats です。
見積もりでは、資金の予約や送金を行いません。
`grossFundingMsat` は、受取側の受取手数料を差し引く前の送金額です。
`totalWalletDebitMsat` は、ウォレットの準備手数料を含む支払総額です。
`netFundingMsat` は、送金額から受取手数料の見積額を差し引いた資金提供額です。
見積もりを確認してから、支払総額の上限を指定してください。
ウォレットは、新しい支払いを準備する前にこの上限を再確認します。
`begin` は、実行するたびに新しい支払いを要求します。
資金提供は補助金です。ボットの資金を引き出す権利が得られる預金ではありません。

`ok` だけでなく、`result.delivery.state` を確認してください。
`pending` と `received` は資金提供の計上完了を示しません。`credited` が完了を示します。
結果が保留中または不確定の場合は、同じ送金を再開します。

```bash
bitcaster-cli market fund resume <condition-id> <transfer-id>
```

返された送金 ID、または不確定な結果の試行 ID を使ってください。
不確定な結果には `resumeCommand` も含まれます。
最初の支払いを再試行するために、新しい支払いを開始しないでください。
`market funding-head <condition-id>` は、現在のローカル送金を `result.head` に返します。
そのマーケットへの資金提供記録がウォレットにない場合、値は `null` です。
このローカル記録は、公開されている資金提供総額ではありません。

### 注文の結果を待つ

```bash
bitcaster-cli order wait <market-id> <order-id> --timeout-ms 30000
```

待機時間の既定値は 30 秒です。上限は 5 分です。
結果には、エンジンとローカルの最新注文状態が含まれます。
`wait.status: "terminal"` は、エンジンの注文が終了し、進行中の決済グループが
ないことを示します。約定、拒否、失敗の区別は、エンジンの状態で確認してください。
この結果はウォレットの復旧完了を保証しません。
`wait.status: "timed_out"` の場合、終了コードはゼロ以外になります。
タイムアウトは監視だけを停止します。注文の取消や準備の取消は行いません。
同じ注文 ID で再確認してください。

### 解決済みポジションを償還する

解決後に、設定済みのネイティブウォレットで選択したポジションを1件償還します。

```bash
bitcaster-cli wallet claim <condition-id> Alpha
bitcaster-cli wallet operations --kind ctf-redeem
```

保存済みポジションの正確な `outcomeCollection` を指定してください。
`Alpha` はラベルの例です。大文字と小文字を正確に保持してください。
`|` を含むコレクションは、`'Beta|Gamma'` のように引用符で囲んでください。
コマンドは、そのコンディションとアウトカムコレクションだけを選択します。
他のポジションの償還や、コンディション全体の廃止は行いません。

`ok` だけでなく、`result.legs` の各項目を確認してください。
各項目には `operationId`、`keysetId`、`state`、`payoutAmountSubunits` が含まれます。
状態は `completed`、`losing`、`pending` のいずれかです。
完了した項目の `payoutAmountSubunits` は、手数料を差し引いた通常の現金の受取額です。単位は msat です。
ミントの手数料は受取額を減らします。手数料によって償還が経済的に成立せず、拒否される場合があります。
ポジションの額面金額がそのまま受取額になる保証はありません。
`losing` の結果でも、保有記録とプルーフ履歴は残ります。
この claim コマンドは、負けたポジションの保有記録を削除しません。

結果が `pending` の場合やレスポンスを受け取れなかった場合は、同じ claim コマンドを再実行してください。
`bitcaster-cli wallet recover` でも、準備済みの償還を再開できます。
復旧は保存済みの操作を使います。別の償還を準備しません。
返された操作 ID を使い、`wallet operations --kind ctf-redeem` で状態を確認してください。
この状態出力には、プルーフ本体、秘密情報、アテステーションの witness は含まれません。

### 負けが検証済みの保有記録を除外する

最初に、正確なコンディションとアウトカムコレクションで `wallet claim` を実行してください。
除外する各プルーフには、負けを検証したミントの結果が保存されている必要があります。
エラー文、不確定な結果、経済的に成立しない償還は、除外の根拠になりません。
コレクションとラベルの大文字・小文字は、上の説明に従って正確に指定してください。

非公開のプレビューファイルを作成し、JSON 出力全体を確認します。

```bash
preview_file=$(mktemp)
bitcaster-cli wallet remove-preview <condition-id> Alpha > "$preview_file"
```

`ok` が `true` であることを確認してください。
`result.conditionId`、`result.outcomeCollection`、`result.mintUrl`、`result.targets` を確認してください。
外側の `ok` と `result` を含む出力全体を、変更せずに保存してください。
ファイルにプルーフの秘密情報は含まれませんが、非公開のウォレット情報が含まれます。
他の人がアクセスできない状態を保ってください。
`--preview-file` は、サイズ上限内の通常ファイルを必要とします。
グループとその他のユーザーには、アクセス権限を設定しないでください。
シンボリックリンクは拒否します。このファイル確認は Windows に対応していません。

損失を明示的に承認し、このバッチだけを除外します。

```bash
bitcaster-cli wallet remove --preview-file "$preview_file" --acknowledge-loss
```

プレビューは、ウォレットプロファイル、ミント、ポジション、正確なプルーフを指定します。
1 バッチの上限は 256 プルーフです。バイト数の上限で、これより小さくなる場合があります。
ウォレットは、保留中または予約済みのプルーフと、変更済みまたは不確定な対象を拒否します。
対象を変更する前に、バッチ全体を拒否します。
変更された保有記録から、代わりのプルーフを選びません。

`result.state`、`result.retiredProofCount`、`result.moreProofsRemain` を確認してください。
`state: "completed"` は、承認したバッチの除外完了を示します。
その他のプルーフは引き続き表示されます。
`moreProofsRemain` が `true` の場合は、新しいプレビューを作成してください。
後続のバッチごとに、別途承認してください。
除外済みのプルーフは、アクティブなポジションとプルーフ選択の対象から外れます。
ウォレットは、プルーフ本体と操作履歴をローカルに保持します。
再インポートしても、除外済みのプルーフはアクティブな利用に戻りません。
除外にはバックアップもネットワークリクエストも必要ありません。
監視は任意で、非同期に行います。プライバシーモードでは監視リクエストを送りません。
どちらのコマンドも、`--dry-run` で実行せずにデーモンへのリクエストを表示できます。
`remove` では、このオプションでもプレビューファイルを検証します。

## 公開契約

`GET /api/v1/markets/{conditionId}/comments` は各コメントに必須の `trade`
フィールドを返します。正確な確定 fill の座標がない場合、この値は `null` です。
座標がある場合、`fillId`、`outcomeId`、`executedAt`、`price`、
`priceDenominator` を含みます。座標には、公開取引履歴と同じ primitive outcome の
価格と時刻を使います。コメントの署名済み `createdAt` は別の値です。

`trade.faceAmountSubunits` は、そのコメントに関連する確定 fill の数量です。
注文全体の数量やユーザーの支払額ではありません。`null` は数量が不明なことを示します。
この endpoint は最大 500 件のコメントを保持します。完全なコメント履歴ではありません。
オラクルの結果説明は、有料の取引コメントとは別です。
確定した約定の座標を提供しません。
[マーケットの解決](/ja/user-guide/core-concepts/resolution/)を参照してください。

### コメントと価格履歴の更新

コメント endpoint と `GET /api/v1/markets/{conditionId}/price-history` は、
`minimumEventOrder` と `refresh=true` を受け付けます。取得したイベント位置を
変更せずに `minimumEventOrder` に渡してください。再接続後は `refresh=true` を使います。
サーバーは現在の source position を一度だけ取得します。その位置まで反映した後に
snapshot を返します。今後発生するすべてのイベントを待つわけではありません。

どちらのレスポンスも `snapshotEventOrder` を含みます。
これは、その snapshot に反映済みと確認した source position です。
このフィールドは `null` を許容します。`null` の場合、次の `minimumEventOrder`
リクエストに使える位置はありません。代わりに `refresh=true` を使ってください。
イベント位置は不透明な値として扱ってください。クライアント側で解析や比較をしないでください。
読み取り期限内に必要な位置までの反映を確認できない場合は `503` を返します。
前の表示を保持し、更新できないことを示してください。
このレスポンスを空のリストや価格ゼロとして扱わないでください。

価格履歴は、サーバーの評価時刻 `asOf` も含みます。
選択した履歴期間には、この時刻を使ってください。
更新後は、選択した期間のデータ全体を置き換えてください。
古い sample を新しいレスポンスに結合しないでください。
確定価格がないアウトカムは、価格不明のままです。
指定した日時には、その日時以前の最後に保持された確定価格を使ってください。
最初の確定取引より前の価格を作らないでください。
別のアウトカムのサンプルがない場合も、新しい価格は発生しません。
既存のカテゴリカル価格のステップも削除しません。

SignalR の `MarketCommentsChanged { conditionId, eventOrder }` は、
公開コメントの source が変更されたことを示します。
`ConfirmedTradeRecorded` も `latestConfirmedTrade.eventOrder` に source position を含みます。
どちらのメッセージも snapshot の準備完了を保証しません。
その位置を次の bounded read に渡してください。配信は best effort です。
再接続後は、最終取引価格が変わっていない場合も更新してください。

`GET /api/v1/markets/{conditionId}/registration` は、コンディション1件の公開登録情報を
返します。マーケット作成のレスポンスを受け取れなかった場合に、登録を確認するために使います。
`404` は登録がないことを示します。それ以外のエラーを未登録として扱わないでください。
フィールドとクライアント側の確認方法は
[Market Catalogue API](/ja/technical/protocol/market-catalogue/) を参照してください。

マーケット作成とカタログのレスポンスに含まれるアウトカムIDと省略可能な表示メタデータは、
[Market Catalogue API](/ja/technical/protocol/market-catalogue/) を参照してください。

読み取り専用の取引見積もり、約定可能な数量、個別の手数料計算については、
[公開 FOK プレビュー](/ja/technical/architecture/trading-model/#公開-fok-プレビュー)
を参照してください。

初回リリースで公開サーバーが受け付ける注文は公開 FOK だけです。GUI と CLI は FOK を送信します。各公開試行は 1 件の one-shot capability を使用します。FOK は注文受付時の板の状態に基づきます。要求数量全体を確定するか、注文全体を取り消します。公開 FAK、GTC、GTD、継続、および残余注文の再認可は利用できません。

## 決済グループ

注文は `PAY_TO_UNLOCK` capability を使用します。注文受付ではミントへのネットワーク呼び出しは行いません。エンジンは 1 件以上の fill をアトミック決済グループにまとめ、そのグループに対して 1 件の複数当事者ミント conversion を送信します。

`fillId` は 1 件の実際の fill を識別します。`groupId` は 1 件のアトミック決済グループを識別します。確定したグループは正確なミント result entry を返します。クライアントは送信した operation と確定した result を保存して回復します。認識済みの FOK operation は operation facts と result を保存します。これらの記録はサーバーの再起動後も残ります。同じ client order ID を意図的に同じ operation facts で再利用すると、保存済みの result を返します。facts が変わると conflict を返します。

エンジンは、注文に対してウォレットが認可した正確な input proof と公開 output manifest だけを受け取ります。ウォレット seed、output blinding factor、refund key、および通常の proof inventory は取得しません。プロトコル詳細は [NUT-CTF Range Settlement](/ja/technical/protocol/atomic-swap/) を参照してください。

## ポートフォリオ監視 API

認証済みの `GET /api/v1/portfolio` endpoint は、最初のポートフォリオ表示用の表示専用データを返します。レスポンスには、選択したウォレットの概要、最初の asset page、選択された value history が含まれます。これはカストディの証明や支出の承認には使用しません。

認証済みアカウントと `walletId` の組ごとに、独立した監視区間を持ちます。
同じ Nostr キーと異なるウォレットシードを持つクライアントは、それぞれの
ポートフォリオを報告して読み取れます。一方の報告で、他方のウォレットが
無効になることはありません。同じウォレットシードを持つクライアントからの
同時支出を許可するものではありません。

保有資産全体のスナップショットを `POST /api/v1/asset-monitoring/reports` に送信します。
最初の報告には `startsNewInterval: true` が必要です。その後に新しい区間を始めても、
対象のアカウントとウォレットの組だけに影響します。最新の報告を同じ内容で再試行しても、
別の区間は始まりません。受理済みの報告がない組には、`asOf` の値を持たない、
空で古い状態の概要を返します。他のウォレットの保有資産は引き継ぎません。

報告が競合すると、`ProblemDetails.code` を含む `409` を返します。
`asset-monitoring-baseline-required` は、その組に最初の報告が必要であることを示します。
送信済みで未完了の注文がない場合だけ、`startsNewInterval: true` で再試行できます。
`asset-monitoring-report-conflict` は、最新の受理済み報告との競合を示します。
このコードや未知の競合コードに対して、自動で新しい区間を始めないでください。

各監視資産は `cashuUnit: "msat"` と `displayBaseAsset: "sat"` を使います。
通信上の金額は msat です。表示するときだけ sats に変換します。
未対応の単位がある場合、ウォレットのレポート全体が無効になります。
その保有資産だけを除外して、一部の資産による置換レポートを送信しないでください。

後続の page を読むには、返された asset cursor を `GET /api/v1/asset-monitoring/assets` と一緒に使用します。後続 page に portfolio endpoint を呼び出さないでください。private response は `Cache-Control: no-store` を使用します。API は無効な query には `400`、history read limit が上限の場合は `429`、監視データを読み取れない場合は `503` を返します。
カーソルは、選択したアカウント、ウォレット、監視区間に属します。
一方のウォレットで新しい区間を始めても、他方のカーソルは無効になりません。

決済が確定した後、owner-filtered の `SettlementGroupStateChanged` update はアクティブな portfolio を更新できます。このベストエフォートの表示 update は、カストディの証明や支出の承認には使用しません。

価格と取引終了の更新を受け取るには、market hub の `SetPortfolioValuationSubscriptions` に購読するコンディションIDを渡します。その接続の購読対象を置き換えます。重複を含めて最大200件を受け付けます。APIが返す正確なコンディションIDを使ってください。空の配列で購読を解除できます。再接続後は購読対象を再送してください。

この購読では `ConfirmedTradeRecorded` と `MarketStatusChanged` を受け取ります。注文板のスナップショットや板の厚さの更新は受け取りません。購読、再接続、または対象の通知を受信した後に、Portfolioのレスポンスを再取得してください。更新要求をまとめ、`429` の応答に従ってください。通知を受け取っても、直後のPortfolio読み取りに反映されている保証はありません。
