/** Pure, deterministic Common Suit scoring. The server is the source of truth. */
export const RULES_VERSION = '1';
export const SUITS = Object.freeze(['hearts', 'diamonds', 'clubs', 'spades']);
export const VALUES = Object.freeze(Array.from({ length: 9 }, (_, i) => i + 2));
export const TOTAL_ROUNDS = 6;
export const ROUND_SECONDS = 30;
export const REVEAL_SECONDS = 8;
export const MAX_PLAYERS = 160;
export const MISSED_ROUND_PENALTY = -15;

const color = suit => (suit === 'hearts' || suit === 'diamonds' ? 'red' : 'black');
export const roundPoints = value => Math.round((value + Number.EPSILON) * 100) / 100;

/** Score submitted cards only. Missing players are penalized by the room engine. */
export function scoreRound(choices) {
  if (!Array.isArray(choices) || choices.length > MAX_PLAYERS) {
    throw new TypeError('Choices must be an array of at most 160 cards.');
  }
  const seen = new Set();
  for (const choice of choices) {
    if (!choice || typeof choice.playerId !== 'string' || !choice.playerId ||
        seen.has(choice.playerId) || !VALUES.includes(choice.value) || !SUITS.includes(choice.suit)) {
      throw new TypeError('Each player must submit one valid number and suit.');
    }
    seen.add(choice.playerId);
  }
  const counts = Object.fromEntries(SUITS.map(suit => [suit, 0]));
  for (const { suit } of choices) counts[suit]++;
  if (!choices.length) return { average: null, target: null, counts, modes: [], scores: [] };
  const average = choices.reduce((sum, card) => sum + card.value, 0) / choices.length;
  const target = 2 + (2 / 3) * (average - 2);
  const maxCount = Math.max(...Object.values(counts));
  const modes = SUITS.filter(suit => counts[suit] === maxCount);
  const scores = choices.map(({ playerId, value, suit }) => {
    const valuePoints = Math.max(0, 60 - 10 * Math.abs(value - target));
    const suitPoints = modes.reduce((sum, mode) => sum +
      (mode === suit ? 24 : color(mode) === color(suit) ? 12 : 0), 0) / modes.length;
    const crowdingPenalty = choices.length <= 1 ? 0 :
      18 * (counts[suit] - 1) / (choices.length - 1);
    return { playerId, value, suit, valuePoints, suitPoints, crowdingPenalty,
      points: roundPoints(valuePoints + suitPoints - crowdingPenalty) };
  });
  return { average, target, counts, modes, scores };
}
