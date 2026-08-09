# Audit de mise en production — Tikmation

Checklist exhaustive issue de la lecture de `package.json`, `.github/workflows/*.yml`, `scripts/*.ts`, `src/*`, `bot/*`.

## 1. Variables d'environnement et secrets

| Variable | Emplacement requis | Rôle | Format / défaut |
| --- | --- | --- | --- |
| `GROQ_API_KEY` | Secrets GitHub (render.yml, cron.yml) | Génération du quiz via Groq `llama-3.3-70b-versatile` (`scripts/generate-quiz.ts`) | `gsk_...` — obligatoire, erreur bloquante si absent |
| `ELEVENLABS_API_KEY` | Secrets GitHub + `.env` local | Voix off (`scripts/prepare.ts`). Liste séparée par virgules, rotation automatique sur 401/402/429 | `sk_aaa,sk_bbb` — absent = vidéo muette (non bloquant) |
| `ELEVENLABS_VOICE_ID` | GitHub **Variables** (`vars`) / `.env` | Voix utilisée | défaut `pNInz6obpgDQGcFmaJgB` |
| `ELEVENLABS_MODEL_ID` | GitHub **Variables** (`vars`) / `.env` | Modèle TTS | défaut `eleven_multilingual_v2` |
| `BUFFER_ACCESS_TOKEN` | Secrets GitHub | Publication TikTok via Buffer (`scripts/upload.ts`) | `1/abcdef...` — requis en mode `publish` / `publish-only` |
| `BUFFER_TIKTOK_PROFILE_ID` | Secrets GitHub | Profil TikTok cible dans Buffer | `5f2c...` (24 hex) |
| `TELEGRAM_BOT_TOKEN` | Secrets GitHub **et** `.env` du bot | Notifications de fin de rendu (`scripts/notify-telegram.ts`) + bot long polling (`bot/index.ts`) | `8814984858:AAFs...` |
| `TELEGRAM_CHAT_ID` | Injecté par le workflow (`inputs.chat_id` / cron) | Destinataire de la notification | `123456789` |
| `TELEGRAM_ALLOWED_CHAT_ID` | `.env` du bot (hébergeur : VPS/AlwaysData) | Whitelist des chats autorisés, virgules | `123456789,987654321` — vide = tout le monde |
| `GITHUB_PAT` | `.env` du bot | Dispatch des workflows + commits `config/schedule.json`, `quiz.json` | `ghp_...` scopes `repo` + `workflow` |
| `GITHUB_OWNER` | `.env` du bot | Propriétaire du dépôt | `mon-pseudo` |
| `GITHUB_REPO` | `.env` du bot | Nom du dépôt | `tikmation` |
| `GITHUB_BRANCH` | `.env` du bot | Branche ciblée | défaut `main` |
| `FORCED_TOPIC` | Injecté par render.yml (`inputs.topic`) | Sujet imposé, sinon rotation des catégories | texte libre, vide par défaut |
| `QUESTION_COUNT` | Optionnel, `.env` / env du job | Force le nombre de questions, sinon tirage pondéré 5→10 | `7` |
| `GITHUB_TOKEN` (implicite) | Fourni par Actions (`permissions: contents: write`) | Commit/push de `input/`, `history.json`, `quiz.json` | automatique |

Aucun `TIKTOK_ACCESS_TOKEN` n'existe : la publication passe exclusivement par Buffer. Litterbox et Pollinations sont appelés **sans clé**.

## 2. Assets requis (`public/`)

