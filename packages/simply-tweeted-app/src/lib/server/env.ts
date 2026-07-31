import { env as privateEnv } from '$env/dynamic/private';

/**
 * These MUST stay lazy.
 *
 * On Cloudflare, secrets live on `platform.env` and SvelteKit exposes them through
 * $env/dynamic/private via AsyncLocalStorage. Module-level `const X = privateEnv.X`
 * would be evaluated once at isolate startup — outside any request's ALS context —
 * and would silently resolve to '' for every request thereafter.
 */
export const AUTH_SECRET = () => privateEnv.AUTH_SECRET || '';
export const DB_ENCRYPTION_KEY = () => privateEnv.DB_ENCRYPTION_KEY || '';
export const AUTH_TWITTER_ID = () => privateEnv.AUTH_TWITTER_ID || '';
export const AUTH_TWITTER_SECRET = () => privateEnv.AUTH_TWITTER_SECRET || '';
export const ALLOWED_TWITTER_ACCOUNTS = () => privateEnv.ALLOWED_TWITTER_ACCOUNTS || '';
/** Optional. Absent just means the composer's AI split button is unavailable. */
export const ANTHROPIC_API_KEY = () => privateEnv.ANTHROPIC_API_KEY || '';
