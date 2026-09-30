import * as path from "node:path";
import * as fs from "node:fs";
import dotenv from "dotenv";

// Résolution de la racine absolue du projet, peu importe d'où PM2 est exécuté
export const ROOT_DIR = path.resolve(__dirname, "..");

// Chargement sécurisé du fichier .env local s'il existe
const envPath = path.join(ROOT_DIR, ".env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

export const CONFIG = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
  ghPat: process.env.GH_PAT || process.env.GITHUB_TOKEN || "",
  repoOwner: (process.env.GITHUB_REPOSITORY || "Awadibernard/video-weaver").split("/")[0],
  repoName: (process.env.GITHUB_REPOSITORY || "Awadibernard/video-weaver").split("/")[1],
  defaultBranch: process.env.GITHUB_REF_NAME || "main",
};

export function validateEnv() {
  if (!CONFIG.telegramToken) {
    throw new Error("❌ TELEGRAM_BOT_TOKEN manquant dans les variables d'environnement.");
  }
  if (!CONFIG.ghPat) {
    throw new Error("❌ GH_PAT ou GITHUB_TOKEN manquant pour l'interaction GitHub API.");
  }
  }
