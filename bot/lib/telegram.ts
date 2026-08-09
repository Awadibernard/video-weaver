/**
 * telegram.ts — mini client de l'API Bot Telegram (aucune dépendance).
 * Utilisé par la fonction serverless Vercel `bot/api/webhook.ts`.
 */

const TOKEN = () => {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN manquant");
  return t;
};

const API = (method: string) => `https://api.telegram.org/bot${TOKEN()}/${method}`;

export type InlineButton = { text: string; callback_data: string };

async function call<T = any>(method: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(API(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = (await res.json()) as any;
  if (!json.ok) throw new Error(`Telegram ${method} a échoué: ${JSON.stringify(json).slice(0, 300)}`);
  return json.result as T;
}

export function sendMessage(
  chatId: number | string,
  text: string,
  buttons?: InlineButton[][],
): Promise<any> {
  return call("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: false,
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
}

export function answerCallbackQuery(id: string, text?: string): Promise<any> {
  return call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
}

/** Long polling : récupère les updates en attente (timeout côté Telegram). */
export function getUpdates(offset?: number, timeoutSec = 30): Promise<any[]> {
  return call<any[]>("getUpdates", {
    ...(offset !== undefined ? { offset } : {}),
    timeout: timeoutSec,
    allowed_updates: ["message", "channel_post", "callback_query"],
  });
}

/** Supprime un éventuel webhook actif (bloquant pour getUpdates). */
export function deleteWebhook(): Promise<any> {
  return call("deleteWebhook", { drop_pending_updates: false });
}


/** Télécharge un fichier envoyé dans le chat (upload manuel de quiz.json). */
export async function downloadFile(fileId: string): Promise<string> {
  const file = await call<{ file_path: string }>("getFile", { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN()}/${file.file_path}`);
  if (!res.ok) throw new Error("Téléchargement du fichier Telegram impossible");
  return res.text();
}

/** Autorisation : seul le chat déclaré dans TELEGRAM_ALLOWED_CHAT_ID peut piloter le bot. */
export function isAuthorized(chatId: number | string): boolean {
  const allowed = (process.env.TELEGRAM_ALLOWED_CHAT_ID || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.length) return true; // non restreint (déconseillé)
  return allowed.includes(String(chatId));
}

/** Boutons affichés sous une vidéo générée. */
export const VIDEO_BUTTONS: InlineButton[][] = [
  [
    { text: "🔍 + Zoom", callback_data: "zoom:in" },
    { text: "🔍 - Dézoom", callback_data: "zoom:out" },
  ],
  [{ text: "🚀 Publier sur TikTok", callback_data: "publish" }],
];
