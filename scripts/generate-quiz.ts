/**
 * generate-quiz.ts — ÉTAPE 1 du pipeline.
 *
 * Génère un quiz de N questions via Groq (Llama-3), N étant tiré au sort par
 * un algorithme pondéré (voir scripts/question-count.ts), puis écrit :
 *  - input/metadata.json  → utilisé par scripts/upload.ts (légende TikTok)
 *  - quiz.json            → consommé par scripts/prepare.ts (rendu vidéo)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { QuizQuestion } from "../src/lib/types";
import { getRandomQuestionCount } from "./question-count";

interface HistoryData {
  last_category_index: number;
  categories: string[];
  used_topics: string[];
}

/** Une question du quiz telle que renvoyée par l'IA. */
export interface QuizItem {
  /** Texte AFFICHÉ (chiffres/symboles autorisés). */
  question: string;
  /** Texte LU par le TTS (tout en toutes lettres). */
  questionAudio: string;
  options: [string, string, string];
  answer: string;
  /** Index (0-2) de la bonne réponse dans `options`. */
  correct: 0 | 1 | 2;
  /** Explication AFFICHÉE. */
  explanation: string;
  /** Explication LUE par le TTS (toutes lettres). */
  explanationAudio: string;
  /** Un prompt d'image par option (génération Pollinations). */
  imagePrompts: [string, string, string];
  /** Emojis PROPRES à cette question (affichés sous l'énoncé). */
  emojis: string[];
}

/** Modèle JSON complet attendu par le moteur vidéo ET par l'upload. */
export interface QuizMetadata {
  topic: string;
  description: string;
  hashtags: string[];
  /** Motif / thème visuel du design (ex: "space", "nature", "neon"). */
  motif: string;
  /** Échelle du bloc quiz dans la vidéo (0.7 - 1.0, défaut 0.85). */
  uiScale: number;
  /** Appel à l'action précis affiché en fin de vidéo. */
  cta: string;
  /** Même appel à l'action, en toutes lettres, pour la voix off. */
  ctaAudio: string;
  /** Emojis d'ambiance affichés en fond animé. */
  emojis: string[];
  /** Nombre de questions réellement présentes dans la vidéo. */
  questionCount: number;
  questions: QuizItem[];
}

const ROOT = path.resolve(__dirname, "..");
const historyPath = path.join(ROOT, "history.json");
const metadataPath = path.join(ROOT, "input/metadata.json");
const quizPath = path.join(ROOT, "quiz.json");

const defaultHistory: HistoryData = {
  last_category_index: -1,
  categories: [
    "Physique & Astronomie",
    "Biologie & Corps Humain",
    "Chimie & Matière",
    "Sciences de la Terre & Nature",
    "Technologies & Inventions Scientifiques",
    "Neurosciences & Psychologie Scientifique",
  ],
  used_topics: [],
};

const FALLBACK_EMOJIS = ["🔬", "🧪", "✨", "🌍", "⚡", "🧠", "🚀"];
const QUALITY_TAIL = "cinematic lighting, 8k resolution, highly detailed, vivid colors, ultra sharp focus";
const QUALITY_KEYS = [
  "hyper-realistic",
  "photorealistic",
  "cinematic",
  "8k",
  "highly detailed",
  "vivid colors",
  "sharp focus",
  "volumetric",
];

