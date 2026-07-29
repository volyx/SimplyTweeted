# Simply Tweeted

A clean, intuitive tweet scheduling platform that makes scheduling your X (Twitter) content effortless.



https://github.com/user-attachments/assets/a221680c-684f-41ae-99dd-5b5624675ab4



## Features

- **📅 Tweet Scheduling**: Plan your content in advance and let Simply Tweeted post it at the perfect time. **Support posting on communities**
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
git clone https://github.com/timotme/SimplyTweeted.git
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

Generate two random values first:

```bash
openssl rand -base64 32   # AUTH_SECRET
openssl rand -base64 32   # DB_ENCRYPTION_KEY
```

Web Worker:

```bash
cd packages/simply-tweeted-app
npx wrangler secret put AUTH_SECRET
npx wrangler secret put DB_ENCRYPTION_KEY
npx wrangler secret put AUTH_TWITTER_ID
npx wrangler secret put AUTH_TWITTER_SECRET
npx wrangler secret put ALLOWED_TWITTER_ACCOUNTS   # comma-separated X usernames
```

Scheduler Worker:

```bash
cd ../scheduler
npx wrangler secret put DB_ENCRYPTION_KEY          # must match the web Worker's value
npx wrangler secret put AUTH_TWITTER_ID
npx wrangler secret put AUTH_TWITTER_SECRET
```

> ⚠️ `DB_ENCRYPTION_KEY` must be identical for both Workers. It decrypts the stored OAuth tokens — if they differ, the scheduler cannot post.

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

Why two Workers rather than one: the stock SvelteKit Cloudflare adapter emits a fetch-only Worker with no way to add a `scheduled()` handler. Splitting them keeps the adapter unmodified and isolates the cron's CPU budget from page rendering.


## Getting Started


### Local Development

**Requirements:**
- **Node.js 20+** - JavaScript runtime environment
- **npm** - Package manager
- **X (Twitter) Developer Account** - Required for API access and OAuth integration

Everything runs locally against a local D1 database — no Cloudflare account needed until you deploy.

#### 1. Clone and install

```bash
git clone https://github.com/timotme/SimplyTweeted.git
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

### Twitter API Setup

1. Create a Twitter Developer Account
2. Create a new App in the Twitter Developer Portal
3. Generate your API keys and tokens
4. Add the credentials to your environment file
5. Set up OAuth 2.0 with the correct callback URLs

### Database Schema

Cloudflare D1 (SQLite), two tables — see [`migrations/0001_init.sql`](migrations/0001_init.sql):

- **`tweets`** — one row per scheduled tweet: content, `scheduledDate` (epoch ms, UTC), community, and a `status` of `scheduled` → `posting` → `posted` / `failed`.
- **`accounts`** — one row per user per OAuth provider, unique on `(userId, provider)`. The `access_token` and `refresh_token` columns are encrypted at rest with AES-256-GCM.

Timestamps are stored as integer epoch milliseconds; the data layer converts them to `Date` on the way out.

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

## Development

### Code Structure

```
migrations/
└── 0001_init.sql           # D1 schema
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

If you encounter any issues or have questions, please [open an issue](https://github.com/timotme/SimplyTweeted/issues) on GitHub.

---

Made with ❤️ by [Timothy] [https://x.com/timot_me]

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

### 2. Create a New App

Once your developer account is approved:

1. **Navigate to the Developer Portal**: Go to your [developer dashboard](https://developer.x.com/en/portal/dashboard)
2. **Create a New Project**: Click "Create Project"
3. **Project Details**:
   - **Name**: Simply Tweeted (or your preferred name)
   - **Use Case**: Choose "Making a bot" or "Building tools for yourself"
   - **Environment**: Select "Development" for testing or "Production" for live use

### 3. Configure Your App

1. **App Settings**: Click on your newly created app
2. **App Permissions**: 
   - Set to **"Read and write"** (required for posting tweets)
   - Enable **"Request email address from users"** if you want email access
3. **Authentication Settings**:
   - **App Type**: Set to "Web App"
   - **Callback URLs**: Add your deployed Worker's callback:
     ```
     https://twitter.volyx.in/auth/callback/twitter
     ```
     For local development, also add:
     ```
     http://localhost:5173/auth/callback/twitter
     ```
   - **Website URL**: Add your application's URL (this is not important)

### 4. Generate OAuth 2.0 Credentials

Simply Tweeted uses OAuth 2.0 for authentication. You only need the OAuth 2.0 Client ID and Client Secret:

1. **User Authentication Settings**: In your app settings, click "Set up" in the OAuth 2.0 section
2. **OAuth 2.0 Settings**:
   - **App Type**: Select "Confidential client"
   - **Client ID**: This becomes your `AUTH_TWITTER_ID`
   - **Client Secret**: This becomes your `AUTH_TWITTER_SECRET`

**Note**: You don't need the older API Key and API Secret - Simply Tweeted only uses OAuth 2.0 credentials.

### Important Notes

- **Rate Limits**: Free tier has limited API calls per day/months. ~ 17 scheduled posts per 24h
- **Security**: Keep your API keys secure and never commit them to version control
- **Callback URLs**: Must exactly match your domain (including https/http)

### Common Issues

- **Callback URL Mismatch**: Ensure the URL you are visiting matches a callback URL registered in your X app. Auth.js derives the callback from the incoming request host (`trustHost: true`), so `workers.dev` and any custom domain each need their own entry.
- **Permission Denied**: Verify your app has "Read and write" permissions
- **Invalid Credentials**: Double-check your `AUTH_TWITTER_ID` and `AUTH_TWITTER_SECRET`

For more detailed information, visit the [X API documentation](https://developer.twitter.com/en/docs).
