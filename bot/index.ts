/**
 * index.ts — TOUR DE CONTRÔLE TELEGRAM en LONG POLLING (autonome).
 *
 * Lancement : `npm start` dans bot/ (ou `tsx bot/index.ts` à la racine).
 * Aucune plateforme serverless, aucun webhook : le bot interroge Telegram
 * en continu via getUpdates (polling: true) et lit ses variables dans `.env`.
 *
 * Commandes :
 *   /start | /help        → aide
 *   /preview [sujet]      → génère une vidéo SANS publier
 *   /publish              → publie la dernière vidéo rendue sur TikTok
 *   /schedule HH:MM       → met à jour config/schedule.json (heure GMT)
 *   /schedule off         → désactive la planification
 *   /status               → état de la planification
 *   fichier .json envoyé  → écrase quiz.json puis relance un rendu
 */
import { loadEnv } from "./lib/env";

loadEnv();

import { dispatchWorkflow, getFile, putFile, actionsUrl } from "./lib/github";
import {
  sendMessage,
  answerCallbackQuery,
  downloadFile,
  isAuthorized,
  getUpdates,
  deleteWebhook,
  VIDEO_BUTTONS,
} from "./lib/telegram";

const RENDER_WORKFLOW = "render.yml";
const ZOOM_STEP = 0.05;
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 1.0;
const POLL_TIMEOUT_SEC = 30;

const HELP = `🎬 <b>Tour de contrôle Tikmation</b>

/preview <i>[sujet]</i> — génère une vidéo test (sans publication)
/publish — publie la dernière vidéo sur TikTok
/schedule — liste les créneaux de publication
/schedule add HH:MM — ajoute un créneau (heure GMT)
/schedule remove HH:MM — supprime un créneau
/schedule clear — supprime tous les créneaux
/schedule on | off — active / désactive la planification
/status — état actuel de la planification

📎 Envoie un fichier <code>.json</code> pour écraser <code>quiz.json</code> et lancer un rendu.`;

/** Configuration de planification (plusieurs créneaux HH:MM en heure GMT). */
type ScheduleConfig = {
  enabled: boolean;
  times: string[];
  timezone: string;
  chat_id: string;
};

function normalizeTime(raw: string): string | null {
  const m = (raw || "").trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}

/** Lit config/schedule.json (compatible avec l'ancien format `time`). */
async function readSchedule(): Promise<ScheduleConfig> {
  const file = await getFile("config/schedule.json");
  if (!file) return { enabled: false, times: [], timezone: "GMT", chat_id: "" };
  let raw: any = {};
  try {
    raw = JSON.parse(file.content);
  } catch {
    raw = {};
  }
  const times: string[] = Array.isArray(raw.times)
    ? raw.times.map((t: unknown) => normalizeTime(String(t))).filter(Boolean)
    : [];
  const legacy = normalizeTime(String(raw.time || ""));
  if (legacy && !times.includes(legacy)) times.push(legacy);
  return {
    enabled: Boolean(raw.enabled) && times.length > 0,
    times: times.sort(),
    timezone: "GMT",
    chat_id: String(raw.chat_id || ""),
  };
}

async function writeSchedule(cfg: ScheduleConfig, message: string): Promise<void> {
  await putFile(
    "config/schedule.json",
    JSON.stringify({ enabled: cfg.enabled, times: cfg.times, timezone: "GMT", chat_id: cfg.chat_id }, null, 2),
    message,
  );
}

function renderSchedule(cfg: ScheduleConfig): string {
  if (!cfg.times.length) return "🗓️ Aucun créneau enregistré.\nAjoute-en un : <code>/schedule add 07:00</code>";
  const list = cfg.times.map((t) => `• <b>${t} GMT</b>`).join("\n");
  return `${cfg.enabled ? "🗓️ Planification active" : "⏸️ Planification désactivée"} — ${cfg.times.length} créneau(x) :\n${list}\n\n<i>Le cron GitHub vérifie chaque heure.</i>`;
}


/** Lance le workflow de rendu. */
async function triggerRender(opts: {
  chatId: number | string;
  mode: "preview" | "publish" | "regenerate";
  topic?: string;
  skipGenerate?: boolean;
}) {
  await dispatchWorkflow(RENDER_WORKFLOW, {
    mode: opts.mode,
    topic: opts.topic || "",
    skip_generate: opts.skipGenerate ? "true" : "false",
    chat_id: String(opts.chatId),
  });
}

