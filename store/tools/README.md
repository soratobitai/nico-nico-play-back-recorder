# ストア用スクリーンショットの撮り方

puppeteer-core と、インストール済みの Chrome（`C:/Program Files/Google/Chrome/Application/chrome.exe`）で撮ります（画面は出しません）。
puppeteer-core が入ったフォルダにこのフォルダのスクリプトを置いて実行してください（このリポジトリの依存には入れていません）。
拡張機能のフォルダ（`EXT`）と書き出し先（`OUT`）は、環境変数で渡します。

1. `npm run build` で `.output/chrome-mv3` を作る
2. 番組を探す: `node list-ranking.mjs`（ランキング・「定点」・「ライブカメラ」の放送中の番組）、`node find-onair.mjs 定点カメラ ライブカメラ …`（キーワードで探し、本当に放送中（ON_AIR）の番組だけ出す。検索に出ても、終わった番組（タイムシフト）では録画が始まらない）、`node survey.mjs lv... lv...`（映像を `cand/` に撮って見比べる）
   - 1画面の映像で、人物・ゲーム画面・個人のペットなどが写らない番組（明るい時間の定点カメラなど）を選ぶ
   - コメントが少ない番組では、「コメントあり」の1枚（4-comments）に流れるコメントが写らない。その時は、手順4の前に `EXT=<リポジトリ>/.output/chrome-mv3 MAIN=https://live.nicovideo.jp/watch/lv... node shots-comments.mjs` で、コメントの canvas に見本のコメントを流して録画した素材（`shots/raw-library-comments.png`）に撮り直し、`SAMPLE_COMMENTS=1 OUT=<リポジトリ>/store/screenshots/ node shots-compose.mjs` で「※ 画面のコメントは見本です（イメージ）」と入れる
3. 素材を撮る: `EXT=<リポジトリ>/.output/chrome-mv3 MAIN=https://live.nicovideo.jp/watch/lv... node shots-all.mjs`（録画してから、視聴ページ・プレイバック・設定・録画一覧を `shots/` に撮る。`OTHERS=` に番組の URL をカンマ区切りで渡すと、一緒に録画して録画一覧に並べる）
   - プレイバックのウィンドウは、プレイバックの画面がある about:blank を探し、setViewport してから撮る（起動時の空のタブを撮ると真っ白になる）
   - 広告・お知らせの吹き出し・配信者のお知らせの帯（`___announcement-renderer___`）は `hidePopups` で隠す
4. 見出しを付ける: `OUT=<リポジトリ>/store/screenshots/ node shots-compose.mjs`（1280×800 で書き出す。視聴ページの切り抜く位置は `shots/regions.json` の録画バーの位置から決める）
