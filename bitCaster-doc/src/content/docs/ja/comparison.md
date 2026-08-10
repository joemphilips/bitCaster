---
title: 類似プラットフォームとの比較
---

# 類似プラットフォームとの比較

## Predyx

[Predyx](https://beta.predyx.com/) はサーバー側カストディモデルと AMM を使用します。bitCaster は CLOB と Cashu bearer token を使用します。

bitCaster のウォレットは通常の proof inventory を制御します。注文では、ウォレットは正確な `PAY_TO_UNLOCK` capability だけをエンジンに渡します。エンジンはその値を別の場所に移動できません。有効期限を延長できません。他の wallet proof を使用できません。ミントは発行済み ecash の裏付け Bitcoin 準備金を保持するため、ユーザーは mint operator を信頼する必要があります。

## Polymarket

[Polymarket](https://polymarket.com) は Polygon で CTF 取引を決済します。bitCaster は sat 建て Cashu ecash と、各アトミック決済グループに対するミント conversion を使用します。

両方のシステムは complementary conversion と mint conversion の概念を使用します。Polymarket は merge conversion もサポートします。bitCaster はこのリリースで merge conversion を提供しません。bitCaster は 1 件以上の fill をグループ化し、1 件の複数当事者 mint conversion を送信します。ミントはグループを確定すると、正確な result entry を返します。

bitCaster は公開ブロックチェーントランザクション、gas token、bridge を必要としません。ecash モデルはトランザクションのプライバシーを改善しますが、オンチェーントランザクションの公開監査記録は提供しません。

## まとめ

bitCaster は Cashu bearer token、CLOB、ミント調整型 NUT-CTF range settlement を使用します。2 者間 peer swap は使用しません。現在のプロダクト資産は sat です。
