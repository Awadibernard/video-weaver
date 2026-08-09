/**
 * drawQuiz.ts
 *
 * Pure canvas-drawing logic ported 1:1 from the original index.html
 * `drawQuizLayout()`. Given a state object (phase, timeLeft, question, images,
 * background, frameCount, transition), draws one full frame to the provided
 * 2D context.
 *
 * The Remotion component calls this once per frame with values derived from
 * `useCurrentFrame()`. This keeps rendering deterministic and identical to the
 * original visual output.
 */

import { CONFIG } from "../config";
import { drawFittedText } from "./fitText";

export type Phase = "reading" | "countdown" | "reveal" | "cta";

export type DrawState = {
  phase: Phase;
  timeLeft: number; // seconds shown on timer (ceil)
  frameCount: number; // for background rotation
  question: {
    question: string;
    options: string[];
    correct: number;
    explanation: string;
    emojis?: string[];
    ctaText?: string;
  };
  loadedImages: (HTMLImageElement | null)[];
  bgImage: HTMLImageElement | null;
  showCountdownAnim: boolean;
  /** Pop d'apparition de la question (spring, 0..1+). Défaut 1. */
  questionPop?: number;
  /** Pulsation du minuteur pendant le countdown. Défaut 1. */
  timerPulse?: number;
  /** Agrandissement de la bonne réponse à la révélation. Défaut 1. */
  correctPop?: number;
  transition: {
    active: boolean;
    phase: "covering" | "uncovering" | "idle";
    type: "fade" | "swipe-left" | "swipe-up";
    color: string;
    progress: number; // 0..1
  };
};


function drawRoundedImage(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(img, x, y, w, h);
  ctx.restore();
}

/**
 * Couches de rendu :
 *  - "bg"      : uniquement le fond rotatif (jamais mis à l'échelle)
 *  - "ui"      : uniquement le bloc quiz (mis à l'échelle via CONFIG/props uiScale)
 *  - "overlay" : CTA plein écran + transitions (jamais mis à l'échelle)
 *  - "all"     : tout (compatibilité)
 */
