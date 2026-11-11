# 6桁番号による進行保存 — Cloudflare公開手順

## 対象と現在の公開構成

- 公式サイト: https://team-kusunoki.com/、アプリ: https://team-kusunoki.com/11月の救祭/app/
- GitHub: `codedev0625-source/kusunoki-official-site`、本番ブランチ: `main`
- Cloudflare Pagesプロジェクト: `kusunoki-official-site`
- CloudflareアカウントID: `6b64f3b62a9ee43a3f703ce0f7d41ee9`
- 2026-10-29の監査時点のHEAD: `4bab8ab592465be43901ece7eb4261e8345a21d4`

既存リポジトリのREADMEでは、ビルドコマンドなし・リポジトリルートを配信し、`main`へのpushでPagesが公開する構成です。公開直前に実際のPages設定と最新HEADを再確認してください。既存サイト全体をこの作業フォルダの`dist`で置き換えないでください。

新しい機能はPages FunctionsとD1を追加します。外部のアカウント連携は使いません。`000000`はデバッグ専用で、進行の保存・API送信の対象外です。

## 認証の確認

2026-10-29の監査では、GitHub接続ツールによるリポジトリ読み取りは成功しました。ローカル`gh auth status`は無効なトークンを報告しました。Wrangler 4.129.1の`whoami`は、ネットワーク制約のある実行では更新失敗となりましたが、制約外での読み取り確認では既存OAuthの更新に成功しました。

ただし、そのOAuthでアクセスできたアカウントは`0925fbadbd4d6f1d276d76dfb1b3e540`で、Pages一覧に今回の`kusunoki-official-site`はありませんでした。公開記録にあるアカウント`6b64f3b62a9ee43a3f703ce0f7d41ee9`を明示した読み取りは、認証エラー`10000`でした。別用途のアカウントへDBを誤作成しないでください。

その後、既にログイン済みのChromeで対象アカウント・プロジェクト・ドメインを確認し、以下の準備を完了しました。CLI認証の権限追加や別アカウントへの再ログインは行っていません。

| 環境 | D1名 | D1 ID | Pagesバインディング |
| --- | --- | --- | --- |
| Production | `kyusai-play-saves` | `042a4931-13dd-447d-b126-54bac2a5db72` | `PLAY_SAVES` |
| Preview | `kyusai-play-saves-preview` | `c79ac1f0-6f15-4958-b54b-968cac4a28bb` | `PLAY_SAVES` |

両DBで`migrations/0001_play_saves.sql`と同じスキーマを適用し、`sqlite_master`の読み取りで`play_saves`、`play_save_rate_limits`、`play_save_rate_expiry`を確認しました。PagesのProduction・Previewそれぞれに、独立した乱数を`PLAY_SAVE_SECRET`というSecretとして登録し、非表示状態の登録結果を確認しました。秘密値はファイルやログへ保存していません。この準備時点では公開を実施しておらず、新しい設定は次回デプロイから有効です。

作業者が管理する環境で`wrangler whoami`により対象アカウントへの接続を確認してください。未接続ならCloudflareへのログインを完了させるか、必要なPages・D1権限を持つAPIトークンを実行環境から安全に渡してください。認証情報をリポジトリ・設定例・公開パッケージへ含めたり、ログへ出力したりしないでください。

## D1と秘密値の設定

1. 本番用D1とプレビュー用D1を別々に作成します。今回の対象では上表のDBを作成済みなので、重複作成せず再利用します。
2. 作成したDBのIDを非公開の作業用Wrangler設定に記入し、適切なDBにこのソースの`migrations/`を適用します。プレビューと本番の対象DBを毎回確認します。
3. PagesプロジェクトのSettings → Bindingsで、D1のバインディング名を`PLAY_SAVES`にします。Productionには本番用、Previewにはプレビュー用を指定します。
4. Settings → Variables and Secretsで`PLAY_SAVE_SECRET`を暗号化された秘密値として設定します。本番とプレビューで別の十分に長い乱数を使います。
5. バインディング・秘密値の変更後は再デプロイし、反映を確認します。

CLIを使う場合の代表的な操作は以下です。実際のWrangler設定の名前・DB名・環境に合わせて指定してください。

```sh
wrangler d1 create kyusai-play-saves-preview
wrangler d1 create kyusai-play-saves
wrangler d1 migrations apply kyusai-play-saves-preview --remote --config /absolute/private-preview-config.jsonc
wrangler d1 migrations apply kyusai-play-saves --remote --config /absolute/private-production-config.jsonc
wrangler pages secret put PLAY_SAVE_SECRET --project-name kusunoki-official-site
```

秘密値はコマンド引数に書かず、対話入力または標準入力から渡します。プレビュー環境の秘密値はCloudflareダッシュボードで環境を明示して設定できます。`PLAY_SAVE_SECRET`は保存番号の照合に使うため、通常の再公開ごとに作り直してはいけません。変更すると既存番号での照合ができなくなる可能性があります。

Pagesの既存設定をWranglerへ移す場合は、先にダッシュボード設定を取得・比較し、設定ファイルを唯一の設定元にするか決めてください。新しい空のWrangler設定で既存プロジェクトの設定を上書きしないでください。

## 公開パッケージの作成

