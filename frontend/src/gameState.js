export const DEFAULT_SENTENCE = 'نزلت علامات المد والدكتور حكالي راجعني';

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
  };
}
