# Tikmation — générateur headless de vidéos quiz (Remotion)

Projet **100 % headless** : aucune interface, aucun studio, aucun serveur web.
Il produit une vidéo verticale 1080×1920 @ 60 fps à partir de `quiz.json`,
avec voix off ElevenLabs et images IA Pollinations.

## Arborescence (racine absolue)

```
.
├── package.json
├── quiz.json                       # contenu métier
├── remotion.config.ts
├── tsconfig.json
├── .env.example
├── .github/workflows/render.yml    # unique point d'entrée CI
├── public/                         # assets statiques (+ generated/, git-ignoré)
├── scripts/prepare.ts              # images + TTS + calcul de timeline → props.json
└── src/
    ├── index.ts                    # registerRoot
    ├── Root.tsx                    # Composition + calculateMetadata
    ├── QuizVideo.tsx
    └── lib/{drawQuiz.ts,types.ts}
```

## Utilisation

```bash
cp .env.example .env      # renseigner ELEVENLABS_API_KEY
npm install
npm run build-video       # prepare-assets + remotion render → out/quiz.mp4
```

Scripts :

- `npm run prepare-assets` — télécharge images + audio, écrit `public/generated/props.json`
- `npm run render` — rendu CLI Remotion
- `npm run build-video` — enchaîne les deux (= `npm start`)
- `npm run build` / `npm run build:dev` — génère seulement un mini `dist/`
  statique pour satisfaire les checks de publication Lovable ; cela ne lance
  pas Remotion et n'intervient pas dans GitHub Actions.

## GitHub Actions

`.github/workflows/render.yml` (déclenchement manuel) : checkout → Node 20 →
FFmpeg + polices emoji → `npm install` → `npm run build-video` → artifact
`Video-Quiz-Finale-MP4`.

Secret requis : `ELEVENLABS_API_KEY` (Settings → Secrets and variables → Actions).
Plusieurs clés séparées par des virgules sont acceptées (rotation sur 401/402/429).
Variables optionnelles : `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID`.

## Note

Les scripts `dev`, `build` et `build:dev` de `package.json` existent uniquement
pour la compatibilité de l'éditeur/publish Lovable. Garde-les si tu veux publier
le dépôt depuis Lovable ; ils n'ont aucun rôle dans le rendu vidéo CI, qui reste
piloté par `npm run build-video`.
