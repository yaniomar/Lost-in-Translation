CREATE TABLE IF NOT EXISTS sentence_presets (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 150),
  normalized_text TEXT NOT NULL UNIQUE,
  category VARCHAR(24) NOT NULL DEFAULT 'Team',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS offline_examples (
  id TEXT PRIMARY KEY,
  original TEXT NOT NULL,
  normalized_original TEXT NOT NULL UNIQUE,
  final_arabic TEXT NOT NULL,
  similarity INTEGER NOT NULL CHECK (similarity BETWEEN 0 AND 100),
  recorded_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS plays (
  id TEXT PRIMARY KEY,
  player_name VARCHAR(30) NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('guardian', 'glitcher')),
  original TEXT NOT NULL CHECK (char_length(original) BETWEEN 1 AND 150),
  final_arabic TEXT NOT NULL,
  similarity INTEGER NOT NULL CHECK (similarity BETWEEN 0 AND 100),
  created_at TIMESTAMPTZ NOT NULL,
  translation_source TEXT NOT NULL DEFAULT 'aws' CHECK (translation_source IN ('aws', 'offline'))
);

CREATE INDEX IF NOT EXISTS plays_guardian_leaderboard
  ON plays (similarity DESC, created_at ASC) WHERE mode = 'guardian' AND translation_source <> 'offline';
CREATE INDEX IF NOT EXISTS plays_glitcher_leaderboard
  ON plays (similarity ASC, created_at ASC) WHERE mode = 'glitcher' AND translation_source <> 'offline';

CREATE TABLE IF NOT EXISTS player_attempts (
  player_id TEXT PRIMARY KEY,
  player_name VARCHAR(30) NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed >= 0),
  active_round_token UUID,
  active_round_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS aws_usage (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  aws_requests_attempted BIGINT NOT NULL DEFAULT 0 CHECK (aws_requests_attempted >= 0),
  translated_characters_submitted BIGINT NOT NULL DEFAULT 0 CHECK (translated_characters_submitted >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO aws_usage (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
