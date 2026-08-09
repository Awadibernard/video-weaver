/**
 * question-count.ts — tirage pondéré du nombre de questions par vidéo.
 *
 * Poids demandés (total 103) :
 *   5 → 30 (~29,1 %)   6 → 20 (~19,4 %)   7 → 20 (~19,4 %)
 *   8 → 18 (~17,5 %)   9 → 10 (~9,7 %)   10 →  5 (~4,8 %)
 */
export const QUESTION_COUNT_WEIGHTS: ReadonlyArray<{ count: number; weight: number }> = [
  { count: 5, weight: 30 },
  { count: 6, weight: 20 },
  { count: 7, weight: 20 },
  { count: 8, weight: 18 },
  { count: 9, weight: 10 },
  { count: 10, weight: 5 },
];

/** Tirage aléatoire pondéré → nombre de questions (5..10). */
export function getRandomQuestionCount(): number {
  // Surcharge manuelle possible (bot Telegram / CI) : QUESTION_COUNT=7
  const forced = Number(process.env.QUESTION_COUNT);
  if (Number.isInteger(forced) && forced >= 1 && forced <= 20) return forced;

  const total = QUESTION_COUNT_WEIGHTS.reduce((s, w) => s + w.weight, 0);
  let r = Math.random() * total;
  for (const { count, weight } of QUESTION_COUNT_WEIGHTS) {
    r -= weight;
    if (r < 0) return count;
  }
  return QUESTION_COUNT_WEIGHTS[0].count;
}
