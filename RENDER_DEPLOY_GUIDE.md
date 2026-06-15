# Renderで公開する手順

この手順は、野球速報アプリをRenderで公開するためのものです。

## 1. GitHubへアップロードする

`C:\baseball-site` の中身をGitHubへアップロードします。

ただし、次のものはアップロードしません。

- `.env`
- `data/`
- `node_modules/`

これらは `.gitignore` で除外済みです。

## 2. Renderでサービスを作る

Renderを開いて、次の順で進めます。

1. Dashboardを開く
2. Newを押す
3. Blueprintを選ぶ
4. GitHubのリポジトリを選ぶ
5. `render.yaml` が読み込まれるのを確認する
6. 作成する

## 3. Renderに環境変数を入れる

RenderのEnvironment画面で、以下を入力します。

```env
APP_BASE_URL=https://Renderで発行されたURL
OPENAI_API_KEY=OpenAIのAPIキー
STRIPE_SECRET_KEY=Stripeのシークレットキー
STRIPE_PRICE_ID=Stripeの価格ID
STRIPE_WEBHOOK_SECRET=StripeのWebhook署名シークレット
```

`.env` ファイルをRenderへアップロードするのではなく、Renderの画面に1つずつ入力します。

## 4. StripeのWebhookを設定する

Stripeの管理画面でWebhookを追加します。

Webhook URL:

```text
https://Renderで発行されたURL/api/stripe/webhook
```

追加するイベント:

- `checkout.session.completed`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_succeeded`
- `invoice.payment_failed`

Webhook作成後に表示される `whsec_...` を、Renderの `STRIPE_WEBHOOK_SECRET` に入れます。

## 5. 公開後に確認する

次のURLを開きます。

```text
https://Renderで発行されたURL/api/health
```

次のように表示されれば、サーバーは動いています。

```json
{"ok":true}
```

## 6. アプリを開く

`https://Renderで発行されたURL/` を開きます。

画面が出たら公開完了です。