/** Modifie `uiScale` dans quiz.json (tous les items) puis relance un rendu. */
async function applyZoom(chatId: number | string, direction: "in" | "out"): Promise<string> {
  const file = await getFile("quiz.json");
  if (!file) return "❌ quiz.json introuvable sur le dépôt.";
  const questions = JSON.parse(file.content) as Array<Record<string, unknown>>;
  const current = Number(questions[0]?.uiScale ?? 0.85);
  const next = Math.min(
    ZOOM_MAX,
    Math.max(ZOOM_MIN, Number((current + (direction === "in" ? ZOOM_STEP : -ZOOM_STEP)).toFixed(2))),
  );
  if (next === current) return `⚠️ Zoom déjà au maximum autorisé (${current}).`;
  for (const q of questions) q.uiScale = next;
  await putFile("quiz.json", JSON.stringify(questions, null, 2), `chore(bot): uiScale ${current} → ${next}`);
  await triggerRender({ chatId, mode: "regenerate", skipGenerate: true });
  return `🔍 uiScale : <b>${current} → ${next}</b>\n♻️ Rendu rapide relancé (sans nouvelle génération IA).\n${actionsUrl()}`;
}

async function handleCommand(chatId: number, text: string) {
  const [cmdRaw, ...rest] = text.trim().split(/\s+/);
  const cmd = cmdRaw.split("@")[0].toLowerCase();
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "/start":
    case "/help":
      return sendMessage(chatId, HELP);

    case "/preview": {
      await triggerRender({ chatId, mode: "preview", topic: arg });
      return sendMessage(
        chatId,
        `🎬 Génération lancée${arg ? ` sur le sujet : <b>${arg}</b>` : ""} (sans publication).\n⏳ Je t'envoie le lien de la vidéo dès que c'est prêt.\n${actionsUrl()}`,
      );
    }

    case "/publish": {
      await dispatchWorkflow(RENDER_WORKFLOW, {
        mode: "publish-only",
        topic: "",
        skip_generate: "true",
        chat_id: String(chatId),
      });
      return sendMessage(chatId, `🚀 Publication TikTok lancée.\n${actionsUrl()}`);
    }

    case "/schedule": {
      const [sub, ...subRest] = arg.split(/\s+/).filter(Boolean);
      const value = subRest.join(" ").trim();
      const action = (sub || "").toLowerCase();

      if (!action || action === "list") {
        const cfg = await readSchedule();
        return sendMessage(chatId, renderSchedule(cfg));
      }

      if (action === "off") {
        const cfg = await readSchedule();
        await writeSchedule({ ...cfg, enabled: false, chat_id: String(chatId) }, "chore(bot): planification désactivée");
        return sendMessage(chatId, "⏸️ Planification désactivée (les créneaux sont conservés).");
      }

      if (action === "on") {
        const cfg = await readSchedule();
        if (!cfg.times.length)
          return sendMessage(chatId, "❌ Aucun créneau enregistré. Ajoute-en un : <code>/schedule add 07:00</code>");
        await writeSchedule({ ...cfg, enabled: true, chat_id: String(chatId) }, "chore(bot): planification réactivée");
        return sendMessage(chatId, renderSchedule({ ...cfg, enabled: true }));
      }

      if (action === "clear") {
        await writeSchedule(
          { enabled: false, times: [], timezone: "GMT", chat_id: String(chatId) },
          "chore(bot): tous les créneaux supprimés",
        );
        return sendMessage(chatId, "🗑️ Tous les créneaux ont été supprimés.");
      }

      if (action === "add" || action === "remove" || action === "del") {
        const time = normalizeTime(value);
        if (!time) return sendMessage(chatId, "❌ Format invalide. Utilise <code>HH:MM</code> en heure GMT (ex: 07:00).");
        const cfg = await readSchedule();
        if (action === "add") {
          if (cfg.times.includes(time)) return sendMessage(chatId, `⚠️ Le créneau <b>${time} GMT</b> existe déjà.`);
          cfg.times = [...cfg.times, time].sort();
          cfg.enabled = true;
        } else {
          if (!cfg.times.includes(time)) return sendMessage(chatId, `⚠️ Aucun créneau <b>${time} GMT</b> enregistré.`);
          cfg.times = cfg.times.filter((t) => t !== time);
          if (!cfg.times.length) cfg.enabled = false;
        }
        cfg.chat_id = String(chatId);
        await writeSchedule(cfg, `chore(bot): créneau ${action === "add" ? "ajouté" : "supprimé"} ${time} GMT`);
        return sendMessage(chatId, `${action === "add" ? "➕" : "➖"} <b>${time} GMT</b>\n\n${renderSchedule(cfg)}`);
      }

      // Raccourci historique : `/schedule 18:30` = ajout d'un créneau.
      const time = normalizeTime(action);
      if (!time)
        return sendMessage(
          chatId,
          "Usage :\n<code>/schedule</code> — liste des créneaux\n<code>/schedule add HH:MM</code>\n<code>/schedule remove HH:MM</code>\n<code>/schedule clear</code>\n<code>/schedule on</code> | <code>/schedule off</code>",
        );
      const cfg = await readSchedule();
      if (cfg.times.includes(time)) return sendMessage(chatId, `⚠️ Le créneau <b>${time} GMT</b> existe déjà.`);
      cfg.times = [...cfg.times, time].sort();
      cfg.enabled = true;
      cfg.chat_id = String(chatId);
      await writeSchedule(cfg, `chore(bot): créneau ajouté ${time} GMT`);
      return sendMessage(chatId, `➕ <b>${time} GMT</b>\n\n${renderSchedule(cfg)}`);
    }

    case "/status": {
      const cfg = await readSchedule();
      return sendMessage(chatId, renderSchedule(cfg));
    }


    default:
      return sendMessage(chatId, HELP);
  }
}

