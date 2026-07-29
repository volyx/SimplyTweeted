-- Initial D1 schema for SimplyTweeted.
-- Ported from the MongoDB $jsonSchema validators in the former deployment/mongo-init/init-tweets.js.
-- Dates are stored as INTEGER epoch milliseconds; the mapping layer in shared-lib converts to Date.

CREATE TABLE IF NOT EXISTS tweets (
  id            TEXT PRIMARY KEY,
  userId        TEXT    NOT NULL,
  content       TEXT    NOT NULL,
  scheduledDate INTEGER NOT NULL,
  community     TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL CHECK (status IN ('scheduled', 'posting', 'posted', 'failed')),
  createdAt     INTEGER NOT NULL,
  updatedAt     INTEGER
);

-- Drives the scheduler's due-tweet scan.
CREATE INDEX IF NOT EXISTS idx_tweets_due ON tweets (status, scheduledDate);
-- Drives the /scheduled and /history listings.
CREATE INDEX IF NOT EXISTS idx_tweets_user ON tweets (userId, status, scheduledDate);

CREATE TABLE IF NOT EXISTS accounts (
  id                TEXT PRIMARY KEY,
  userId            TEXT    NOT NULL,
  username          TEXT    NOT NULL,
  provider          TEXT    NOT NULL,
  providerAccountId TEXT    NOT NULL,
  access_token      TEXT    NOT NULL,
  refresh_token     TEXT    NOT NULL,
  expires_at        INTEGER NOT NULL,
  expires_in        INTEGER NOT NULL,
  token_type        TEXT    NOT NULL,
  scope             TEXT    NOT NULL,
  createdAt         INTEGER NOT NULL,
  updatedAt         INTEGER,
  UNIQUE (userId, provider)
);

CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts (userId);
CREATE INDEX IF NOT EXISTS idx_accounts_provider_account ON accounts (providerAccountId);
