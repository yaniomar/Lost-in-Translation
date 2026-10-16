import assert from 'node:assert/strict';
import test from 'node:test';
import { getNewPlayerState } from './gameState.js';

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
  });
});
