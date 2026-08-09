/**
 * config.ts — Configuration centralisée du rendu vidéo.
 * 100% browser-safe : aucun import Node ici (utilisable par les composants
 * Remotion ET par scripts/prepare.ts).
 */
export const CONFIG = {
  // --- Vidéo ---
  fps: 60,
  width: 1080,
  height: 1920,

  // --- Fond ---
  rotationSpeed: 0.001, // radians par frame (rotation lente du fond)
  backgroundOverlay: "rgba(7, 10, 19, 0.7)",
  fallbackBackground: "#070a13",

  // --- Transitions ---
  transitionDurationMs: 500,

  // --- Timings ---
  countdownSeconds: 7,
  introMs: 500,
  outroMs: 500,

  // --- Couleurs / typographie ---
  textColor: "#000000",
  cardColor: "#ffffff",
  boxColor: "#d1d5db",
  accentColor: "#00f2fe",
  correctColor: "#10b981",
  correctGlow: "#ffb800",
  timerColor: "#00f2fe",
  ctaTextColor: "#ffffff",
  titleText: "SCIENCE QUIZ",

  // --- Texte adaptatif ---
  text: {
    question: { max: 40, min: 22, lineHeightRatio: 1.32 },
    option: { max: 34, min: 20, lineHeightRatio: 1.2 },
    cta: { max: 56, min: 30, lineHeightRatio: 1.2 },
  },

  // --- Audio ---
  // Fichier tic-tac : WAV uniquement (pas de micro-silence de compression).
  // Placé dans public/audio/ticks/ (scan auto, .wav seulement).
  tickSound: "audio/ticks/tic-tac.wav",
  // "loop"       : fichier court (~1s) rejoué en boucle sur tout le countdown
  // "continuous" : fichier long (7s+) joué une seule fois, coupé par la Sequence
  tickAudioMode: "loop" as "loop" | "continuous",
  tickVolume: 0.9,
  enableBGM: true,
  bgmVolume: 0.15,

  // --- Échelle de l'UI (0.85 = le fond rotatif "respire" autour du quiz) ---
  uiScale: 0.85,

  // --- SFX (public/sfx/) : absents = ignorés silencieusement ---
  sfx: {
    whoosh: "sfx/whoosh.mp3",
    timer: "sfx/timer.mp3",
    correct: "sfx/correct.mp3",
  },
  sfxVolume: 0.6,

  // --- Animations (GIF / WebP animés, transparence native) ---
  countdownAnim: {
    left: 140,
    top: 660,
    width: 800,
    height: 800,
  },
  ctaAnim: {
    left: 90,
    top: 660,
    width: 900,
    height: 800,
  },
} as const;

export type AppConfig = typeof CONFIG;
