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

公開サーバーは FAK と FOK を受け付けます。GUI には FAK を表示します。CLI は FAK と FOK に対応します。各公開試行は 1 件の one-shot capability を使用します。一部約定では、確定した fill を決済し、残りを取り消します。約定がない FAK も取り消します。FOK は admission snapshot に基づき、要求数量全体を確定するか、注文全体を取り消します。公開 GTC、GTD、継続、および残余注文の再認可は利用できません。内部の custody-backed LMSR quote は GTC を使用します。これは公開クライアントの注文ではありません。

## 注文の認可

ウォレットは公開 FAK または FOK 注文を送信するときに 1 件の `PAY_TO_UNLOCK` capability を提供します。エンジンは注文受付で capability を検証します。受付中にミントへのネットワーク呼び出しは行いません。

capability はその 1 回の試行で認可された range を対象にします。公開継続は利用できません。取消は板に残る注文だけを取り消します。capability を使用せず、capability の返金も開始しません。

## Fill と決済グループ

マッチした数量ごとに 1 件の fill が作成されます。`fillId` はその実際の fill を識別します。

エンジンは 1 件以上の fill を 1 件のアトミック決済グループにまとめることができます。`groupId` は決済グループを識別します。ミントはグループに対して 1 件の複数当事者 conversion を受け取ります。現在のプロダクトは complementary conversion と mint conversion をサポートします。このリリースでは merge conversion を提供しません。

ミントが確定すると、正確な result entry を返します。クライアントは送信した operation と確定した result を保持します。クラッシュ後もこの正確な記録を回復できます。認識済みの FAK または FOK operation は operation facts と result を保存します。これらの記録はサーバーの再起動後も残ります。同じ client order ID を意図的に同じ operation facts で再利用すると、保存済みの result を返します。facts が変わると conflict を返します。結果が不確実な場合、クライアントは永続的なエンジンとミントの authority で照合します。

## Participation Score

Participation Score は公開注文の受付を保護します。成功した公開 one-shot capability binding は、`settlement-capability-v1` の下で 1 回だけ課金します。料金は `1 + InputCount + ceil(ManifestCount/16) + ceil(ArtifactByteCount/4096)` です。認証済みの invalid proof または DLEQ validation attempt は同じ料金を使用します。order、fill、settlement failure ごとの別料金はありません。source facts は検証済みの work facts と rule ID を持ちますが、計算済みの debit は持ちません。fill、取消、settlement failure、refund、recovery は Score を debit しません。内部の custody-backed LMSR quote はこの公開料金の対象外です。

## 信頼境界

エンジンは、注文を認可する正確な `PAY_TO_UNLOCK` proof を受け取ります。その secret と公開された blinded-output manifest を確認します。ウォレット seed、output blinding factor、refund key、および他の wallet proof は取得しません。

エンジンは、有効期限前に認可された selection だけを使用できます。manifest の外に値を移動できません。有効期限を延長できません。決済を保留した場合、認可された proof は refund が有効になるまで使用できません。

ミントは conversion を実行します。ウォレットは proof の材料を制御します。`PAY_TO_UNLOCK` capability は NUT の規則に従い、期限後に返金できます。

## オンチェーン CTF 取引所との比較

complementary、mint、merge という名前はオンチェーン CTF システムにもあります。実装は異なります。bitCaster は現在、complementary conversion と mint conversion だけを提供します。1 件のアトミック決済グループに対して 1 件のミント conversion を使用します。peer-to-peer 決済交換やオンチェーン operator transaction は使用しません。
