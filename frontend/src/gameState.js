export const DEFAULT_SENTENCE = 'نزلت علامات المد والدكتور حكالي راجعني';
export const WELCOME_SESSION_KEY = 'devfest-lost-in-translation-welcome-dismissed';

export const AWS_RESOURCES = [
  ['What is Amazon Translate?', 'https://docs.aws.amazon.com/translate/latest/dg/what-is.html'],
  ['Getting Started with Amazon Translate', 'https://docs.aws.amazon.com/translate/latest/dg/getting-started.html'],
  ['Amazon Translate Resources and Videos', 'https://aws.amazon.com/translate/resources/'],
  ['Amazon Translate Getting Started with AWS SDK', 'https://docs.aws.amazon.com/translate/latest/dg/get-started-sdk.html'],
];

export const AWS_VIDEO_TITLES = [
  'What is Amazon Translate?',
  'Introduction to Amazon Translate and Neural Machine Translation',
  'Real-time Translation with Amazon Translate',
];

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

export function shouldShowWelcome(storage) {
  try { return storage.getItem(WELCOME_SESSION_KEY) !== 'true'; } catch { return true; }
}

export function dismissWelcome(storage) {
  try { storage.setItem(WELCOME_SESSION_KEY, 'true'); } catch {}
}

export function scoreMessage(mode, similarity) {
  if (mode === 'guardian') return similarity >= 70 ? 'Meaning survived!' : 'Meaning got lost along the way.';
  return similarity < 25 ? 'Glitch successful!' : 'Meaning survived the chaos.';
}

export function isExceptionalScore(mode, similarity) {
  return mode === 'guardian' ? similarity >= 70 : similarity < 25;
}

export function podiumRank(index) {
  return index < 3 ? `podium-${index + 1}` : 'standard-rank';
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
