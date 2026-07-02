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
  <a href="../README.md">English</a> | <a href="./README.zh-CN.md">中文</a> | <a href="./README.ja.md">日本語</a> | <a href="./README.ko.md">한국어</a> | <a href="./README.es.md">Español</a> | Français
</p>

<p align="center">
  Utilisez les plus de 300 modèles d'image / vidéo / LLM d'<a href="https://www.atlascloud.ai?utm_source=github&utm_campaign=mcp-server">Atlas Cloud</a> dans Claude Code, Codex, Gemini CLI, Cursor, Cline et bien d'autres. Générez des images, des vidéos et discutez via des outils MCP standard.
</p>

<p align="center">
  <a href="https://www.atlascloud.ai/console/api-keys?utm_source=github&utm_campaign=mcp-server"><b>→ Obtenez votre clé API Atlas Cloud gratuite</b></a> · plus de 300 modèles · compatible OpenAI
</p>

---

## Modèles pris en charge

- 🎬 **Vidéo** — Seedance 2.0 · Kling 3 · Sora 2 · Veo 3.1 · HappyHorse 1 · Grok Imagine 1.5 · Wan 2.7
- 🎨 **Image** — Nano Banana 2/Pro · GPT Image 2 · Flux 2 · Seedream 5
- 🧊 **3D** — Hunyuan 3D image-vers-3D / texte-vers-3D
- 💬 **LLM** — Claude · GPT · DeepSeek · MiniMax · Kimi · GLM · Qwen
- 🔊 **Audio (TTS)** — Seed Audio · xAI/Grok TTS · ElevenLabs