/** Normalise une question renvoyée par l'IA (garde-fous format + prompts). */
function normalizeItem(raw: any, fallbackEmojis: string[] = FALLBACK_EMOJIS): QuizItem {
  if (!Array.isArray(raw?.options) || raw.options.length !== 3) {
    throw new Error("❌ JSON invalide : chaque question doit contenir exactement 3 'options'.");
  }
  const options = raw.options.map((o: unknown) => String(o)) as [string, string, string];
  const foundIndex = options.findIndex((o) => o.trim() === String(raw.answer ?? "").trim());
  const correct = (typeof raw.correct === "number" && raw.correct >= 0 && raw.correct <= 2
    ? raw.correct
    : foundIndex >= 0
      ? foundIndex
      : 0) as 0 | 1 | 2;

  const rawPrompts: string[] =
    Array.isArray(raw.imagePrompts) && raw.imagePrompts.length === 3 ? raw.imagePrompts : options;
  const imagePrompts = rawPrompts.map((p) => {
    let text = String(p || "")
      .trim()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    const score = QUALITY_KEYS.filter((k) => text.toLowerCase().includes(k)).length;
    if (score < 3) {
      text = `A hyper-realistic photorealistic 3D render of ${text.replace(/[.,]+$/, "")}, ${QUALITY_TAIL}`;
    }
    return text;
  }) as [string, string, string];

  const emojis = (Array.isArray(raw.emojis) ? raw.emojis : [])
    .filter((e: unknown) => typeof e === "string" && e.trim().length > 0)
    .map((e: string) => e.trim()) as string[];
  for (const e of fallbackEmojis) {
    if (emojis.length >= 3) break;
    if (!emojis.includes(e)) emojis.push(e);
  }

  const pair = (value: any, legacy: any): { display: string; audio: string } => {
    const src = value ?? legacy;
    if (src && typeof src === "object") {
      const display = String(src.text_display ?? src.display ?? legacy ?? "").trim();
      const audio = String(src.text_audio ?? src.audio ?? display).trim();
      return { display, audio: audio || display };
    }
    const display = String(src ?? "").trim();
    return { display, audio: display };
  };

  const q = pair(raw.question, raw.text_display);
  if (raw.text_audio && !q.audio) q.audio = String(raw.text_audio).trim();
  const qAudio = String(raw.question_audio ?? raw.text_audio ?? q.audio ?? "").trim() || q.display;
  const exp = pair(raw.explanation, null);
  const expAudio = String(raw.explanation_audio ?? exp.audio ?? "").trim() || exp.display;

  return {
    question: q.display,
    questionAudio: qAudio,
    emojis: emojis.slice(0, 7),
    options,
    correct,
    answer: options[correct],
    explanation: exp.display,
    explanationAudio: expAudio,
    imagePrompts,
  };
}

