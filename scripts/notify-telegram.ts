/**
 * notify-telegram.ts — appelé par GitHub Actions à la fin d'un rendu.
 *
 * 1. Héberge out/quiz.mp4 sur Litterbox (lien temporaire 72h = maximum du service).
 * 2. Livraison adaptative :
 *    - fichier <= 50 Mo  → `sendVideo` (vidéo jouable directement dans Telegram),
 *      avec le lien Litterbox 72h en légende ;
 *    - fichier  > 50 Mo  → simple message texte avec le lien de téléchargement
 *      (l'API Bot Telegram rejette tout envoi de fichier au-delà de 50 Mo).
 *
 * Ne fait jamais échouer le job : toute erreur est simplement loguée.
 *
 * Variables : TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (fourni par le workflow).
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");

/** Limite dure de l'API Bot Telegram pour un envoi de fichier. */
const TELEGRAM_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** Rétention maximale autorisée par Litterbox. */
const LITTERBOX_RETENTION = "72h";

const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(2);

const KEYBOARD = {
  inline_keyboard: [
    [
      { text: "🔍 + Zoom", callback_data: "zoom:in" },
      { text: "🔍 - Dézoom", callback_data: "zoom:out" },
    ],
    [{ text: "🚀 Publier sur TikTok", callback_data: "publish" }],
  ],
};

/** Upload Litterbox avec 3 tentatives (le service renvoie souvent 5xx). */
async function uploadToLitterbox(videoPath: string): Promise<string> {
  const buffer = fs.readFileSync(videoPath);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const form = new FormData();
      form.append("reqtype", "fileupload");
      form.append("time", LITTERBOX_RETENTION);
      form.append("fileToUpload", new Blob([buffer]), "quiz.mp4");
      const res = await fetch("https://litterbox.catbox.moe/resources/internals/api.php", {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(600_000),
      });
      const text = (await res.text()).trim();
      if (res.ok && text.startsWith("http")) return text;
      throw new Error(`réponse inattendue (${res.status}): ${text.slice(0, 150)}`);
    } catch (e) {
      console.warn(`⚠️  Litterbox essai ${attempt}/3 : ${e instanceof Error ? e.message : e}`);
      await new Promise((r) => setTimeout(r, 4000 * attempt));
    }
  }
  return "";
}

async function tgSendMessage(token: string, chatId: string, text: string) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
      reply_markup: KEYBOARD,
    }),
  });
  console.log(res.ok ? "📨 Message Telegram envoyé." : `⚠️ Telegram: ${await res.text()}`);
}

async function tgSendVideo(token: string, chatId: string, videoPath: string, caption: string) {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  form.append("supports_streaming", "true");
  form.append("reply_markup", JSON.stringify(KEYBOARD));
  form.append("video", new Blob([fs.readFileSync(videoPath)], { type: "video/mp4" }), "quiz.mp4");
  const res = await fetch(`https://api.telegram.org/bot${token}/sendVideo`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(600_000),
  });
  if (res.ok) {
    console.log("🎬 Vidéo envoyée directement dans Telegram.");
    return true;
  }
  console.warn(`⚠️ sendVideo a échoué: ${(await res.text()).slice(0, 300)}`);
  return false;
}

/** Rapport de santé TTS écrit par scripts/tts.ts (public/tts-status.json). */
function readTtsReport(): string[] {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(ROOT, "public/tts-status.json"), "utf8"));
    const lines = [`🗣️ Moteur TTS : <b>${s.engineLabel || s.engine || "inconnu"}</b>`];
    if (s.fishKeysTotal > 0) {
      lines.push(`🐟 Clés Fish Audio fonctionnelles : ${s.fishKeysAlive}/${s.fishKeysTotal}`);
    }
    if (s.blocks) lines.push(`🎧 Blocs audio : ${s.blocks.ok} ok / ${s.blocks.failed} échec(s)`);
    for (const e of (s.events || []).slice(-4)) lines.push(`• ${e}`);
    return lines;
  } catch {
    return [];
  }
}

/** Quota GitHub Actions restant (nécessite GITHUB_PAT avec le scope \`user\`). */
async function githubActionsMinutes(): Promise<string> {
  const pat = process.env.GITHUB_PAT;
  if (!pat) return "";
  try {
    const res = await fetch("https://api.github.com/user/settings/billing/actions", {
      headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return "";
    const b = (await res.json()) as any;
    const quota = Number(b.included_minutes ?? 2000);
    const used = Number(b.total_minutes_used ?? 0);
    return `⏱️ Minutes GitHub Actions restantes : ${Math.max(0, quota - used)} / ${quota} min`;
  } catch {
    return "";
  }
}

export async function notifyTelegram(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log("ℹ️  Notification Telegram ignorée (token ou chat_id absent).");
    return;
  }

  const videoPath = path.join(ROOT, "out/quiz.mp4");
  const exists = fs.existsSync(videoPath);
  const size = exists ? fs.statSync(videoPath).size : 0;
  if (exists) console.log(`📦 Vidéo : ${mb(size)} Mo`);

  const link = exists && size > 0 ? await uploadToLitterbox(videoPath) : "";

  let topic = "";
  try {
    topic = JSON.parse(fs.readFileSync(path.join(ROOT, "input/metadata.json"), "utf8")).topic || "";
  } catch {
    /* ignore */
  }

  const header = ["✅ <b>Vidéo générée</b>", topic ? `📌 Sujet : <b>${topic}</b>` : ""]
    .filter(Boolean)
    .join("\n");
  const linkLine = link
    ? `🔗 <a href="${link}">Télécharger la vidéo</a> (valide 72h)\n<code>${link}</code>`
    : "⚠️ Lien indisponible — récupère l'artefact GitHub.";
  const sizeLine = exists ? `📦 Poids : ${mb(size)} Mo` : "";
  const ttsLines = readTtsReport();
  const minutesLine = await githubActionsMinutes();
  const healthBlock = [...ttsLines, minutesLine].filter(Boolean).join("\n");

  // <= 50 Mo : envoi direct jouable. Au-delà : lien uniquement (limite API Telegram).
  if (exists && size > 0 && size <= TELEGRAM_MAX_UPLOAD_BYTES) {
    const ok = await tgSendVideo(
      token,
      chatId,
      videoPath,
      [header, sizeLine, healthBlock, linkLine].filter(Boolean).join("\n"),
    );
    if (ok) return;
    console.log("↩️  Repli sur un message texte.");
  } else if (size > TELEGRAM_MAX_UPLOAD_BYTES) {
    console.log("ℹ️  Vidéo > 50 Mo : envoi direct ignoré (limite API Telegram) — lien seul.");
  }

  await tgSendMessage(
    token,
    chatId,
    [
      header,
      sizeLine,
      size > TELEGRAM_MAX_UPLOAD_BYTES ? "ℹ️ Trop lourde pour l'envoi direct Telegram (>50 Mo)." : "",
      healthBlock,
      linkLine,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

if (require.main === module) {
  notifyTelegram().catch((e) => {
    console.warn("⚠️  Notification Telegram échouée:", e instanceof Error ? e.message : e);
  });
}