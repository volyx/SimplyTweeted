# Simply Tweeted

A clean, intuitive tweet scheduling platform that makes scheduling your X (Twitter) content effortless.



https://github.com/user-attachments/assets/a221680c-684f-41ae-99dd-5b5624675ab4



## Features

- **📅 Tweet Scheduling**: Plan your content in advance and let Simply Tweeted post it at the perfect time. **Support posting on communities**
- **🧵 Threads**: Compose up to 10 parts; each is posted as a reply to the previous one with ` 1/n` numbering appended automatically
- **🔐 Authentication**: OAuth integration with X (Twitter) for secure access
- **🔒 Token Security**: User tokens are encrypted and securely stored in the database
- **📱 Responsive Design**: Works seamlessly on desktop and mobile devices


## How to host Simply Tweeted on Cloudflare

Simply Tweeted runs entirely on the **Cloudflare Workers free plan**: two Workers (the web app and the scheduler) sharing one D1 database. No servers, no containers, no MongoDB.

### What you need

- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- **Node.js 20+** and npm
- An X (Twitter) developer application — see [Setting Up X (Twitter) Developer Application](#setting-up-x-twitter-developer-application)

### 1. Clone and install

```bash
git clone https://github.com/volyx/SimplyTweeted.git
cd SimplyTweeted
npm install
npx wrangler login
```

### 2. Create the D1 database

```bash
npx wrangler d1 create simplytweeted
```

Copy the printed `database_id` into **both** `packages/simply-tweeted-app/wrangler.jsonc` and `packages/scheduler/wrangler.jsonc`, replacing `REPLACE_WITH_DATABASE_ID`. Both Workers must point at the same database.

Then apply the schema:

```bash
npm run db:migrate
```

### 3. Set the secrets

Both Workers read overlapping secrets, and three of them must be byte-identical. Keep one
gitignored file as the source of truth rather than typing values twice:

```bash
cp secrets.example.json secrets.json
openssl rand -base64 32   # AUTH_SECRET
openssl rand -base64 32   # DB_ENCRYPTION_KEY
# fill in secrets.json, then:
npm run secrets:push      # -> both Workers, each getting only the keys it reads
npm run secrets:local     # -> both .dev.vars files, for `wrangler dev`
```

| Secret | Web | Cron |
|---|:-:|:-:|
| `AUTH_SECRET` | ✅ | |
| `DB_ENCRYPTION_KEY` | ✅ | ✅ |
| `AUTH_TWITTER_ID` | ✅ | ✅ |
| `AUTH_TWITTER_SECRET` | ✅ | ✅ |
| `ALLOWED_TWITTER_ACCOUNTS` | ✅ | |

`secrets:push` sends all five to the web Worker and filters to just the three the scheduler
reads, so neither Worker holds a secret it has no use for. `wrangler secret bulk` only
deletes a key when it is explicitly set to `null`, so a partial `secrets.json` cannot
silently remove a live secret.

> ⚠️ Changing `DB_ENCRYPTION_KEY` orphans every stored OAuth token — the scheduler will fail
> to decrypt them and mark tweets `failed`. Treat it as permanent once users have signed in.

`wrangler secret put <NAME>` still works for a one-off change; just remember the three shared
keys live in two places.

### 4. Deploy

```bash
cd ../..
npm run deploy
```

This builds `shared-lib`, deploys `simplytweeted-web`, and deploys `simplytweeted-cron` with its every-minute Cron Trigger.

### 5. Custom domain

`packages/simply-tweeted-app/wrangler.jsonc` binds the web Worker to **`twitter.volyx.in`**:

```jsonc
"routes": [
  { "pattern": "twitter.volyx.in", "custom_domain": true }
]
```

On first deploy Wrangler creates the DNS record and provisions the edge certificate — no manual DNS entry needed. The only prerequisite is that the `volyx.in` zone is on the same Cloudflare account you logged into with `wrangler login`.

Certificate issuance usually takes a minute or two; until it completes the domain may serve a TLS error. Check status with:

```bash
npx wrangler deployments status
```

To use a different domain, change the `pattern`. To drop the custom domain entirely, remove the `routes` block and fall back to the `workers.dev` URL.

### 6. Point X at your Worker

Add the callback to your X app's OAuth 2.0 settings:

```
https://twitter.volyx.in/auth/callback/twitter
```

The Worker also stays reachable at `https://simplytweeted-web.<your-subdomain>.workers.dev`. Auth.js derives its callback from the incoming request host, so if you want sign-in to work on that URL too, register its callback as well — or set `"workers_dev": false` in `wrangler.jsonc` to make the custom domain the only entry point.

Visit https://twitter.volyx.in, sign in with an account listed in `ALLOWED_TWITTER_ACCOUNTS`, and schedule a tweet.

### Free plan limits

Everything below is comfortably within the free tier for personal use:

| Resource | Free plan | What this app uses |
|---|---|---|
| Worker requests | 100,000/day | Your page views + 1,440 cron ticks/day |
| CPU time | 10 ms per invocation | SSR of a page; the cron is almost entirely I/O |
| D1 storage | 5 GB | Kilobytes |
| D1 rows read / written | 5M / 100k per day | Hundreds |
| Cron Triggers | 5 per account | 1 |

The real ceiling is X itself: the free X API tier allows roughly **17 posts per 24 hours**.

If you ever exceed the 10 ms CPU limit on SSR, the fix is the $5/month Workers Paid plan — no architecture change is needed.

## Tech Stack

### Frontend
- **SvelteKit**: Modern web framework with SSR support
- **TypeScript**: Type-safe development
- **Tailwind CSS**: Utility-first CSS framework
- **DaisyUI**: Beautiful component library

### Backend
- **Cloudflare Workers** - Serverless runtime
- **Cloudflare D1** - SQLite database for tweets and user accounts
- **X API v2** - Called directly over `fetch`

### Infrastructure
- **Cloudflare Cron Triggers** - Runs the poster every minute
- **Wrangler** - Build and deploy tooling

## Architecture

A monorepo of three packages, deployed as **two Workers sharing one D1 database**:

- **`simply-tweeted-app`** → the `simplytweeted-web` Worker. SvelteKit SSR plus static assets, built with `@sveltejs/adapter-cloudflare`. Handles sign-in and the UI, and writes scheduled tweets to D1.
- **`scheduler`** → the `simplytweeted-cron` Worker. Exports only a `scheduled()` handler, fired every minute by a Cron Trigger. Reads due tweets from D1, refreshes the user's OAuth token if needed, and posts to X.
- **`shared-lib`**: shared types, the D1 data access layer, and AES-256-GCM encryption for OAuth tokens at rest.

```
                  ┌──────────────────────┐
   browser ─────► │  simplytweeted-web   │ ─┐
                  │  (fetch handler)     │  │
                  └──────────────────────┘  │   ┌─────────────┐
                                            ├──►│   D1 DB     │
                  ┌──────────────────────┐  │   │ simplytweeted│
   cron ────────► │  simplytweeted-cron  │ ─┘   └─────────────┘
   (every min)    │  (scheduled handler) │ ───► X API v2
                  └──────────────────────┘
```

### Why two Workers rather than one

The immediate reason is mechanical: `@sveltejs/adapter-cloudflare` emits a fetch-only Worker
and has no scheduled-handler support. Worse, it writes its output to whatever `main` points
at and `rimraf`s that path first, so a hand-written wrapper cannot simply be dropped in
there — merging requires a second wrangler config purely to satisfy the adapter.

But the better reason is structural, and it survives even if the adapter gains support:

- **The poster is the product; the web app is the control panel.** The scheduler runs
  unattended and changes rarely. The SvelteKit app changes constantly. Merging puts the
  stable critical component behind the churning one's build and removes independent
  rollback.
- Every cron tick would evaluate the whole SSR bundle at module scope unless the SvelteKit
  worker is imported lazily — 1,440 times a day, against a 10 ms CPU budget.
- `wrangler deploy [path]` can override the entry positionally, but a bare `wrangler deploy`
  would then ship a Worker with `triggers.crons` and no `scheduled` export. Wrangler does
  not validate that, so cron would fire into errors, rows would sit at `scheduled` forever,
  and nothing would surface in the UI.

The one genuine cost of splitting — three secrets duplicated by hand — is solved by
`npm run secrets:push` above rather than by merging. Note that drift there fails *loudly*:
AES-256-GCM rejects a mismatched `DB_ENCRYPTION_KEY`, the tweet is marked `failed`, and it
appears in `/history`.

### Notes on the Workers runtime

Three constraints shaped this design, and they are easy to trip over again:

- **Read env lazily.** Secrets arrive on `platform.env` and SvelteKit surfaces
  them via AsyncLocalStorage. A module-level `const X = env.X` runs at isolate
  startup, outside any request's ALS context, and silently yields `''` forever.
  `src/lib/server/env.ts` exposes accessor functions, and `src/auth.ts` builds
  its Auth.js config per event, for exactly this reason.
- **No singletons for D1.** `DatabaseClient` is constructed per request from the
  binding. There is no connection to pool, and caching one in module scope would
  outlive the request whose bindings it captured.
- **D1 writes are retried.** D1 intermittently fails a statement with *"storage
  operation exceeded timeout which caused object to be reset"* — a transient
  fault in its backing Durable Object, not a bad query. Every call is wrapped in
  a bounded retry; non-transient errors such as constraint violations still fail
  fast.

Tweet status transitions, with the claim that prevents double-posting when a run
overlaps the next tick:

```
scheduled ──(claimTweet)──► posting ──(all parts 2xx)──► posted
     ▲                         │
     │                         ├──(429 / eviction)──┐
     └──(quota deferral)───────┤                    │  reclaimed after 5 min,
                               │                    └─ resumes at the next
                               └──(error)──────────► failed    unposted part
```

A `posting` row stranded by an interrupted run is reclaimed after 5 minutes.

### Threads

A thread is **one row**. `parts` is a JSON array frozen at save time; the ` 1/n`
suffix is computed at post time from `parts.length`, so the two can never drift.
`packages/shared-lib/src/types/thread.ts` holds the formatter and validator, and
is used by the composer preview, the form action, and the scheduler alike — what
the preview shows is byte-identical to what X receives.

Three things make partial publication survivable, and they are load-bearing
rather than nice-to-have:

- **Resume, never restart.** Because the stale-claim reclaim above is already an
  auto-retry, a thread evicted mid-flight comes back through the poster. It
  starts at `postedIds.length` and chains to the last known id. Restarting would
  duplicate every part already published.
- **`recordThreadProgress` bumps `updatedAt` after every part.** That heartbeat is
  what stops the 5-minute reclaim firing underneath a thread still legitimately
  in flight.
- **A post with no `data.id` throws.** X can return 2xx with an `errors` array and
  no id; left unchecked, `JSON.stringify` silently drops `in_reply_to_tweet_id`
  and the next part publishes as a standalone orphan tweet.

Failure inside a thread always aborts the remainder — skipping a part would
silently drop content from a numbered sequence. The row becomes `failed` with a
non-empty `postedIds`, and `/history` shows "N of M posted" with links to what
went out.

**Quota.** X's free tier allows ~17 posts/24h, so a 5-part thread costs 5. Before
starting a thread the scheduler counts parts it has posted in the last 24h from
its own rows; if the whole thread won't fit it stays `scheduled` and goes out
intact once the window rolls, rather than stranding a half-thread. The ledger is
approximate — it cannot see posts made by other tools.

**Limits.** `MAX_THREAD_PARTS = 10`, and `MAX_POSTS_PER_RUN = 15` per cron
invocation. The latter is about subrequests, not rate limits: every X post *and
every D1 call* counts against a 50-subrequest cap on the free plan, and a thread
costs `2n + 2`.


## Getting Started


### Local Development

**Requirements:**
- **Node.js 20+** - JavaScript runtime environment
- **npm** - Package manager
- **X (Twitter) Developer Account** - Required for API access and OAuth integration

Everything runs locally against a local D1 database — no Cloudflare account needed until you deploy.

#### 1. Clone and install

```bash
git clone https://github.com/volyx/SimplyTweeted.git
cd SimplyTweeted
npm install
```

#### 2. Environment setup

Local secrets go in `.dev.vars` (gitignored), not `.env`. Each Worker package ships a template:

```bash
cp packages/simply-tweeted-app/.dev.vars.example packages/simply-tweeted-app/.dev.vars
cp packages/scheduler/.dev.vars.example packages/scheduler/.dev.vars
```

Fill both in. `DB_ENCRYPTION_KEY` must be the same in each.

#### 3. Build the shared library

```bash
npm run build --workspace=shared-lib
```

#### 4. Create the local database

```bash
npm run db:migrate:local
```

This creates a local SQLite database under `.wrangler-state/`, shared by both Workers.

#### 5. Start the dev servers

Web app (Vite, hot reload — but no D1 binding):

```bash
npm run dev
```

Web app as a real Worker, with the D1 binding and secrets wired up:

```bash
npm run preview --workspace=simply-tweeted-app
```

Scheduler:

```bash
npm run dev:cron
```

Cron Triggers do not fire automatically in local dev. Fire one by hand:

```bash
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

The app will be available at:
- **Web app (Vite)**: http://localhost:5173
- **Web app (Worker)**: http://localhost:8787
- **Scheduler**: http://localhost:8787 (`/__scheduled` only)

Add `http://localhost:5173/auth/callback/twitter` to your X app's callback URLs so sign-in works locally.

#### Inspecting the local database

```bash
cd packages/simply-tweeted-app
npx wrangler d1 execute simplytweeted --local --persist-to ../../.wrangler-state \
  --command "SELECT id, status, scheduledDate FROM tweets"
```

#### Typechecking

```bash
npm run check
```


## Configuration

### X API Setup

See [Setting Up X (Twitter) Developer Application](#setting-up-x-twitter-developer-application)
for the full walkthrough, including the two things that most often go wrong: the
App must sit inside a **Project**, and you need the **OAuth 2.0** Client ID and
Secret rather than the API Key / Bearer Token.

### Secrets

All configuration is Worker secrets — there are no `.env` files in production and
no `MONGODB_URI`, `AUTH_URL`, `ORIGIN`, `PORT` or `CRON_SCHEDULE` any more. The
cron schedule lives in `packages/scheduler/wrangler.jsonc`.

| Secret | Web | Cron | Notes |
|---|:-:|:-:|---|
| `AUTH_SECRET` | ✅ | | Signs the session JWT |
| `DB_ENCRYPTION_KEY` | ✅ | ✅ | **Must be identical on both.** Decrypts stored OAuth tokens — lose it and every user must re-authenticate |
| `AUTH_TWITTER_ID` | ✅ | ✅ | OAuth 2.0 Client ID |
| `AUTH_TWITTER_SECRET` | ✅ | ✅ | OAuth 2.0 Client Secret |
| `ALLOWED_TWITTER_ACCOUNTS` | ✅ | | Comma-separated X usernames, no `@`. Empty means nobody can sign in |

### Database Schema

Cloudflare D1 (SQLite), two tables — see the [`migrations/`](migrations) directory:

- **`tweets`** — one row per scheduled item, `scheduledDate` (epoch ms, UTC), community, and a `status` of `scheduled` → `posting` → `posted` / `failed`. A thread is **one row**, not many: `parts` holds a JSON array of the individual texts, and `postedIds` records the X ids already published. `content` is the display text; `parts` is the authoritative post plan.
- **`accounts`** — one row per user per OAuth provider, unique on `(userId, provider)`. The `access_token` and `refresh_token` columns are encrypted at rest with AES-256-GCM.

Timestamps are stored as integer epoch milliseconds; the data layer converts them to `Date` on the way out.

Migrations are tracked by wrangler in a `d1_migrations` table, so applying is idempotent:

```bash
npm run db:migrate:list    # read-only — shows what is unapplied
npm run db:migrate         # apply to the remote database
npm run db:migrate:local   # apply to the local one
```

## 🤝 Contributions Welcome!

We love contributions from the community! Whether you're fixing bugs, adding new features, improving documentation, or sharing ideas, your input helps make Simply Tweeted better for everyone.

**What we're looking for:**
- 🐛 Bug fixes and performance improvements
- ✨ New features and enhancements
- 📚 Documentation improvements
- 🎨 UI/UX enhancements
- 💡 Feature suggestions and feedback

**New to open source?** No problem! We welcome first-time contributors and are happy to help you get started!

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

There is no test suite yet and `npm test` exits 1, so verify changes by running
`npm run check` (typechecks all three packages) plus a manual end-to-end pass:
sign in, schedule a tweet a couple of minutes out, and confirm the cron posts it.

## Development

### Code Structure

```
migrations/
├── 0001_init.sql           # D1 schema
└── 0002_thread_columns.sql # parts + postedIds for threads
packages/
├── simply-tweeted-app/     # "simplytweeted-web" Worker
│   ├── wrangler.jsonc      # Bindings, assets, compatibility flags
│   ├── src/routes/         # SvelteKit routes
│   ├── src/lib/server/     # env accessors, D1 client factory, logger
│   └── src/auth.ts         # Auth.js config (lazy, per-request)
├── scheduler/              # "simplytweeted-cron" Worker
│   ├── wrangler.jsonc      # Cron Trigger + D1 binding
│   └── src/
│       ├── index.ts        # scheduled() handler
│       ├── tweetProcessor.ts  # Claim, post, update status
│       └── xApi.ts         # X API v2 over fetch (token refresh + post)
└── shared-lib/             # Shared utilities and types
    ├── src/types/          # TypeScript type definitions
    └── src/backend/        # D1 data access + token encryption
```

## License

This project is licensed under the GPL-3.0-or-later License - see the [LICENSE](LICENSE) file for details.

## Support

For issues with this Cloudflare port, [open an issue](https://github.com/volyx/SimplyTweeted/issues)
on this fork. For questions about the original app, see
[timotme/SimplyTweeted](https://github.com/timotme/SimplyTweeted/issues).

---

Originally made with ❤️ by [Timothy](https://x.com/timot_me).

This fork replaces the Docker + MongoDB deployment with Cloudflare Workers, D1,
and Cron Triggers, so the whole app runs on the free tier. See
[`migrations/`](migrations) and the two
`wrangler.jsonc` files for the deployment surface.

## Setting Up X (Twitter) Developer Application

To use Simply Tweeted, you'll need to create an X (Twitter) developer application to get the required API credentials. Here's a step-by-step guide:

### 1. Apply for X Developer Access

1. **Visit the X Developer Portal**: Go to [developer.twitter.com](https://developer.x.com)
2. **Sign in**: Use your X (Twitter) account credentials
3. **Apply for Access**: Click "Apply" and select "Professional" use case
4. **Fill out the Application**: 
   - Describe your intended use (e.g., "Personal tweet scheduling application")
   - Explain how you'll use the Twitter API
   - Agree to the Developer Agreement and Policy

### 2. Create a Project, then an App inside it

> 🚨 **The App must live inside a Project.** X blocks *every* v2 API endpoint for
> standalone apps, so sign-in fails with a 403 that has nothing to do with your
> credentials. This is the single most common way to get stuck.

1. **Navigate to the Developer Portal**: Go to your [developer dashboard](https://developer.x.com/en/portal/dashboard)
2. **Create a Project** first: Click "Create Project"
   - **Name**: Simply Tweeted (or your preferred name)
   - **Use Case**: Choose "Making a bot" or "Building tools for yourself"
3. **Create the App inside that Project** when prompted — not from the dashboard's
   top-level "Create App", which produces a standalone app.

If your app already exists under a **Standalone Apps** heading, move it into a
Project via the Project's **Add App** → *add an existing App*. Prefer moving it
over recreating it: a new app means a new Client ID and Secret to re-register.

### 3. Enable OAuth 2.0 (this is what creates the credentials)

Open the App → **Settings** → scroll to the bottom → **User authentication
settings** → **Set up**. The OAuth 2.0 Client ID and Secret **do not exist until
you complete this form** — before that, the Keys and tokens page shows only
OAuth 1.0a consumer keys.

| Field | Value |
|---|---|
| App permissions | **Read and write** (required for posting) |
| Type of App | **Web App, Automated App or Bot** |
| Callback URI | `https://twitter.volyx.in/auth/callback/twitter` |
| Website URL | `https://twitter.volyx.in` |

For local development, also add `http://localhost:5173/auth/callback/twitter`.

**Type of App matters.** *Web App, Automated App or Bot* registers a
**confidential client**, which is what gets a client secret and authenticates
with an HTTP Basic header. *Native App* and *Single page App* are public clients
with no secret, and both sign-in and token refresh will fail.

### 4. Copy the right credentials

Saving that form displays the pair you need. **The Client Secret is shown only
once** — copy it immediately, or regenerate it later from **Keys and tokens**.

> ⚠️ **Do not use the API Key / API Secret / Bearer Token.** Those are OAuth 1.0a
> and app-only credentials, they sit higher up the same page, and this app uses
> none of them. Look for the section headed **OAuth 2.0 Client ID and Client
> Secret**.
>
> How to tell them apart: the API Key is 25 plain alphanumerics
> (`m3J0lnm1YmG1DobhBhYxARtkN`). The Client ID is longer mixed-case base64 that
> decodes to something ending in `:1:ci`
> (`S2JtLUlnQUM0dWhoLUpNRmdNMTk6MTpjaQ`).

- **Client ID** → `AUTH_TWITTER_ID`
- **Client Secret** → `AUTH_TWITTER_SECRET`

Set both on **both** Workers — the scheduler needs them too, for token refresh.

### 5. Verify the pair before deploying

One curl saves a deploy-and-login cycle. Substitute your own values:

```bash
CID='your-client-id'
SECRET='your-client-secret'
curl -s -X POST https://api.x.com/2/oauth2/token -u "$CID:$SECRET" \
  -d "grant_type=refresh_token&refresh_token=INVALID&client_id=$CID"
```

| Response | Meaning |
|---|---|
| `"Value passed for the token was invalid"` | ✅ Credentials accepted — only the dummy token was rejected |
| `"Missing valid authorization header"` | ❌ Wrong Client Secret (X's wording is misleading) |
| `"Value passed for the client id was invalid"` | ❌ Wrong Client ID |

### Important Notes

- **Rate Limits**: Free tier allows roughly **17 scheduled posts per 24h**. This, not Cloudflare, is the real ceiling.
- **Security**: Keep credentials out of version control. `secrets.json` and both `.dev.vars` files are gitignored; only `secrets.example.json` is committed.
- **Callback URLs**: Must match exactly, including scheme and host.

## Troubleshooting

Read the Worker logs first — they contain the actual cause, which the browser
error page hides:

```bash
cd packages/simply-tweeted-app && npx wrangler tail --format pretty
# or the scheduler:
cd packages/scheduler && npx wrangler tail --format pretty
```

| Symptom | Cause | Fix |
|---|---|---|
| `/auth/error?error=Configuration` + `unauthorized_client` / *"Missing valid authorization header"* | Wrong `AUTH_TWITTER_SECRET`, or a public-client app type | Re-copy the OAuth 2.0 Client Secret; confirm Type of App is *Web App, Automated App or Bot*. Verify with the curl above. |
| `403` + `client-not-enrolled` / *"…App that is attached to a Project"* | App is standalone | Attach it to a Project (step 2) |
| `client_id=` empty in the authorize URL | `AUTH_TWITTER_ID` not set on the web Worker | `wrangler secret put AUTH_TWITTER_ID` from `packages/simply-tweeted-app` |
| `/auth/error?error=AccessDenied` | The `signIn` callback returned false, or a D1 write failed | Check `ALLOWED_TWITTER_ACCOUNTS` contains your username without `@`; check the log for a `D1_ERROR` |
| `OAuthProfileParseError` / *"Cannot read properties of undefined"* | X returned a non-success body from `/2/users/me` | The log line above it prints X's actual response |
| Secrets appear set but are read as `''` | Env read at module scope | Keep `$env/dynamic/private` access lazy — see `src/lib/server/env.ts` |
| A thread stays `scheduled` past its time, log says "Deferring thread" | Its parts don't fit in the remaining ~17/24h budget | Expected — it posts intact once the window rolls. Check `x-user-limit-24hour-remaining` in the cron logs |
| Thread shows "N of M posted" and `failed` | A part was rejected mid-thread; the rest were aborted deliberately | The log line above it has X's response. Already-published parts stay on X |
| `duplicate column name: parts` | Migrations replayed without tracked state | Use `npm run db:migrate`, not `d1 execute --file` |

Secrets are per-Worker and resolved from the `wrangler.jsonc` in the current
directory, so `wrangler secret put` from the repo root silently targets nothing.
`cd` into the package first.

For more detailed information, visit the [X API documentation](https://docs.x.com).
