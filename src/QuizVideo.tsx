import React, { useEffect, useRef, useState } from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { loadFont as loadEmojiFont } from "@remotion/google-fonts/NotoColorEmoji";
import type { PreparedProps, QuestionSegment } from "./lib/types";
import { drawFrame, type DrawState, type Phase } from "./lib/drawQuiz";
import { CONFIG } from "./config";

/**
 * Resolves the current phase + local frame offset for a given absolute frame.
 * Order per question: reading -> countdown -> reveal -> cta (last only) -> transition.
 */
function phaseAt(seg: QuestionSegment, absFrame: number): {
  phase: Phase;
  localFrame: number;
  inTransition: boolean;
  transitionProgress: number;
} {
  const local = absFrame - seg.startFrame;
  let cursor = 0;

  if (local < cursor + seg.readingFrames)
    return { phase: "reading", localFrame: local - cursor, inTransition: false, transitionProgress: 0 };
  cursor += seg.readingFrames;

  if (local < cursor + seg.countdownFrames)
    return { phase: "countdown", localFrame: local - cursor, inTransition: false, transitionProgress: 0 };
  cursor += seg.countdownFrames;

  if (local < cursor + seg.revealFrames)
    return { phase: "reveal", localFrame: local - cursor, inTransition: false, transitionProgress: 0 };
  cursor += seg.revealFrames;

  if (seg.ctaFrames > 0 && local < cursor + seg.ctaFrames)
    return { phase: "cta", localFrame: local - cursor, inTransition: false, transitionProgress: 0 };
  cursor += seg.ctaFrames;

  // transition -> keep drawing last phase (cta if present, otherwise reveal) with cover overlay
  const trLocal = local - cursor;
  const p = seg.transitionFrames > 0 ? Math.min(1, Math.max(0, trLocal / seg.transitionFrames)) : 0;
  const lastPhase: Phase = seg.ctaFrames > 0 ? "cta" : "reveal";
  return { phase: lastPhase, localFrame: seg.ctaFrames > 0 ? seg.ctaFrames - 1 : seg.revealFrames - 1, inTransition: true, transitionProgress: p };
}

function useImage(src: string | null): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!src) {
      setImg(null);
      return;
    }
    const el = new Image();
    el.crossOrigin = "anonymous";
    el.onload = () => setImg(el);
    el.onerror = () => setImg(null);
    el.src = src;
  }, [src]);
  return img;
}

function useImages(srcs: (string | null)[]): (HTMLImageElement | null)[] {
  const [imgs, setImgs] = useState<(HTMLImageElement | null)[]>(() => srcs.map(() => null));
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      srcs.map(
        (s) =>
          new Promise<HTMLImageElement | null>((resolve) => {
            if (!s) return resolve(null);
            const el = new Image();
            el.crossOrigin = "anonymous";
            el.onload = () => resolve(el);
            el.onerror = () => resolve(null);
            el.src = s;
          }),
      ),
    ).then((list) => {
      if (!cancelled) setImgs(list);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcs.join("|")]);
  return imgs;
}

// Police emoji chargée une seule fois : garantit l'affichage des emojis
// sous l'environnement Linux headless des runners GitHub Actions.
try {
  loadEmojiFont();
} catch {
  // Silencieux : le fallback système prend le relais.
}

