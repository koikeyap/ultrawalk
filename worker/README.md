# 中継Worker（worker.js）

ウォークアプリ（ルート下見ウォーカー / 寄り道ウォーカー / 次どこウォーカー）から使う、Cloudflare Worker です。ブラウザから直接つなげない相手への中継だけを行います。

- APIキーが必要で、キーをブラウザに置きたくないもの（Google Maps、Claude、TypeSafe Jev）
- ブラウザから直接つなぐとCORSで止められたり、混雑ではじかれたりするもの（Overpass、BRouter、OSRM）
- リダイレクトをたどる必要があるもの（Googleの短縮リンク）

外部AIへの問い合わせ文は、すべてこのコードの中で固定しています。呼び出し側は材料（スポットの一覧、候補の一覧）だけを送り、質問そのものは送れません。任意の内容をAIに素通しする窓口にはなっていません。

公開先: `https://shortlink.taiji007ai.workers.dev/`

## 置き場所

このファイルはCloudflareで動くサーバー側のコードで、ブラウザが読むHTMLとは役割が違うため、`worker/` フォルダに分けています。GitHubにはコードだけを置き、キーや合言葉は置きません（下記のシークレットで持たせます）。

ただしGitHub Pagesはリポジトリ内のファイルをそのまま配信するため、このファイルもURLを知れば誰でも読めます。入口の名前や合言葉の条件は分かりますが、キーと合言葉そのものは含まれていないので、そのままで問題ありません。

## 設定

### 1. シークレット

Cloudflareの「設定 → 変数とシークレット」に、**シークレット**として登録します。使わない機能のものは未登録で構いません。その入口だけが `... not configured` を返して止まります。

| 名前 | 中身 | 使う入口 |
| --- | --- | --- |
| `ACCESS_CODES` | `名前:合言葉` をカンマ区切り。例 `self:長いランダム文字列,friends:別の長いランダム文字列` | `/key` `/guide` `/jev` |
| `MAPS_API_KEY` | Google Maps のAPIキー | `/key` |
| `ANTHROPIC_API_KEY` | Claude APIのキー | `/guide` |
| `TYPESAFE_API_KEY` | TypeSafe Jev APIのキー | `/jev` |

合言葉は人ごと・グループごとに分けておくと、漏れたときにその1つだけを消して無効化できます。8文字以上が必要です。合言葉そのものは、このREADMEにもコードにも書かないでください。

### 2. 呼び出し元の制限

コード先頭の `ALLOWED_ORIGIN` を、自分のGitHub Pagesのドメインにします。

```js
const ALLOWED_ORIGIN = "https://koikeyap.github.io";
```

POSTの入口は、ここからの呼び出し以外を `403 forbidden` で断ります。**アプリが動かないときは、まずここを疑ってください。** ドメインが1文字でも違うと、すべてのPOSTが失敗します。末尾にスラッシュは付けません。

## 入口の一覧

| メソッド | パス | 用途 | 合言葉 | 使うアプリ |
| --- | --- | --- | --- | --- |
| GET | `/?u=<短縮URL>` | Googleの短縮リンクを展開 | 不要 | ルート下見 |
| GET | `/route?engine=...&coords=...` | 経路計算の中継 | 不要 | 全部 |
| POST | `/key` | 合言葉 → Google Maps APIキー | 必要 | ルート下見、寄り道 |
| POST | `/guide` | AI道案内の文を作る（Claude Haiku） | 必要 | 寄り道 |
| POST | `/overpass` | スポット検索の中継 | 不要 | 寄り道、次どこ |
| POST | `/jev` | 行き先・道順の順位づけ（TypeSafe Jev） | 必要 | 次どこ |

### GET `/?u=<短縮URL>`

`https://maps.app.goo.gl/...` と `https://goo.gl/...` だけを受け付け、最大5回までリダイレクトをたどって、たどり着いたURLを返します。goo.glの外に出た時点で止めます。

```
→ {"url":"https://www.google.com/maps?..."}
```

### GET `/route`

