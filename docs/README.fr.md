<p align="center">
  <img src="https://www.atlascloud.ai/logo.svg" alt="Atlas Cloud" width="80" />
</p>

<h1 align="center">Atlas Cloud MCP Server</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/atlascloud-mcp"><img src="https://img.shields.io/npm/v/atlascloud-mcp.svg?style=flat&colorA=18181B&colorB=28CF8D" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/atlascloud-mcp"><img src="https://img.shields.io/npm/dm/atlascloud-mcp.svg?style=flat&colorA=18181B&colorB=28CF8D" alt="npm downloads" /></a>
  <a href="https://github.com/AtlasCloudAI/mcp-server"><img src="https://img.shields.io/github/license/AtlasCloudAI/mcp-server?style=flat&colorA=18181B&colorB=28CF8D" alt="license" /></a>
</p>

<p align="center">
  <a href="../README.md">English</a> | <a href="./README.zh-CN.md">中文</a> | <a href="./README.ja.md">日本語</a> | <a href="./README.ko.md">한국어</a> | <a href="./README.es.md">Español</a> | Français
</p>

<p align="center">
  Serveur MCP (Model Context Protocol) pour <a href="https://www.atlascloud.ai">Atlas Cloud</a> — plateforme d'agrégation d'APIs IA offrant la génération d'images, la génération de vidéos et des modèles LLM.
</p>

---

## Fonctionnalités

- **Découverte de modèles** — Parcourez plus de 200 modèles IA avec prix et capacités
- **Génération d'images** — Générez des images avec Seedream, Qwen-Image, Flux, Imagen, etc.
- **Génération de vidéos** — Générez des vidéos avec Kling, Vidu, Seedance, Wan, Hailuo, Veo, etc.
- **Chat LLM** — Discutez avec des modèles LLM (format compatible OpenAI) : DeepSeek, Qwen, GLM, MiniMax, etc.
- **Téléchargement de médias** — Téléchargez des images/fichiers locaux pour les utiliser avec les modèles d'édition d'image et image-vers-vidéo
- **Génération rapide** — Génération en une étape avec recherche automatique de modèles et construction de paramètres
- **Recherche de documentation** — Recherchez la documentation, les modèles et les références API d'Atlas Cloud directement depuis votre IDE
- **Schéma dynamique** — Récupère automatiquement le schéma de paramètres de chaque modèle

## Démarrage rapide

### Prérequis

- Node.js >= 18
- Clé API Atlas Cloud — [Obtenir gratuitement](https://www.atlascloud.ai/console/api-keys)

### Cursor / Claude Desktop

Ajoutez à votre configuration MCP :

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

### Claude Code

```bash
claude mcp add atlascloud -- npx -y atlascloud-mcp
```

## Outils disponibles

| Outil | Description |
|-------|-------------|
| `atlas_search_docs` | Rechercher documentation et modèles par mot-clé |
| `atlas_list_models` | Lister tous les modèles (filtrer par type : Text/Image/Video) |
| `atlas_get_model_info` | Obtenir les détails d'un modèle (schéma API, paramètres, exemples) |
| `atlas_generate_image` | Générer des images |
| `atlas_generate_video` | Générer des vidéos |
| `atlas_quick_generate` | Génération en une étape — recherche auto par mot-clé, construit les paramètres et soumet |
| `atlas_upload_media` | Télécharger des fichiers locaux pour obtenir une URL (pour modèles d'édition/image-vers-vidéo) |
| `atlas_chat` | Chat avec LLM (compatible OpenAI) |
| `atlas_get_prediction` | Vérifier le statut et le résultat des tâches de génération |

> **Note** : Les fichiers téléchargés sont uniquement destinés à un usage temporaire avec les tâches de génération Atlas Cloud. Les fichiers peuvent être nettoyés périodiquement. Ne pas utiliser comme hébergement permanent — tout abus peut entraîner la suspension de la clé API.

## Développement

```bash
npm install
npm run build
npm run dev
```

## Licence

MIT