export async function generateQuiz(): Promise<QuizMetadata> {
  console.log("🧠 Étape 1/3 — Génération du sujet via Groq (Llama-3)...");

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("❌ GROQ_API_KEY manquant dans les secrets GitHub.");

  let history: HistoryData = defaultHistory;
  if (fs.existsSync(historyPath)) {
    history = JSON.parse(fs.readFileSync(historyPath, "utf8")) as HistoryData;
  }

  const nextIndex = (history.last_category_index + 1) % history.categories.length;
  const forcedTopic = (process.env.FORCED_TOPIC || "").trim();
  const currentCategory = forcedTopic || history.categories[nextIndex];

  const questionCount = getRandomQuestionCount();

  console.log(`📌 Catégorie sélectionnée : ${currentCategory}${forcedTopic ? " (imposée)" : ""}`);
  console.log(`🎲 Nombre de questions tiré au sort : ${questionCount}`);

  const prompt = `
Tu es un scientifique rigoureux et un expert en vulgarisation pour TikTok.
Génère EXACTEMENT ${questionCount} questions au format JSON sur ce domaine : "${currentCategory}".

CONTRAINTES DE FIABILITÉ STRICTES :
1. Chaque information doit être un FAIT SCIENTIFIQUE AVÉRÉ.
2. Pas de pseudo-science, pas de théories controversées.
3. Les ${questionCount} questions doivent être DIFFÉRENTES.

INTERDICTION STRICTE DE PARLER DE CES SUJETS :
${JSON.stringify(history.used_topics.slice(-100))}

Tu dois répondre UNIQUEMENT avec un objet JSON valide structuré exactement comme ceci :
{
  "topic": "Titre accrocheur et court pour TikTok (ex: 🧠 Test Tes Connaissances en Physique !)",
  "description": "Une phrase d'accroche très captivante pour inciter à regarder et commenter.",
  "hashtags": ["#science", "#quiz", "#cultureg", "#apprendre", "#decouverte"],
  "motif": "Un seul mot-clé visuel parmi: space, nature, human-body, chemistry, tech, brain",
  "cta": { "text_display": "Abonne-toi pour 1 quiz / jour !", "text_audio": "Abonne-toi pour un quiz par jour !" },
  "emojis": ["🔬", "🧪", "✨", "🌍", "⚡", "🧠", "🚀"],
  "uiScale": 0.85,
  "questions": [
    {
      "question": {
        "text_display": "La question posée ? (max 140 caractères)",
        "text_audio": "La même question, entièrement en toutes lettres pour la voix off"
      },
      "options": ["Option A", "Option B", "Option C"],
      "answer": "Le texte EXACT de la bonne réponse, recopié depuis options",
      "correct": 0,
      "explanation": {
        "text_display": "Explication factuelle en 2 phrases simples.",
        "text_audio": "La même explication, entièrement en toutes lettres."
      },
      "imagePrompts": ["english prompt A", "english prompt B", "english prompt C"],
      "emojis": ["7 emojis PROPRES à cette question"]
    }
  ]
}

RÈGLES DE FORMAT :
- "hashtags" : STRICTEMENT ENTRE 3 ET 5 HASHTAGS MAXIMUM. Doivent commencer par #.
- "topic" : Titre principal percutant pour la publication TikTok.
- "description" : Texte engageant pour la légende.
- "questions" : contient EXACTEMENT ${questionCount} éléments.
- "options" : 3 éléments par question.
`;

  console.log("🤖 Envoi de la requête à l'API Groq...");
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: "Tu es un générateur de JSON. Tu ne dois renvoyer aucun texte en dehors du JSON.",
        },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.7,
    }),
  });

  if (!response.ok) throw new Error(`❌ Erreur API Groq: ${await response.text()}`);

  const result = (await response.json()) as any;
  const data = JSON.parse(result.choices[0].message.content) as any;

  const rawQuestions: any[] = Array.isArray(data.questions) ? data.questions : [];
  if (!rawQuestions.length) throw new Error("❌ JSON invalide : aucun élément dans 'questions'.");

  const globalEmojis = (Array.isArray(data.emojis) ? data.emojis : []).filter(
    (e: unknown) => typeof e === "string" && e.trim().length > 0,
  ) as string[];

  const questions = rawQuestions
    .slice(0, questionCount)
    .map((raw: any) => normalizeItem(raw, globalEmojis.length ? globalEmojis : FALLBACK_EMOJIS));

  const emojis = [...globalEmojis];
  for (const e of FALLBACK_EMOJIS) {
    if (emojis.length >= 3) break;
    if (!emojis.includes(e)) emojis.push(e);
  }

  // --- Nettoyage & Bridage strict des Hashtags (5 max) ---
  const rawHashtags: string[] = Array.isArray(data.hashtags) ? data.hashtags : ["#science", "#quiz"];
  const cleanHashtags = rawHashtags
    .map((h) => String(h).trim().replaceAll(/\s+/g, ""))
    .filter(Boolean)
    .map((h) => (h.startsWith("#") ? h : `#${h}`))
    .slice(0, 5); // FORCE MAX 5 HASHTAGS

  const ctaRaw = data.cta;
  const ctaDisplay =
    (ctaRaw && typeof ctaRaw === "object"
      ? String(ctaRaw.text_display || ctaRaw.text_audio || "")
      : String(ctaRaw || "")
    ).trim() || "Abonne-toi pour un quiz par jour !";
  const ctaAudio =
    (ctaRaw && typeof ctaRaw === "object" ? String(ctaRaw.text_audio || "") : "").trim() || ctaDisplay;

  const metadata: QuizMetadata = {
    topic: String(data.topic || currentCategory),
    description: String(data.description || "Découvre les réponses à ce quiz scientifique !"),
    hashtags: cleanHashtags,
    motif: data.motif || "science",
    cta: ctaDisplay,
    ctaAudio,
    emojis: emojis.slice(0, 7),
    uiScale:
      typeof data.uiScale === "number" && data.uiScale > 0.3 && data.uiScale <= 1.2 ? data.uiScale : 0.85,
    questionCount: questions.length,
    questions,
  };

  console.log(`🎉 Quiz généré : "${metadata.topic}" — Hashtags (${metadata.hashtags.length}): ${metadata.hashtags.join(" ")}`);

  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

  const videoQuestions: QuizQuestion[] = metadata.questions.map((q) => ({
    question: q.question,
    questionAudio: q.questionAudio,
    options: q.options,
    correct: q.correct,
    explanation: q.explanation,
    explanationAudio: q.explanationAudio,
    emojis: q.emojis && q.emojis.length ? q.emojis : metadata.emojis,
    imagePrompts: q.imagePrompts,
    motif: metadata.motif,
    ctaText: metadata.cta,
    ctaTextAudio: metadata.ctaAudio,
    uiScale: metadata.uiScale,
  }));

  fs.writeFileSync(quizPath, JSON.stringify(videoQuestions, null, 2));

  history.last_category_index = nextIndex;
  history.used_topics.push(metadata.topic);
  if (history.used_topics.length > 200) history.used_topics.shift();
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));

  return metadata;
}

if (require.main === module) {
  generateQuiz().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}