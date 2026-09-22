/**
 * prepare.ts
 *
 * Exécuté avant `remotion render`. Génère le son et les images,
 * puis calcule la timeline et écrit public/props.json.
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pickRandomFile(dir: string, exts: string[]): string | null {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => exts.some((e) => f.toLowerCase().endsWith(e)));
  if (!files.length) return null;
  return files[Math.floor(Math.random() * files.length)];
}

/** 1. Génération d'image via Cloudflare Workers AI (FLUX.1-schnell) */
async function fetchCloudflareImage(promptText: string, outPath: string): Promise<boolean> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const model = process.env.CLOUDFLARE_MODEL || "@cf/black-forest-labs/flux-1-schnell";

  if (!accountId || !apiToken) {
    console.warn("  ⚠️ Cloudflare AI ignoré : CLOUDFLARE_ACCOUNT_ID ou CLOUDFLARE_API_TOKEN non défini dans les secrets.");
    return false;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: promptText,
          steps: 4,
        }),
        signal: AbortSignal.timeout(25_000),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const contentType = res.headers.get("content-type") || "";

      // Si Cloudflare renvoie directement le flux binaire d'image
      if (contentType.includes("image/")) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 1024) throw new Error("Image binaire reçue trop petite/invalide");
        fs.writeFileSync(outPath, buf);
        return true;
      }

      // Si Cloudflare renvoie un objet JSON avec base64
      const data = (await res.json()) as any;
      if (data?.result?.image) {
        const buf = Buffer.from(data.result.image, "base64");
        if (buf.length < 1024) throw new Error("Image base64 reçue trop petite/invalide");
        fs.writeFileSync(outPath, buf);
        return true;
      }
    } catch (e) {
      console.warn(`  ↻ Cloudflare AI (essai ${attempt}/2) : ${e instanceof Error ? e.message : e}`);
      await sleep(1000);
    }
  }
  return false;
}

/** 2. Secours via Pollinations AI */
async function fetchImageFromPollinations(promptText: string, outPath: string): Promise<boolean> {
  const encodedPrompt = encodeURIComponent(promptText);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(
        `https://image.pollinations.ai/prompt/${encodedPrompt}?width=512&height=512&nologo=true&model=flux&seed=${attempt + Math.floor(Math.random() * 1000)}`,
        { signal: AbortSignal.timeout(30_000) },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024) throw new Error(`réponse trop petite (${buf.length} o)`);
      fs.writeFileSync(outPath, buf);
      return true;
    } catch (e) {
      console.warn(`  ↻ Pollinations (essai ${attempt}/2) : ${e instanceof Error ? e.message : e}`);
      await sleep(1000);
    }
  }
  return false;
}

/** 3. Dernier recours : recherche d'image via Wikimedia Commons API */
async function fetchWikimediaImage(queryText: string, outPath: string): Promise<boolean> {
  try {
    const cleanQuery = queryText
      .replace(/[^\w\s\u00C0-\u024F]/gi, " ")
      .trim()
      .split(" ")
      .slice(0, 3)
      .join(" "); // Recherche ciblée sur les 3 premiers mots max

    if (!cleanQuery) return false;

    const searchUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(cleanQuery)}&gsrlimit=1&prop=imageinfo&iiprop=url&format=json`;

    const res = await fetch(searchUrl, {
      headers: { "User-Agent": "VideoWeaverQuiz/1.0 (https://github.com)" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return false;

    const data = (await res.json()) as any;
    const pages = data?.query?.pages;
    if (!pages) return false;

    const pageKey = Object.keys(pages)[0];
    const imageUrl = pages[pageKey]?.imageinfo?.[0]?.url;
    if (!imageUrl || (!imageUrl.endsWith(".jpg") && !imageUrl.endsWith(".png") && !imageUrl.endsWith(".jpeg"))) {
      return false;
    }

    const imgRes = await fetch(imageUrl, {
      headers: { "User-Agent": "VideoWeaverQuiz/1.0 (https://github.com)" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!imgRes.ok) return false;

    const buf = Buffer.from(await imgRes.arrayBuffer());
    if (buf.length < 1024) return false;

    fs.writeFileSync(outPath, buf);
    return true;
  } catch (e) {
    console.warn(`  ↻ Wikimedia Commons fail : ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/** Fonction unifiée de récupération d'image avec cascade stricte */
async function fetchBestImage(promptText: string, optionText: string, outPath: string): Promise<boolean> {
  // 1. Priorité N°1 : Cloudflare Workers AI (FLUX)
  if (await fetchCloudflareImage(promptText, outPath)) {
    console.log(`  🖼️  image : ok (Cloudflare FLUX)`);
    return true;
  }

  // 2. Priorité N°2 : Pollinations AI
  if (await fetchImageFromPollinations(promptText, outPath)) {
    console.log(`  🖼️  image : ok (Pollinations AI)`);
    return true;
  }

  // 3. Priorité N°3 (Dernier recours) : Wikimedia Commons
  if (await fetchWikimediaImage(optionText, outPath)) {
    console.log(`  🖼️  image : ok (Wikimedia Commons)`);
    return true;
  }

  console.log(`  ❌ image : ÉCHEC (Toutes les options d'hébergement/génération ont échoué)`);
  return false;
}

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

function tryExtract(absFile: string, outDir: string): number {
  const out = path.join(outDir, "%04d.png");
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
      if (n === 1) continue;
    } catch {
      continue;
    }
  }
  try {
    return countPngs(outDir);
  } catch {
    return 0;
  }
}

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

  const countdownAnim = extractAnimationFromDir(path.join(PUBLIC, "animations/countdown"), "anim-countdown");
  const ctaAnim = extractAnimationFromDir(path.join(PUBLIC, "animations/cta"), "anim-cta");

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
      const optionText = q.options[j];
      const rel = `generated/q${i}_img${j}.jpg`;
      const abs = path.join(PUBLIC, rel);

      const ok = await fetchBestImage(prompt, optionText, abs);
      images.push(ok ? rel : null);
      await sleep(200);
    }

    const relQ = `generated/q${i}_question.mp3`;
    const relR = `generated/q${i}_reponse.mp3`;
    const relCta = q.ctaText ? `generated/q${i}_cta.mp3` : undefined;

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

  const sfxRel = (rel: string) => (fs.existsSync(path.join(PUBLIC, rel)) ? rel : null);
  const sfx = {
    whoosh: sfxRel(CONFIG.sfx.whoosh),
    timer: sfxRel(CONFIG.sfx.timer),
    correct: sfxRel(CONFIG.sfx.correct),
  };

  const uiScaleRaw = quiz[0]?.uiScale;
  const uiScale =
    typeof uiScaleRaw === "number" && uiScaleRaw > 0.3 && uiScaleRaw <= 1.2
      ? uiScaleRaw
      : CONFIG.uiScale;

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