- 📚 **Explorer plus** — [plus de 300 modèles »](https://www.atlascloud.ai/models?utm_source=github&utm_campaign=mcp-server)

## Sommaire

- [Ce que vous pouvez faire](#ce-que-vous-pouvez-faire)
- [Démarrage rapide](#démarrage-rapide)
- [Outils disponibles](#outils-disponibles)
- [Exemples d'utilisation](#exemples-dutilisation)
- [Développement](#développement)
- [Plus d'outils Atlas Cloud](#plus-doutils-atlas-cloud)
- [Licence](#licence)

## Ce que vous pouvez faire

Demandez à votre assistant IA en langage naturel — il découvre le bon modèle, construit les paramètres et soumet la tâche :

- 🎨 **« Crée une image de couverture pour cet article de blog »** — texte-vers-image avec Nano Banana Pro, GPT Image 2, Flux 2, Seedream, Imagen…
- 🎬 **« Transforme cette photo de produit en publicité de 5 secondes »** — image-vers-vidéo avec Kling 3, Seedance 2, Veo 3.1, Sora 2…
- 🧊 **« Crée un modèle 3D à partir de cette photo »** — image-vers-3D / texte-vers-3D avec Hunyuan 3D (sortie GLB/OBJ/USDZ)
- 🔊 **« Lis ce script à voix haute »** — synthèse vocale avec Seed Audio, ElevenLabs, xAI TTS
- 🎞️ **« Découpe ce script en 6 plans (storyboard) »** — enchaîne LLM → image → vidéo dans une seule conversation
- ✏️ **« Modifie cette image — ajoute un chapeau »** — téléversez un fichier local, puis exécutez un modèle d'édition d'image
- 💸 **« Combien de crédits me reste-t-il, et combien ai-je dépensé ce mois-ci ? »** — consultez le solde, l'utilisation et le détail des coûts
- 💬 **« Résume ce PDF avec DeepSeek »** — chat LLM compatible OpenAI avec Claude, GPT, DeepSeek, Qwen, GLM…

Sous le capot : découverte de modèles, schémas de paramètres dynamiques propres à chaque modèle (validés avant chaque requête, de sorte que les paramètres invalides échouent immédiatement sans consommer de crédits), téléversement de médias, génération rapide en une étape, solde et utilisation du compte, et recherche dans la documentation — le tout exposé sous forme d'outils MCP standard (voir [Outils disponibles](#outils-disponibles)).

## Démarrage rapide

### Prérequis

- Node.js >= 18
- Clé API Atlas Cloud — [Obtenez-en une gratuitement sur atlascloud.ai](https://www.atlascloud.ai/console/api-keys?utm_source=github&utm_campaign=mcp-server)

Consultez [`.env.example`](./.env.example) pour la variable d'environnement à définir.

### Agents CLI (installation en une ligne)

La voie la plus rapide — ces agents de programmation IA ajoutent le serveur en une seule commande :

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

> Définissez d'abord la variable d'environnement `ATLASCLOUD_API_KEY` dans votre shell.

### IDE, éditeurs et extensions (configuration JSON)

Ajoutez ceci à la configuration MCP de votre client — compatible avec tous les clients compatibles MCP :

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

| Client | Où l'ajouter |
|--------|--------------|
| [Cursor](https://cursor.com) | Settings → MCP → Add Server |
| [Cline](https://github.com/cline/cline) | MCP Marketplace → Add Server |
| [Continue](https://continue.dev) | `config.yaml` → MCP |
| [Windsurf](https://codeium.com/windsurf) | Settings → MCP → Add Server |
| [VS Code (Copilot)](https://code.visualstudio.com) | `.vscode/mcp.json` ou Settings → MCP |
| [Trae](https://trae.ai) | Settings → MCP → Add Server |
| [JetBrains IDEs](https://www.jetbrains.com) | Settings → Tools → AI Assistant → MCP |
| [ChatGPT Desktop](https://openai.com/chatgpt/desktop) | Settings → MCP |
| [Amazon Q Developer](https://aws.amazon.com/q/developer/) | MCP Configuration |
| [Roo Code](https://github.com/RooCodeInc/Roo-Code) | Settings → MCP → Add Server |

### Vous préférez les Skills ?

Si vous préférez utiliser les Skills plutôt que MCP, nous proposons également un package [Atlas Cloud Skills](https://github.com/AtlasCloudAI/atlas-cloud-skills) pour Claude Code et les autres agents compatibles Skills.

## Outils disponibles

| Outil | Description |
|-------|-------------|
| `atlas_search_docs` | Rechercher dans la documentation et les modèles Atlas Cloud par mot-clé |
| `atlas_list_models` | Lister tous les modèles disponibles, avec filtrage optionnel par type (Text/Image/Video/Audio) |
| `atlas_get_model_info` | Obtenir les informations détaillées d'un modèle : schéma API, paramètres et exemples d'utilisation |
| `atlas_generate_image` | Générer des images et des modèles 3D (image-vers-3D / texte-vers-3D) avec n'importe quel modèle Image pris en charge |
| `atlas_generate_video` | Générer des vidéos avec n'importe quel modèle vidéo pris en charge |
| `atlas_generate_audio` | Générer de l'audio / de la parole (TTS) avec n'importe quel modèle audio pris en charge |
| `atlas_quick_generate` | Génération d'image/vidéo/audio en une étape — trouve automatiquement le modèle par mot-clé, construit les paramètres et soumet |
| `atlas_upload_media` | Téléverser des fichiers locaux pour obtenir une URL utilisable avec les modèles d'édition d'image / image-vers-vidéo |
| `atlas_chat` | Discuter avec les modèles LLM (format compatible OpenAI) |
| `atlas_get_prediction` | Vérifier le statut et le résultat des tâches de génération d'image/vidéo/audio/3D |
| `atlas_get_balance` | Obtenir le solde du compte et le récapitulatif des crédits pour votre clé API |
| `atlas_get_model_usage` | Obtenir l'utilisation quotidienne des modèles (requêtes, tokens, nombre d'images/vidéos) sur une plage de dates |
| `atlas_get_model_costs` | Obtenir les coûts quotidiens des modèles (dépenses) répartis sur une plage de dates |

## Exemples d'utilisation

### Rechercher des modèles

> « Cherche des modèles de génération vidéo sur Atlas Cloud »

Votre assistant IA utilisera `atlas_search_docs` ou `atlas_list_models` pour trouver les modèles pertinents.

### Générer une image

> « Génère une image d'un chat dans l'espace avec Seedream »

L'assistant va :
1. Utiliser `atlas_list_models` pour trouver les modèles d'image Seedream
2. Utiliser `atlas_get_model_info` pour obtenir les paramètres du modèle
3. Utiliser `atlas_generate_image` avec les bons paramètres

### Générer une vidéo

> « Crée une vidéo d'un lancement de fusée avec Kling v3 »

L'assistant va :
1. Trouver le modèle vidéo Kling
2. Obtenir son schéma pour comprendre les paramètres requis
3. Utiliser `atlas_generate_video` avec les paramètres appropriés

### Téléverser une image locale pour l'édition ou la génération de vidéo

> « Modifie cette image /Users/me/photos/cat.jpg pour y ajouter un chapeau »

L'assistant va :
1. Utiliser `atlas_upload_media` pour téléverser le fichier local et obtenir une URL
2. Trouver un modèle d'édition d'image
3. Utiliser `atlas_generate_image` avec l'URL téléversée

> **Note** : Les fichiers téléversés sont destinés uniquement à un usage temporaire avec les tâches de génération Atlas Cloud. Ils peuvent être supprimés périodiquement. Ne les utilisez pas comme hébergement permanent de fichiers — tout abus peut entraîner la suspension de la clé API.

### Générer de la parole (TTS)

> « Lis cette phrase à voix haute avec Seed Audio : Bienvenue sur Atlas Cloud »

L'assistant va :
1. Utiliser `atlas_list_models` avec `type="Audio"` pour trouver le modèle TTS
2. Utiliser `atlas_generate_audio` avec le texte à synthétiser
3. Utiliser `atlas_get_prediction` pour récupérer l'URL de l'audio généré

### Générer un modèle 3D

> « Transforme cette photo de produit en modèle 3D avec Hunyuan 3D »

Les modèles 3D sont des modèles de type Image ; l'assistant utilise donc `atlas_generate_image` avec le paramètre `image` et récupère un fichier GLB/OBJ/USDZ via `atlas_get_prediction`.

### Discuter avec un LLM

> « Demande à Qwen d'expliquer l'informatique quantique »

L'assistant utilisera `atlas_chat` avec le modèle Qwen.

### Vérifier le solde et l'utilisation

> « Combien de crédits Atlas Cloud me reste-t-il, et combien ai-je dépensé ce mois-ci ? »

L'assistant utilisera `atlas_get_balance` pour le solde actuel et `atlas_get_model_costs` pour le détail des dépenses.

## Développement

```bash
# Installer les dépendances
npm install

# Compiler
npm run build

# Lancer en mode développement
npm run dev
```

## Plus d'outils Atlas Cloud

- 🧰 **Envie de l'utiliser depuis le terminal ?** → [atlascloud-cli](https://github.com/AtlasCloudAI/cli)
- 🤖 **Envie de l'utiliser dans Claude Code / Cursor ?** → [Atlas Cloud MCP Server](https://github.com/AtlasCloudAI/mcp-server)
- 🎬 **Envie de l'utiliser comme Skill Claude Code / Codex / Gemini CLI ?** → [atlas-cloud-skills](https://github.com/AtlasCloudAI/atlas-cloud-skills)
- 🎨 **Nœuds ComfyUI** → [atlascloud_comfyui](https://github.com/AtlasCloudAI/atlascloud_comfyui)
- 🔁 **Nœuds n8n** → [n8n-nodes-atlascloud](https://github.com/AtlasCloudAI/n8n-nodes-atlascloud)
- 💬 **Rejoignez notre Discord** → [discord.gg/MWmMr4q9es](https://discord.gg/MWmMr4q9es)
- 🌐 **Site web** → [atlascloud.ai](https://www.atlascloud.ai?utm_source=github&utm_campaign=mcp-server)

## Licence

MIT
