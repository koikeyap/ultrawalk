# ultrawalk

長距離ウォーキングのルートを、歩く前にストリートビューで「歩いて」下見するためのWebアプリ集です。
ブラウザだけで動き、スマホ（縦画面）でも使えます。

公開ページ: https://koikeyap.github.io/ultrawalk/

| アプリ | ファイル | 概要 |
|---|---|---|
| ルート下見ウォーカー | [`route-preview-walker.html`](route-preview-walker.html) | ルートに沿ってストリートビューをコマ送り再生する |
| 寄り道ウォーカー | [`yorimichi-walker.html`](yorimichi-walker.html) | 上記に、経路沿いのスポット表示と道案内（字幕・読み上げ・AI）を追加 |
| 中継 Worker | [`shortlink-expander-worker.js`](shortlink-expander-worker.js) | Cloudflare Workers 用。短縮リンク展開・経路計算・スポット検索の中継、合言葉によるキー受け渡し、AI案内 |

---

## 主な機能

### 共通（両アプリ）

- **ルートの読み込み**：GPX / KML / KMZ ファイル、または Google マップの経路リンク（短縮リンク・共有文ごと貼り付け可）
- **ストリートビュー再生**：歩幅 20 / 50 / 100 / 200 / 300 m、表示間隔を選んで自動再生。視線は常に進行方向
- **先読み**：ビューアを4つ重ね、次の3地点の画像を裏で読み込むことで、切り替え時の暗転を抑える
- **向きの判定**：画像地点の道の向きと進行方向が 35° 以上ずれる画像（交差する道など）を「隠す / 薄く表示 / 表示」から選択
- **表示できない地点は飛ばす**：画像なし・非表示の地点を再生や ◀▶ で自動スキップ（初期値オン）
- **標高グラフ**：累積の登り下り・勾配を表示。グラフをドラッグして位置を移動
- **レイアウト**：縦画面は「上：メイン / 左下：操作 / 右下：サブ」、横画面は「左：メイン / 右：サブ＋操作」。メインはストリートビューと地図を切り替え可
- **GPXで保存**：読み込んだルートをGPXとして書き出し（Zepp などへの転送用）

### 寄り道ウォーカーのみ

- **経路沿いのスポット**：経路から 200 m 以内のトイレ・コンビニ・水飲み場・見どころ（展望地・名所・博物館・史跡）・カフェ・寺社を地図に表示。種類ごとにオン/オフ
- **この先のスポット**：3 km 以内の直近4件を「距離・左右・道からの距離」付きで一覧表示
- **道案内**：スポット・曲がり角・坂・地名の変化・5 km ごとの距離と所要時間（時速 5 km 換算）を、再生中に字幕と音声で案内
  - 定型文モード：API不要
  - AIモード：Claude Haiku が案内文を作成（合言葉が必要）
- **見どころの説明**：OSM に Wikipedia のリンクがある場所は、要約の最初の1文を案内に含める
- **トイレ間隔**：「次のトイレまで約 ○ km」を案内

---

## 構成

```
ブラウザ（GitHub Pages）
 ├─ Leaflet + OpenStreetMap タイル ……… 地図
 ├─ Google Maps JavaScript API ………… ストリートビュー表示
 ├─ BRouter / OSRM（FOSSGIS） ………… 経路計算（直接 or 中継）
 ├─ Overpass API ……………………… スポット検索（直接 or 中継）
 ├─ Nominatim …………………………… 地名の逆引き
 ├─ Wikipedia REST API ……………… 見どころの要約
 └─ Cloudflare Worker（中継）
      ├─ GET  /?u=<短縮リンク>        短縮リンクの展開
      ├─ GET  /route?engine=&coords=   経路計算の中継（brouter | osrm）
      ├─ POST /overpass               Overpass API の中継
      ├─ POST /key   {code}           合言葉 → Google Maps APIキー
      └─ POST /guide {code,context,events}  AI案内（Claude Haiku）
```

---

## セットアップ

### 1. GitHub Pages

1. このリポジトリの「Settings」→「Pages」で、Source を「Deploy from a branch」、Branch を `main` / `/ (root)` にする
2. `https://<ユーザー名>.github.io/<リポジトリ名>/<ファイル名>.html` で開ける

### 2. Google Maps APIキー（ストリートビューを使う場合）

1. Google Cloud でプロジェクトを作り、請求先アカウントを登録
2. 「Maps JavaScript API」を有効化し、APIキーを作成
3. キーの制限を設定
   - アプリケーションの制限：ウェブサイト `https://<ユーザー名>.github.io/*`
   - APIの制限：Maps JavaScript API のみ
4. 「割り当て」で Dynamic Street View の1日の上限を低めに設定（漏洩時の被害を限定）

> APIキーはリポジトリにコミットしないこと。アプリ画面から入力するか、Worker の合言葉機能で受け取る。

### 3. 中継 Worker（任意だが推奨）

短縮リンク・合言葉・AI案内を使う場合と、ブラウザから外部サービスに直接つながらない場合に必要です。

1. Cloudflare の「Workers & Pages」で Worker を作成し、`shortlink-expander-worker.js` の内容を貼り付け
2. 冒頭の `ALLOWED_ORIGIN` を自分の GitHub Pages のドメインに変更（例：`https://koikeyap.github.io`。末尾の `/` やパスは付けない）
3. 「設定」→「変数とシークレット」に**シークレット**として登録

   | 名前 | 内容 | 必須 |
   |---|---|---|
   | `MAPS_API_KEY` | Google Maps APIキー | 合言葉を使う場合 |
   | `ACCESS_CODES` | `名前:合言葉` のカンマ区切り（例：`self:xxxx,friends:yyyy`） | 合言葉を使う場合 |
   | `ANTHROPIC_API_KEY` | Claude API のキー | AI案内を使う場合 |

