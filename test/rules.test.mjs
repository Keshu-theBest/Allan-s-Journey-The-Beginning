import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreRound, SUITS } from '../rules.js';

test('worked example: 10H against 7D, 6D, 5S earns 25.33', () => {
  const result = scoreRound([
    { playerId: 'a', value: 10, suit: 'hearts' },
    { playerId: 'b', value: 7, suit: 'diamonds' },
    { playerId: 'c', value: 6, suit: 'diamonds' },
    { playerId: 'd', value: 5, suit: 'spades' },
  ]);
  assert.equal(result.average, 7);
  assert.ok(Math.abs(result.target - 16 / 3) < 1e-10);
  assert.deepEqual(result.modes, ['diamonds']);
  assert.equal(result.scores[0].points, 25.33);
  assert.equal(result.scores[1].points, 61.33);
  assert.equal(result.scores[2].points, 71.33);
  assert.equal(result.scores[3].points, 56.67);
});

test('ties average suit bonuses fairly, independent of submission order', () => {
  const cards = SUITS.map((suit, i) => ({ playerId: String(i), value: 2, suit }));
  const result = scoreRound(cards);
  assert.deepEqual(result.modes, SUITS);
  for (const score of result.scores) {
    assert.equal(score.suitPoints, 9);
    assert.equal(score.points, 69);
  }
  assert.deepEqual(scoreRound(cards.toReversed()).scores.toReversed(), result.scores);
});

test('two red suits tie for 18, opposing colors tie for 12', () => {
  for (const [suit, expected] of [['diamonds', 18], ['spades', 12]]) {
    const result = scoreRound([{ playerId: 'a', value: 2, suit: 'hearts' }, { playerId: 'b', value: 2, suit }]);
    assert.equal(result.scores[0].suitPoints, expected);
    assert.equal(result.scores[0].crowdingPenalty, 0);
  }
});

test('unanimous crowding charges 18 and single submission never divides by zero', () => {
  const cards = Array.from({ length: 160 }, (_, i) => ({ playerId: String(i), value: 2, suit: 'hearts' }));
  for (const score of scoreRound(cards).scores) assert.equal(score.points, 66);
  assert.equal(scoreRound([cards[0]]).scores[0].points, 84);
  assert.deepEqual(scoreRound([]), { average: null, target: null, counts: { hearts: 0, diamonds: 0, clubs: 0, spades: 0 }, modes: [], scores: [] });
});

test('invalid inputs and duplicate players are rejected', () => {
  const card = { playerId: 'a', value: 2, suit: 'hearts' };
  for (const bad of [null, [{}], [card, card], [{ ...card, value: 1 }], [{ ...card, value: '2' }], [{ ...card, suit: 'joker' }]]) {
    assert.throws(() => scoreRound(bad), TypeError);
  }
});

test('score range, finite values, and conservation of suit counts across deterministic samples', () => {
  for (let n = 1; n <= 160; n++) {
    const cards = Array.from({ length: n }, (_, i) => ({ playerId: String(i), value: 2 + (i * 7 + n) % 9, suit: SUITS[(i * i + n) % 4] }));
    const result = scoreRound(cards);
    assert.equal(Object.values(result.counts).reduce((a, b) => a + b, 0), n);
    assert.ok(result.target >= 2 && result.target <= 22 / 3);
    for (const score of result.scores) {
      assert.ok(Number.isFinite(score.points) && score.points >= -18 && score.points <= 84);
      assert.equal(score.points, Math.round((score.valuePoints + score.suitPoints - score.crowdingPenalty + Number.EPSILON) * 100) / 100);
    }
  }
});
