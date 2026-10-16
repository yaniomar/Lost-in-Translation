import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  AudioLines,
  BadgePlus,
  Check,
  ChevronDown,
  CircleHelp,
  Flame,
  LoaderCircle,
  RotateCcw,
  Search,
  Shield,
  Sparkles,
  Swords,
  X,
} from 'lucide-react';
import { DEFAULT_SENTENCE, getNewPlayerState } from './gameState.js';

const API = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '' : 'http://localhost:5000');
const emptyBoard = { guardians: [], glitchers: [] };
const categoryLabels = {
  'من الفريق': 'Team',
  'أكاديمي': 'Academic',
  'رتاج': 'Ritaj',
  'الحرم': 'Campus',
  'مواصلات': 'Transport',
  'طلاب': 'Student life',
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
      ? 'The local server returned an unreadable response.'
      : `The local server returned an unexpected error (${response.status}).`);
  }
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function IconButton({ children, label, onClick, className = '', disabled = false }) {
  return (
    <button aria-label={label} title={label} className={`icon-button ${className}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

function ScoreList({ title, subtitle, entries, type }) {
  const isGuardian = type === 'guardian';
  const Icon = isGuardian ? Shield : Flame;
  return (
    <section className={`score-section ${type}`}>
      <div className="score-heading">
        <span className="score-icon"><Icon size={18} /></span>
        <div><h3>{title}</h3><p>{subtitle}</p></div>
        <span className="score-top">TOP 5</span>
      </div>
      {entries.length ? (
        <ol className="score-list">
          {entries.map((entry, index) => (
            <li key={entry.id} className="score-row">
              <span className={`rank rank-${index + 1}`}>{String(index + 1).padStart(2, '0')}</span>
              <span className="player-name">{entry.playerName}</span>
              <span className="score-number">{entry.similarity}<small>%</small></span>
            </li>
          ))}
        </ol>
      ) : <p className="empty-score">No scores yet. Be the first to play.</p>}
    </section>
  );
}

function App() {
  const [mode, setMode] = useState('guardian');
  const [sentence, setSentence] = useState(DEFAULT_SENTENCE);
  const [playerName, setPlayerName] = useState('');
  const [presets, setPresets] = useState([]);
  const [leaderboard, setLeaderboard] = useState(emptyBoard);
  const [showPresets, setShowPresets] = useState(false);
  const [showLogger, setShowLogger] = useState(false);
  const [presetSearch, setPresetSearch] = useState('');
  const [newSentence, setNewSentence] = useState('');
  const [newCategory, setNewCategory] = useState('Team');
  const [pipeline, setPipeline] = useState([]);
  const [activeStep, setActiveStep] = useState(-1);
  const [play, setPlay] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState('');
  const [savingSentence, setSavingSentence] = useState(false);
  const [offlineDemo, setOfflineDemo] = useState(null);
  const timerRef = useRef(null);
  const modalRef = useRef(null);
  const roundInFlightRef = useRef(false);

  async function refreshData() {
    const [presetData, boardData] = await Promise.all([request('/api/presets'), request('/api/leaderboard')]);
    setPresets(presetData);
    setLeaderboard(boardData);
  }

  useEffect(() => {
    refreshData().catch(() => setError('Can’t connect to the local server. Make sure the app is running.'));
    const interval = window.setInterval(() => {
      refreshData().catch(() => setError('Can’t connect to the local server. Make sure the app is running.'));
    }, 12000);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (showPresets || showLogger) modalRef.current?.focus();
  }, [showPresets, showLogger]);

  function resetRound() {
    window.clearTimeout(timerRef.current);
    setPlay(null);
    setPipeline([]);
    setActiveStep(-1);
    setIsPlaying(false);
    setError('');
    setOfflineDemo(null);
  }

  function newPlayer() {
    const next = getNewPlayerState();
    window.clearTimeout(timerRef.current);
    roundInFlightRef.current = false;
    setPlayerName(next.playerName);
    setSentence(next.sentence);
    setPipeline(next.pipeline);
    setActiveStep(next.activeStep);
    setPlay(next.play);
    setIsPlaying(next.isPlaying);
    setError(next.error);
    setOfflineDemo(next.offlineDemo);
  }

  async function startGame(event) {
    event.preventDefault();
    if (roundInFlightRef.current || isPlaying || !sentence.trim() || !playerName.trim()) return;
    roundInFlightRef.current = true;
    resetRound();
    setIsPlaying(true);
    setError('');
    try {
      const result = await request('/api/play', {
        method: 'POST',
        body: JSON.stringify({ mode, sentence: sentence.trim(), playerName: playerName.trim() }),
      });
      setPipeline(result.steps);
      setLeaderboard(result.leaderboard);
      setOfflineDemo(result.offline?.active ? result.offline : null);
      if (result.offline?.active) {
        setPlay(result.play);
        setActiveStep(-1);
        setIsPlaying(false);
        return;
      }
      let stepIndex = 0;
      const advance = () => {
        setActiveStep(stepIndex);
        stepIndex += 1;
        if (stepIndex < result.steps.length) {
          timerRef.current = window.setTimeout(advance, 800);
        } else {
          setPlay(result.play);
          setIsPlaying(false);
        }
      };
      timerRef.current = window.setTimeout(advance, 800);
    } catch (requestError) {
      setError(requestError.message);
      setIsPlaying(false);
    } finally {
      roundInFlightRef.current = false;
    }
  }

  async function addSentence(event) {
    event.preventDefault();
    setSavingSentence(true);
    setError('');
    try {
      const added = await request('/api/log-sentence', {
        method: 'POST',
        body: JSON.stringify({ text: newSentence.trim(), category: newCategory }),
      });
      setPresets((current) => [added, ...current]);
      setNewSentence('');
      setShowLogger(false);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSavingSentence(false);
    }
  }

  const guardian = mode === 'guardian';
  const filteredPresets = presets.filter((item) => item.text.includes(presetSearch.trim()));
  const scoreMessage = play && (guardian
    ? play.similarity >= 70 ? 'Meaning survived!' : 'Meaning got lost along the way.'
    : play.similarity < 25 ? 'Glitch successful!' : 'Meaning survived the chaos.');

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand-lockup" href="#home" aria-label="DEVFEST Booth 2">
          <span className="brand-mark"><AudioLines size={21} strokeWidth={2.2} /></span>
          <span><b>DEVFEST</b><small>AWS CLUB · BZU</small></span>
        </a>
        <div className="event-label"><span className="live-dot" /> <span>BOOTH 02</span><i /> <b>Lost in Translation</b></div>
        <button className="team-button" onClick={() => { setShowLogger(true); setError(''); }}>
          <BadgePlus size={17} /> <span>Add a sentence</span>
        </button>
      </header>

      <div className="main-grid" id="home">
        <section className="game-column">
          <div className="intro-row">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" /> THE TRANSLATION RELAY</div>
              <h1>Will meaning <span>survive?</span></h1>
              <p className="intro-copy">One sentence. Five stops. A result you won’t see coming.</p>
            </div>
            <div className="round-stamp" aria-label="Five stops"><span>5</span><small>stops</small></div>
          </div>

          <div className="mode-switch" role="tablist" aria-label="Game mode">
            <button type="button" className={`mode-option guardian-option ${guardian ? 'selected' : ''}`} onClick={() => { setMode('guardian'); resetRound(); }} role="tab" aria-selected={guardian}>
              <span className="mode-symbol"><Shield size={22} /></span>
              <span className="mode-copy"><b>Meaning Guardian</b><small>Keep it intact · target 70%+</small></span>
              {guardian && <Check className="mode-check" size={18} />}
            </button>
            <button type="button" className={`mode-option glitcher-option ${!guardian ? 'selected' : ''}`} onClick={() => { setMode('glitcher'); resetRound(); }} role="tab" aria-selected={!guardian}>
              <span className="mode-symbol"><Swords size={22} /></span>
              <span className="mode-copy"><b>AI Glitcher</b><small>Scramble the meaning · target under 25%</small></span>
              {!guardian && <Check className="mode-check" size={18} />}
            </button>
          </div>

          <form className="game-form" onSubmit={startGame}>
            <div className="form-topline"><label htmlFor="sentence">Ready to send a sentence?</label><span><Sparkles size={14} /> YOUR TURN</span></div>
            <div className="sentence-wrap">
              <textarea id="sentence" dir="rtl" value={sentence} onChange={(event) => setSentence(event.target.value.slice(0, 150))} maxLength={150} placeholder="اكتب جملتك بالعربي هنا... (مثال: الدكتور مش منزل علامات المد)" disabled={isPlaying} />
              <div className="sentence-foot">
                <button type="button" className="quick-pick" onClick={() => { setShowPresets(true); setPresetSearch(''); }} disabled={isPlaying}>
                  <ChevronDown size={16} /> Sentence bank
                </button>
                <span className={sentence.length > 135 ? 'count-near' : ''}>{sentence.length} / 150</span>
              </div>
            </div>
            <div className="form-bottomline">
              <label className="player-field"><span>Player name <b aria-hidden="true">*</b></span><input required value={playerName} onChange={(event) => setPlayerName(event.target.value.slice(0, 30))} placeholder="e.g. Alex" maxLength={30} disabled={isPlaying} /><small>Name required for the leaderboard</small></label>
              <button className={`start-button ${guardian ? 'guardian-cta' : 'glitcher-cta'}`} type="submit" disabled={isPlaying || !sentence.trim() || !playerName.trim()}>
                  {isPlaying ? <><LoaderCircle className="spin" size={18} /> Translating...</> : <>{guardian ? <Shield size={18} /> : <Flame size={18} />} Start challenge <ArrowRight size={17} /></>}
              </button>
            </div>
            {error && <p className="inline-error" role="alert">{error}</p>}
          </form>

          <section className={`pipeline-panel ${isPlaying ? 'is-running' : ''}`} aria-live="polite">
            <div className="pipeline-heading">
              <div><span className="pipeline-label">Fixed translation route</span><span className="pipeline-meta">AR <i /> JP <i /> RU <i /> FR <i /> EN <i /> AR</span></div>
              <span className={`pipeline-status ${isPlaying ? 'status-running' : play ? 'status-done' : ''}`}>
                {isPlaying ? <><span className="status-pulse" /> IN TRANSIT</> : offlineDemo ? <><CircleHelp size={14} /> PRERECORDED DEMO</> : play ? <><Check size={13} /> ROUTE COMPLETE</> : <><CircleHelp size={14} /> AWAITING SENTENCE</>}
              </span>
            </div>
            <div className="route-line" aria-hidden="true"><span style={{ width: `${activeStep < 0 ? 0 : (activeStep + 1) * 20}%` }} /></div>
            <div className="language-grid">
              {pipeline.length ? pipeline.map((step, index) => {
                const revealed = index <= activeStep;
                return <article key={step.key} className={`language-card ${revealed ? 'revealed' : ''} ${index === activeStep ? 'current' : ''} ${step.key === 'arabic' ? 'last-card' : ''}`}>
                  <div className="language-card-head"><span className="flag">{step.flag}</span><span>{step.language}</span>{revealed && <Check size={13} className="card-check" />}</div>
                  <div className="language-card-text" dir={step.key === 'japanese' || step.key === 'russian' ? 'ltr' : 'auto'}>{revealed ? step.text : '···'}</div>
                </article>;
              }) : ['🇯🇵', '🇷🇺', '🇫🇷', '🇬🇧', '🇵🇸'].map((flag, index) => (
                <article key={flag} className={`language-card idle-card ${index === 4 ? 'last-card' : ''}`}>
                  <div className="language-card-head"><span className="flag">{flag}</span><span>{['Japanese', 'Russian', 'French', 'English', 'Arabic'][index]}</span></div>
                  <div className="language-card-text">···</div>
                </article>
              ))}
            </div>
            {play && <div className={`result-banner ${guardian ? 'result-guardian' : 'result-glitcher'} ${offlineDemo ? 'result-offline' : ''}`}>
              <div className="result-stamp">{play.similarity}<small>%</small></div>
              <div className="result-copy">
                <strong>{offlineDemo ? offlineDemo.label : scoreMessage}</strong>
                <span>Final Arabic: <b dir="rtl">{play.finalArabic}</b></span>
                {offlineDemo && <em>{offlineDemo.message}</em>}
              </div>
              <IconButton label="New player" onClick={newPlayer}><RotateCcw size={17} /></IconButton>
            </div>}
          </section>
        </section>

        <aside className="board-column">
          <div className="board-title"><div><span className="eyebrow"><span className="eyebrow-line" /> LIVE STANDINGS</span><h2>Booth champions</h2></div><span className="board-live"><span className="live-dot" /> LIVE</span></div>
          <ScoreList title="Meaning Guardians" subtitle="Highest similarity" entries={leaderboard.guardians} type="guardian" />
          <ScoreList title="AI Glitchers" subtitle="Lowest similarity" entries={leaderboard.glitchers} type="glitcher" />
          <div className="booth-note"><span className="note-glyph">↝</span><p>Arabic travels through <b>Japanese, Russian, French, and English</b> before we see what meaning makes it home.</p></div>
          <button className="booth-link" onClick={() => { setShowPresets(true); setPresetSearch(''); }}><span>Explore sentence bank</span><ArrowRight size={15} /></button>
        </aside>
      </div>

      <footer className="page-footer"><span>DEVFEST 2026 <i /> AWS CLUB · BIRZEIT UNIVERSITY</span><span>BOOTH 02 <i /> LOST IN TRANSLATION</span></footer>

      {showPresets && <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowPresets(false); }}>
        <section className="dialog preset-dialog" role="dialog" aria-modal="true" aria-labelledby="preset-title" tabIndex={-1} ref={modalRef}>
          <div className="dialog-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> QUICK PICK</span><h2 id="preset-title">Sentence bank</h2></div><IconButton label="Close" onClick={() => setShowPresets(false)}><X size={19} /></IconButton></div>
          <label className="search-field"><Search size={17} /><input value={presetSearch} onChange={(event) => setPresetSearch(event.target.value)} placeholder="Search Arabic sentences..." /></label>
          <div className="preset-list">
            {filteredPresets.map((item) => <button key={item.id} className="preset-item" onClick={() => { setSentence(item.text); setShowPresets(false); resetRound(); }}><span className="preset-tag">{categoryLabels[item.category] || item.category}</span><span dir="rtl">{item.text}</span><ArrowRight size={15} /></button>)}
            {!filteredPresets.length && <p className="no-presets">No sentences found.</p>}
          </div>
          <div className="dialog-bottom"><span>{presets.length} sentences</span><button className="text-action" onClick={() => { setShowPresets(false); setShowLogger(true); }}>Add a sentence <BadgePlus size={16} /></button></div>
        </section>
      </div>}

      {showLogger && <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowLogger(false); }}>
        <section className="dialog logger-dialog" role="dialog" aria-modal="true" aria-labelledby="logger-title" tabIndex={-1} ref={modalRef}>
          <div className="dialog-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> TEAM CONTRIBUTION</span><h2 id="logger-title">Add to the sentence bank</h2></div><IconButton label="Close" onClick={() => setShowLogger(false)}><X size={19} /></IconButton></div>
          <p className="dialog-description">Save a memorable campus moment for the next player.</p>
          <form onSubmit={addSentence}>
            <label className="dialog-label" htmlFor="new-sentence">Arabic sentence <span>{newSentence.length} / 150</span></label>
            <textarea id="new-sentence" dir="rtl" className="logger-textarea" maxLength={150} value={newSentence} onChange={(event) => setNewSentence(event.target.value)} placeholder="Write a campus moment in Arabic..." autoFocus />
            <label className="dialog-label" htmlFor="new-category">Category</label>
            <select id="new-category" value={newCategory} onChange={(event) => setNewCategory(event.target.value)}><option>Team</option><option>Academic</option><option>Ritaj</option><option>Campus</option><option>Transport</option><option>Student life</option></select>
            {error && <p className="inline-error" role="alert">{error}</p>}
            <button className="start-button logger-submit" type="submit" disabled={!newSentence.trim() || savingSentence}>{savingSentence ? <><LoaderCircle className="spin" size={17} /> Saving...</> : <>Save sentence <BadgePlus size={17} /></>}</button>
          </form>
        </section>
      </div>}
    </main>
  );
}

export default App;
