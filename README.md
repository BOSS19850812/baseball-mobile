# 野球速報 LIVE

スマホで使う野球速報アプリです。  
スコア入力、速報履歴、選手入力、成績管理、実況音声、課金機能の土台が入っています。

## ローカルで動かす方法

PowerShellで以下を実行します。

```powershell
cd C:\baseball-site
npm start
```

開くURL:

```text
http://127.0.0.1:8766/
```

## 公開に必要なもの

- GitHubアカウント
- Renderアカウント
- Stripeアカウント
- OpenAI APIキー

## 大事な注意

`.env` と `data/` は公開しません。  
APIキーやユーザー情報が入るため、GitHubへ上げないでください。
