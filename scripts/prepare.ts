/**
 * prepare.ts
 *
 * Runs BEFORE `remotion render`. Reads quiz.json, calls ElevenLabs + Pollinations,
 * saves images/audio to public/generated/, computes per-question frame timing,
 * and writes public/props.json which the Remotion composition loads
 * through calculateMetadata().
 *
 * This mirrors the original index.html preload logic (fetchElevenLabsAsBuffer,
 * fetchImageFromPollinations, getAnimationIndices, transition selection) but
 * runs once, deterministically, in Node before rendering.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseFile } from "music-metadata";
import type {
  AnimSequence,
  PreparedProps,
  PreparedQuestion,
  QuestionSegment,
  QuizQuestion,
  TransitionInfo,
} from "../src/lib/types";
import { CONFIG } from "../src/config";
import { synthesizeSpeech, writeTtsStatus } from "./tts";


const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const GEN = path.join(PUBLIC, "generated");

const FPS = CONFIG.fps;
const WIDTH = CONFIG.width;
const HEIGHT = CONFIG.height;

const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "pNInz6obpgDQGcFmaJgB";
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pickRandomFile(dir: string, exts: string[]): string | null {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => exts.some((e) => f.toLowerCase().endsWith(e)));
  if (!files.length) return null;
  return files[Math.floor(Math.random() * files.length)];
}

async function fetchImageFromPollinations(promptText: string, outPath: string): Promise<boolean> {
  const prompt = encodeURIComponent(
    `A crisp realistic studio photograph of ${promptText}, highly detailed 8k, isolated on a pure solid white background, single subject, centered`,
  );
  // 3 tentatives : le service renvoie régulièrement 502/timeout sous charge,
  // ce qui expliquait les images manquantes dans les rendus.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(
        `https://image.pollinations.ai/prompt/${prompt}?width=512&height=512&nologo=true&model=flux&seed=${attempt}`,
        { signal: AbortSignal.timeout(90_000) },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // Un fichier < 1 Ko est une page d'erreur, pas une image.
      if (buf.length < 1024) throw new Error(`réponse trop petite (${buf.length} o)`);
      fs.writeFileSync(outPath, buf);
      return true;
    } catch (e) {
      console.warn(`  ↻ image (essai ${attempt}/3) : ${e instanceof Error ? e.message : e}`);
      await sleep(1500 * attempt);
    }
  }
  return false;
}


/**
 * Génération de la voix off — pipeline 3 niveaux :
 *   ElevenLabs → Fish Audio (8 clés, rotation) → Edge TTS (gratuit).
 * Voir scripts/tts.ts. Le texte reçu ici est TOUJOURS le texte AUDIO
 * (`text_audio`, en toutes lettres), jamais le texte affiché.
 */
async function generateVoice(textAudio: string, outPath: string): Promise<boolean> {
  const engine = await synthesizeSpeech(textAudio, outPath);
  if (engine === "none") return false;
  console.log(`  🗣️  ${path.basename(outPath)} ← ${engine}`);
  return true;
}


async function audioDurationSec(filePath: string): Promise<number> {
  try {
    const meta = await parseFile(filePath);
    return meta.format.duration || 0;
  } catch {
    return 0;
  }
}

/**
 * Décompose une animation en séquence PNG via ffmpeg.
 *
 * Pourquoi : rendus dans une balise <Img>, les GIF/WebP animés sont pilotés par
 * l'horloge murale du navigateur, pas par la timeline Remotion → animation
 * accélérée et bouclée à l'infini. En extrayant les frames, la composition
 * choisit elle-même l'image à afficher : vitesse 1x exacte, lecture unique.
 *
 * ⚠️ IMPORTANT (bug Linux/CI) : la plupart des builds ffmpeg NE SAVENT PAS
 * décoder le WebP *animé* (une seule frame extraite → overlay figé/invisible).
 * On essaie donc plusieurs sources (webm/mp4/gif/apng d'abord, webp en dernier)
 * et plusieurs jeux d'arguments, et on ne valide qu'un résultat > 1 frame.
 */
const ANIM_SOURCE_PRIORITY = [".webm", ".mp4", ".mov", ".gif", ".apng", ".webp", ".png"];

function probeFps(absFile: string): number {
  let sourceFps = 25;
  try {
    const raw = execFileSync(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate", "-of", "csv=p=0", absFile],
      { encoding: "utf8" },
    ).trim();
    const [num, den] = raw.split("/").map(Number);
    if (num && den) sourceFps = num / den;
    else if (num) sourceFps = num;
  } catch {
    /* valeur par défaut */
  }
  if (!isFinite(sourceFps) || sourceFps <= 0) sourceFps = 25;
  return sourceFps;
}

