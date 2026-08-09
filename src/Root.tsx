import { CONFIG } from "./config";
import { Composition } from "remotion";
import { QuizVideo } from "./QuizVideo";
import type { PreparedProps } from "./lib/types";

const EMPTY_PROPS: PreparedProps = {
  fps: 60,
  width: 1080,
  height: 1920,
  introFrames: 30,
  outroFrames: 30,
  transitionFrames: 30,
  questions: [],
  background: null,
  tickSound: null,
  bgm: null,
  uiScale: CONFIG.uiScale,
  sfx: { whoosh: null, timer: null, correct: null },
  countdownAnim: null,
  ctaAnim: null,
  segments: [],
  totalFrames: 60,
};

/**
 * 100% browser-safe: aucun import Node (`fs`, `path`, `music-metadata`) ici.
 * Les props réelles sont injectées par la CLI via `--props=public/props.json`
 * (voir le script `render` dans package.json). `calculateMetadata` se contente
 * de lire ces props pour fixer durée / fps / dimensions.
 */
export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="QuizVideo"
      component={QuizVideo}
      defaultProps={EMPTY_PROPS}
      durationInFrames={EMPTY_PROPS.totalFrames}
      fps={EMPTY_PROPS.fps}
      width={EMPTY_PROPS.width}
      height={EMPTY_PROPS.height}
      calculateMetadata={({ props }) => {
        const p = props as PreparedProps;
        if (!p || !p.segments?.length) return {};
        return {
          durationInFrames: p.totalFrames,
          fps: p.fps,
          width: p.width,
          height: p.height,
        };
      }}
    />
  );
};
