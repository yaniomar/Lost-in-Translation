export const DEFAULT_SENTENCE = 'نزلت علامات المد والدكتور حكالي راجعني';

export function pageFromPath(pathname) {
  return pathname === '/leaderboard' ? 'leaderboard' : 'game';
}

export function claimRoundSubmission(lock) {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function releaseRoundSubmission(lock) {
  lock.current = false;
}

export function getNewPlayerState() {
  return {
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
  };
}
