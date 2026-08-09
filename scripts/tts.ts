/**
 * tts.ts — Synthèse vocale à 3 niveaux avec bascule automatique.
 *
 *  NIVEAU 1 : ElevenLabs      (ELEVENLABS_API_KEY)
 *  NIVEAU 2 : Cartesia AI     (CARTESIA_API_KEY, CARTESIA_VOICE_ID)
 *  NIVEAU 3 : Edge TTS        (gratuit, binaire `edge-tts`)
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

const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB";
const ELEVEN_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";

const CARTESIA_KEY = (process.env.CARTESIA_API_KEY || "").trim();
const CARTESIA_VOICE_ID = process.env.CARTESIA_VOICE_ID || "a0e99841-438c-4a64-b679-ae501e7d6091";
const CARTESIA_MODEL_ID = process.env.CARTESIA_MODEL_ID || "sonic-multilingual";

const EDGE_VOICE = process.env.EDGE_TTS_VOICE || "fr-BE-GerardNeural";
const EDGE_VOICE_FALLBACK = "fr-FR-RemyMultilingualNeural";

export type TtsEngine = "elevenlabs" | "cartesia" | "edge-tts" | "none";

export type TtsStatus = {
  /** Moteur ayant produit le DERNIER bloc audio réussi. */
  engine: TtsEngine;
  /** Détail lisible (ex: "Cartesia AI"). */
  engineLabel: string;
  elevenlabsAvailable: boolean;
  cartesiaAvailable: boolean;
  blocks: { ok: number; failed: number };
  events: string[];
};

const status: TtsStatus = {
  engine: "none",
  engineLabel: "aucun",
  elevenlabsAvailable: true,
  cartesiaAvailable: true,
  blocks: { ok: 0, failed: 0 },
  events: [],
};

const splitKeys = (raw: string | undefined) =>
  (raw || "")
    .split(/[,\n]/)
    .map((k) => k.trim())
    .filter(Boolean);

const elevenKeys = splitKeys(process.env.ELEVENLABS_API_KEY);

status.elevenlabsAvailable = elevenKeys.length > 0;
status.cartesiaAvailable = Boolean(CARTESIA_KEY);

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

// ───────────────────────────── NIVEAU 1 : ElevenLabs ─────────────────────────

let elevenDown = false;

async function tryElevenLabs(text: string, outPath: string): Promise<boolean> {
  if (elevenDown || !elevenKeys.length) return false;
  for (const key of elevenKeys) {
    try {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}?output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "xi-api-key": key },
          body: JSON.stringify({
            text,
            model_id: ELEVEN_MODEL_ID,
            voice_settings: { stability: 0.45, similarity_boost: 0.75 },
          }),
          signal: AbortSignal.timeout(120_000),
        },
      );
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024) continue;
      fs.writeFileSync(outPath, buf);
      return true;
    } catch {
      continue;
    }
  }
  elevenDown = true;
  status.elevenlabsAvailable = false;
  await alertTelegram("⚠️ ElevenLabs indisponible. Bascule sur Cartesia AI...");
  return false;
}

// ───────────────────────────── NIVEAU 2 : Cartesia AI ────────────────────────

let cartesiaDown = false;

async function tryCartesia(text: string, outPath: string): Promise<boolean> {
  if (cartesiaDown || !CARTESIA_KEY) return false;
  try {
    const res = await fetch("https://api.cartesia.ai/tts/bytes", {
      method: "POST",
      headers: {
        "Cartesia-Version": "2024-06-10",
        "X-API-Key": CARTESIA_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model_id: CARTESIA_MODEL_ID,
        transcript: text,
        voice: {
          mode: "id",
          id: CARTESIA_VOICE_ID,
        },
        output_format: {
          container: "mp3",
          bit_rate: 128000,
          sample_rate: 44100,
        },
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) throw new Error(`réponse trop petite (${buf.length} o)`);
    fs.writeFileSync(outPath, buf);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`  ↻ Cartesia AI : ${msg}`);
    cartesiaDown = true;
    status.cartesiaAvailable = false;
    await alertTelegram("⚠️ Cartesia AI indisponible. Bascule sur Edge TTS...");
    return false;
  }
}

// ───────────────────────────── NIVEAU 3 : Edge TTS ───────────────────────────

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

  if (await tryElevenLabs(text, outPath)) {
    status.engine = "elevenlabs";
    status.engineLabel = "ElevenLabs";
    status.blocks.ok++;
    writeTtsStatus();
    return "elevenlabs";
  }

  if (await tryCartesia(text, outPath)) {
    status.engine = "cartesia";
    status.engineLabel = "Cartesia AI";
    status.blocks.ok++;
    writeTtsStatus();
    return "cartesia";
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