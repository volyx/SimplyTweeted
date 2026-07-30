-- Thread support: one row holds the whole thread.
--
-- `parts` is the frozen post plan (JSON string[]), written only when there is
-- more than one part — so ordinary single tweets keep `parts IS NULL` and behave
-- exactly as before. `content` keeps its meaning as the display text.
--
-- `postedIds` records the X post ids already created for this row, in order. It
-- is what makes the scheduler resume a partially-posted thread instead of
-- restarting it (the stale-claim reclaim in findDueTweets would otherwise
-- repost from part 1 and duplicate everything already published).
--
-- No new status value: SQLite cannot ALTER a CHECK constraint without rebuilding
-- the table, so "partially posted" is `failed` with a non-empty postedIds.
--
-- Note ALTER TABLE ADD COLUMN has no IF NOT EXISTS in SQLite, which is why this
-- repo uses `wrangler d1 migrations apply` (tracked state) rather than replaying
-- files.

ALTER TABLE tweets ADD COLUMN parts TEXT;
ALTER TABLE tweets ADD COLUMN postedIds TEXT;