| パラメータ | 値 |
| --- | --- |
| `engine` | `brouter` または `osrm`（必須） |
| `coords` | `経度,緯度;経度,緯度;...`（2〜50地点） |
| `profile` | BRouterのみ。`hiking-mountain`（既定） / `shortest` / `trekking` |
| `alt` | BRouterのみ。`0`〜`3`（既定 `0`）。代替案の番号 |

行き先はBRouterとOSRMに固定で、任意のURLには中継しません。応答はそのまま返します。

### POST `/key`

```json
{"code":"合言葉"}  →  {"key":"AIza..."}
```

### POST `/guide`

```json
{"code":"合言葉", "context":{...}, "events":[{"id":"e1", "name":"...", "side":"右", ...}]}
→ {"items":[{"id":"e1","text":"右手に……"}], "usage":{...}}
```

スポットは1回12件まで、案内文は1件120文字までです。渡したスポットに対応する案内文だけを返し、モデルが増やした分は捨てます。

### POST `/overpass`

Overpassのクエリを本文（`data=...`）のまま送ると、`https://overpass-api.de/api/interpreter` に中継して応答をそのまま返します。

### POST `/jev`

```json
{
  "code": "合言葉",
  "stage": "dest" または "route",
  "target_km": 5,
  "wish": "自由記入（200文字まで）",
  "prefs": ["green", "worship", ...],
  "candidates": [ ... ]
}
→ {"stage":"dest","model":"jev-...","choice":1,"confidence":0.5,
   "probabilities":{"0":0.3,"1":0.6,...},"usage":{...}}
```

`choice` と `probabilities` の番号は、送った `candidates` の並び順（0始まり）です。候補は2〜10件必要です。

`stage` によって、Jevに見せる項目と質問文が変わります。

- **`dest`（行き先を選ぶ）**：行き先の名前、種類、方向、おおよその距離、近くの場所、歩いた道との重なり。`prefs` は `green` / `worship` / `view` / `water` / `culture` / `station`。
- **`route`（道順を選ぶ）**：距離、登り、コンビニ・トイレ・水飲み場・カフェの数、補給なしの最長区間、沿道の見どころ、大通り・静かな道・未舗装の割合、歩いた道との重なり。`prefs` は `supply` / `quiet` / `flat` / `sights`。

`prefs` は決まった言葉だけを受け付け、知らない言葉は捨てます。数値は範囲外や欠損をすべて `null`（不明）に直してから渡します。Jevには「`null` はゼロではなく不明」と伝えてあります。

## エラーの読み方

| 応答 | 意味 |
| --- | --- |
| `403 forbidden` | `ALLOWED_ORIGIN` と呼び出し元が違う |
| `401 invalid code` | 合言葉が違う（総当たり対策で1秒待ってから返す） |
| `405 method not allowed` | GET/POSTの取り違え |
| `413 too large` | 本文が大きすぎる |
| `400 bad json` / `bad coords` / `unknown engine` / `unsupported url` / `need 2+ candidates` | 送った内容の誤り |
| `500 ... not configured` | シークレットが未登録 |
| `502 upstream` | 外部APIがエラーを返した（`status` と `detail` が付く） |
| `502 bad model output` | AIの応答を読み取れなかった |
| `404 not found` | 知らないパス |

## 手を入れるときの約束

- **AIへの問い合わせ文は、このコードの中に固定したままにする。** 呼び出し側から質問文や指示を受け取る作りにはしないでください。誰かに合言葉が渡ったとき、そのままAIを自由に使われてしまいます。
- **中継先は決め打ちのままにする。** `/route` や `/overpass` で、送られたURLにそのままつなぐ作りにしないでください。
- **受け取った値は、外部APIに渡す前に整える。** 数値は `num()`、文字列は `str()`、配列は `list()` を通します。
- 上限（本文の長さ、件数、文字数）は先頭の `LIMITS` にまとめてあります。変えるときはここだけを直します。
- キー・合言葉・個人の位置情報をコードやこのREADMEに書かない。ログにも残さない。

## 変更の記録

- 2026-09：`/jev` を追加（TypeSafe Jev。次どこウォーカー用）。段階を `dest` と `route` に分け、自由記入の希望を渡せるようにした。
- 2026-09：共通処理（CORS、合言葉の確認、値の整形）をまとめ、入口ごとに関数を分けるリファクタリング。動きは変えていない。