| Chemin | Format attendu | Rôle | Fallback si absent |
| --- | --- | --- | --- |
| `public/images/backgrounds/*.jpg\|.png` | JPG/PNG, idéalement ≥ 1080×1920 (rotation lente en fond) | Fond de la vidéo, tiré au hasard | Couleur unie `#070a13` (`CONFIG.fallbackBackground`) |
| `public/audio/ticks/tic-tac.wav` | **WAV** uniquement, 44,1 kHz. ~1 s en mode `loop`, ≥ 7 s en mode `continuous` | Tic-tac du compte à rebours | Premier `.wav` du dossier, sinon aucun son (avertissement) |
| `public/audio/bgm/*.mp3\|.wav\|.m4a\|.ogg` | Musique instrumentale en boucle, volume 0.15 | Musique de fond (`enableBGM: true`) | Aucune musique — **dossier actuellement vide** |
| `public/sfx/whoosh.mp3` | MP3 court (<1 s) | Apparition de la question | Ignoré silencieusement (présent ✔) |
| `public/sfx/timer.mp3` | MP3 bouclable | Ambiance du décompte | Ignoré silencieusement — **manquant** |
| `public/sfx/correct.mp3` | MP3 court | Révélation de la bonne réponse | Ignoré silencieusement — **manquant** |
| `public/animations/countdown/<nom>.webm` (+ `.webp`) | WebM VP8/VP9 **avec canal alpha**, ~800×800, ou GIF/APNG animé | Animation du compte à rebours, extraite en séquence PNG RGBA | Ordre d'essai `.webm > .mp4 > .mov > .gif > .apng > .webp > .png` ; si aucune frame valide, l'overlay est simplement omis |
| `public/animations/cta/<nom>.webm` (+ `.webp`) | Idem, ~900×800, alpha obligatoire | Overlay final Like / Abonne-toi / Partage | Idem |
| `public/generated/qN_question.mp3`, `qN_reponse.mp3`, `qN_cta.mp3` | Généré par ElevenLabs à l'exécution | Voix off par question | Durées par défaut 4,5 s / 4,0 s / 2,5 s si TTS échoue |
| `public/generated/qN_optM.jpg` | Généré par Pollinations (512×512, 3 tentatives) | Illustration de chaque option | Case sans image |
| `public/generated/anim-countdown/NNNN.png`, `anim-cta/NNNN.png` | Séquences PNG RGBA générées par FFmpeg | Lecture 1× pilotée par `useCurrentFrame()` | Overlay omis |
| `public/props.json` | Généré par `scripts/prepare.ts` | Entrée du rendu Remotion (`--props`) | Aucun : le rendu échoue sans lui |
| Polices | `fonts-noto-color-emoji` + `fonts-liberation` installés par apt dans les workflows ; `@remotion/google-fonts/NotoColorEmoji` chargé côté composition | Emojis couleur + texte (`Segoe UI`/`Arial`/`Courier New` via canvas) | Carrés vides si la police emoji manque sur la machine |

Noms de fichiers : rester en kebab-case, sans espace ni virgule (contrainte FFmpeg).

## 3. Fichiers de configuration et données locales

| Fichier | Structure minimale | Rôle |
| --- | --- | --- |
| `config/schedule.json` | `{ "enabled": false, "times": [], "timezone": "GMT", "chat_id": "" }` | Planification horaire lue par `cron.yml` (comparaison à l'heure GMT) et écrite par `/schedule` du bot ; champ hérité `time` encore accepté |
| `history.json` | `{ "last_category_index": 0, "categories": [...6 thèmes], "used_topics": [...] }` | Rotation des catégories + mémoire anti-doublon (100 derniers sujets injectés dans le prompt, cap 200) |
| `quiz.json` | Tableau de `QuizQuestion` (`question`, `options[3]`, `correct`, `explanation`, `emojis`, `imagePrompts[3]`, `motif`, `ctaText`, `uiScale`) | Source du rendu vidéo, régénérable ou remplaçable par upload d'un `.json` dans Telegram |
| `input/metadata.json` | `{ topic, description, hashtags[], motif, uiScale, cta, emojis[], questionCount, questions[] }` | Légende TikTok (`scripts/upload.ts`) et titre de la notification Telegram |
| `.env` / `.env.example` | Clés listées au tableau 1 | Exécution locale et bot (chargé par `bot/lib/env.ts`, racine ou `bot/`) |
| `src/config.ts` | Constante `CONFIG` | Réglages de rendu : 60 fps, 1080×1920, couleurs, `countdownSeconds: 7`, `tickAudioMode`, `enableBGM`, `uiScale`, volumes |
| `remotion.config.ts` | Config Remotion CLI | h264, yuv420p, concurrency 1, renderer ANGLE |
| `.github/workflows/render.yml` | — | Point d'entrée manuel/bot (modes preview, publish, regenerate, publish-only) |
| `.github/workflows/cron.yml` | — | Vérification horaire du planning et pipeline complet |

## Actions manquantes avant production

1. Déposer au moins un fichier dans `public/audio/bgm/` (sinon `enableBGM` reste sans effet).
2. Ajouter `public/sfx/timer.mp3` et `public/sfx/correct.mp3`.
3. Renseigner les secrets GitHub : `GROQ_API_KEY`, `ELEVENLABS_API_KEY`, `BUFFER_ACCESS_TOKEN`, `BUFFER_TIKTOK_PROFILE_ID`, `TELEGRAM_BOT_TOKEN`, et les variables `ELEVENLABS_VOICE_ID` / `ELEVENLABS_MODEL_ID`.
4. Renseigner `.env` sur l'hébergeur du bot : `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_ID`, `GITHUB_PAT`, `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH`.
5. Vérifier que les deux WebM d'overlay possèdent bien un canal alpha (sinon pavé opaque).
6. Ajouter plusieurs fonds dans `public/images/backgrounds/` pour varier les vidéos.

Aucune modification de code n'est proposée ici : ce document est un livrable d'audit. Dis-moi si tu veux que je crée les fichiers manquants ou que je documente ceci dans le README.
