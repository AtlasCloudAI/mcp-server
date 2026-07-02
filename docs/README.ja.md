<p align="center">
  <img src="https://www.atlascloud.ai/logo.svg" alt="Atlas Cloud" width="80" />
</p>

<h1 align="center">Atlas Cloud MCP Server</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/atlascloud-mcp"><img src="https://img.shields.io/npm/v/atlascloud-mcp.svg?style=flat&colorA=18181B&colorB=28CF8D" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/atlascloud-mcp"><img src="https://img.shields.io/npm/dm/atlascloud-mcp.svg?style=flat&colorA=18181B&colorB=28CF8D" alt="npm downloads" /></a>
  <a href="https://github.com/AtlasCloudAI/mcp-server"><img src="https://img.shields.io/github/license/AtlasCloudAI/mcp-server?style=flat&colorA=18181B&colorB=28CF8D" alt="license" /></a>
  <a href="https://github.com/AtlasCloudAI/mcp-server"><img src="https://img.shields.io/github/stars/AtlasCloudAI/mcp-server?style=flat&colorA=18181B&colorB=28CF8D" alt="github stars" /></a>
  <a href="https://github.com/AtlasCloudAI/mcp-server/pulls"><img src="https://img.shields.io/badge/PRs-welcome-28CF8D.svg?style=flat&colorA=18181B&colorB=28CF8D" alt="PRs Welcome" /></a>
</p>

<p align="center">
  <a href="../README.md">English</a> | <a href="./README.zh-CN.md">中文</a> | 日本語 | <a href="./README.ko.md">한국어</a> | <a href="./README.es.md">Español</a> | <a href="./README.fr.md">Français</a>
</p>

<p align="center">
  <a href="https://www.atlascloud.ai?utm_source=github&utm_campaign=mcp-server">Atlas Cloud</a> の 300 以上の画像 / 動画 / LLM モデルを Claude Code、Codex、Gemini CLI、Cursor、Cline などで利用できます。標準的な MCP ツールを通じて、画像・動画の生成やチャットを実現します。
</p>

<p align="center">
  <a href="https://www.atlascloud.ai/console/api-keys?utm_source=github&utm_campaign=mcp-server"><b>→ 無料の Atlas Cloud API キーを取得</b></a> · 300 以上のモデル · OpenAI 互換
</p>

---

## サポートモデル

- 🎬 **動画** — Seedance 2.0 · Kling 3 · Sora 2 · Veo 3.1 · HappyHorse 1 · Grok Imagine 1.5 · Wan 2.7
- 🎨 **画像** — Nano Banana 2/Pro · GPT Image 2 · Flux 2 · Seedream 5
- 🧊 **3D** — Hunyuan 3D image-to-3D / text-to-3D
- 💬 **LLM** — Claude · GPT · DeepSeek · MiniMax · Kimi · GLM · Qwen
- 🔊 **音声 (TTS)** — Seed Audio · xAI/Grok TTS · ElevenLabs

