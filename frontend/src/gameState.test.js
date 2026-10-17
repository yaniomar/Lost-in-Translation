import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimRoundSubmission, getNewPlayerState, pageFromPath, releaseRoundSubmission,
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
