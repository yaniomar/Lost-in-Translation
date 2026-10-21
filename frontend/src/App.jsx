import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, AudioLines, BadgePlus, BookOpen, Check, ChevronDown,
  CircleHelp, ExternalLink, Eye, Flame, HelpCircle, Home, LoaderCircle, Medal,
  PlayCircle, RotateCcw, Search, Shield, Sparkles, Swords, Trophy, X,
} from 'lucide-react';
import {
  AWS_RESOURCES, AWS_VIDEO_TITLES, claimRoundSubmission, DEFAULT_SENTENCE, dismissWelcome,
  getNewPlayerState, isExceptionalScore, pageFromPath, podiumRank, releaseRoundSubmission,
  scoreMessage, shouldShowWelcome,
} from './gameState.js';

const API = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '' : 'http://localhost:5000');
const emptyBoard = { guardians: [], glitchers: [] };
const stagePlaceholders = [
  { key: 'japanese', language: 'Japanese', flag: '🇯🇵' },
  { key: 'russian', language: 'Russian', flag: '🇷🇺' },
  { key: 'french', language: 'French', flag: '🇫🇷' },
  { key: 'english', language: 'English', flag: '🇬🇧' },
  { key: 'arabic', language: 'Arabic', flag: '🇵🇸' },
];
const categoryLabels = {
  'من الفريق': 'Team', 'أكاديمي': 'Academic', 'رتاج': 'Ritaj', 'الحرم': 'Campus',
  'مواصلات': 'Transport', 'طلاب': 'Student life',
};

