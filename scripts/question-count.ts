/**
 * question-count.ts — tirage pondéré du nombre de questions par vidéo.
 *
 * Poids mis à jour (total 100) :
 *   5 → 40 (40,0 %)   6 → 30 (30,0 %)   7 → 30 (30,0 %)
 */
export const QUESTION_COUNT_WEIGHTS: ReadonlyArray<{ count: number; weight: number }> = [
  { count: 5, weight: 40 },
  { count: 6, weight: 30 },
  { count: 7, weight: 30 },
];

/** Tirage aléatoire pondéré → nombre de questions (5..7). */
export function getRandomQuestionCount(): number {
  // Surcharge manuelle possible (bot Telegram / CI) : QUESTION_COUNT=7
  const forced = Number(process.env.QUESTION_COUNT);
  if (Number.isInteger(forced) && forced >= 1 && forced <= 7) return forced;

  const total = QUESTION_COUNT_WEIGHTS.reduce((s, w) => s + w.weight, 0);
  let r = Math.random() * total;
  for (const { count, weight } of QUESTION_COUNT_WEIGHTS) {
    r -= weight;
    if (r < 0) return count;
  }
  return QUESTION_COUNT_WEIGHTS[0].count;
}
