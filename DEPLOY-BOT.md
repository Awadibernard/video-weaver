# 🤖 Bot Telegram Tikmation — Long Polling

Le bot n'utilise plus de webhook ni Vercel : c'est un simple processus Node
qui interroge Telegram en continu (`getUpdates`, long polling).

## 1. Variables d'environnement

Copie `.env.example` en `.env` (à la racine du dépôt ou dans `bot/`) puis remplis :

```
TELEGRAM_BOT_TOKEN=123456:ABC...        # donné par @BotFather
TELEGRAM_ALLOWED_CHAT_ID=123456789      # (optionnel) whitelist, séparée par des virgules
GITHUB_PAT=ghp_...                      # scopes: repo + workflow
GITHUB_OWNER=ton-pseudo
GITHUB_REPO=tikmation
GITHUB_BRANCH=main
```

## 2. Démarrage

```bash
cd bot
npm install
npm start        # = tsx index.ts
```

Le bot supprime automatiquement tout webhook restant au démarrage (un webhook
actif empêcherait `getUpdates` de fonctionner).

Pour le laisser tourner en continu sur un VPS :

```bash
npm i -g pm2
pm2 start "npm start" --name tikmation-bot --cwd ./bot
pm2 save
```

## 3. Commandes

| Commande | Effet |
| --- | --- |
| `/start` `/help` | Aide |
| `/preview [sujet]` | Lance le workflow `render.yml` en mode preview (sans publication) |
| `/publish` | Lance uniquement l'upload TikTok de la dernière vidéo |
| `/schedule HH:MM` | Écrit `config/schedule.json` (heure GMT), lu par `cron.yml` |
| `/schedule off` | Désactive la planification |
| `/status` | Affiche la planification courante |
| Fichier `.json` | Écrase `quiz.json` sur GitHub et relance un rendu |

Boutons inline sous chaque vidéo : `🔍 + Zoom`, `🔍 - Dézoom` (commit `uiScale`
± 0.05 puis re-rendu rapide) et `🚀 Publier sur TikTok`.

## 4. Secrets GitHub Actions (pipeline)

`GROQ_API_KEY`, `ELEVENLABS_API_KEY`, `BUFFER_ACCESS_TOKEN`,
`BUFFER_TIKTOK_PROFILE_ID`, `TELEGRAM_BOT_TOKEN` (notifications de fin de rendu).