function countPngs(dir: string): number {
  return fs.readdirSync(dir).filter((f) => f.endsWith(".png") && fs.statSync(path.join(dir, f)).size > 0).length;
}

/** Tente l'extraction d'UN fichier source. Renvoie le nombre de frames obtenues. */
function tryExtract(absFile: string, outDir: string): number {
  const out = path.join(outDir, "%04d.png");
  // ⚠️ TRANSPARENCE : sans décodeur explicite, ffmpeg aplatit le canal alpha
  // des WebM VP8/VP9 (alpha stocké dans un plan secondaire) → gros pavé blanc
  // opaque à l'écran. On force donc `libvpx-vp9`/`libvpx` en décodage et
  // `-pix_fmt rgba` en sortie PNG pour conserver la transparence.
  const attempts: string[][] = [
    ["-y", "-v", "error", "-c:v", "libvpx-vp9", "-i", absFile, "-fps_mode", "passthrough", "-pix_fmt", "rgba", out],
    ["-y", "-v", "error", "-c:v", "libvpx", "-i", absFile, "-vsync", "0", "-pix_fmt", "rgba", out],
    ["-y", "-v", "error", "-i", absFile, "-fps_mode", "passthrough", "-pix_fmt", "rgba", out],
    ["-y", "-v", "error", "-i", absFile, "-vsync", "0", "-pix_fmt", "rgba", out],
    ["-y", "-v", "error", "-c:v", "libwebp_anim", "-i", absFile, "-vsync", "0", "-pix_fmt", "rgba", out],
    ["-y", "-v", "error", "-i", absFile, "-vsync", "0", out],
  ];

  for (const args of attempts) {
    try {
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.mkdirSync(outDir, { recursive: true });
      execFileSync("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
      const n = countPngs(outDir);
      if (n > 1) return n;
      if (n === 1) continue; // probablement un WebP animé mal décodé → on tente mieux
    } catch {
      continue;
    }
  }
  // Dernier recours : accepter une image fixe si c'est tout ce qu'on a.
  try {
    return countPngs(outDir);
  } catch {
    return 0;
  }
}

/**
 * Cherche la meilleure source d'animation dans `dir` (toutes extensions
 * confondues) et l'extrait en séquence PNG dans public/generated/<outName>.
 */
function extractAnimationFromDir(dir: string, outName: string): AnimSequence | null {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => ANIM_SOURCE_PRIORITY.includes(path.extname(f).toLowerCase()))
    .sort((a, b) => {
      const ia = ANIM_SOURCE_PRIORITY.indexOf(path.extname(a).toLowerCase());
      const ib = ANIM_SOURCE_PRIORITY.indexOf(path.extname(b).toLowerCase());
      return ia - ib;
    });
  if (!files.length) {
    console.warn(`⚠️  Aucune animation trouvée dans ${dir}`);
    return null;
  }

  const outDir = path.join(GEN, outName);
  for (const file of files) {
    const absFile = path.join(dir, file);
    const frameCount = tryExtract(absFile, outDir);
    if (frameCount > 1 || (frameCount === 1 && file === files[files.length - 1])) {
      const sourceFps = probeFps(absFile);
      // Vérification finale : la première frame doit exister et ne pas être vide.
      const first = path.join(outDir, "0001.png");
      if (!fs.existsSync(first) || fs.statSync(first).size === 0) {
        console.warn(`⚠️  Frames illisibles pour ${file}, essai suivant...`);
        continue;
      }
      console.log(`✅ Animation "${outName}" ← ${file} (${frameCount} frames @ ${sourceFps.toFixed(2)}fps)`);
      return {
        dir: `generated/${outName}`,
        frameCount,
        sourceFps,
        durationSec: frameCount / sourceFps,
      };
    }
    console.warn(`⚠️  ${file} : ${frameCount} frame(s) extraite(s) — source suivante...`);
  }

  console.warn(`❌ Extraction impossible pour ${dir} (ffmpeg ne décode pas ces fichiers).`);
  return null;
}

function getAnimationIndices(total: number): number[] {
  const indices: number[] = [];
  let i = Math.floor(Math.random() * 2) + 1;
  while (i < total) {
    indices.push(i);
    i += Math.floor(Math.random() * 2) + 2;
  }
  return indices;
}