export const QuizVideo: React.FC<PreparedProps> = (props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  const uiCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);

  // Locate active segment
  const activeIndex = (() => {
    for (let i = 0; i < props.segments.length; i++) {
      const seg = props.segments[i];
      if (frame >= seg.startFrame && frame < seg.startFrame + seg.totalFrames) return i;
    }
    return Math.max(0, props.segments.length - 1);
  })();
  const seg = props.segments[activeIndex];
  const q = props.questions[activeIndex];

  const bgImage = useImage(props.background ? staticFile(props.background) : null);
  const imageSrcs = q.images.map((rel) => (rel ? staticFile(rel) : null));
  const loadedImages = useImages(imageSrcs);

  const info = phaseAt(seg, frame);
  const uiScale = props.uiScale ?? CONFIG.uiScale;

  const timeLeft =
    info.phase === "countdown"
      ? Math.max(0, CONFIG.countdownSeconds - info.localFrame / fps)
      : info.phase === "reading"
        ? CONFIG.countdownSeconds
        : 0;

  // --- Animations (spring / interpolate) ---
  // "Pop" d'apparition du bloc question au début de chaque phase texte.
  const popFrame =
    info.phase === "reading" || info.phase === "reveal" ? info.localFrame : 999;
  const questionPop = spring({
    frame: popFrame,
    fps,
    config: { damping: 12, stiffness: 180, mass: 0.6 },
    durationInFrames: Math.round(fps * 0.6),
  }) * 0.15 + 0.85;

  // Pulsation douce du minuteur pendant le countdown.
  const timerPulse =
    info.phase === "countdown"
      ? 1 + 0.06 * Math.abs(Math.sin((info.localFrame / fps) * Math.PI))
      : 1;

  // Bonne réponse : scale 1.05 + bordure brillante à la révélation.
  const correctPop =
    info.phase === "reveal" || info.phase === "cta"
      ? interpolate(
          spring({
            frame: info.phase === "reveal" ? info.localFrame : 999,
            fps,
            config: { damping: 10, stiffness: 200, mass: 0.5 },
          }),
          [0, 1],
          [1, 1.05],
        )
      : 1;

  const state: DrawState = {
    phase: info.phase,
    timeLeft,
    frameCount: frame,
    questionPop,
    timerPulse,
    correctPop,
    question: q,
    loadedImages,
    bgImage,
    showCountdownAnim: q.showCountdownAnim,
    transition: {
      active: info.inTransition && seg.transition !== null,
      phase: "covering",
      type: seg.transition?.type ?? "fade",
      color: seg.transition?.color ?? "#000000",
      progress: info.transitionProgress,
    },
  };

  // Trois couches : fond (jamais scalé) / quiz (scalé) / overlay (jamais scalé)
  useEffect(() => {
    const layers: [HTMLCanvasElement | null, "bg" | "ui" | "overlay"][] = [
      [bgCanvasRef.current, "bg"],
      [uiCanvasRef.current, "ui"],
      [overlayCanvasRef.current, "overlay"],
    ];
    for (const [c, layer] of layers) {
      if (!c) continue;
      const ctx = c.getContext("2d");
      if (!ctx) continue;
      ctx.clearRect(0, 0, c.width, c.height);
      drawFrame(ctx, state, layer);
    }
  });

  // --- Overlays d'animation (séquences PNG extraites par prepare.ts) ---
  // Lecture à vitesse 1x pilotée par la timeline Remotion, UNE SEULE FOIS :
  // au-delà de la dernière frame source, le composant est démonté.
  const countdownAnim = q.showCountdownAnim ? props.countdownAnim : null;
  const countdownFrameIdx =
    info.phase === "countdown" && countdownAnim
      ? Math.floor((info.localFrame * countdownAnim.sourceFps) / fps)
      : -1;
  const showCountdownOverlay =
    countdownAnim !== null && countdownFrameIdx >= 0 && countdownFrameIdx < countdownAnim.frameCount;

  const ctaAnim = props.ctaAnim;
  const ctaFrameIdx =
    info.phase === "cta" && ctaAnim ? Math.floor((info.localFrame * ctaAnim.sourceFps) / fps) : -1;
  const showCtaOverlay = ctaAnim !== null && ctaFrameIdx >= 0 && ctaFrameIdx < ctaAnim.frameCount;

  const animSrc = (anim: { dir: string }, idx: number) =>
    staticFile(`${anim.dir}/${String(idx + 1).padStart(4, "0")}.png`);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <canvas
        ref={bgCanvasRef}
        width={props.width}
        height={props.height}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      />

      {/* Bloc quiz mis à l'échelle (uiScale) pour laisser respirer le fond */}
      <canvas
        ref={uiCanvasRef}
        width={props.width}
        height={props.height}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          transform: `scale(${uiScale})`,
          transformOrigin: "center center",
        }}
      />

      {showCountdownOverlay && countdownAnim && (
        <AbsoluteFill style={{ pointerEvents: "none" }}>
          <div
            style={{
              position: "absolute",
              left: CONFIG.countdownAnim.left,
              top: CONFIG.countdownAnim.top,
              width: CONFIG.countdownAnim.width,
              height: CONFIG.countdownAnim.height,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Img
              src={animSrc(countdownAnim, countdownFrameIdx)}
              style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
            />
          </div>
        </AbsoluteFill>
      )}

      {showCtaOverlay && ctaAnim && (
        <AbsoluteFill style={{ pointerEvents: "none" }}>
          <div
            style={{
              position: "absolute",
              left: CONFIG.ctaAnim.left,
              top: CONFIG.ctaAnim.top,
              width: CONFIG.ctaAnim.width,
              height: CONFIG.ctaAnim.height,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Img
              src={animSrc(ctaAnim, ctaFrameIdx)}
              style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
            />
          </div>
        </AbsoluteFill>
      )}


      <canvas
        ref={overlayCanvasRef}
        width={props.width}
        height={props.height}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      />

      {/* --- MUSIQUE DE FOND (optionnelle, volume très bas) --- */}
      {CONFIG.enableBGM && props.bgm && (
        <Audio src={staticFile(props.bgm)} volume={CONFIG.bgmVolume} loop />
      )}

      {/* --- AUDIO TRACKS --- */}
      {props.questions.map((question, i) => {
        const s = props.segments[i];
        const readingStart = s.startFrame;
        const countdownStart = s.startFrame + s.readingFrames;
        const revealStart = countdownStart + s.countdownFrames;
        const ctaStart = revealStart + s.revealFrames;

        return (
          <React.Fragment key={i}>
            {question.audioQuestion && (
              <Sequence from={readingStart} durationInFrames={s.readingFrames}>
                <Audio src={staticFile(question.audioQuestion)} />
              </Sequence>
            )}

            {/* Tic-tac (WAV) : bouclé ou joué une seule fois selon CONFIG.tickAudioMode.
                Toujours encapsulé dans la Sequence du countdown → coupé net à la fin. */}
            {props.tickSound && (
              <Sequence from={countdownStart} durationInFrames={s.countdownFrames}>
                <Audio
                  src={staticFile(props.tickSound)}
                  volume={CONFIG.tickVolume}
                  loop={CONFIG.tickAudioMode === "loop"}
                />
              </Sequence>
            )}

            {/* SFX whoosh : apparition de la question */}
            {props.sfx?.whoosh && (
              <Sequence from={readingStart} durationInFrames={Math.min(s.readingFrames, 45)}>
                <Audio src={staticFile(props.sfx.whoosh)} volume={CONFIG.sfxVolume} />
              </Sequence>
            )}

            {/* SFX timer : bouclé sur toute la phase countdown */}
            {props.sfx?.timer && (
              <Sequence from={countdownStart} durationInFrames={s.countdownFrames}>
                <Audio src={staticFile(props.sfx.timer)} volume={CONFIG.sfxVolume} loop />
              </Sequence>
            )}

            {/* SFX correct : instant précis de la révélation */}
            {props.sfx?.correct && (
              <Sequence from={revealStart} durationInFrames={Math.min(s.revealFrames, 90)}>
                <Audio src={staticFile(props.sfx.correct)} volume={CONFIG.sfxVolume} />
              </Sequence>
            )}

            {question.audioReponse && (
              <Sequence from={revealStart} durationInFrames={s.revealFrames}>
                <Audio src={staticFile(question.audioReponse)} />
              </Sequence>
            )}

            {question.audioCta && s.ctaFrames > 0 && (
              <Sequence from={ctaStart} durationInFrames={s.ctaFrames}>
                <Audio src={staticFile(question.audioCta)} />
              </Sequence>
            )}
          </React.Fragment>
        );
      })}
    </AbsoluteFill>
  );
};
