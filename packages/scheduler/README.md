# Tweet Poster Service

The `simplytweeted-cron` Cloudflare Worker. A Cron Trigger fires it every minute; it posts any tweets that have come due.

## Features

- **Cron Trigger**: Cloudflare invokes `scheduled()` every minute — no long-running process
- **Batch Processing**: Groups due tweets by user so each user's token is refreshed at most once per run
- **Token Management**: Refreshes X OAuth 2.0 access tokens just before expiry and persists the rotated pair
- **Double-post protection**: Each tweet is claimed with a conditional `UPDATE` before the X API call, so overlapping runs cannot post it twice
- **Error Handling**: Failures mark the individual tweet `failed` and leave the rest of the batch alone
- **Database Integration**: Shares the `simplytweeted` D1 database with the web Worker

## Architecture

- `index.ts` — the `scheduled()` handler; finds due tweets, groups them by user
- `logger.ts` — structured JSON logging over `console.*` (picked up by Workers Logs)
- `xApi.ts` — X API v2 over `fetch`: token refresh and tweet posting
- `tweetProcessor.ts` — per-user posting logic and status transitions

Configuration lives in `wrangler.jsonc` (cron schedule, D1 binding, compatibility flags) rather than in environment variables.

## Setup

1. Install dependencies from the repo root:
   ```bash
   npm install
   ```

2. Build the shared library:
   ```bash
   npm run build --workspace=shared-lib
   ```

3. Create `.dev.vars` for local runs:
   ```bash
   cp .dev.vars.example .dev.vars
   ```
   `DB_ENCRYPTION_KEY` must match the web Worker's value, or stored OAuth tokens cannot be decrypted.

4. Point `wrangler.jsonc` at your D1 database by replacing `REPLACE_WITH_DATABASE_ID` with the same `database_id` used by `packages/simply-tweeted-app/wrangler.jsonc`.

## Running

Local dev server:

```bash
npm run dev
```

Cron Triggers do not fire on their own locally. Trigger a run by hand:

```bash
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

Typecheck:

```bash
npm run check
```

Deploy:

```bash
npm run deploy
```

This Worker reads three secrets: `DB_ENCRYPTION_KEY`, `AUTH_TWITTER_ID`, `AUTH_TWITTER_SECRET`
— all shared with the web Worker and required to be identical. Set them from the repo root
with `npm run secrets:push`, which pushes from a single gitignored `secrets.json` and filters
to just these three. `npm run secrets:local` writes the matching `.dev.vars`.

## Tweet lifecycle

```
scheduled ──(claimTweet)──► posting ──(X API 2xx)──► posted
                               │
                               └──(error)──────────► failed
```

A `posting` row left behind by an interrupted run is reclaimed automatically after 5 minutes.