async function handleDocument(chatId: number, doc: { file_id: string; file_name?: string }) {
  if (!doc.file_name?.toLowerCase().endsWith(".json")) {
    return sendMessage(chatId, "❌ Envoie un fichier <code>.json</code>.");
  }
  const content = await downloadFile(doc.file_id);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return sendMessage(chatId, "❌ JSON invalide (impossible à parser).");
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  await putFile("quiz.json", JSON.stringify(arr, null, 2), `chore(bot): quiz.json remplacé via Telegram`);
  await triggerRender({ chatId, mode: "preview", skipGenerate: true });
  return sendMessage(chatId, `✅ <code>quiz.json</code> mis à jour (${arr.length} question(s)).\n🎬 Rendu lancé.\n${actionsUrl()}`);
}

async function handleUpdate(update: any) {
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message?.chat?.id;
    await answerCallbackQuery(cq.id, "⏳ En cours...");
    if (!isAuthorized(chatId)) return;

    const data: string = cq.data || "";
    if (data.startsWith("zoom:")) {
      const msg = await applyZoom(chatId, data.endsWith("in") ? "in" : "out");
      await sendMessage(chatId, msg, VIDEO_BUTTONS);
    } else if (data === "publish") {
      await dispatchWorkflow(RENDER_WORKFLOW, {
        mode: "publish-only",
        topic: "",
        skip_generate: "true",
        chat_id: String(chatId),
      });
      await sendMessage(chatId, `🚀 Publication TikTok lancée.\n${actionsUrl()}`);
    }
    return;
  }

  const message = update.message || update.channel_post;
  if (!message) return;
  const chatId = message.chat.id;
  if (!isAuthorized(chatId)) {
    await sendMessage(chatId, `⛔ Chat non autorisé (id: <code>${chatId}</code>).`);
    return;
  }
  if (message.document) await handleDocument(chatId, message.document);
  else if (message.text) await handleCommand(chatId, message.text);
}

/** Boucle de long polling (getUpdates). */
async function main() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN manquant — renseigne-le dans le fichier .env");
  }
  // Un webhook actif désactive getUpdates : on le supprime au démarrage.
  await deleteWebhook().catch(() => {});
  console.log("🤖 Bot Telegram démarré en long polling. Ctrl+C pour arrêter.");

  let offset: number | undefined;
  let running = true;
  process.on("SIGINT", () => {
    running = false;
    console.log("\n👋 Arrêt du bot.");
    process.exit(0);
  });

  while (running) {
    try {
      const updates = await getUpdates(offset, POLL_TIMEOUT_SEC);
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await handleUpdate(update);
        } catch (e) {
          const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
          const detail = e instanceof Error ? e.message : String(e);
          console.error(e);
          if (chatId) await sendMessage(chatId, `❌ Erreur : <code>${detail.slice(0, 500)}</code>`).catch(() => {});
        }
      }
    } catch (e) {
      console.error("⚠️ Polling error:", e instanceof Error ? e.message : e);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
