import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AWS_RESOURCES, AWS_VIDEO_TITLES, claimRoundSubmission, dismissWelcome, getNewPlayerState,
  isExceptionalScore, pageFromPath, podiumRank, releaseRoundSubmission, scoreMessage,
  shouldShowWelcome, WELCOME_SESSION_KEY,
} from './gameState.js';

test('routes direct leaderboard visits and falls back to the game', () => {
  assert.equal(pageFromPath('/leaderboard'), 'leaderboard');
  assert.equal(pageFromPath('/'), 'game');
  assert.equal(pageFromPath('/unexpected'), 'game');
});

test('round submission lock prevents duplicate API requests until released', () => {
  const lock = { current: false };
  assert.equal(claimRoundSubmission(lock), true);
  assert.equal(claimRoundSubmission(lock), false);
  releaseRoundSubmission(lock);
  assert.equal(claimRoundSubmission(lock), true);
});

test('new player state clears player-specific data and preserves no round state', () => {
  assert.deepEqual(getNewPlayerState(), {
    playerName: '',
    sentence: '',
    pipeline: [],
    activeStep: -1,
    play: null,
    isPlaying: false,
    error: '',
    offlineDemo: null,
    challengePhase: 'idle',
    roundSnapshot: null,
    showChallenge: false,
  });
});

test('welcome appears once per tab session and can still be reopened by UI state', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(shouldShowWelcome(storage), true);
  dismissWelcome(storage);
  assert.equal(values.get(WELCOME_SESSION_KEY), 'true');
  assert.equal(shouldShowWelcome(storage), false);
});

test('score reveal keeps the established mode thresholds', () => {
  assert.equal(scoreMessage('guardian', 70), 'Meaning survived!');
  assert.equal(scoreMessage('guardian', 69), 'Meaning got lost along the way.');
  assert.equal(scoreMessage('glitcher', 24), 'Glitch successful!');
  assert.equal(scoreMessage('glitcher', 25), 'Meaning survived the chaos.');
  assert.equal(isExceptionalScore('guardian', 70), true);
  assert.equal(isExceptionalScore('glitcher', 24), true);
});

test('only the top three rows receive podium styling hooks', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(podiumRank), [
    'podium-1', 'podium-2', 'podium-3', 'standard-rank', 'standard-rank',
  ]);
});

test('AWS education uses the required official documentation and resource links', () => {
  assert.deepEqual(AWS_RESOURCES.map((resource) => resource[1]), [
    'https://docs.aws.amazon.com/translate/latest/dg/what-is.html',
    'https://docs.aws.amazon.com/translate/latest/dg/getting-started.html',
    'https://aws.amazon.com/translate/resources/',
    'https://docs.aws.amazon.com/translate/latest/dg/get-started-sdk.html',
  ]);
  assert.equal(AWS_VIDEO_TITLES.length, 3);
  assert.ok(AWS_VIDEO_TITLES.includes('Real-time Translation with Amazon Translate'));
});
