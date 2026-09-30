import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG, ROOT_DIR, validateEnv } from "./lib/env";
import { triggerWorkflow, resetHistoryTopicsOnGitHub } from "./lib/github";
import {
  sendMessage,
  editMessage,
  answerCallbackQuery,
  getMainMenuInlineKeyboard,
  getResetConfirmInlineKeyboard,
  sendTelegramApi,
} from "./lib/telegram";

validateEnv();

console.log("🤖 Video Weaver Bot actif et à l'écoute...");

let lastUpdateId = 0;

/**
 * Boucle de polling optimisée pour serveur (Serv00 / PM2)
 */
async function pollUpdates() {
  try {
    const res = await sendTelegramApi("getUpdates", {
      offset: lastUpdateId + 1,
      timeout: 30,
    });

    if (res.ok && Array.isArray(res.result)) {
      for (const update of res.result) {
        lastUpdateId = update.update_id;
        await handleUpdate(update);
      }
    }
  } catch (err: any) {
    console.error("⚠️ Erreur Polling Telegram :", err.message);
  } finally {
    setTimeout(pollUpdates, 1000);
  }
}

/**
 * Gestion centralisée des événements (Commandes & Boutons)
 */
async function handleUpdate(update: any) {
  // 1. Gestion des clics sur les boutons (Callback Queries)
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;
    const messageId = cb.message.message_id;
    const data = cb.data;

    await answerCallbackQuery(cb.id, "Traitement en cours...");

    if (data === "action_main_menu") {
      await editMessage(
        chatId,
        messageId,
        "🎛️ **Panneau de Contrôle - Video Weaver**\n\nChoisissez une action ci-dessous :",
        getMainMenuInlineKeyboard()
      );
    } else if (data === "action_publish") {
      await editMessage(chatId, messageId, "⏳ **Lancement du pipeline de publication complet...**\n\n_GitHub Actions exécute le rendu et la publication sur TikTok._");
      const ok = await triggerWorkflow("render.yml", { mode: "publish", chat_id: String(chatId) });
      if (!ok) {
        await sendMessage(chatId, "❌ Échec du déclenchement du workflow sur GitHub.");
      }
    } else if (data === "action_preview") {
      await editMessage(chatId, messageId, "⏳ **Génération de l'aperçu en cours...**\n\n_Rendu vidéo uniquement, sans publication._");
      const ok = await triggerWorkflow("render.yml", { mode: "preview", chat_id: String(chatId) });
      if (!ok) {
        await sendMessage(chatId, "❌ Échec du déclenchement du workflow sur GitHub.");
      }
    } else if (data === "action_regenerate") {
      await editMessage(chatId, messageId, "⏳ **Régénération du quiz en cours...**");
      const ok = await triggerWorkflow("render.yml", { mode: "regenerate", chat_id: String(chatId) });
      if (!ok) {
        await sendMessage(chatId, "❌ Échec du déclenchement sur GitHub.");
      }
    } else if (data === "action_reset_topics_confirm") {
      await editMessage(
        chatId,
        messageId,
        "⚠️ **ATTENTION : Réinitialisation des Thèmes**\n\nCette action va effacer la liste des sujets déjà abordés (`used_topics`) dans `history.json` sur GitHub.\n\nÊtes-vous sûr de vouloir repartir sur une base vierge ?",
        getResetConfirmInlineKeyboard()
      );
    } else if (data === "action_reset_topics_do") {
      await editMessage(chatId, messageId, "⏳ **Nettoyage de `history.json` sur GitHub en cours...**");
      
      // 1. Réinitialisation sur GitHub
      const result = await resetHistoryTopicsOnGitHub();

      // 2. Réinitialisation locale sur le serveur si le fichier existe
      const localHistoryPath = path.join(ROOT_DIR, "history.json");
      if (fs.existsSync(localHistoryPath)) {
        try {
          fs.writeFileSync(localHistoryPath, JSON.stringify({ used_topics: [] }, null, 2), "utf8");
        } catch (e) {
          console.warn("⚠️ Impossible de nettoyer le fichier local history.json :", e);
        }
      }

      await editMessage(
        chatId,
        messageId,
        `${result.message}\n\n🎛️ **Panneau de Contrôle :**`,
        getMainMenuInlineKeyboard()
      );
    } else if (data === "action_status") {
      await editMessage(
        chatId,
        messageId,
        `🟢 **Statut du Bot :** Opérationnel\n📂 **Dépôt :** \`${CONFIG.repoOwner}/${CONFIG.repoName}\`\n🌿 **Branche :** \`${CONFIG.defaultBranch}\``,
        getMainMenuInlineKeyboard()
      );
    }
    return;
  }

  // 2. Gestion des messages textes / commandes
  if (update.message && update.message.text) {
    const msg = update.message;
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    if (text === "/start" || text === "/menu") {
      await sendMessage(
        chatId,
        "🎛️ **Panneau de Contrôle - Video Weaver**\n\nSélectionnez l'action souhaitée :",
        getMainMenuInlineKeyboard()
      );
    } else if (text === "/reset_topics") {
      await sendMessage(
        chatId,
        "⚠️ **Confirmer la suppression des thèmes enregistrés ?**",
        getResetConfirmInlineKeyboard()
      );
    }
  }
}

// Lancement de la boucle
pollUpdates();
