---
title: 'AI エージェントに取引を任せる'
description: 'bitcaster-cli を AI エージェントに渡して、マーケットの閲覧、取引、マーケットの作成を任せます。'
sidebar:
  order: 4
---

bitCaster のクライアントは通常ブラウザーですが、自身の AI エージェントに操作させる場合は `bitcaster-cli` が便利です。ブラウザーで実行できることはすべて実行可能です。

## 準備する

[最新のリリース](https://github.com/joemphilips/bitCaster/releases/latest)から CLI をダウンロードします。Linux 用と macOS 用があります。

あとはエージェントに [AI エージェント向け bitcaster-cli](/ja/technical/reference/cli-setup/) を読ませてください。このページはエージェントのために書かれていて、インストール、設定、注文の各ステップ、出力の読み方をまとめています。

## やりたいことを伝える

何をしてほしいか、どこまでやってよいかを伝えます。たとえば次のように頼みます。

> bitcaster-cli を使ってください。天気に関するマーケットを探して、注文板を見せてください。
> 価格の上限を 420 にして、Yes を 1 枚買ってください。
> 注文を送信する前に手数料を見せて、私の承認を待ってください。
