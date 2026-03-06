# Atlas Cloud MCP Server

Serveur MCP (Model Context Protocol) pour [Atlas Cloud](https://www.atlascloud.ai) — plateforme d'agrégation d'APIs IA offrant la génération d'images, la génération de vidéos et des modèles LLM.

[English](../README.md) | [中文](./README.zh-CN.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | Français

## Fonctionnalités

- **Recherche de documentation** — Recherchez la documentation, les modèles et les références API d'Atlas Cloud directement depuis votre IDE
- **Découverte de modèles** — Parcourez plus de 80 modèles IA avec prix et capacités
- **Génération d'images** — Générez des images avec Seedream, Qwen-Image, Z-Image, etc.
- **Génération de vidéos** — Générez des vidéos avec Kling, Vidu, Seedance, Wan, etc.
- **Chat LLM** — Discutez avec des modèles LLM (format compatible OpenAI) : GPT, DeepSeek, Qwen, GLM, etc.
- **Schéma dynamique** — Récupère automatiquement le schéma de paramètres de chaque modèle

## Démarrage rapide

### Prérequis

- Node.js >= 18
- Clé API Atlas Cloud (obtenir sur [atlascloud.ai](https://www.atlascloud.ai))

### Configuration dans Cursor / Claude Desktop

Ajoutez à votre configuration MCP :

```json
{
  "mcpServers": {
    "atlascloud": {
      "command": "npx",
      "args": ["-y", "atlascloud-mcp-server"],
      "env": {
        "ATLASCLOUD_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

## Outils disponibles

| Outil | Description |
|-------|-------------|
| `atlas_search_docs` | Rechercher documentation et modèles par mot-clé |
| `atlas_list_models` | Lister tous les modèles (filtrer par type : Text/Image/Video) |
| `atlas_get_model_info` | Obtenir les détails d'un modèle (schéma API, paramètres, exemples) |
| `atlas_generate_image` | Générer des images |
| `atlas_generate_video` | Générer des vidéos |
| `atlas_chat` | Chat avec LLM (compatible OpenAI) |
| `atlas_get_prediction` | Vérifier le statut et le résultat des tâches de génération |

## Développement

```bash
npm install
npm run build
npm run dev
```

## Licence

MIT