プロジェクトルートで実行します。出力先はプロジェクト内`.build/`以下の、まだ存在しない絶対パスを指定します。

```sh
node webapp/scripts/package-play-save.mjs /absolute/project/.build/play-saves-backend --backend-only
node webapp/scripts/package-play-save.mjs /absolute/project/.build/play-saves-release
```

各出力ディレクトリに、公開先へ重ねる`site/`と、配信ファイル・元ソースのSHA-256を記録した`manifest.json`ができます。出力先の使い回しは拒否します。パッケージ作成中にソースが変わった場合も失敗します。

通常パッケージはHTMLからJavaScriptの相対importを再帰的にたどり、CSSの画像・シナリオの資料画像も収集します。`play-save.js`など新しいimport先も取り込み、アプリ資材を`11月の救祭/app/assets/release-save-ハッシュ/`に配置します。元の相対関係を維持するため、同名ファイルを誤って平坦化しません。HTMLとシナリオの資料URLを公開先に合わせて変換します。

APIと補助ソースは次のように配置します。

```text
site/
  _routes.json                     /api/play-savesだけでFunctionsを起動
  functions/api/play-saves.js       API入口
  functions/_lib/server/            サーバー補助モジュール
  _redirects                       旧/app入口から新URLへの301転送（通常パッケージのみ）
  11月の救祭/app/index.html          通常パッケージのみ
  11月の救祭/app/assets/release-save-.../  通常パッケージのみ
```

`webapp/server/`の補助モジュールを`functions/`配下へ移し、importを書き換えます。静的配信ルートへサーバーソースを置きません。マイグレーション、Wrangler設定、秘密値、テスト、プロンプト用メタデータ、`manifest.json`は`site/`へ入れません。

既存の公式サイトリポジトリに`site/`の変更を重ね、アプリ以外の既存ファイルを保持してください。公開先に既存の`functions/`や`_routes.json`が追加されていた場合は、衝突を調べて統合し、自動的に全置換しないでください。

## 公開順序と確認

1. 既存の自動テスト、保存APIのテスト、同期制御のテストを通します。
2. 作成済みパッケージのFunctionsを`wrangler pages functions build`でコンパイルし、import解決とランタイム互換性を確認します。
3. D1のスキーマ・バインディング・秘密値をプレビュー環境へ設定します。プレビュー公開は本番D1に接続しないことを確認します。
4. APIから先に公開します。`--backend-only`のパッケージはアプリHTMLを変更しないため、既存アプリのまま新APIを確認できます。
5. プレビュー用の専用テスト記録で、番号発行、先頭0の保持、読み取り、更新番号による競合検出、不正形式、無効番号、回数制限、`000000`の拒否を確認します。
6. 通常パッケージでクライアントを反映します。別ブラウザで番号を入力して同じ進行が開くこと、通信断と再送、会話途中・宵終了画面・Q8の復元、既存ローカル記録の移行を確認します。
7. 本番D1とProductionの設定を確認し、APIを先に、次にクライアントを公開します。本番用の専用テスト記録で発行・保存・復元を確認します。テストデータ削除は対象を確かめて行います。
8. `000000`でのプレイ中に進行のブラウザ書き込み・保存API通信が発生しないこと、元の本番記録が変わらないことを確認します。
9. Cloudflareのデプロイ成功に加え、公開URLのファイルハッシュとAPIの実動作を記録します。デプロイ成功だけで進行保存の確認済みとは扱いません。

## 切り戻し

画面側の不具合では、以前の`app/index.html`へ戻すか、以前のPagesデプロイへ戻します。D1の記録は削除しません。旧クライアントと新クライアントのブラウザ保存キーが異なる場合も、旧記録を残して切り戻せるようにします。

DBの変更は追加型マイグレーションを基本にします。公開後に保存データが作られたDBへ、初期化・テーブル削除を使う切り戻しを実行しないでください。秘密値の変更も通常の切り戻し手順には含めません。

## 公式資料

- [Pages Functionsのルーティング](https://developers.cloudflare.com/pages/functions/routing/)
- [Pages FunctionsとD1の接続](https://developers.cloudflare.com/pages/functions/bindings/)
- [PagesのWrangler設定](https://developers.cloudflare.com/pages/functions/wrangler-configuration/)
- [Wrangler Pagesコマンドと秘密値](https://developers.cloudflare.com/workers/wrangler/commands/pages/)

## 2026-10-29 本番反映結果

ユーザーの承認後、本番コミット`d3fe99ba116508403d50a52cde035aa1c362e0dd`を公開しました。APIを先に反映し、本番で11項目のHTTP検証に成功してからアプリを反映しました。Cloudflare Pagesチェックはsuccess、静的28ファイルは完成パッケージとSHA-256が一致しています。PR #1はmergedです。詳細と検証範囲は`VERIFICATION.md`の先頭に記録しています。

## 2026-11-02 URL変更

アプリの公開先を `/11月の救祭/app/` に変更。旧 `/app`・`/app/`・`/app/index`・`/app/index.html` のみ新URLへ301転送し、旧 `/app/assets/` は開いているタブ向けに保持します。作品ページの開始リンクと公開パッケージ作成先も新URLに統一します。保存APIはルートの `/api/play-saves` を維持します。既存の `_redirects` がある場合は今回の4行と統合し、他の転送設定を保持してください。
