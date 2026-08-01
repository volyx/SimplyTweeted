-- What X reports about the account's remaining daily posts.
--
-- Every successful post comes back with x-user-limit-24hour-* headers. They were
-- logged and thrown away; storing the latest set gives the dashboard a real
-- number rather than a locally modelled guess, at no extra API call.
--
-- All nullable: an account that has not posted since this shipped simply has
-- nothing to report yet, which the UI states rather than guesses at.
ALTER TABLE accounts ADD COLUMN postsRemaining INTEGER;
ALTER TABLE accounts ADD COLUMN postsLimit INTEGER;
-- Epoch ms. When the 24h window rolls over, per X's own reset header.
ALTER TABLE accounts ADD COLUMN postsResetAt INTEGER;
-- Epoch ms the figures were observed, so the UI can say how stale they are.
ALTER TABLE accounts ADD COLUMN postsObservedAt INTEGER;