4. デプロイ後、HTML 冒頭の `CFG.defaultProxy` に Worker のURLを書くと、利用者の入力が不要になる

**合言葉の運用**
- `ACCESS_CODES` のどれか1つと一致すれば使える。名前はメモ用で、動作には影響しない
- 合言葉は8文字以上。`,` は使えない。名前を省略する場合は `:` も使わない
- 合言葉を無効にするには `ACCESS_CODES` から消して保存するだけ
- ただし、APIキーは最終的にブラウザに届くため、受け取った人は技術的にキーを見られる。不正が疑われる場合は Google Cloud でキーを作り直し、`MAPS_API_KEY` を差し替える

---

## 使い方

1. アプリを開き、「ルート・キー」画面でルート（ファイル or Google マップのリンク）と、APIキーまたは合言葉を入れて「開始」
2. 「再生」で進む。◀▶ やキーボード（スペース / ← →）でも操作可能
3. 標高グラフのドラッグ、地図のクリック、スポット一覧のタップで好きな地点へ移動

### Google マップのリンクについて

- 対応形式：`/maps/dir/…`（ブラウザ版）、`/maps?saddr=…&daddr=…&geocode=…`（アプリの共有リンクの展開先）、`/maps/dir/?api=1&…`
- リンクから**地点の座標だけ**を取り出し、OpenStreetMap ベースの経路エンジンで徒歩ルートを引き直す。Google の経路そのものは使わない（利用規約上、Google 以外の地図への表示や保存が不可のため）
- Google の経路と近づけたい場合は、使いたい道の上に経由地を多めに置く
- 短縮リンク（`maps.app.goo.gl`）は中継 Worker が必要

### 経路エンジン

| | BRouter | OSRM（FOSSGIS 徒歩） |
|---|---|---|
| 標高 | あり | なし |
| カスタマイズ | プロファイルで調整可能 | 固定 |
| 速度 | やや遅い | 速い |

既定は BRouter（`hiking-mountain` プロファイル）。失敗したら OSRM を自動で試す。

---

## 設定値（HTML 冒頭の `CFG`）

| キー | 既定値 | 内容 |
|---|---|---|
| `stepM` | 50 | 1歩の距離（m） |
| `intervalMs` | 1200 | 再生時の1歩あたりの表示間隔（ms） |
| `radiusM` | 30 | 各地点からストリートビューを探す半径（m） |
| `buffers` | 4 | 画像を読み込んでおくビューアの数（現在＋先読み） |
| `prefetchMeta` | 12 | 画像の有無・向きを先に調べる歩数 |
| `alignTolDeg` | 35 | 進行方向と道の向きの許容差（°） |
| `mismatchMode` | `"hide"` | 向きが合わない画像：`hide` / `dim` / `show` |
| `skip` | true | 表示できない地点を飛ばす |
| `defaultProxy` | Worker のURL | 中継用URLの初期値 |
| `poiRadiusM` | 200 | スポットを取る範囲（経路からの距離、m）※寄り道のみ |
| `poiChunkM` | 2500 | スポット検索1回あたりの経路の長さ（m）※寄り道のみ |
| `guideLeadM` | 150 | スポットの何m手前で案内するか ※寄り道のみ |
| `paceKmh` | 5 | 所要時間の目安に使う歩く速さ ※寄り道のみ |
| `aiWindowM` | 1500 | AI案内をまとめて作る区間の長さ（m）※寄り道のみ |

---

## 費用の目安

| サービス | 課金単位 | 目安 |
|---|---|---|
| Google Dynamic Street View | ビューアの生成ごと（ページを開くたびに `buffers` 回） | 月5,000回まで無料枠あり（要確認）。超過分は1,000回あたり14ドル |
| StreetViewService（画像の有無の検索） | — | 課金対象外 |
| Claude Haiku 4.5（AI案内） | 入力100万トークンあたり1ドル、出力100万トークンあたり5ドル | 125 km のルートで数十セント程度（見積もり） |
| Cloudflare Workers | リクエスト数 | 無料枠内で十分 |
| OSM 系サービス（BRouter / OSRM / Overpass / Nominatim） | — | 無料。公開サーバーなので大量アクセスは避ける |

料金は変わることがあるため、各サービスの公式ページで確認してください。

---

## データとライセンス表記

- 地図・経路・スポット・地名：© [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)（ODbL）
- 見どころの要約：[Wikipedia](https://ja.wikipedia.org/)（CC BY-SA）
- ストリートビュー：Google（[Google Maps Platform 利用規約](https://cloud.google.com/maps-platform/terms)に従う。画像の保存・動画化はしない）
- 書き出した GPX のうち、Google マップのリンクから作ったルートは OSM 由来のデータ（ODbL）

---

## 既知の制約

- 日本の OSM は歩道（`sidewalk`）のタグ登録が少なく、歩道の有無は最終的にストリートビューでの確認が必要
- 「向きの判定」は、並行する別の道の画像を見分けられない
- Google マップのURLの内部形式は非公開仕様のため、将来読めなくなる可能性がある
- 公開サーバー（Overpass など）の混雑時は、スポット取得が一部失敗することがある
- iPhone の読み上げは、最初に再生ボタンを押した後から有効になる
- チャットアプリ内のプレビューなど、外部通信が制限された環境では動かない

---

## セキュリティ

- リポジトリには秘密情報（APIキー・合言葉）を置かない。すべて Cloudflare のシークレットで管理する
- 誤ってキーをコミットした場合は、履歴に残るため削除では不十分。キーを作り直す
- 出発地が自宅になっている GPX など、個人の行動が分かるファイルはコミットしない
- Worker は中継先を固定しており、任意のURLを中継する踏み台にはならない
