import { CONFIG } from "./env";

const BASE_URL = `https://api.telegram.org/bot${CONFIG.telegramToken}`;

export async function sendTelegramApi(method: string, body: Record<string, any>): Promise<any> {
  const res = await fetch(`${BASE_URL}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  return sendTelegramApi("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text || "",
    show_alert: false,
  });
}

export async function sendMessage(chatId: string | number, text: string, replyMarkup?: any) {
  return sendTelegramApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    reply_markup: replyMarkup,
  });
}

export async function editMessage(chatId: string | number, messageId: number, text: string, replyMarkup?: any) {
  return sendTelegramApi("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "Markdown",
    reply_markup: replyMarkup,
  });
}

/**
 * Menu interactif principal à boutons Inline Keyboard
 */
export function getMainMenuInlineKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🚀 Générer & Publier", callback_data: "action_publish" },
        { text: "👁️ Mode Aperçu", callback_data: "action_preview" },
      ],
      [
        { text: "🔄 Régénérer Quiz", callback_data: "action_regenerate" },
        { text: "📅 Planification (Cron)", callback_data: "action_schedule_menu" },
      ],
      [
        { text: "🧹 Réinitialiser les Thèmes", callback_data: "action_reset_topics_confirm" },
      ],
      [
        { text: "ℹ️ Statut du Bot", callback_data: "action_status" },
      ],
    ],
  };
}

/**
 * Menu de confirmation pour la suppression des thèmes
 */
export function getResetConfirmInlineKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "⚠️ Oui, Vider history.json", callback_data: "action_reset_topics_do" },
      ],
      [
        { text: "❌ Annuler", callback_data: "action_main_menu" },
      ],
    ],
  };
    }
