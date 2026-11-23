---
title: 'AI エージェント向け bitcaster-cli'
description: 'bitcaster-cli の準備、AI エージェントへの渡し方、JSON 出力の読み方、ウォレットの守り方。'
sidebar:
  order: 1
  label: 'エージェント向け CLI'
---

シェルコマンドを実行できる AI エージェントは、あなたの代わりに `bitcaster-cli` を使えます。
マーケットの確認、手数料の確認、注文の送信、マーケットの作成ができます。
CLI は JSON を出力するため、エージェントは各結果を読み取れます。エージェントは CLI ウォレットの資金を使います。
資金を入れる前に、[資金を安全に保つ](#資金を安全に保つ)を読んでください。

## エージェントにできること

CLI は、スクリプトや取引用 AI エージェントのためのアプリケーションインターフェースです。
CLI は Web アプリの操作を提供します。
利用できるコマンドとオプションは、エージェントに `bitcaster-cli --help` と `bitcaster-cli <command> --help` を実行させて確認してください。
コマンドグループには `market`、`order`、`wallet`、`score`、`mint`、`relay`、`signer`、`config`、`daemon` があります。

CLI は、時間のかかるウォレット処理を `bitcaster-daemon` に任せます。
daemon は、ウォレットと保存された処理を保持するローカルプロセスです。
コマンドが daemon を必要とするとき、CLI が daemon を起動します。
注文、支払い、マーケット作成が進行中の間は、daemon を動かしたままにしてください。

## CLI を準備する

CLI は[最新リリース](https://github.com/joemphilips/bitCaster/releases/latest)からダウンロードします。
x64 の Linux 用と、Apple シリコンの macOS 用のアーカイブがあります。Node.js 22.15 以降が必要です。
Windows ではまだ注文を送信できないため、Windows 用のアーカイブはありません。

Linux では、アーカイブとチェックサムファイルをダウンロードします。アーカイブを検証してから展開します。

```bash
curl -fLO https://github.com/joemphilips/bitCaster/releases/latest/download/bitcaster-cli-linux-x64.tar.gz &&
  curl -fLO https://github.com/joemphilips/bitCaster/releases/latest/download/SHA256SUMS &&
  grep ' bitcaster-cli-linux-x64.tar.gz$' SHA256SUMS | sha256sum -c - &&
  tar -xzf bitcaster-cli-linux-x64.tar.gz &&
  export PATH="$PWD/bitcaster-cli-linux-x64/bin:$PATH" &&
  bitcaster-cli --help
```

コマンドは、失敗した手順で止まります。チェックサムの検証に失敗した場合は、2 つのファイルをもう一度ダウンロードしてください。
2 回のダウンロードの間に、新しいリリースが公開されることがあります。

macOS では、`bitcaster-cli-linux-x64` の代わりに `bitcaster-cli-darwin-arm64` を、`sha256sum -c -` の代わりに `shasum -a 256 -c -` を使います。
アーカイブには、CLI、daemon、マーケット作成に使うオラクルヘルパーが入っています。
新しいシェルでも `bitcaster-cli` を使えるようにするには、シェルのプロファイルで `bin` ディレクトリを `PATH` に追加してください。

必要に応じて、このリポジトリの main ブランチのリリースワークフローがアーカイブをビルドしたことを確認できます。
この手順には GitHub CLI が必要です。

```bash
gh attestation verify bitcaster-cli-linux-x64.tar.gz --repo joemphilips/bitCaster \
  --cert-identity https://github.com/joemphilips/bitCaster/.github/workflows/release-cli.yml@refs/heads/main \
  --deny-self-hosted-runners
```

`bitcaster-cli --version` は、リリースのバージョンとソースのコミットを表示します。例: `0.1.0+0123456789ab`

公開リポジトリのクローンから CLI をビルドすることもできます。
Git と Node.js 22.15 以降が必要です。ビルドに必要なサブモジュールは `cashu-ts` だけです。

```bash
git clone https://github.com/joemphilips/bitCaster.git
cd bitCaster
git submodule update --init cashu-ts
npm ci
npm link --workspace bitcaster-cli
bitcaster-cli --help
```

`npm ci` は依存関係をインストールし、CLI をビルドします。
`npm link` は `bitcaster-cli` を npm のグローバル bin ディレクトリに置きます。
このビルドにはオラクルヘルパーが含まれないため、マーケットを作成できません。
マーケットを作成するには、リリースのアーカイブを使ってください。

CLI の初期設定は、ローカル開発用のエンジンとミントを指します。
bitCaster のエンジン URL とミント URL を設定してください。
`--trust-engine-url` はエンジン URL を信頼します。デーモンは信頼済みのエンジン URL でだけ起動し、
ターミナルがない場合、CLI は確認の質問ができません。その後、ウォレットのプロファイルを作成します。

```bash
bitcaster-cli config set --engine-url https://api.bitcaster.market --trust-engine-url --mint-url https://mint.bitcaster.cash
bitcaster-cli daemon init
bitcaster-cli wallet invoice create --amount-msat 25000
```

`daemon init` は、新しいウォレットシードと Nostr 鍵を `~/.bitcaster` に作成します。
エージェントのウォレットを他の CLI ウォレットと分けるには、すべてのコマンドに `--datadir <path>` を付けるか、`BITCASTER_DATADIR` を設定してください。
Lightning インボイスは別のウォレットから支払います。
その後、`bitcaster-cli wallet invoice show <quote-record-id>` と `bitcaster-cli wallet balance` で確認します。
金額の単位は msat です。1,000 msat が 1 sat です。

## セッションの例

エージェントに、やることと守る上限を伝えます。例えば次のように指示します。

> bitcaster-cli を使って、天気に関するマーケットを探し、その注文板を見せてください。
> 価格上限 420 で Yes のシェアを 1 枚買ってください。
> 注文を送信する前に手数料を見せて、私の承認を待ってください。

エージェントは、例えば次のコマンドを実行します。

```bash
bitcaster-cli market list --search weather --limit 5
bitcaster-cli order book <condition-id>-Yes
bitcaster-cli order fee-preview --market <condition-id>-Yes --outcome Yes \
  --side Buy --price 420 --amount-msat 1000 > fees.json
bitcaster-cli order submit --market <condition-id>-Yes --outcome Yes \
  --side Buy --price 420 --amount-msat 1000 --fee-consent-file fees.json
bitcaster-cli order wait <condition-id>-Yes <order-id>
bitcaster-cli wallet positions
```

マーケット ID の形式は `<condition-id>-<outcome>` です。
通常のマーケットでは、`--amount-msat 1000` がシェア 1 枚です。
`--price` は上限価格を指定します。省略すると、サーバーの Auto 上限を使います。
`fee-preview` の出力は変更せずに保存し、`order submit` には同じ注文内容を指定してください。
公開注文は FOK(fill-or-kill)です。注文は全量が約定するか、まったく約定しません。
`order wait` はタイムアウトで待機を終えます。注文はキャンセルしません。

マーケットを作成するときは、先に手数料を確認します。その後、そのウォレット引き落とし額を承認します。

```bash
bitcaster-cli market creation-quote --outcomes Yes,No
bitcaster-cli market create --creation-id <id> \
  --title "<質問>" --description "<結果判定基準>" \
  --outcomes Yes,No --maturity-epoch <unix-time> \
  --relay <relay-url> --max-wallet-debit-msat <msat>
```

画像を付けるには、`--thumbnail <file>` を指定します。
ファイルは、5 MiB 以下の JPEG、PNG、WebP 画像にしてください。
相対パスは、現在のディレクトリを基準にします。

作成 ID は保管してください。
`market creation-status` と `market creation-resume` で使います。
新しいエンジン URL で初めてマーケットを作成するとき、CLI は URL の確認を求めます。
ターミナルの確認プロンプトがない場合、CLI は作成を拒否します。
最初の作成は自分で実行するか、URL を確認してから `--trust-engine-url` を付けてください。

## JSON 出力を読む

出力は初期設定で JSON です。`--json` で明示的に指定することもできます。
daemon の結果は `{ "ok": true, "result": ... }` の形式です。
失敗した結果は `"ok": false` と `error` のテキストを持ち、終了コードは 1 です。
使い方の誤りは終了コード 2、検証エラーは終了コード 3 で終了します。警告と進捗メッセージは標準エラー出力に出ます。
`market watch` と `wallet watch` は、1 行に 1 つの JSON オブジェクトを出力します。
`daemon init` など一部の準備用コマンドは、プレーンテキストを出力します。

結果は `warnings` 配列を含むこともあります。
コード `conditional-keyset-final-expiry-soon` は、保有するポジションのミントのキーセットが
7 日未満で最終期限になること、または最終期限を過ぎたことを示します。
この時刻の後、ミントはそのポジションに応じる義務がありません。
先にそのポジションを売るか償還するよう、エージェントに指示してください。
[最終期限の警告](/ja/technical/#最終期限の警告)を参照してください。

## ミントが注文を拒否したとき

daemon は注文を送信する前に、ミントで注文の資金を準備します。
ミントの拒否の中には、準備が完了しておらず、今後も完了しないことを証明するものがあります。
このような拒否の後、daemon は予約した資金をもう一度確認し、注文の試行を終了します。
このとき `order submit` はコード `order-attempt-released` で失敗し、`mintError` にミントのコードを含めます。
`error` のテキストは、例えば「The mint refused the order (mint code 11008). No order was submitted. The reserved funds, less any consolidation fee already paid, are available again.」です。
別の操作が資金の一部を使っていた場合、daemon は残りの資金だけを解放します。新しい注文を送信できます。

その他の失敗では資金は予約されたままで、daemon は結果をもう一度確認します。
確認に失敗するたびに間隔が長くなり、最大 15 分になります。
`order recovery` は、daemon がまだ回復している注文の操作と、ミントの拒否で終了した注文の試行を表示します。
ミントが同じリクエストを同じコードで 5 回拒否すると、daemon は自動の確認を停止します。
その項目には `"halted": true`、ミントのコード、`retryCommand`(例: `bitcaster-cli order retry <operation-id>`)が表示されます。
返金の現在の出力プランの出力ではなく、その返金の以前の出力プランの出力をミントが保持しているときも、返金はすぐに停止します。
daemon はそれらの出力を返金として使いません。
その項目には `"halted": true` と `retryCommand` が表示されますが、`mintError` は表示されません。
`retryCommand` を実行すると、確認をもう一度だけ送信します。daemon を再起動した場合も、自動の確認が再開します。
`order retry` は `--dry-run` に対応しています。
同じマーケットの前の売り注文が資金を準備している間、`order submit` はそのマーケットの新しい売り注文をコード `order-sell-preparation-pending` で拒否し、資金を予約しません。

ほかのウォレットのコマンドがミントの応答で失敗したとき、`error` のテキストは固定です。
コード付きの拒否では「mint request was refused (mint code 11001)」と表示し、`mintError` にコードと短い詳細を含めます。
その他のミントの HTTP 応答では「mint request failed (HTTP 502)」と表示します。

## コマンドが使えない資金

daemon は、使える各 proof のカストディ記録を保持します。
この記録のない proof も `wallet balance` には含まれますが、どのコマンドもその proof を使いません。
そのような proof でしかコマンドを完了できない場合、コマンドは何も実行せずにコード `custody-repair-required` で停止します。
`error` のテキストは、利用可能な資金の一部をカストディが記録しておらず、このコマンドではその資金を使えないことを示します。
このコードで停止することがあるコマンドは、`wallet send`、`wallet pay quote`、`wallet pay execute`、`market fund`、`score buy`、`order submit` の Score 補充、`wallet split`、`wallet consolidate` です。
記録のある proof で支払えるコマンドは停止しません。

## ポジションを分割・統合する

`wallet split <condition-id> <amount-sats>` は、通常の資金を、マーケットの各アウトカム集合の指定額に変えます。
金額が入力 proof の額と一致する必要はありません。
分割はミントでの 1 回の変換なので、入力 proof に対する入力手数料を 1 回だけ支払います。
おつりは通常の資金として戻ります。
同じ `--operation-id` で再試行すると、保存された分割を再開するか、その結果を返します。
条件、金額、ミントのいずれかが異なる別の分割の操作 ID は拒否します。

分割と `wallet consolidate <market-id>` は、何かを実行する前にミントで条件を読みます。
ミントが条件を知らない場合、コマンドはコード `market-not-found` で停止します。
ミントが条件の結果を記録している場合、コマンドはコード `market-not-pending` で停止します。
これらの拒否では資金を予約しません。

分割は、何も実行せずに次のコードで停止することもあります。

- `insufficient-funds`: 通常の資金では、金額と入力手数料を支払えません。
  `result.requiredMsat` は金額と入力手数料の合計です。`result.availableMsat` は、分割で使える通常の資金です。
  カストディ記録のない proof があれば分割を完了できる場合、コードは `custody-repair-required` になります。
- `split-input-fee-zero`: ミントが入力手数料を課さず、手数料のない変換をミントが拒否します。
- `split-input-limit`: 分割に 256 個を超える入力 proof が必要です。より少ない金額で分割してください。
- `split-group-limit`: マーケットのアウトカム集合が 15 個を超えています。1 回の変換が持てる出力グループは最大 16 個で、おつりがそのうち 1 個を使います。
- `split-output-limit`: 分割に 256 個を超える出力が必要です。より少ない金額で分割してください。

この確認の後に、ミントが結果を記録することがあります。
その場合、ミントは変換を拒否し、分割または統合はコード `market-not-pending` で停止します。
その後、daemon はミントで各入力の状態を読みます。
すべての入力が未使用であれば、daemon は資金を解放し、その資金をもう一度使えます。
それ以外の場合、資金は予約されたままです。

`wallet consolidate-proofs` はなくなりました。
`order fee-preview` と `order submit` の `--consolidate-proofs` オプションは別の機能です。

## 資金を安全に保つ

エージェントは CLI ウォレットのすべての資金を操作できます。
取引、手数料、Participation Score に資金を使えます。Score は返金できません。
エージェントに取引させてよい金額だけを入れてください。

エージェントは CLI のデータディレクトリにあるファイルを読めます。そこにウォレットがあります。
エージェントには新しいウォレットを使ってください。メインウォレットの復元フレーズをインポートしないでください。
エージェントに復元フレーズを渡さないでください。復元フレーズを持つ人は、そのウォレットの資金を使えます。

送信する前に、`order fee-preview` と `market creation-quote` の結果を見せるようエージェントに指示してください。
コマンドの前に `--dry-run` を付けると、実行せずにコマンドを確認できます。
各コマンドの `--help` に、そのコマンドの dry-run での動作を示します。すべてのコマンドに、この動作が定められています。
対応するコマンドは `{"dryRun": true, "method", "params"}` を表示し、何も変更しません。`params` に秘密の値は入りません。
`order submit`、`market create`、`wallet invoice create` は対応しています。
読み取り専用のコマンドは通常どおり実行します。資金、注文、マーケット、鍵、設定は変更しません。
拒否するコマンドは、何も実行せずに終了コード 2 で終了します。
`daemon init`、`daemon stop`、`daemon restart` は `--dry-run` を拒否します。

`--dry-run` を付けると、CLI は daemon を起動しません。
daemon を必要とするコマンドは、daemon がすでに動いているときだけ動作します。
`--dry-run` は `--` より前に、値を付けずに指定してください。
それ以外の場合、CLI は終了コード 2 で終了します。
dry-run が成功しても、操作の成功は保証されません。
すべての処理の最終結果が出るまで、データディレクトリを保持してください。
