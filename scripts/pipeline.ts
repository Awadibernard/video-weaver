/**
 * pipeline.ts — POINT D'ENTRÉE UNIQUE (100% headless).
 *
 *   1. generate-quiz.ts  → input/metadata.json + quiz.json (IA Groq)
 *   2. prepare.ts + remotion render → out/quiz.mp4
 *   3. upload.ts         → Litterbox + Buffer → TikTok
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import { uploadToBufferGraphQL } from "./upload";

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const skipUpload = args.includes("--skip-upload");
const skipGenerate = args.includes("--skip-generate");

function run(label: string, command: string, cmdArgs: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`\n──────── ${label} ────────`);
    const child = spawn(command, cmdArgs, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} a échoué (code ${code}).`));
    });
  });
}

async function main() {
  const started = Date.now();

  // --- ÉTAPE 1 : génération du sujet ---
  if (skipGenerate) {
    console.log("⏭️  Étape 1 ignorée (--skip-generate).");
  } else {
    await run("ÉTAPE 1/3 · Génération du quiz (IA)", "npx", ["tsx", "scripts/generate-quiz.ts"]);
  }

  // --- ÉTAPE 2 : préparation des assets + rendu vidéo ---
  await run("ÉTAPE 2/3 · Préparation des assets", "npx", ["tsx", "scripts/prepare.ts"]);
  await run("ÉTAPE 2/3 · Rendu Remotion", "npx", [
    "remotion",
    "render",
    "src/index.ts",
    "QuizVideo",
    "out/quiz.mp4",
    "--props=public/props.json",
    "--concurrency=1",
  ]);

  // --- ÉTAPE 3 : upload TikTok ---
  if (skipUpload) {
    console.log("\n⏭️  Étape 3 ignorée (--skip-upload). Vidéo disponible : out/quiz.mp4");
  } else {
    console.log(`\n──────── ÉTAPE 3/3 · Upload TikTok (Buffer) ────────`);
    await uploadToBufferGraphQL();
  }

  console.log(`\n✅ Pipeline terminé en ${((Date.now() - started) / 1000).toFixed(1)}s.`);
}

main().catch((e) => {
  console.error(`\n❌ Pipeline interrompu : ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
Solution 2 : Corriger le bas du fichier scripts/upload.ts
Si vous souhaitez conserver l'exécution sous forme de script séparé via npx tsx scripts/upload.ts[cite: 11], modifiez le bas de scripts/upload.ts pour forcer l'exécution de la fonction sans la condition require.main[cite: 10] :

Remplacer à la fin de scripts/upload.ts :

TypeScript
// ❌ À supprimer :
if (require.main === module) {
  uploadToBufferGraphQL().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
```[cite: 10]

**Par :**

```typescript
// ✅ À mettre à la place :
uploadToBufferGraphQL().catch((e) => {
  console.error(e);
  process.exit(1);
});