function pickTransition(): TransitionInfo | null {
  // 40% cut simple (no transition), 60% animated
  if (Math.random() < 0.4) return null;
  const types: TransitionInfo["type"][] = ["fade", "fade", "swipe-left", "swipe-up"];
  const colors = ["#000000", "#ffffff", "#070a13"];
  return {
    type: types[Math.floor(Math.random() * types.length)],
    color: colors[Math.floor(Math.random() * colors.length)],
  };
}

async function main() {
  fs.mkdirSync(GEN, { recursive: true });

  const quiz: QuizQuestion[] = JSON.parse(fs.readFileSync(path.join(ROOT, "quiz.json"), "utf8"));

  const bgFile = pickRandomFile(path.join(PUBLIC, "images/backgrounds"), [".jpg", ".jpeg", ".png"]);

  // Tic-tac : WAV uniquement (le MP3 est volontairement ignoré : sa compression
  // ajoute un micro-silence qui casse le loop). Priorité au fichier défini dans
  // CONFIG, sinon premier .wav trouvé dans public/audio/ticks/.
  const TICK_DIR = path.join(PUBLIC, "audio/ticks");
  let tickRel: string | null = null;
  if (CONFIG.tickSound.toLowerCase().endsWith(".wav") && fs.existsSync(path.join(PUBLIC, CONFIG.tickSound))) {
    tickRel = CONFIG.tickSound;
  } else {
    const found = pickRandomFile(TICK_DIR, [".wav"]);
    if (found) tickRel = `audio/ticks/${found}`;
  }
  if (!tickRel) {
    console.warn(`⚠️  Aucun tic-tac .wav trouvé dans public/audio/ticks/ (mode: ${CONFIG.tickAudioMode})`);
  } else {
    console.log(`🔊 Tic-tac: ${tickRel} (mode: ${CONFIG.tickAudioMode})`);
  }

  // Animations : sélection automatique de la meilleure source disponible
  // (webm/mp4/gif/apng avant webp — voir extractAnimationFromDir).
  const countdownAnim = extractAnimationFromDir(path.join(PUBLIC, "animations/countdown"), "anim-countdown");
  const ctaAnim = extractAnimationFromDir(path.join(PUBLIC, "animations/cta"), "anim-cta");
  if (countdownAnim)
    console.log(`🎞️  Countdown: ${countdownAnim.frameCount} frames @ ${countdownAnim.sourceFps.toFixed(2)}fps (${countdownAnim.durationSec.toFixed(2)}s)`);
  if (ctaAnim)
    console.log(`🎞️  CTA: ${ctaAnim.frameCount} frames @ ${ctaAnim.sourceFps.toFixed(2)}fps (${ctaAnim.durationSec.toFixed(2)}s)`);

  // Musique de fond aléatoire (si activée dans CONFIG)
  const bgmFile = CONFIG.enableBGM
    ? pickRandomFile(path.join(PUBLIC, "audio/bgm"), [".mp3", ".wav", ".m4a", ".ogg"])
    : null;

  const allowedAnim = getAnimationIndices(quiz.length);
  const prepared: PreparedQuestion[] = [];

  for (let i = 0; i < quiz.length; i++) {
    const q = quiz[i];
    console.log(`\n▶️  Question ${i + 1}/${quiz.length}: ${q.question}`);

    const images: (string | null)[] = [];
    for (let j = 0; j < 3; j++) {
      const prompt = q.imagePrompts?.[j] || q.options[j];
      const rel = `generated/q${i}_img${j}.jpg`;
      const abs = path.join(PUBLIC, rel);
      const ok = await fetchImageFromPollinations(prompt, abs);
      images.push(ok ? rel : null);
      console.log(`  🖼️  image ${j + 1}: ${ok ? "ok" : "FAIL"}`);
      await sleep(200);
    }

    const relQ = `generated/q${i}_question.mp3`;
    const relR = `generated/q${i}_reponse.mp3`;
    const relCta = q.ctaText ? `generated/q${i}_cta.mp3` : undefined;

    // ⚠️ TTS = texte AUDIO uniquement (toutes lettres), jamais le texte affiché.
    const okQ = await generateVoice(q.questionAudio || q.question, path.join(PUBLIC, relQ));
    const okR = await generateVoice(
      `Bonne réponse ! C'était l'option ${["A", "B", "C"][q.correct]}. ${q.explanationAudio || q.explanation}`,
      path.join(PUBLIC, relR),
    );
    const okCta =
      q.ctaText && relCta
        ? await generateVoice(q.ctaTextAudio || q.ctaText, path.join(PUBLIC, relCta))
        : false;


    const durQ = okQ ? await audioDurationSec(path.join(PUBLIC, relQ)) : 4.5;
    const durR = okR ? await audioDurationSec(path.join(PUBLIC, relR)) : 4.0;
    const durCta = okCta && relCta ? await audioDurationSec(path.join(PUBLIC, relCta)) : q.ctaText ? 2.5 : 0;

    prepared.push({
      ...q,
      images,
      audioQuestion: okQ ? relQ : null,
      audioReponse: okR ? relR : null,
      audioCta: okCta && relCta ? relCta : null,
      audioQuestionDurationSec: durQ,
      audioReponseDurationSec: durR,
      audioCtaDurationSec: durCta,
      showCountdownAnim: allowedAnim.includes(i),
      transition: i < quiz.length - 1 ? pickTransition() : null,
    });
  }

  // --- Timeline (mirrors startAutomation in index.html) ---
  const introFrames = Math.round((CONFIG.introMs / 1000) * FPS);
  const outroFrames = Math.round((CONFIG.outroMs / 1000) * FPS);
  const transitionFrames = Math.round((CONFIG.transitionDurationMs / 1000) * FPS);
  const countdownFrames = CONFIG.countdownSeconds * FPS;

  const segments: QuestionSegment[] = [];
  let cursor = introFrames;

  for (let i = 0; i < prepared.length; i++) {
    const q = prepared[i];
    const readingFrames = Math.ceil(q.audioQuestionDurationSec * FPS) + Math.round(0.3 * FPS);
    const revealFrames = Math.ceil(q.audioReponseDurationSec * FPS) + Math.round(0.5 * FPS);
    const ctaFrames =
      q.ctaText && i === prepared.length - 1
        ? Math.ceil((q.audioCtaDurationSec || 0) * FPS) + Math.round(1.5 * FPS)
        : 0;
    const trFrames = i < prepared.length - 1 ? transitionFrames : 0;

    const total = readingFrames + countdownFrames + revealFrames + ctaFrames + trFrames;
    segments.push({
      index: i,
      startFrame: cursor,
      readingFrames,
      countdownFrames,
      revealFrames,
      ctaFrames,
      transitionFrames: trFrames,
      totalFrames: total,
      transition: q.transition,
    });
    cursor += total;
  }

  const totalFrames = cursor + outroFrames;

  // --- SFX (public/sfx/) : chaque fichier absent est simplement ignoré ---
  const sfxRel = (rel: string) => (fs.existsSync(path.join(PUBLIC, rel)) ? rel : null);
  const sfx = {
    whoosh: sfxRel(CONFIG.sfx.whoosh),
    timer: sfxRel(CONFIG.sfx.timer),
    correct: sfxRel(CONFIG.sfx.correct),
  };
  Object.entries(sfx).forEach(([k, v]) =>
    console.log(v ? `🔉 SFX ${k}: ${v}` : `➖ SFX ${k}: absent (ignoré)`),
  );

  // Échelle de l'UI : valeur du JSON IA si fournie, sinon CONFIG
  const uiScaleRaw = quiz[0]?.uiScale;
  const uiScale =
    typeof uiScaleRaw === "number" && uiScaleRaw > 0.3 && uiScaleRaw <= 1.2
      ? uiScaleRaw
      : CONFIG.uiScale;
  console.log(`📐 uiScale: ${uiScale}`);

  const props: PreparedProps = {
    fps: FPS,
    width: WIDTH,
    height: HEIGHT,
    introFrames,
    outroFrames,
    transitionFrames,
    questions: prepared,
    background: bgFile ? `images/backgrounds/${bgFile}` : null,
    tickSound: tickRel,
    bgm: bgmFile ? `audio/bgm/${bgmFile}` : null,
    uiScale,
    sfx,
    countdownAnim,
    ctaAnim,
    segments,
    totalFrames,
  };

  fs.writeFileSync(path.join(PUBLIC, "props.json"), JSON.stringify(props, null, 2));
  // Bilan TTS (moteur final, clés Fish restantes) → rapport Telegram.
  writeTtsStatus();
  console.log(
    `\n✅ Préparation terminée — ${prepared.length} questions, ${totalFrames} frames @ ${FPS}fps ` +
      `(${(totalFrames / FPS).toFixed(1)}s).`,
  );

}

main().catch((e) => {
  console.error("❌ prepare.ts a échoué:", e);
  process.exit(1);
});