export type DrawLayer = "bg" | "ui" | "overlay" | "all";

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  s: DrawState,
  layer: DrawLayer = "all",
) {
  const { question: data, phase, timeLeft, frameCount, bgImage, loadedImages } = s;
  const questionPop = s.questionPop ?? 1;
  const timerPulse = s.timerPulse ?? 1;
  const correctPop = s.correctPop ?? 1;

  // Background
  if (layer === "bg" || layer === "all") {
    if (bgImage) {
      const angle = frameCount * CONFIG.rotationSpeed;
      ctx.save();
      ctx.translate(540, 960);
      ctx.rotate(angle);
      ctx.drawImage(bgImage, -1250, -1250, 2500, 2500);
      ctx.restore();
      ctx.fillStyle = CONFIG.backgroundOverlay;
      ctx.fillRect(0, 0, 1080, 1920);
    } else {
      ctx.fillStyle = CONFIG.fallbackBackground;
      ctx.fillRect(0, 0, 1080, 1920);
    }
  }

  if (layer === "ui" || layer === "all") {
  // Main card
  ctx.shadowColor = "rgba(0, 242, 254, 0.5)";
  ctx.shadowBlur = 15;
  ctx.fillStyle = CONFIG.cardColor;
  ctx.beginPath();
  (ctx as any).roundRect(140, 150, 800, 1620, 56);
  ctx.fill();
  ctx.shadowBlur = 0;

  // Title
  ctx.fillStyle = CONFIG.textColor;
  ctx.font = "900 55px 'Segoe UI', Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(CONFIG.titleText, 540, 210);

  // Question / explanation box — "pop" d'apparition (spring côté Remotion)
  ctx.save();
  ctx.translate(540, 395);
  ctx.scale(questionPop, questionPop);
  ctx.translate(-540, -395);

  ctx.fillStyle = CONFIG.boxColor;
  ctx.beginPath();
  (ctx as any).roundRect(200, 290, 680, 210, 24);
  ctx.fill();

  // Texte adaptatif : la police rétrécit si la question/explication est longue
  ctx.fillStyle = CONFIG.textColor;
  ctx.textAlign = "center";
  const txt = phase === "reveal" || phase === "cta" ? data.explanation : data.question;
  drawFittedText(ctx, txt, 540, 395, 620, 180, {
    maxFontSize: CONFIG.text.question.max,
    minFontSize: CONFIG.text.question.min,
    lineHeightRatio: CONFIG.text.question.lineHeightRatio,
  });
  ctx.restore();

  // Emojis (3 minimum garantis par l'IA ; les slots manquants sont ignorés)
  if (data.emojis && data.emojis.length > 0) {
    const slots: [number, number][] = [
      [315, 600],
      [465, 600],
      [615, 600],
      [765, 600],
      [390, 720],
      [540, 720],
      [690, 720],
    ];
    const list = data.emojis.slice(0, 7);
    // Centrage : si moins de 4 emojis, on utilise la rangée du haut centrée
    const positions =
      list.length <= 4
        ? slots.slice(0, 4).slice(0, list.length).map(([x, y], i, arr) => {
            const offset = ((4 - arr.length) * 150) / 2;
            return [x + offset, y] as [number, number];
          })
        : slots.slice(0, list.length);
    ctx.font = "75px 'Noto Color Emoji', 'Segoe UI Emoji', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    list.forEach((e, i) => {
      const [x, y] = positions[i];
      ctx.fillText(e, x, y);
    });
  }


  // Options
  const letters = ["A", "B", "C"];
  const rotations = [-5, 3, -4];
  for (let i = 0; i < 3; i++) {
    const posY = 860 + i * 125;
    const isCorrect = (phase === "reveal" || phase === "cta") && i === data.correct;
    let boxColor = "#d1d5db";
    let fontColor = "#333333";
    if (phase === "reveal" || phase === "cta") {
      if (i === data.correct) {
        boxColor = CONFIG.correctColor;
        fontColor = "#ffffff";
      } else {
        ctx.globalAlpha = 0.35;
      }
    }

    // La bonne réponse s'agrandit légèrement + bordure brillante à la révélation
    ctx.save();
    if (isCorrect) {
      ctx.translate(585, posY + 42.5);
      ctx.scale(correctPop, correctPop);
      ctx.translate(-585, -(posY + 42.5));
    }

    ctx.fillStyle = boxColor;
    if (isCorrect) {
      ctx.shadowColor = CONFIG.correctGlow;
      ctx.shadowBlur = 30 * correctPop;
    }
    ctx.beginPath();
    (ctx as any).roundRect(290, posY, 590, 85, 20);
    ctx.fill();
    ctx.shadowBlur = 0;
    if (isCorrect) {
      ctx.strokeStyle = CONFIG.correctGlow;
      ctx.lineWidth = 5;
      ctx.shadowColor = CONFIG.correctGlow;
      ctx.shadowBlur = 20;
      ctx.beginPath();
      (ctx as any).roundRect(290, posY, 590, 85, 20);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }


    ctx.fillStyle = fontColor;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    // Texte adaptatif : l'option rétrécit si le libellé est long
    drawFittedText(ctx, data.options[i] || "", 330, posY + 42.5, loadedImages[i] ? 400 : 520, 78, {
      maxFontSize: CONFIG.text.option.max,
      minFontSize: CONFIG.text.option.min,
      lineHeightRatio: CONFIG.text.option.lineHeightRatio,
      maxLines: 2,
    });
    ctx.restore();
    ctx.globalAlpha = 1;


    ctx.fillStyle = "#000000";
    ctx.beginPath();
    ctx.arc(220, posY + 42.5, 42, 0, Math.PI * 2);
    ctx.fill();

    if ((phase === "reveal" || phase === "cta") && i === data.correct) {
      ctx.shadowColor = "#ffb800";
      ctx.strokeStyle = "#ffb800";
    } else {
      ctx.shadowColor = "#00f2fe";
      ctx.strokeStyle = "#00f2fe";
    }
    ctx.shadowBlur = 10;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(220, posY + 42.5, 38, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.fillStyle = "#ffffff";
    ctx.font = "900 32px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(letters[i], 220, posY + 46);

    if (loadedImages[i]) {
      const cardSize = 110;
      const cardX = 750;
      const cardY = posY - 12;
      ctx.save();
      ctx.translate(cardX + cardSize / 2, cardY + cardSize / 2);
      ctx.rotate((rotations[i] * Math.PI) / 180);
      ctx.shadowColor = "rgba(0,0,0,0.3)";
      ctx.shadowBlur = 10;
      ctx.shadowOffsetX = 3;
      ctx.shadowOffsetY = 3;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      (ctx as any).roundRect(-cardSize / 2, -cardSize / 2, cardSize, cardSize, 16);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      drawRoundedImage(
        ctx,
        loadedImages[i]!,
        -cardSize / 2 + 8,
        -cardSize / 2 + 8,
        cardSize - 16,
        cardSize - 16,
        10,
      );
      ctx.restore();
    }
  }

  // Timer box (pulsation douce pendant le countdown)
  const timerY = 1300;
  ctx.fillStyle = "#031620";
  ctx.beginPath();
  (ctx as any).roundRect(200, timerY, 680, 380, 24);
  ctx.fill();
  ctx.save();
  ctx.translate(540, timerY + 190);
  ctx.scale(timerPulse, timerPulse);
  ctx.translate(-540, -(timerY + 190));
  ctx.shadowColor = CONFIG.timerColor;
  ctx.shadowBlur = 15 * timerPulse;
  ctx.fillStyle = CONFIG.timerColor;
  ctx.font = "bold 160px 'Courier New', monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  let displaySec = Math.ceil(timeLeft);
  if (displaySec < 0) displaySec = 0;
  ctx.fillText(`00:0${displaySec}`, 540, timerY + 240);
  ctx.shadowBlur = 0;
  ctx.restore();
  } // fin couche "ui"

  if (layer === "overlay" || layer === "all") {
  // CTA overlay (text — video is layered above the canvas in React)

  if (phase === "cta") {
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillRect(0, 0, 1080, 1920);
    ctx.fillStyle = CONFIG.ctaTextColor;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    drawFittedText(ctx, data.ctaText || "Abonne-toi !", 540, 500, 900, 240, {
      maxFontSize: CONFIG.text.cta.max,
      minFontSize: CONFIG.text.cta.min,
      lineHeightRatio: CONFIG.text.cta.lineHeightRatio,
    });
  }

  // Transition overlay
  if (s.transition.active) {
    const p = Math.max(0, Math.min(1, s.transition.progress));
    ctx.fillStyle = s.transition.color;
    if (s.transition.type === "fade") {
      ctx.globalAlpha = s.transition.phase === "covering" ? p : 1 - p;
      ctx.fillRect(0, 0, 1080, 1920);
      ctx.globalAlpha = 1;
    } else if (s.transition.type === "swipe-left") {
      const x = s.transition.phase === "covering" ? 1080 - p * 1080 : -(p * 1080);
      ctx.fillRect(x, 0, 1080, 1920);
    } else if (s.transition.type === "swipe-up") {
      const y = s.transition.phase === "covering" ? 1920 - p * 1920 : -(p * 1920);
      ctx.fillRect(0, y, 1080, 1920);
    }
  }
  } // fin couche "overlay"
}

