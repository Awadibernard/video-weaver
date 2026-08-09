export type QuizQuestion = {
  /** Texte AFFICHÉ à l'écran (chiffres et symboles autorisés : "-273,15 °C"). */
  question: string;
  /** Texte LU par le TTS, en toutes lettres. Repli sur `question` si absent. */
  questionAudio?: string;
  options: [string, string, string];
  correct: 0 | 1 | 2;
  /** Explication affichée (chiffres/symboles). */
  explanation: string;
  /** Explication lue par le TTS, en toutes lettres. */
  explanationAudio?: string;
  emojis: string[];
  imagePrompts?: string[];
  /** Motif / thème visuel issu du JSON IA (ex: "space", "brain"). */
  motif?: string;
  ctaText?: string;
  /** CTA lu par le TTS, en toutes lettres. */
  ctaTextAudio?: string;
  /** Échelle du bloc quiz (0..1). Laisse respirer le fond. */
  uiScale?: number;
};


export type PreparedQuestion = QuizQuestion & {
  images: (string | null)[]; // relative paths under public/, e.g. "generated/q0_img0.png"
  audioQuestion: string | null; // e.g. "generated/q0_question.mp3"
  audioReponse: string | null;
  audioCta?: string | null;
  audioQuestionDurationSec: number;
  audioReponseDurationSec: number;
  audioCtaDurationSec?: number;
  showCountdownAnim: boolean;
  transition: null | {
    type: "fade" | "swipe-left" | "swipe-up";
    color: string;
  };
};

export type TransitionInfo = {
  type: "fade" | "swipe-left" | "swipe-up";
  color: string;
};

export type PreparedProps = {
  fps: number;
  width: number;
  height: number;
  introFrames: number;
  outroFrames: number;
  transitionFrames: number;
  questions: PreparedQuestion[];
  background: string | null; // e.g. "images/backgrounds/fond.jpg"
  tickSound: string | null; // e.g. "audio/ticks/tic-tac.mp3"
  bgm: string | null;
  /** Échelle globale du bloc quiz (fallback CONFIG.uiScale). */
  uiScale: number;
  /** SFX détectés dans public/sfx/ (null si le fichier est absent). */
  sfx: { whoosh: string | null; timer: string | null; correct: string | null }; // e.g. "audio/bgm/track.mp3" (null si enableBGM=false)
  countdownAnim: AnimSequence | null; // séquence PNG extraite du GIF/WebP
  ctaAnim: AnimSequence | null; // séquence PNG extraite du GIF/WebP
  segments: QuestionSegment[]; // computed frame ranges per question
  totalFrames: number;
};

/**
 * Animation décomposée en images fixes (extraites par ffmpeg dans prepare.ts).
 * Permet un rendu déterministe à vitesse 1x, joué UNE SEULE FOIS.
 */
export type AnimSequence = {
  dir: string; // ex: "generated/anim-countdown"
  frameCount: number;
  sourceFps: number;
  durationSec: number;
};

export type QuestionSegment = {
  index: number;
  startFrame: number;
  readingFrames: number;
  countdownFrames: number;
  revealFrames: number;
  ctaFrames: number;
  transitionFrames: number;
  totalFrames: number;
  transition: TransitionInfo | null;
};
