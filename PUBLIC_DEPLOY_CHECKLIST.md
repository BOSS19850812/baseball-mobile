# 公開前チェックリスト

Renderへ公開する前に確認することをまとめています。

## ファイル

- `server.js` がある
- `package.json` がある
- `render.yaml` がある
- `public/index.html` がある
- `public/service-worker.js` がある
- `.env.example` がある

## GitHubへ上げないもの

- `.env`
- `data/`
- `node_modules/`

## Renderに入れる環境変数

- `APP_BASE_URL`
- `OPENAI_API_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_PRICE_ID`
- `STRIPE_WEBHOOK_SECRET`

## Renderの確認URL

`/api/health` が200を返せばOKです。

## Stripe Webhook URL

`https://Renderで発行されたURL/api/stripe/webhook`

## 最後に確認すること

- トップ画面が開く
- ログインできる
- 有料プランへボタンが動く
- 決済後に有料表示になる
- 契約管理ボタンが動く
- 実況音声が鳴る
