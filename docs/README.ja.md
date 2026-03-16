# Atlas Cloud MCP Server

[Atlas Cloud](https://www.atlascloud.ai) の MCP（Model Context Protocol）サーバー — 画像生成、動画生成、LLM を提供する AI API 統合プラットフォーム。

[English](../README.md) | [中文](./README.zh-CN.md) | 日本語 | [한국어](./README.ko.md) | [Español](./README.es.md) | [Français](./README.fr.md)

## 機能

- **ドキュメント検索** — IDE から Atlas Cloud のドキュメント、モデル、API リファレンスを直接検索
- **モデル探索** — 80以上の AI モデルを価格や機能と共に一覧表示
- **画像生成** — Seedream、Qwen-Image、Z-Image などのモデルで画像を生成
- **動画生成** — Kling、Vidu、Seedance、Wan などのモデルで動画を生成
- **LLM チャット** — DeepSeek、Qwen、GLM、MiniMax などの LLM と対話（OpenAI 互換形式）
- **メディアアップロード** — ローカル画像/メディアファイルをアップロードし、画像編集や画像から動画生成に使用
- **動的スキーマ** — 各モデルのパラメータスキーマを自動取得

## クイックスタート

### 前提条件

- Node.js >= 18
- Atlas Cloud API Key（[atlascloud.ai](https://www.atlascloud.ai) で取得）

### Cursor / Claude Desktop での設定

MCP 設定に以下を追加：

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

## 利用可能なツール

| ツール | 説明 |
|--------|------|
| `atlas_search_docs` | キーワードでドキュメントとモデルを検索 |
| `atlas_list_models` | 全モデル一覧（タイプでフィルタ可能：Text/Image/Video） |
| `atlas_get_model_info` | モデル詳細情報（API スキーマ、パラメータ、使用例） |
| `atlas_generate_image` | 画像生成 |
| `atlas_generate_video` | 動画生成 |
| `atlas_quick_generate` | ワンステップ生成 — キーワードでモデルを自動検索、パラメータ構築、タスク送信 |
| `atlas_upload_media` | ローカルファイルをアップロードしてURL取得（画像編集/画像→動画モデル用） |
| `atlas_chat` | LLM チャット（OpenAI 互換） |
| `atlas_get_prediction` | 生成タスクのステータスと結果を確認 |

> **注意**: アップロードされたファイルは Atlas Cloud 生成タスクでの一時的な使用のみを目的としています。ファイルは定期的にクリーンアップされる場合があります。恒久的なファイルホスティングとして使用しないでください。乱用は API キーの停止につながる可能性があります。

## 開発

```bash
npm install
npm run build
npm run dev
```

## ライセンス

MIT
