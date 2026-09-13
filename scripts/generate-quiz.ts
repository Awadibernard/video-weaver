/**
 * generate-quiz.ts — ÉTAPE 1 du pipeline.
 *
 * Génère un quiz de N questions via Groq / OpenAI, N étant tiré au sort par
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
  /** Texte LU par le TTS (avec accents, sans ponctuation perturbatrice, phonétique). */
  questionAudio: string;
  options: [string, string, string];
  answer: string;
  /** Index (0-2) de la bonne réponse dans `options`. */
  correct: 0 | 1 | 2;
  /** Explication AFFICHÉE. */
  explanation: string;
  /** Explication LUE par le TTS. */
  explanationAudio: string;
  /** Un prompt d'image par option (format 1:1, style isolé). */
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

/** Nettoie le texte audio pour le moteur TTS (Unreal Speech). */
function cleanAudioText(text: string): string {
  return String(text || "")
    // CONSERVATION STRICTE DES ACCENTS (é, è, à, ê, ù, ç)
    // Supprime uniquement la ponctuation perturbatrice pour le moteur TTS
    .replace(/[?()"'\[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

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

  // --- Normalisation des prompts d'images ---
  const rawPrompts: string[] =
    Array.isArray(raw.imagePrompts) && raw.imagePrompts.length === 3 ? raw.imagePrompts : options;

  const PREFIX = "Square 1:1 aspect ratio, centered subject, clean lighting, ";
  const STYLES = [
    ", Clean 3D Octane Render",
    ", Cinematic Studio Photography",
    ", Modern Minimalist Vector Graphic",
  ];

  const BANNED_BUZZWORDS = [
    /hyper-realistic/gi,
    /photorealistic/gi,
    /8k resolution/gi,
    /8k/gi,
    /trending on artstation/gi,
    /highly detailed/gi,
    /ultra sharp focus/gi,
    /volumetric light/gi,
  ];

  const imagePrompts = rawPrompts.map((p, idx) => {
    let text = String(p || "").trim();

    // Suppression des diacritiques uniquement pour l'anglais du prompt d'image
    text = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    // Élimination du buzzword stuffing
    BANNED_BUZZWORDS.forEach((bw) => {
      text = text.replace(bw, "");
    });

    // Nettoyage des résidus du préfixe s'il était présent
    text = text.replace(/^Square 1:1 aspect ratio, centered subject, clean lighting,?\s*/i, "");
    
    // Nettoyage de tout style déjà injecté pour garantir l'isolation stricte
    STYLES.forEach((s) => {
      const cleanS = s.replace(", ", "");
      text = text.replace(new RegExp(cleanS, "gi"), "");
    });

    text = text.replace(/^[.,\s]+|[.,\s]+$/g, "");

    // Application du format obligatoire + sujet + style isolé dédié
    const targetStyle = STYLES[idx % STYLES.length];
    return `${PREFIX}${text}${targetStyle}`;
  }) as [string, string, string];

  // Emojis spécifiques à CETTE question
  const emojis = (Array.isArray(raw.emojis) ? raw.emojis : [])
    .filter((e: unknown) => typeof e === "string" && e.trim().length > 0)
    .map((e: string) => e.trim()) as string[];
  for (const e of fallbackEmojis) {
    if (emojis.length >= 3) break;
    if (!emojis.includes(e)) emojis.push(e);
  }

  // Séparation visuel / audio avec garde-fous TTS
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
  const qAudio = cleanAudioText(String(raw.question_audio ?? raw.text_audio ?? q.audio ?? "").trim() || q.display);

  const exp = pair(raw.explanation, null);
  const expAudio = cleanAudioText(String(raw.explanation_audio ?? exp.audio ?? "").trim() || exp.display);

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
  console.log("🧠 Étape 1/3 — Génération du quiz via LLM...");

  // Vérification stricte des variables d'environnement
  const apiKey = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("❌ Clé API manquante : Veuillez définir GROQ_API_KEY ou OPENAI_API_KEY dans vos variables d'environnement.");
  }

  const isGroq = !!process.env.GROQ_API_KEY;
  const apiUrl = isGroq
    ? "https://api.groq.com/openai/v1/chat/completions"
    : "https://api.openai.com/v1/chat/completions";
  const modelName = isGroq ? "openai/gpt-oss-120b" : "gpt-4o";

  let history: HistoryData = defaultHistory;
  if (fs.existsSync(historyPath)) {
    history = JSON.parse(fs.readFileSync(historyPath, "utf8")) as HistoryData;
  }

  const nextIndex = (history.last_category_index + 1) % history.categories.length;
  const forcedTopic = (process.env.FORCED_TOPIC || "").trim();
  const currentCategory = forcedTopic || history.categories[nextIndex];

  // Tirage pondéré du nombre de questions
  const questionCount = getRandomQuestionCount();

  console.log(`📌 Catégorie sélectionnée : ${currentCategory}${forcedTopic ? " (imposée)" : ""}`);
  console.log(`🎲 Nombre de questions tiré au sort : ${questionCount}`);
  console.log(`📜 Sujets déjà abordés : ${history.used_topics.length}`);

  const prompt = `
Tu es un scientifique rigoureux et un expert en vulgarisation pour TikTok.
Génère EXACTEMENT ${questionCount} questions au format JSON sur ce domaine : "${currentCategory}".

CONTRAINTES DE FIABILITÉ STRICTES (FACT-CHECKING) :
1. Chaque information, question et réponse doit être un FAIT SCIENTIFIQUE AVÉRÉ et faire l'objet d'un consensus total.
2. N'invente rien. Aucune pseudo-science, aucune théorie controversée.
3. Si tu as le moindre doute sur l'exactitude d'un fait, choisis un autre sujet.
4. Les ${questionCount} questions doivent être DIFFÉRENTES les unes des autres.

INTERDICTION STRICTE DE PARLER DE CES SUJETS :
${JSON.stringify(history.used_topics.slice(-100))}

Tu dois répondre UNIQUEMENT avec un objet JSON valide structuré exactement comme ceci :
{
  "topic": "Titre accrocheur et court pour TikTok (ex: 🧠 Test Tes Connaissances en Physique !)",
  "description": "Une phrase d'accroche très captivante pour inciter à regarder et commenter.",
  "hashtags": ["#science", "#quiz", "#cultureg", "#apprendre", "#decouverte"],
  "motif": "Un seul mot-clé de thème visuel parmi: space, nature, human-body, chemistry, tech, brain",
  "cta": { 
    "text_display": "Abonne-toi pour 1 quiz / jour !", 
    "text_audio": "Abonne toi pour un quiz par jour !" 
  },
  "emojis": ["🔬", "🧪", "✨", "🌍", "⚡", "🧠", "🚀"],
  "uiScale": 0.85,
  "questions": [
    {
      "question": {
        "text_display": "Quelle est la formule de l'eau à 0 °C ?",
        "text_audio": "Quelle est la formule de l'eau à zéro degré celsius"
      },
      "options": ["Option A", "Option B", "Option C"],
      "answer": "Le texte EXACT de la bonne réponse, recopié depuis options",
      "correct": 0,
      "explanation": {
        "text_display": "La molécule d'eau contient 2 atomes d'hydrogène et 1 d'oxygène.",
        "text_audio": "La molécule d'eau contient deux atomes d'hydrogène et un d'oxygène."
      },
      "imagePrompts": [
        "Square 1:1 aspect ratio, centered subject, clean lighting, clear ice cube resting on a dark wooden table, Clean 3D Octane Render",
        "Square 1:1 aspect ratio, centered subject, clean lighting, liquid water dripping into a glass bowl, Cinematic Studio Photography",
        "Square 1:1 aspect ratio, centered subject, clean lighting, H2O chemical molecular structure diagram, Modern Minimalist Vector Graphic"
      ],
      "emojis": ["💧", "🧊", "🧪", "🔬", "🌊", "❄️", "✨"]
    }
  ]
}

═══════════════════════════════════════════════════════
OPTIMISATION STRICTE DU TTS (text_audio)
═══════════════════════════════════════════════════════
1. CONSERVATION DES ACCENTS FRANÇAIS : Conserve TOUS les accents français (é, è, à, ê, ù, ç). Ne les retire JAMAIS car le moteur TTS Unreal Speech en a besoin pour la prononciation.
2. NETTOYAGE PONCTUATION : Supprime les points d'interrogation (?), parenthèses (), guillemets ("") et crochets []. Conserve uniquement les virgules et points pour marquer les pauses.
3. ADAPTATION PHONÉTIQUE ET ÉPELLATION : Écris TOUT en toutes lettres.
   - Symboles / Formules : "Au" -> "A U", "O2" -> "O deux", "H2O" -> "H deux O"
   - Unités / Math : "0°C" -> "zéro degré celsius", "100 km/h" -> "cent kilomètres par heure", "50%" -> "cinquante pour cent".
   - Nombres / Dates : "1969" -> "mille neuf cent soixante neuf".

═══════════════════════════════════════════════════════
OPTIMISATION STRICTE DES PROMPTS D'IMAGES (imagePrompts)
═══════════════════════════════════════════════════════
1. LANGUE : 100% Anglais.
2. FORMAT CARRÉ OBLIGATOIRE : Tous les prompts doivent COMMENCER par : "Square 1:1 aspect ratio, centered subject, clean lighting, ".
3. SUJETS CONCRETS : Décris uniquement des objets physiques, des matières ou des décors concrets. Pas de concepts scientifiques abstraits (ex: "une pomme rouge tombant sur un sol" au lieu de "concept de gravité").
4. ISOLATION STRICTE DES STYLES (1 style unique par prompt) :
   - Prompt 1 (Option A) : "Square 1:1 aspect ratio, centered subject, clean lighting, [Sujet physique concret A], Clean 3D Octane Render"
   - Prompt 2 (Option B) : "Square 1:1 aspect ratio, centered subject, clean lighting, [Sujet physique concret B], Cinematic Studio Photography"
   - Prompt 3 (Option C) : "Square 1:1 aspect ratio, centered subject, clean lighting, [Sujet physique concret C], Modern Minimalist Vector Graphic"
5. ZÉRO BUZZWORD STUFFING : Interdiction d'inclure "hyper-realistic", "photorealistic", "8k", "trending on artstation", "highly detailed", "ultra sharp focus".

RÈGLES DE FORMAT GÉNÉRALES :
- "hashtags" : STRICTEMENT ENTRE 3 ET 5 HASHTAGS MAXIMUM avec #.
- "questions" contient EXACTEMENT ${questionCount} éléments.
- Chaque "options" contient EXACTEMENT 3 éléments.
- "correct" est l'index (0, 1 ou 2).
- "uiScale" vaut 0.85.
`;

  console.log(`🤖 Envoi de la requête à l'API (${isGroq ? "Groq" : "OpenAI"})...`);
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelName,
      messages: [
        {
          role: "system",
          content:
            "Tu es un générateur de JSON strict. Tu ne dois renvoyer aucun texte en dehors du JSON. " +
            `Le tableau 'questions' doit contenir EXACTEMENT ${questionCount} questions. ` +
            "Chaque question doit contenir son propre champ 'emojis' (7 emojis pertinents).",
        },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.7,
    }),
  });

  if (!response.ok) throw new Error(`❌ Erreur API: ${await response.text()}`);

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
    .slice(0, 5);

  const ctaRaw = data.cta;
  const ctaDisplay =
    (ctaRaw && typeof ctaRaw === "object"
      ? String(ctaRaw.text_display || ctaRaw.text_audio || "")
      : String(ctaRaw || "")
    ).trim() || "Abonne-toi pour 1 quiz par jour !";

  const rawCtaAudio =
    (ctaRaw && typeof ctaRaw === "object" ? String(ctaRaw.text_audio || "") : "").trim() || ctaDisplay;
  const ctaAudio = cleanAudioText(rawCtaAudio);

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

  console.log(
    `🎉 Quiz généré : "${metadata.topic}" — ${metadata.questionCount} questions (motif: ${metadata.motif})`
  );
  console.log(`🏷️ Hashtags (${metadata.hashtags.length}) : ${metadata.hashtags.join(" ")}`);

  // --- Écriture input/metadata.json (upload) ---
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  console.log(`💾 ${metadataPath}`);

  // --- Écriture quiz.json (rendu vidéo) ---
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

  fs.mkdirSync(path.dirname(quizPath), { recursive: true });
  fs.writeFileSync(quizPath, JSON.stringify(videoQuestions, null, 2));
  console.log(`💾 ${quizPath} (${videoQuestions.length} questions)`);

  // --- Mise à jour de l'historique ---
  history.last_category_index = nextIndex;
  history.used_topics.push(metadata.topic);
  if (history.used_topics.length > 200) history.used_topics.shift();
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
  console.log("🧠 Mémoire mise à jour.");

  return metadata;
}

if (require.main === module) {
  generateQuiz().catch((e) => {
    console.error(e);
    process.exit(1);
  });
    }
