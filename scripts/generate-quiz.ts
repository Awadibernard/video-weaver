/**
 * generate-quiz.ts — ÉTAPE 1 du pipeline.
 *
 * Génère un quiz de N questions via Groq, N étant tiré au sort par
 * un algorithme pondéré (voir scripts/question-count.ts).
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

export interface QuizItem {
  question: string;
  questionAudio: string;
  options: [string, string, string];
  answer: string;
  correct: 0 | 1 | 2;
  explanation: string;
  explanationAudio: string;
  imagePrompts: [string, string, string];
  emojis: string[];
}

export interface QuizMetadata {
  topic: string;
  description: string;
  hashtags: string[];
  motif: string;
  uiScale: number;
  cta: string;
  ctaAudio: string;
  emojis: string[];
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

function sanitizeText(str: string): string {
  return String(str || "")
    .replace(/[→->]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeItem(raw: any, fallbackEmojis: string[] = FALLBACK_EMOJIS): QuizItem {
  if (!Array.isArray(raw?.options) || raw.options.length !== 3) {
    throw new Error("Chaque question doit contenir un tableau 'options' avec EXACTEMENT 3 éléments.");
  }

  // Nettoyage strict des options (suppression des flèches et abréviations parasites)
  const options = raw.options.map((o: unknown) => sanitizeText(String(o))) as [string, string, string];
  
  const cleanAnswer = sanitizeText(String(raw.answer ?? ""));
  const foundIndex = options.findIndex((o) => o.toLowerCase() === cleanAnswer.toLowerCase());
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
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[→->]/g, " ");
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
      const display = sanitizeText(String(src.text_display ?? src.display ?? legacy ?? ""));
      const audio = sanitizeText(String(src.text_audio ?? src.audio ?? display));
      return { display, audio: audio || display };
    }
    const display = sanitizeText(String(src ?? ""));
    return { display, audio: display };
  };

  const q = pair(raw.question, raw.text_display);
  const qAudio = sanitizeText(String(raw.question_audio ?? raw.text_audio ?? q.audio ?? "")) || q.display;
  const exp = pair(raw.explanation, null);
  const expAudio = sanitizeText(String(raw.explanation_audio ?? exp.audio ?? "")) || exp.display;

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
  console.log("🧠 Étape 1/3 — Génération du sujet via Groq...");

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
Génère EXACTEMENT ${questionCount} questions au format JSON sur le domaine exact suivant : "${currentCategory}".

REGLES DE COHÉRENCE ET DE SUJET STRICTES :
1. Le "topic" DOIT être en lien direct et exclusif avec "${currentCategory}". Ne parle JAMAIS d'un autre domaine scientifique.
2. Chaque information, question et réponse doit être un FAIT SCIENTIFIQUE AVÉRÉ.
3. Les ${questionCount} questions doivent être DIFFÉRENTES les unes des autres.

RÈGLES D'AFFICHAGE ET D'AUDIO (CRITIQUE) :
1. INTERDICTION ABSOLUE d'utiliser des flèches ("→", "->"), des émojis dans le texte, des symboles mathématiques ou des abréviations télégraphiques.
2. Le texte affiché ("text_display") et le texte lu ("text_audio") doivent raconter STRICTEMENT la même chose.
   - "text_display" : Phrase complète, lisible et naturelle en français.
   - "text_audio" : La MÊME phrase, mais avec TOUS les chiffres, symboles et unités rédigés INTÉGRALEMENT EN TOUTES LETTRES (ex: "100 km/h" devient "cent kilomètres par heure").
3. Chaque option dans le tableau "options" doit être une phrase ou un terme clair rédigé normalement (ex: "La consolidation de la mémoire" et JAMAIS "Hippocampe -> mémoire").

RÈGLES POUR LES PROMPTS D'IMAGES ("imagePrompts") :
- Fournis EXACTEMENT 3 prompts d'images en ANGLAIS (un prompt détaillé pour chaque option du tableau "options").
- Chaque prompt doit décrire une illustration 3D détaillée, cinématique et photoréaliste représentative du concept de l'option correspondante.

INTERDICTION STRICTE DE PARLER DE CES SUJETS DÉJÀ TRAITÉS :
${JSON.stringify(history.used_topics.slice(-100))}

Tu dois répondre UNIQUEMENT avec un objet JSON valide structuré EXACTEMENT comme ceci :

{
  "topic": "🧠 Quiz : ${currentCategory}",
  "description": "Une phrase d'accroche captivante en lien avec ${currentCategory}.",
  "hashtags": ["#science", "#quiz", "#cultureg"],
  "motif": "science",
  "cta": { "text_display": "Abonne-toi pour en apprendre plus !", "text_audio": "Abonne toi pour en apprendre plus !" },
  "emojis": ["🔬", "🧪", "✨", "🌍", "⚡", "🧠", "🚀"],
  "uiScale": 0.85,
  "questions": [
    {
      "question": {
        "text_display": "Quelle est la fonction principale de l'hippocampe ?",
        "text_audio": "Quelle est la fonction principale de l'hippocampe ?"
      },
      "options": [
        "La consolidation de la mémoire",
        "La régulation du rythme cardiaque",
        "La production de dopamine"
      ],
      "answer": "La consolidation de la mémoire",
      "correct": 0,
      "explanation": {
        "text_display": "L'hippocampe joue un rôle central dans la mémoire et la navigation spatiale.",
        "text_audio": "L'hippocampe joue un rôle central dans la mémoire et la navigation spatiale."
      },
      "imagePrompts": [
        "A 3D glowing render of a human brain with the hippocampus highlighted in blue, cinematic lighting",
        "A 3D anatomical model of a human heart beating rhythmically, highly detailed",
        "A 3D abstract visualization of dopamine molecules floating in a neural network, glowing 8k"
      ],
      "emojis": ["🧠", "🔬", "✨"]
    }
  ]
}

RÈGLES DE FORMAT STRUCTURAL :
- "questions" contient EXACTEMENT ${questionCount} éléments.
- Chaque "options" contient EXACTEMENT 3 éléments. JAMAIS 2, JAMAIS 4.
- "correct" est l'index (0, 1 ou 2) de la bonne réponse dans "options".
`;

  const messages: Array<{ role: string; content: string }> = [
    {
      role: "system",
      content:
        "Tu es un générateur de JSON strict. Tu ne renvoies AUCUN texte hors du JSON. " +
        "CRITIQUE : Il est VITAL que le tableau 'options' de chaque question contienne EXACTEMENT 3 éléments sans flèches ni symboles. " +
        `Le tableau 'questions' doit contenir EXACTEMENT ${questionCount} questions.`,
    },
    { role: "user", content: prompt },
  ];

  const MAX_RETRIES = 3;
  let data: any = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`🤖 Envoi de la requête à l'API Groq (Tentative ${attempt}/${MAX_RETRIES})...`);

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages,
        response_format: { type: "json_object" },
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      throw new Error(`❌ Erreur API Groq: ${await response.text()}`);
    }

    const result = (await response.json()) as any;
    const rawContent = result.choices?.[0]?.message?.content || "";

    try {
      data = JSON.parse(rawContent);
      const rawQuestions: any[] = Array.isArray(data.questions) ? data.questions : [];
      if (!rawQuestions.length) {
        throw new Error("Le tableau 'questions' est vide ou absent du JSON.");
      }

      const globalEmojis = (Array.isArray(data.emojis) ? data.emojis : []).filter(
        (e: unknown) => typeof e === "string" && e.trim().length > 0,
      ) as string[];

      rawQuestions
        .slice(0, questionCount)
        .map((raw: any) => normalizeItem(raw, globalEmojis.length ? globalEmojis : FALLBACK_EMOJIS));

      break;
    } catch (err: any) {
      console.warn(`⚠️ Échec de validation du JSON à la tentative ${attempt}: ${err.message}`);

      if (attempt === MAX_RETRIES) {
        throw new Error(`❌ Impossible d'obtenir un JSON valide de Groq après ${MAX_RETRIES} tentatives: ${err.message}`);
      }

      messages.push({ role: "assistant", content: rawContent });
      messages.push({
        role: "user",
        content:
          `❌ Le JSON généré est INVALIDE. Erreur rencontrée : "${err.message}".\n` +
          `RAPPEL STRICT : Génère EXACTEMENT ${questionCount} questions. Assure-toi que le tableau 'options' ` +
          "de CHAQUE question contient EXACTEMENT 3 choix rédigés clairement sans flèches ni symboles.",
      });
    }
  }

  const globalEmojis = (Array.isArray(data.emojis) ? data.emojis : []).filter(
    (e: unknown) => typeof e === "string" && e.trim().length > 0,
  ) as string[];

  const rawQuestions: any[] = Array.isArray(data.questions) ? data.questions : [];
  const questions = rawQuestions
    .slice(0, questionCount)
    .map((raw: any) => normalizeItem(raw, globalEmojis.length ? globalEmojis : FALLBACK_EMOJIS));

  const emojis = [...globalEmojis];
  for (const e of FALLBACK_EMOJIS) {
    if (emojis.length >= 3) break;
    if (!emojis.includes(e)) emojis.push(e);
  }

  const rawHashtags: string[] = Array.isArray(data.hashtags) ? data.hashtags : ["#science", "#quiz"];
  const cleanHashtags = rawHashtags
    .map((h) => String(h).trim().replaceAll(/\s+/g, ""))
    .filter(Boolean)
    .map((h) => (h.startsWith("#") ? h : `#${h}`))
    .slice(0, 5);

  const ctaRaw = data.cta;
  const ctaDisplay =
    sanitizeText(
      ctaRaw && typeof ctaRaw === "object"
        ? String(ctaRaw.text_display || ctaRaw.text_audio || "")
        : String(ctaRaw || "")
    ) || "Abonne-toi pour un quiz par jour !";
  const ctaAudio =
    sanitizeText(ctaRaw && typeof ctaRaw === "object" ? String(ctaRaw.text_audio || "") : "") || ctaDisplay;

  const metadata: QuizMetadata = {
    topic: sanitizeText(String(data.topic || `🧠 Quiz : ${currentCategory}`)),
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

  console.log(`🎉 Quiz généré : "${metadata.topic}" — ${metadata.questionCount} questions`);

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