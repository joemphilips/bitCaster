---
title: "Ecash"
description: "Cashu ecash の概要と、bitCaster が sat 建て条件付きトークンを使う方法。"
sidebar:
  order: 0
---

# Ecash

bitCaster のポジションは Cashu ecash を使用します。現在のプロダクト資産は sat です。

## Ecash とは

ecash は Chaumian blind signature を使用します。ミントは署名済みの bearer token を発行します。token を制御する人が token を使用できます。ミントは token を検証しますが、blind signature により、発行と後の使用を結び付けにくくします。

bitCaster では、ウォレットは通常の sat ecash とマーケットポジション用の条件付きトークンを使用します。ミントは決済中にこれらのポジションを conversion します。確定した conversion は、正確な result entry をウォレットに返します。

ウォレットは seed、output blinding factor、refund key、および通常の proof inventory を保持します。注文では、その注文を認可する正確な `PAY_TO_UNLOCK` proof だけをエンジンに送信します。エンジンはその proof secret を確認しますが、値を別の場所に移動したり、有効期限を延長したりできません。

## 入金と出金

初回リリースは、bitCaster が運営する1つのミントに対応します。sat ウォレットには、ミントの BOLT11 Lightning 支払い方式またはそのミントが発行した sat Cashu token のインポートで入金できます。取引フローが条件付きマーケット proof を管理します。ミントの BOLT11 Lightning フローで通常の sat ecash を出金できます。

## 信頼モデル

ecash は bearer system です。ウォレットデータと回復材料を保護してください。ミントは発行した token の裏付けとなる Bitcoin 準備金を保持します。そのため、mint operator が ecash の義務を履行すると信頼する必要があります。

ミントは永続的なユーザー identity ではなく bearer token を検証します。ユーザーは償還前に token を swap して、以前の request との関連を切断できます。そのため、ミントはユーザー identity に基づいて ecash を選択的に凍結できません。ミントはサービス全体を停止できるため、ユーザーは参加前にミントと観測可能な運用データを自分で評価する必要があります。

マッチングエンジンは、注文に対する限定された capability を一時的に保持します。他の wallet proof は使用できません。決済を保留した場合、認可された proof は refund が有効になるまで使用できません。

## Cashu を使う理由

Cashu は Bitcoin と Lightning をサポートするプライベートな bearer token を提供します。また、bitCaster が条件付きトークンと `PAY_TO_UNLOCK` authorization に使用する NUT framework も提供します。

## 関連情報

- [アトミック決済](/ja/user-guide/core-concepts/atomic-swap/)はミント conversion フローを説明します。
- [Conditional Token Framework](/ja/user-guide/core-concepts/conditional-tokens/)は条件付きマーケットポジションを説明します。
- [Bitcoin Design — Ecash Introduction](https://bitcoin.design/guide/how-it-works/ecash/introduction/)は ecash 信頼モデルの外部紹介です。
