-- Cached top-performing posts from the accounts a user follows.
--
-- Cached deliberately, not fetched per page view: X is pay-per-usage, so every
-- timeline read spends credits. Rows are replaced wholesale on each manual
-- refresh, so this is a snapshot rather than history — there is nothing here
-- worth migrating or backfilling if it is ever dropped.
CREATE TABLE IF NOT EXISTS trends (
  id             TEXT    PRIMARY KEY,
  userId         TEXT    NOT NULL,
  tweetId        TEXT    NOT NULL,
  authorName     TEXT    NOT NULL,
  authorUsername TEXT    NOT NULL,
  text           TEXT    NOT NULL,
  likeCount      INTEGER NOT NULL,
  retweetCount   INTEGER NOT NULL,
  replyCount     INTEGER NOT NULL,
  quoteCount     INTEGER NOT NULL,
  -- Weighted engagement, stored so the ordering cannot drift from the ranking
  -- that produced it.
  score          INTEGER NOT NULL,
  postedAt       INTEGER NOT NULL,
  fetchedAt      INTEGER NOT NULL
);

-- Every read is "this user's snapshot, best first".
CREATE INDEX IF NOT EXISTS idx_trends_user_score ON trends (userId, score DESC);
