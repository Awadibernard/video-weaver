/**
 * tts.ts — Synthèse vocale à 2 niveaux avec bascule automatique.
 *
 *  NIVEAU 1 : Unreal Speech   (UNREAL_SPEECH_API_KEY, UNREAL_SPEECH_VOICE)
 *  NIVEAU 2 : Edge TTS        (gratuit, binaire `edge-tts`)
 *
 * Chaque bascule déclenche une alerte Telegram (si TELEGRAM_BOT_TOKEN +
 * TELEGRAM_CHAT_ID sont présents) et est consignée dans public/tts-status.json.
 *
 * ⚠️ Seul le texte AUDIO (`text_audio`, en toutes lettres) doit être passé ici.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(__dirname, "..");
const STATUS_FILE = path.join(ROOT, "public", "tts-status.json");

// Configuration Unreal Speech (Niveau 1)
const UNREAL_KEY = (process.env.UNREAL_SPEECH_API_KEY || "").trim();
const UNREAL_VOICE = process.env.UNREAL_SPEECH_VOICE || "Scarlett";

// Configuration Edge TTS (Niveau 2)
const EDGE_VOICE = process.env.EDGE_TTS_VOICE || "fr-FR-DeniseNeural";
const EDGE_VOICE_FALLBACK = "fr-FR-VivienneMultilingualNeural";

export type TtsEngine = "unrealspeech" | "edge-tts" | "none";

export type TtsStatus = {
  /** Moteur ayant produit le DERNIER bloc audio réussi. */
  engine: TtsEngine;
  /** Détail lisible (ex: "Unreal Speech (Scarlett)"). */
  engineLabel: string;
  unrealSpeechAvailable: boolean;
  blocks: { ok: number; failed: number };
  events: string[];
};

const status: TtsStatus = {
  engine: "none",
  engineLabel: "aucun",
  unrealSpeechAvailable: Boolean(UNREAL_KEY),
  blocks: { ok: 0, failed: 0 },
  events: [],
};

/** Alerte Telegram non bloquante. */
async function alertTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  console.log(text);
  status.events.push(text);
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_notification: true }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    /* une alerte ne doit jamais casser le pipeline */
  }
}

/** Écrit l'état courant. */
export function writeTtsStatus(): void {
  try {
    fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  } catch {
    /* ignore */
  }
}

export function getTtsStatus(): TtsStatus {
  return status;
}

// ───────────────────────────── NIVEAU 1 : Unreal Speech ─────────────────────────

let unrealDown = false;
let unrealKeyMissingNotified = false;

async function tryUnrealSpeech(text: string, outPath: string): Promise<boolean> {
  // 1. Log explicite si la clé est introuvable (affiché une seule fois pour ne pas spammer)
  if (!UNREAL_KEY) {
    if (!unrealKeyMissingNotified) {
      console.warn("⚠️ Unreal Speech ignoré : La clé API (UNREAL_SPEECH_API_KEY) est vide ou manquante. Bascule immédiate sur Edge TTS.");
      unrealKeyMissingNotified = true;
    }
    return false;
  }

  if (unrealDown) return false;

  try {
    const res = await fetch("https://api.v8.unrealspeech.com/stream", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${UNREAL_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        Text: text,
        VoiceId: UNREAL_VOICE,
        Bitrate: "192k",
        Speed: 0,
        Pitch: 1.0,
        Codec: "libmp3lame",
      }),
      signal: AbortSignal.timeout(120_000),
    });

    // 2. Extraction du message d'erreur exact renvoyé par l'API
    if (!res.ok) {
      const errorBody = await res.text().catch(() => "Impossible de lire le corps de l'erreur");
      throw new Error(`HTTP ${res.status} - ${res.statusText} | Détails API : ${errorBody}`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) {
      throw new Error(`Réponse audio invalide ou trop petite (${buf.length} octets)`);
    }

    fs.writeFileSync(outPath, buf);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 3. Affichage bien visible du crash dans les logs
    console.warn(`❌ Erreur fatale Unreal Speech : ${msg}`);
    unrealDown = true;
    status.unrealSpeechAvailable = false;
    await alertTelegram(`⚠️ Unreal Speech indisponible : ${msg}. Bascule sur Edge TTS...`);
    return false;
  }
}

// ───────────────────────────── NIVEAU 2 : Edge TTS ───────────────────────────

let edgeMissingNotified = false;

function runEdgeTts(text: string, outPath: string, voice: string): boolean {
  try {
    execFileSync("edge-tts", ["--voice", voice, "--text", text, "--write-media", outPath], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 180_000,
    });
    return fs.existsSync(outPath) && fs.statSync(outPath).size > 1024;
  } catch {
    return false;
  }
}

async function tryEdgeTts(text: string, outPath: string): Promise<boolean> {
  if (runEdgeTts(text, outPath, EDGE_VOICE)) return true;
  if (runEdgeTts(text, outPath, EDGE_VOICE_FALLBACK)) return true;
  if (!edgeMissingNotified) {
    edgeMissingNotified = true;
    await alertTelegram("❌ Edge TTS indisponible (binaire `edge-tts` absent ?) — piste muette.");
  }
  return false;
}

// ───────────────────────────── Point d'entrée ────────────────────────────────

export async function synthesizeSpeech(textAudio: string, outPath: string): Promise<TtsEngine> {
  const text = (textAudio || "").trim();
  if (!text) return "none";

  if (await tryUnrealSpeech(text, outPath)) {
    status.engine = "unrealspeech";
    status.engineLabel = `Unreal Speech (${UNREAL_VOICE})`;
    status.blocks.ok++;
    writeTtsStatus();
    return "unrealspeech";
  }

  if (await tryEdgeTts(text, outPath)) {
    status.engine = "edge-tts";
    status.engineLabel = `Edge TTS (${EDGE_VOICE})`;
    status.blocks.ok++;
    writeTtsStatus();
    return "edge-tts";
  }

  status.blocks.failed++;
  writeTtsStatus();
  console.warn("⚠️  Aucun moteur TTS n'a pu générer :", text.slice(0, 60));
  return "none";
  }