- 📚 **さらに探す** — [300 以上のモデル »](https://www.atlascloud.ai/models?utm_source=github&utm_campaign=mcp-server)

## 目次

- [できること](#できること)
- [クイックスタート](#クイックスタート)
- [利用可能なツール](#利用可能なツール)
- [使用例](#使用例)
- [開発](#開発)
- [その他の Atlas Cloud ツール](#その他の-atlas-cloud-ツール)
- [ライセンス](#ライセンス)

## できること

AI アシスタントに自然な言葉で頼むだけで、適切なモデルを見つけ、パラメータを組み立て、ジョブを送信します。

- 🎨 **「このブログ記事のヒーロー画像を作って」** — Nano Banana Pro、GPT Image 2、Flux 2、Seedream、Imagen などによるテキストから画像の生成
- 🎬 **「この商品写真を 5 秒の広告に変えて」** — Kling 3、Seedance 2、Veo 3.1、Sora 2 などによる画像から動画の生成
- 🧊 **「この写真から 3D モデルを作って」** — Hunyuan 3D による画像から 3D / テキストから 3D の生成（GLB/OBJ/USDZ 出力）
- 🔊 **「この台本を読み上げて」** — Seed Audio、ElevenLabs、xAI TTS によるテキストから音声への変換
- 🎞️ **「この台本を 6 カットの絵コンテにして」** — 1 つの会話の中で LLM → 画像 → 動画を連鎖的に実行
- ✏️ **「この画像を編集して — 帽子を追加して」** — ローカルファイルをアップロードし、画像編集モデルを実行
- 💸 **「クレジットはあといくら残っていて、今月はいくら使った？」** — 残高、使用量、コストの内訳を確認
- 💬 **「この PDF を DeepSeek で要約して」** — Claude、GPT、DeepSeek、Qwen、GLM などによる OpenAI 互換の LLM チャット

その裏側では、モデル探索、モデルごとの動的なパラメータスキーマ（リクエストごとに事前検証され、無効なパラメータはクレジットを消費せずに即座に失敗します）、メディアアップロード、ワンステップのクイック生成、アカウント残高と使用量、ドキュメント検索が動作しており、これらはすべて標準的な MCP ツールとして提供されています（[利用可能なツール](#利用可能なツール)を参照）。

## クイックスタート

### 前提条件

- Node.js >= 18
- Atlas Cloud API Key — [atlascloud.ai で無料取得](https://www.atlascloud.ai/console/api-keys?utm_source=github&utm_campaign=mcp-server)

設定すべき環境変数については [`.env.example`](./.env.example) を参照してください。

### CLI エージェント（ワンラインインストール）

最速の方法です。これらの AI コーディングエージェントは、単一のコマンドでサーバーを追加できます。

```bash
# Claude Code
claude mcp add atlascloud -- npx -y atlascloud-mcp

# OpenAI Codex CLI
codex mcp add atlascloud -- npx -y atlascloud-mcp

# Gemini CLI
gemini mcp add atlascloud -- npx -y atlascloud-mcp

# Goose CLI
goose mcp add atlascloud -- npx -y atlascloud-mcp
```

> 先にシェルで `ATLASCLOUD_API_KEY` 環境変数を設定してください。

### IDE・エディタ・拡張機能（JSON 設定）

クライアントの MCP 設定に以下を追加してください。MCP 対応のすべてのクライアントで動作します。

```json
{
  "mcpServers": {
    "atlascloud": {
      "command": "npx",
      "args": ["-y", "atlascloud-mcp"],
      "env": {
        "ATLASCLOUD_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

| クライアント | 追加場所 |
|--------|-----------------|
| [Cursor](https://cursor.com) | Settings → MCP → Add Server |
| [Cline](https://github.com/cline/cline) | MCP Marketplace → Add Server |
| [Continue](https://continue.dev) | `config.yaml` → MCP |
| [Windsurf](https://codeium.com/windsurf) | Settings → MCP → Add Server |
| [VS Code (Copilot)](https://code.visualstudio.com) | `.vscode/mcp.json` または Settings → MCP |
| [Trae](https://trae.ai) | Settings → MCP → Add Server |
| [JetBrains IDEs](https://www.jetbrains.com) | Settings → Tools → AI Assistant → MCP |
| [ChatGPT Desktop](https://openai.com/chatgpt/desktop) | Settings → MCP |
| [Amazon Q Developer](https://aws.amazon.com/q/developer/) | MCP Configuration |
| [Roo Code](https://github.com/RooCodeInc/Roo-Code) | Settings → MCP → Add Server |

### Skills の方がお好みですか？

MCP よりも Skills を使いたい場合は、Claude Code やその他の Skills 対応エージェント向けに [Atlas Cloud Skills](https://github.com/AtlasCloudAI/atlas-cloud-skills) パッケージも提供しています。

## 利用可能なツール

| ツール | 説明 |
|------|-------------|
| `atlas_search_docs` | キーワードで Atlas Cloud のドキュメントとモデルを検索します |
| `atlas_list_models` | 利用可能なすべてのモデルを一覧表示します（タイプ（Text/Image/Video/Audio）でのフィルタリングも可能） |
| `atlas_get_model_info` | API スキーマ、パラメータ、使用例を含む詳細なモデル情報を取得します |
| `atlas_generate_image` | サポートされている任意の Image モデルで画像および 3D モデル（画像から 3D / テキストから 3D）を生成します |
| `atlas_generate_video` | サポートされている任意の動画モデルで動画を生成します |
| `atlas_generate_audio` | サポートされている任意の音声モデルで音声 / スピーチ（TTS）を生成します |
| `atlas_quick_generate` | ワンステップでの画像/動画/音声生成 — キーワードでモデルを自動検索し、パラメータを構築して送信します |
| `atlas_upload_media` | ローカルファイルをアップロードし、画像編集 / 画像から動画モデルで使用する URL を取得します |
| `atlas_chat` | LLM モデルとチャットします（OpenAI 互換形式） |
| `atlas_get_prediction` | 画像/動画/音声/3D 生成タスクのステータスと結果を確認します |
| `atlas_get_balance` | API キーのアカウント残高とクレジットの概要を取得します |
| `atlas_get_model_usage` | 指定した期間の日次モデル使用量（リクエスト数、トークン数、画像/動画数）を取得します |
| `atlas_get_model_costs` | 指定した期間の日次モデルコスト（支出）の内訳を取得します |

## 使用例

### モデルを検索する

> 「Atlas Cloud で動画生成モデルを検索して」

AI アシスタントは `atlas_search_docs` または `atlas_list_models` を使用して、関連するモデルを見つけます。

### 画像を生成する

> 「Seedream を使って宇宙にいる猫の画像を生成して」

アシスタントは次のように動作します。
1. `atlas_list_models` を使用して Seedream の画像モデルを見つけます
2. `atlas_get_model_info` を使用してモデルのパラメータを取得します
3. 正しいパラメータで `atlas_generate_image` を使用します

### 動画を生成する

> 「Kling v3 を使ってロケット打ち上げの動画を作って」

アシスタントは次のように動作します。
1. Kling の動画モデルを見つけます
2. スキーマを取得して必要なパラメータを把握します
3. 適切なパラメータで `atlas_generate_video` を使用します

### 編集や動画生成のためにローカル画像をアップロードする

> 「この画像 /Users/me/photos/cat.jpg を編集して帽子を追加して」

アシスタントは次のように動作します。
1. `atlas_upload_media` を使用してローカルファイルをアップロードし、URL を取得します
2. 画像編集モデルを見つけます
3. アップロードした URL で `atlas_generate_image` を使用します

> **注意**: アップロードされたファイルは、Atlas Cloud の生成タスクでの一時的な使用のみを目的としています。ファイルは定期的にクリーンアップされる場合があります。恒久的なファイルホスティングとして使用しないでください。乱用は API キーの停止につながる可能性があります。

### 音声を生成する（TTS）

> 「Seed Audio でこの文を読み上げて: Welcome to Atlas Cloud」

アシスタントは次のように動作します。
1. `type="Audio"` を指定して `atlas_list_models` を使用し、TTS モデルを見つけます
2. 合成するテキストで `atlas_generate_audio` を使用します
3. `atlas_get_prediction` を使用して、生成された音声の URL を取得します

### 3D モデルを生成する

> 「この商品写真を Hunyuan 3D で 3D モデルに変えて」

3D モデルは Image タイプのモデルであるため、アシスタントは `image` パラメータを指定して `atlas_generate_image` を使用し、`atlas_get_prediction` を通じて GLB/OBJ/USDZ ファイルを取得します。

### LLM とチャットする

> 「Qwen に量子コンピューティングを説明してもらって」

アシスタントは Qwen モデルで `atlas_chat` を使用します。

### 残高と使用量を確認する

> 「Atlas Cloud のクレジットはあといくら残っていて、今月はいくら使った？」

アシスタントは、現在の残高を確認するために `atlas_get_balance` を、支出の内訳を確認するために `atlas_get_model_costs` を使用します。

## 開発

```bash
# 依存関係をインストール
npm install

# ビルド
npm run build

# 開発モードで実行
npm run dev
```

## その他の Atlas Cloud ツール

- 🧰 **ターミナルから使いたいですか？** → [atlascloud-cli](https://github.com/AtlasCloudAI/cli)
- 🤖 **Claude Code / Cursor で使いたいですか？** → [Atlas Cloud MCP Server](https://github.com/AtlasCloudAI/mcp-server)
- 🎬 **Claude Code / Codex / Gemini CLI の Skill として使いたいですか？** → [atlas-cloud-skills](https://github.com/AtlasCloudAI/atlas-cloud-skills)
- 🎨 **ComfyUI ノード** → [atlascloud_comfyui](https://github.com/AtlasCloudAI/atlascloud_comfyui)
- 🔁 **n8n ノード** → [n8n-nodes-atlascloud](https://github.com/AtlasCloudAI/n8n-nodes-atlascloud)
- 💬 **Discord に参加** → [discord.gg/MWmMr4q9es](https://discord.gg/MWmMr4q9es)
- 🌐 **ウェブサイト** → [atlascloud.ai](https://www.atlascloud.ai?utm_source=github&utm_campaign=mcp-server)

## ライセンス

MIT
