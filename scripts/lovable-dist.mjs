import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const distDir = resolve('dist');

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

writeFileSync(
  resolve(distDir, 'index.html'),
  `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Tikmation — rendu vidéo headless</title>
    <meta name="description" content="Projet headless de génération de vidéos quiz avec Remotion, conçu pour GitHub Actions." />
    <meta property="og:title" content="Tikmation — rendu vidéo headless" />
    <meta property="og:description" content="Projet headless de génération de vidéos quiz avec Remotion, conçu pour GitHub Actions." />
    <meta property="og:type" content="website" />
    <meta name="twitter:card" content="summary" />
    <style>
      :root { color-scheme: dark; font-family: Arial, system-ui, sans-serif; background: #111; color: #f5f5f5; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
      main { width: min(680px, calc(100% - 40px)); }
      h1 { font-size: clamp(2rem, 7vw, 4rem); line-height: 1; margin: 0 0 1rem; }
      p { color: #c9c9c9; font-size: 1.125rem; line-height: 1.6; margin: 0; }
      code { color: #fff; background: #242424; border-radius: 6px; padding: 0.125rem 0.375rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>Tikmation</h1>
      <p>Ce dépôt est un moteur de rendu vidéo headless. Le pipeline utile reste <code>npm run build-video</code> via GitHub Actions ; cette page statique sert uniquement aux checks de publication.</p>
    </main>
  </body>
</html>
`,
);

console.log('Lovable compatibility build complete: dist/index.html');