async function request(path, options) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(response.ok
      ? 'The server returned an unreadable response.'
      : `The server returned an unexpected error (${response.status}).`);
  }
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function IconButton({ children, label, onClick, className = '', disabled = false }) {
  return (
    <button type="button" aria-label={label} title={label} className={`icon-button ${className}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

function keepFocusInside(event, dialog) {
  if (event.key !== 'Tab' || !dialog) return;
  const controls = [...dialog.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')];
  if (!controls.length) { event.preventDefault(); dialog.focus(); return; }
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function ScoreList({ title, subtitle, entries, type, large = false }) {
  const Icon = type === 'guardian' ? Shield : Flame;
  return (
    <section className={`score-section ${type} ${large ? 'score-section-large' : ''}`}>
      <div className="score-heading">
        <span className="score-icon"><Icon size={large ? 23 : 18} /></span>
        <div><h3>{title}</h3><p>{subtitle}</p></div>
        <span className="score-top">TOP 5</span>
      </div>
      {entries.length ? (
        <ol className="score-list">
          {entries.slice(0, 5).map((entry, index) => (
            <li key={entry.id} className={`score-row ${podiumRank(index)}`}>
              <span className={`rank rank-${index + 1}`} aria-label={`Rank ${index + 1}`}>
                {index === 0 ? <Trophy size={18} /> : index < 3 ? <Medal size={17} /> : String(index + 1).padStart(2, '0')}
              </span>
              <span className="player-name">{entry.playerName}</span>
              <span className="score-number">{entry.similarity}<small>%</small></span>
            </li>
          ))}
        </ol>
      ) : <p className="empty-score">No scores yet. Be the first to play.</p>}
    </section>
  );
}

function LeaderboardPage({ leaderboard, dataError, onBack }) {
  return (
    <section className="leaderboard-page" aria-labelledby="leaderboard-title">
      <div className="leaderboard-hero">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" /> LIVE BOOTH STANDINGS</div>
          <h1 id="leaderboard-title">Booth <span>champions</span></h1>
          <p className="intro-copy">Two ways to win. Five places on each podium.</p>
        </div>
        <div className="leaderboard-live"><span className="live-dot" /> LIVE</div>
      </div>
      {dataError && <p className="page-error" role="alert">{dataError}</p>}
      <div className="leaderboard-grid">
        <ScoreList title="Meaning Guardians" subtitle="Highest similarity wins" entries={leaderboard.guardians} type="guardian" large />
        <ScoreList title="AI Glitchers" subtitle="Lowest similarity wins" entries={leaderboard.glitchers} type="glitcher" large />
      </div>
      <div className="leaderboard-bottom">
        <p>Arabic travels through Japanese, Russian, French, and English before coming home.</p>
        <button type="button" className="secondary-button" onClick={onBack}><ArrowLeft size={17} /> Back to the game</button>
      </div>
    </section>
  );
}

function ChallengeModal({ activeStep, error, isPlaying, offlineDemo, onClose, onEducation, onLeaderboard, onNewPlayer, onRetry, phase, pipeline, play, snapshot }) {
  const dialogRef = useRef(null);
  const guardian = (play?.mode || snapshot?.mode) === 'guardian';
  const resultMessage = play && scoreMessage(play.mode, play.similarity);
  const exceptional = play && !offlineDemo && isExceptionalScore(play.mode, play.similarity);
  const visibleStages = pipeline.length ? pipeline : stagePlaceholders;
  const progress = activeStep < 0 ? 0 : Math.min(activeStep + 1, 5);

  useEffect(() => { dialogRef.current?.focus(); }, []);
  useEffect(() => {
    function onKeyDown(event) {
      keepFocusInside(event, dialogRef.current);
      if (event.key === 'Escape' && !isPlaying) onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isPlaying, onClose]);

  return (
    <div className="overlay challenge-overlay" role="presentation">
      <section className="challenge-dialog" role="dialog" aria-modal="true" aria-labelledby="challenge-title" tabIndex={-1} ref={dialogRef}>
        <div className="challenge-topbar">
          <div className="challenge-player">
            <span className={`mode-pill ${guardian ? 'guardian-pill' : 'glitcher-pill'}`}>{guardian ? <Shield size={14} /> : <Flame size={14} />}{guardian ? 'Guardian' : 'Glitcher'}</span>
            <span>Playing as <b>{snapshot?.playerName}</b></span>
          </div>
          <IconButton label={isPlaying ? 'Challenge in progress' : 'Close challenge'} onClick={onClose} disabled={isPlaying}><X size={20} /></IconButton>
        </div>
        <div className="challenge-heading">
          <div>
            <span className="eyebrow"><span className="eyebrow-line" /> THE TRANSLATION JOURNEY</span>
            <h2 id="challenge-title">{phase === 'loading' ? 'Sending meaning around the world…' : phase === 'error' ? 'The route hit a problem' : play ? 'The sentence made it home' : 'Watch every stop unfold'}</h2>
          </div>
          <span className="challenge-progress">{phase === 'loading' ? 'WAITING' : offlineDemo ? 'PRERECORDED' : `${progress} / 5`}</span>
        </div>
        <div className="original-callout"><span>Original Arabic</span><p dir="rtl">{snapshot?.sentence}</p></div>

        {phase === 'loading' && (
          <div className="journey-loading" role="status" aria-live="polite">
            <div className="orbit-loader"><AudioLines size={30} /><i /><i /><i /></div>
            <strong>Waiting for the completed translation route</strong>
            <p>The server is processing all five translations. No intermediate result is simulated.</p>
            <div className="route-code">AR <i /> JP <i /> RU <i /> FR <i /> EN <i /> AR</div>
          </div>
        )}

        {phase !== 'loading' && phase !== 'error' && !offlineDemo && !play && (
          <div className="journey-stage-area" aria-live="polite">
            <div className="journey-progress"><span style={{ width: `${progress * 20}%` }} /></div>
            <div className="journey-stages">
              {visibleStages.map((step, index) => {
                const revealed = index <= activeStep;
                return (
                  <article key={step.key} className={`journey-card ${revealed ? 'revealed' : ''} ${index === activeStep ? 'current' : ''} ${step.key === 'arabic' ? 'final-stage' : ''}`}>
                    <div className="journey-card-head"><span className="journey-number">0{index + 1}</span><span className="flag">{step.flag}</span><b>{step.language}</b>{revealed && <Check size={15} />}</div>
                    <p dir={step.key === 'arabic' ? 'rtl' : 'auto'}>{revealed ? step.text : 'Waiting to be revealed…'}</p>
                  </article>
                );
              })}
            </div>
          </div>
        )}

        {phase === 'error' && (
          <div className="challenge-error" role="alert">
            <CircleHelp size={27} /><div><strong>Translation could not be completed</strong><p>{error}</p></div>
            <button type="button" className="secondary-button" onClick={onRetry}>Retry</button>
          </div>
        )}
        {offlineDemo && play && (
          <div className="offline-result" role="status"><CircleHelp size={24} /><div><strong>{offlineDemo.label}</strong><p>{offlineDemo.message}</p></div></div>
        )}
        {play && (
          <div className={`final-result ${guardian ? 'result-guardian' : 'result-glitcher'} ${offlineDemo ? 'result-offline' : ''} ${exceptional ? 'exceptional-result' : ''}`}>
            {exceptional && <div className="celebration" aria-hidden="true"><i /><i /><i /><i /><i /></div>}
            <div className="result-title-row">
              <div><span className="eyebrow"><span className="eyebrow-line" /> FINAL RESULT</span><h3>{offlineDemo ? 'Offline demonstration' : resultMessage}</h3><span className={`result-mode ${guardian ? 'guardian-mode' : 'glitcher-mode'}`}>{guardian ? <Shield size={13} /> : <Flame size={13} />}{guardian ? 'Meaning Guardian' : 'AI Glitcher'}</span></div>
              <div className="final-score" aria-label={`${play.similarity} percent similarity`}><strong>{play.similarity}</strong><small>%</small><span>similarity</span></div>
            </div>
            <div className="sentence-compare">
              <div><span>Started as</span><p dir="rtl">{play.original}</p></div>
              <ArrowRight className="compare-arrow" size={22} />
              <div className="final-sentence"><span>Returned as</span><p dir="rtl">{play.finalArabic}</p></div>
            </div>
            <button type="button" className="education-link" onClick={onEducation}><BookOpen size={15} /> How does this game work? Discover the AWS technology behind it <ArrowRight size={14} /></button>
            <div className="result-actions">
              <button type="button" className="secondary-button" onClick={onLeaderboard}><Trophy size={17} /> View leaderboard</button>
              <button type="button" className={`start-button ${guardian ? 'guardian-cta' : 'glitcher-cta'}`} onClick={onNewPlayer}><RotateCcw size={17} /> New player</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function InfoModal({ onClose }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    const previousFocus = document.activeElement;
    dialogRef.current?.focus();
    function onKeyDown(event) { keepFocusInside(event, dialogRef.current); if (event.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); previousFocus?.focus?.(); };
  }, [onClose]);

  return (
    <div className="overlay info-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="dialog info-dialog" role="dialog" aria-modal="true" aria-labelledby="info-title" tabIndex={-1} ref={dialogRef}>
        <div className="dialog-heading info-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> BEHIND THE GAME</span><h2 id="info-title">How AWS powers the journey</h2></div><IconButton label="Close AWS explanation" onClick={onClose}><X size={19} /></IconButton></div>
        <div className="info-content">
          <section><h3><span>A</span> What is Lost in Translation?</h3><p>An Arabic sentence travels through five consecutive translations—Japanese, Russian, French, English, and back to Arabic. The experiment reveals how wording can change when machine translations are chained together.</p></section>
          <section><h3><span>B</span> Two ways to play</h3><div className="info-mode-grid"><p><b><Shield size={15} /> Meaning Guardian</b>Higher textual similarity wins.</p><p><b><Flame size={15} /> AI Glitcher</b>Lower textual similarity wins.</p></div><p>The score measures textual differences between the first and last sentences. It does not directly judge whether their meaning is the same.</p></section>
          <section><h3><span>C</span> What is Amazon Translate?</h3><p>Amazon Translate is an AWS machine translation service that uses machine learning to translate text between languages. It gives developers translation capabilities without requiring them to train their own AI models.</p></section>
          <section><h3><span>D</span> How we use AWS</h3><ol className="aws-steps"><li>The player submits an Arabic sentence.</li><li>The game sends it securely to its server.</li><li>The server authenticates with AWS.</li><li>It calls the Amazon Translate <code>TranslateText</code> API.</li><li>AWS returns the translated result.</li><li>That result becomes the next translation’s input.</li><li>The process repeats five times until the sentence returns to Arabic.</li><li>The game compares the first and last sentences and displays the score.</li></ol><p><strong>One completed live round makes exactly five sequential Amazon Translate requests.</strong> AWS performs each translation; the game calculates the similarity score. AWS Identity and Access Management (IAM) restricts what the game may access, while AWS Security Token Service (STS) verifies the AWS identity before translation begins.</p></section>
          <section><h3><span>E</span> Why is this interesting?</h3><p>Repeated translations can introduce different wording, ambiguity, and surprising results. This is a playful experiment: one low similarity score does not mean Amazon Translate is generally inaccurate.</p></section>
          <section className="resource-section"><h3><span>F</span> Learn from AWS</h3><div className="resource-grid">{AWS_RESOURCES.map(([title, href]) => <a key={href} href={href} target="_blank" rel="noopener noreferrer"><BookOpen size={16} /><span>{title}</span><ExternalLink size={13} /></a>)}</div><h4><PlayCircle size={16} /> Recommended videos on the official resources page</h4><ul className="video-list">{AWS_VIDEO_TITLES.map((title) => <li key={title}><a href="https://aws.amazon.com/translate/resources/" target="_blank" rel="noopener noreferrer">{title}<ExternalLink size={12} /></a></li>)}</ul></section>
        </div>
      </section>
    </div>
  );
}

function WelcomeModal({ onClose, onEducation }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    dialogRef.current?.focus();
    function onKeyDown(event) { keepFocusInside(event, dialogRef.current); if (event.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="overlay welcome-overlay" role="presentation">
      <section className="dialog welcome-dialog" role="dialog" aria-modal="true" aria-labelledby="welcome-title" tabIndex={-1} ref={dialogRef}>
        <div className="welcome-visual" aria-hidden="true"><AudioLines size={30} /><span>AR</span><i /><span>JP</span><i /><span>RU</span><i /><span>FR</span><i /><span>EN</span><i /><span>AR</span></div>
        <div className="dialog-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> READY FOR THE RELAY?</span><h2 id="welcome-title">Welcome to Lost in Translation!</h2><p className="welcome-subtitle">One sentence. Five translations. Can you beat the AI?</p></div><IconButton label="Close welcome" onClick={onClose}><X size={19} /></IconButton></div>
        <div className="welcome-content"><section><h3>What is the game?</h3><p>Enter an Arabic sentence and see how it changes after traveling through Japanese, Russian, French, English, and back to Arabic using Amazon Translate.</p></section><section><h3>Choose your challenge</h3><div className="welcome-modes"><p><b><Shield size={15} /> Meaning Guardian</b>Try to preserve your sentence. Higher similarity wins.</p><p><b><Flame size={15} /> AI Glitcher</b>Try to create the biggest wording change. Lower similarity wins.</p></div></section><section><h3>How to play</h3><ol className="play-steps"><li>Choose a game mode.</li><li>Enter an Arabic sentence or choose one from the Sentence Bank.</li><li>Enter your player name.</li><li>Press Start Challenge.</li><li>Watch all five translations and see your score.</li><li>Check the leaderboard.</li></ol></section></div>
        <div className="welcome-actions"><button type="button" className="text-action" onClick={onEducation}><BookOpen size={16} /> Learn how AWS powers this game</button><button type="button" className="start-button guardian-cta" onClick={onClose}>Let’s Play! <ArrowRight size={17} /></button></div>
      </section>
    </div>
  );
}

function App() {
  const [page, setPage] = useState(() => pageFromPath(window.location.pathname));
  const [mode, setMode] = useState('guardian');
  const [sentence, setSentence] = useState(DEFAULT_SENTENCE);
  const [playerName, setPlayerName] = useState('');
  const [presets, setPresets] = useState([]);
  const [leaderboard, setLeaderboard] = useState(emptyBoard);
  const [showPresets, setShowPresets] = useState(false);
  const [showLogger, setShowLogger] = useState(false);
  const [showChallenge, setShowChallenge] = useState(false);
  const [showWelcome, setShowWelcome] = useState(() => shouldShowWelcome(window.sessionStorage));
  const [showInfo, setShowInfo] = useState(false);
  const [presetSearch, setPresetSearch] = useState('');
  const [newSentence, setNewSentence] = useState('');
  const [newCategory, setNewCategory] = useState('Team');
  const [pipeline, setPipeline] = useState([]);
  const [activeStep, setActiveStep] = useState(-1);
  const [play, setPlay] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [challengePhase, setChallengePhase] = useState('idle');
  const [roundSnapshot, setRoundSnapshot] = useState(null);
  const [error, setError] = useState('');
  const [dataError, setDataError] = useState('');
  const [loggerError, setLoggerError] = useState('');
  const [savingSentence, setSavingSentence] = useState(false);
  const [offlineDemo, setOfflineDemo] = useState(null);
  const timerRef = useRef(null);
  const modalRef = useRef(null);
  const startButtonRef = useRef(null);
  const roundInFlightRef = useRef(false);

  async function refreshData() {
    const [presetData, boardData] = await Promise.all([request('/api/presets'), request('/api/leaderboard')]);
    setPresets(presetData); setLeaderboard(boardData); setDataError('');
  }

  useEffect(() => {
    refreshData().catch(() => setDataError('Can’t connect to the server. Make sure the app is running.'));
    const interval = window.setInterval(() => refreshData().catch(() => setDataError('Can’t connect to the server. Make sure the app is running.')), 12000);
    return () => { window.clearInterval(interval); window.clearTimeout(timerRef.current); };
  }, []);
  useEffect(() => {
    function onPopState() { setPage(pageFromPath(window.location.pathname)); setShowChallenge(false); }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  useEffect(() => { if (showPresets || showLogger) modalRef.current?.focus(); }, [showPresets, showLogger]);
  useEffect(() => {
    document.body.classList.toggle('modal-open', showPresets || showLogger || showChallenge || showWelcome || showInfo);
    return () => document.body.classList.remove('modal-open');
  }, [showPresets, showLogger, showChallenge, showWelcome, showInfo]);
  useEffect(() => {
    function onKeyDown(event) {
      if (event.key !== 'Escape') return;
      if (showPresets) setShowPresets(false);
      if (showLogger) setShowLogger(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showPresets, showLogger]);

  function navigate(path) {
    if (window.location.pathname !== path) window.history.pushState({}, '', path);
    setPage(pageFromPath(path)); setShowChallenge(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  const closeWelcome = useCallback(() => {
    dismissWelcome(window.sessionStorage);
    setShowWelcome(false);
    window.setTimeout(() => startButtonRef.current?.focus(), 0);
  }, []);
  const welcomeToEducation = useCallback(() => {
    dismissWelcome(window.sessionStorage);
    setShowWelcome(false); setShowInfo(true);
  }, []);
  const closeInfo = useCallback(() => setShowInfo(false), []);
  function resetRound() {
    window.clearTimeout(timerRef.current);
    setPlay(null); setPipeline([]); setActiveStep(-1); setIsPlaying(false); setError('');
    setOfflineDemo(null); setChallengePhase('idle'); setRoundSnapshot(null);
  }
  function newPlayer() {
    const next = getNewPlayerState();
    window.clearTimeout(timerRef.current); roundInFlightRef.current = false;
    setPlayerName(next.playerName); setSentence(next.sentence); setPipeline(next.pipeline);
    setActiveStep(next.activeStep); setPlay(next.play); setIsPlaying(next.isPlaying);
    setError(next.error); setOfflineDemo(next.offlineDemo); setChallengePhase(next.challengePhase);
    setRoundSnapshot(next.roundSnapshot); setShowChallenge(next.showChallenge);
    window.setTimeout(() => startButtonRef.current?.focus(), 0);
  }
  async function runRound(snapshot) {
    if (!claimRoundSubmission(roundInFlightRef)) return;
    window.clearTimeout(timerRef.current);
    setPipeline([]); setActiveStep(-1); setPlay(null); setOfflineDemo(null); setError('');
    setIsPlaying(true); setChallengePhase('loading');
    try {
      const result = await request('/api/play', {
        method: 'POST',
        body: JSON.stringify({ mode: snapshot.mode, sentence: snapshot.sentence, playerName: snapshot.playerName }),
      });
      setPipeline(result.steps); setLeaderboard(result.leaderboard);
      setOfflineDemo(result.offline?.active ? result.offline : null);
      if (result.offline?.active) {
        setPlay(result.play); setChallengePhase('complete'); setIsPlaying(false); return;
      }
      setChallengePhase('revealing');
      let stepIndex = 0;
      const advance = () => {
        setActiveStep(stepIndex); stepIndex += 1;
        if (stepIndex < result.steps.length) timerRef.current = window.setTimeout(advance, 850);
        else timerRef.current = window.setTimeout(() => {
          setPlay(result.play); setChallengePhase('complete'); setIsPlaying(false);
        }, 700);
      };
      timerRef.current = window.setTimeout(advance, 450);
    } catch (requestError) {
      setError(requestError.message); setChallengePhase('error'); setIsPlaying(false);
    } finally { releaseRoundSubmission(roundInFlightRef); }
  }
  function startGame(event) {
    event.preventDefault();
    if (roundInFlightRef.current || isPlaying || !sentence.trim() || !playerName.trim()) return;
    const snapshot = { mode, sentence: sentence.trim(), playerName: playerName.trim() };
    setRoundSnapshot(snapshot); setShowChallenge(true); runRound(snapshot);
  }
  async function addSentence(event) {
    event.preventDefault(); setSavingSentence(true); setLoggerError('');
    try {
      const added = await request('/api/log-sentence', {
        method: 'POST', body: JSON.stringify({ text: newSentence.trim(), category: newCategory }),
      });
      setPresets((current) => [added, ...current]); setNewSentence(''); setShowLogger(false);
    } catch (requestError) { setLoggerError(requestError.message); }
    finally { setSavingSentence(false); }
  }

  const guardian = mode === 'guardian';
  const filteredPresets = presets.filter((item) => item.text.includes(presetSearch.trim()));
  const canResume = !showChallenge && (play || challengePhase === 'error');

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand-lockup" href="/" onClick={(event) => { event.preventDefault(); navigate('/'); }} aria-label="DEVFEST Booth 2">
          <span className="brand-mark"><AudioLines size={21} strokeWidth={2.2} /></span>
          <span><b>DEVFEST</b><small>AWS CLUB · BZU</small></span>
        </a>
        <nav className="main-nav" aria-label="Main navigation">
          <a href="/" className={page === 'game' ? 'active' : ''} onClick={(event) => { event.preventDefault(); navigate('/'); }}><Home size={15} /> Game</a>
          <a href="/leaderboard" className={page === 'leaderboard' ? 'active' : ''} onClick={(event) => { event.preventDefault(); navigate('/leaderboard'); }}><Trophy size={15} /> Leaderboard</a>
          <button type="button" aria-label="How to play" onClick={() => setShowWelcome(true)}><HelpCircle size={15} /> <span>How to play</span></button>
        </nav>
        <button className="team-button" onClick={() => { setShowLogger(true); setLoggerError(''); }}><BadgePlus size={17} /> <span>Add a sentence</span></button>
      </header>

      {page === 'leaderboard' ? <LeaderboardPage leaderboard={leaderboard} dataError={dataError} onBack={() => navigate('/')} /> : (
        <div className="game-main" id="home"><section className="game-column">
          <div className="intro-row game-intro"><div>
            <div className="eyebrow"><span className="eyebrow-line" /> THE TRANSLATION RELAY</div>
            <h1>Will meaning <span>survive?</span></h1>
            <p className="intro-copy">One sentence. Five stops. A result you won’t see coming.</p>
          </div><div className="round-stamp" aria-label="Five stops"><span>5</span><small>stops</small></div></div>
          <div className="mode-switch" role="tablist" aria-label="Game mode">
            <button type="button" className={`mode-option guardian-option ${guardian ? 'selected' : ''}`} onClick={() => { setMode('guardian'); resetRound(); }} role="tab" aria-selected={guardian} disabled={isPlaying}>
              <span className="mode-symbol"><Shield size={22} /></span><span className="mode-copy"><b>Meaning Guardian</b><small>Keep it intact · target 70%+</small></span>{guardian && <Check className="mode-check" size={18} />}
            </button>
            <button type="button" className={`mode-option glitcher-option ${!guardian ? 'selected' : ''}`} onClick={() => { setMode('glitcher'); resetRound(); }} role="tab" aria-selected={!guardian} disabled={isPlaying}>
              <span className="mode-symbol"><Swords size={22} /></span><span className="mode-copy"><b>AI Glitcher</b><small>Scramble the meaning · target under 25%</small></span>{!guardian && <Check className="mode-check" size={18} />}
            </button>
          </div>
          <form className="game-form spacious-form" onSubmit={startGame}>
            <div className="form-topline"><label htmlFor="sentence">Ready to send a sentence?</label><span><Sparkles size={14} /> YOUR TURN</span></div>
            <div className="sentence-wrap">
              <textarea id="sentence" dir="rtl" value={sentence} onChange={(event) => setSentence(event.target.value.slice(0, 150))} maxLength={150} placeholder="اكتب جملتك بالعربي هنا... (مثال: الدكتور مش منزل علامات المد)" disabled={isPlaying} required />
              <div className="sentence-foot"><button type="button" className="quick-pick" onClick={() => { setShowPresets(true); setPresetSearch(''); }} disabled={isPlaying}><ChevronDown size={16} /> Sentence bank</button><span className={sentence.length > 135 ? 'count-near' : ''}>{sentence.length} / 150</span></div>
            </div>
            <div className="form-bottomline">
              <label className="player-field"><span>Player name <b aria-hidden="true">*</b></span><input required value={playerName} onChange={(event) => setPlayerName(event.target.value.slice(0, 30))} placeholder="e.g. Alex" maxLength={30} disabled={isPlaying} /><small>Name required for the leaderboard</small></label>
              <button ref={startButtonRef} className={`start-button ${guardian ? 'guardian-cta' : 'glitcher-cta'}`} type="submit" disabled={isPlaying || !sentence.trim() || !playerName.trim()}>{isPlaying ? <><LoaderCircle className="spin" size={18} /> Translating...</> : <>{guardian ? <Shield size={18} /> : <Flame size={18} />} Start challenge <ArrowRight size={17} /></>}</button>
            </div>
            {dataError && <p className="inline-error" role="alert">{dataError}</p>}
            {canResume && <button type="button" className="resume-result" onClick={() => setShowChallenge(true)}><Eye size={16} /> {play ? 'View last result' : 'Return to error details'}</button>}
          </form>
        </section></div>
      )}
      <footer className="page-footer"><span>DEVFEST 2026 <i /> AWS CLUB · BIRZEIT UNIVERSITY</span><span>BOOTH 02 <i /> LOST IN TRANSLATION</span></footer>

      {showChallenge && roundSnapshot && <ChallengeModal activeStep={activeStep} error={error} isPlaying={isPlaying} offlineDemo={offlineDemo} onClose={() => { if (!isPlaying) { setShowChallenge(false); startButtonRef.current?.focus(); } }} onEducation={() => setShowInfo(true)} onLeaderboard={() => navigate('/leaderboard')} onNewPlayer={newPlayer} onRetry={() => runRound(roundSnapshot)} phase={challengePhase} pipeline={pipeline} play={play} snapshot={roundSnapshot} />}

      {showWelcome && !showInfo && <WelcomeModal onClose={closeWelcome} onEducation={welcomeToEducation} />}
      {showInfo && <InfoModal onClose={closeInfo} />}

      {showPresets && <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowPresets(false); }}><section className="dialog preset-dialog" role="dialog" aria-modal="true" aria-labelledby="preset-title" tabIndex={-1} ref={modalRef}>
        <div className="dialog-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> QUICK PICK</span><h2 id="preset-title">Sentence bank</h2></div><IconButton label="Close" onClick={() => setShowPresets(false)}><X size={19} /></IconButton></div>
        <label className="search-field"><Search size={17} /><input value={presetSearch} onChange={(event) => setPresetSearch(event.target.value)} placeholder="Search Arabic sentences..." /></label>
        <div className="preset-list">{filteredPresets.map((item) => <button key={item.id} className="preset-item" onClick={() => { setSentence(item.text); setShowPresets(false); resetRound(); }}><span className="preset-tag">{categoryLabels[item.category] || item.category}</span><span dir="rtl">{item.text}</span><ArrowRight size={15} /></button>)}{!filteredPresets.length && <p className="no-presets">No sentences found.</p>}</div>
        <div className="dialog-bottom"><span>{presets.length} sentences</span><button className="text-action" onClick={() => { setShowPresets(false); setShowLogger(true); }}>Add a sentence <BadgePlus size={16} /></button></div>
      </section></div>}

      {showLogger && <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowLogger(false); }}><section className="dialog logger-dialog" role="dialog" aria-modal="true" aria-labelledby="logger-title" tabIndex={-1} ref={modalRef}>
        <div className="dialog-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> TEAM CONTRIBUTION</span><h2 id="logger-title">Add to the sentence bank</h2></div><IconButton label="Close" onClick={() => setShowLogger(false)}><X size={19} /></IconButton></div>
        <p className="dialog-description">Save a memorable campus moment for the next player.</p><form onSubmit={addSentence}>
          <label className="dialog-label" htmlFor="new-sentence">Arabic sentence <span>{newSentence.length} / 150</span></label><textarea id="new-sentence" dir="rtl" className="logger-textarea" maxLength={150} value={newSentence} onChange={(event) => setNewSentence(event.target.value)} placeholder="Write a campus moment in Arabic..." autoFocus />
          <label className="dialog-label" htmlFor="new-category">Category</label><select id="new-category" value={newCategory} onChange={(event) => setNewCategory(event.target.value)}><option>Team</option><option>Academic</option><option>Ritaj</option><option>Campus</option><option>Transport</option><option>Student life</option></select>
          {loggerError && <p className="inline-error" role="alert">{loggerError}</p>}<button className="start-button logger-submit" type="submit" disabled={!newSentence.trim() || savingSentence}>{savingSentence ? <><LoaderCircle className="spin" size={17} /> Saving...</> : <>Save sentence <BadgePlus size={17} /></>}</button>
        </form>
      </section></div>}
    </main>
  );
}

export default App;
