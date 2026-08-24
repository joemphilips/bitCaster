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

公開サーバーは FAK と FOK を受け付けます。GUI には FAK を表示します。CLI は FAK と FOK に対応します。各公開試行は 1 件の one-shot capability を使用します。一部約定では、確定した fill を決済し、残りを取り消します。約定がない FAK も取り消します。FOK は admission snapshot に基づき、要求数量全体を確定するか、注文全体を取り消します。公開 GTC、GTD、継続、および残余注文の再認可は利用できません。内部 LMSR bot の GTC は private operator 機能であり、公開クライアントの機能ではありません。

## 注文の認可

ウォレットは公開 FAK または FOK 注文を送信するときに 1 件の `PAY_TO_UNLOCK` capability を提供します。エンジンは注文受付で capability を検証します。受付中にミントへのネットワーク呼び出しは行いません。

capability はその 1 回の試行で認可された range を対象にします。公開継続は利用できません。取消は板に残る注文だけを取り消します。capability を使用せず、capability の返金も開始しません。

## Fill と決済グループ

マッチした数量ごとに 1 件の fill が作成されます。`fillId` はその実際の fill を識別します。

エンジンは 1 件以上の fill を 1 件のアトミック決済グループにまとめることができます。`groupId` は決済グループを識別します。ミントはグループに対して 1 件の複数当事者 conversion を受け取ります。現在のプロダクトは complementary conversion と mint conversion をサポートします。このリリースでは merge conversion を提供しません。

ミントが確定すると、正確な result entry を返します。クライアントは送信した operation と確定した result を保持します。クラッシュ後もこの正確な記録を回復できます。結果が不確実な場合、クライアントは永続的なエンジンとミントの authority で照合します。

## Participation Score

Participation Score は公開注文の受付を保護します。versioned projector は、確定した source facts から durable acceptance 時の charge を導出します。fill ごとには課金せず、決済失敗のペナルティも適用しません。内部 engine bot の注文には Score を課金しません。

## 信頼境界

エンジンは、注文を認可する正確な `PAY_TO_UNLOCK` proof を受け取ります。その secret と公開された blinded-output manifest を確認します。ウォレット seed、output blinding factor、refund key、および他の wallet proof は取得しません。

エンジンは、有効期限前に認可された selection だけを使用できます。manifest の外に値を移動できません。有効期限を延長できません。決済を保留した場合、認可された proof は refund が有効になるまで使用できません。

ミントは conversion を実行します。ウォレットは proof の材料を制御します。`PAY_TO_UNLOCK` capability は NUT の規則に従い、期限後に返金できます。

## オンチェーン CTF 取引所との比較

complementary、mint、merge という名前はオンチェーン CTF システムにもあります。実装は異なります。bitCaster は現在、complementary conversion と mint conversion だけを提供します。1 件のアトミック決済グループに対して 1 件のミント conversion を使用します。peer-to-peer 決済交換やオンチェーン operator transaction は使用しません。
