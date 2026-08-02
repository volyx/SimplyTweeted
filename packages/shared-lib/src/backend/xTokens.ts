/**
 * OAuth token handling for X, shared by every Worker that calls the API.
 *
 * This lives here rather than in the scheduler because X **rotates the refresh
 * token** on every refresh. Two Workers each running their own copy of this
 * logic would race: whichever refreshed second would present a refresh token the
 * first had already invalidated, and the account would be signed out with no
 * obvious cause. One implementation, one persisted result.
 */
import type { UserAccount } from '../types/types.js';
import type { DatabaseClient } from './db.js';

const TOKEN_URL = 'https://api.x.com/2/oauth2/token';

/** Refresh when the access token expires within this window. */
const REFRESH_SKEW_MS = 60_000;

export interface XCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Carries the HTTP status as a real field. Callers branch on it (429 defers and
 * resumes, 401/403 abandons the batch), and recovering the status by regexing an
 * error message would break the first time anyone edits the string.
 */
export class XApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(`X API request failed (${status}): ${body}`);
    this.name = 'XApiError';
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

/**
 * Returns a usable access token for the account, refreshing and persisting it
 * first if it is at or near expiry.
 */
export async function ensureAccessToken(
  db: DatabaseClient,
  account: UserAccount,
  credentials: XCredentials
): Promise<string> {
  const expiresAtMs = account.expires_at * 1000;
  if (expiresAtMs - REFRESH_SKEW_MS > Date.now()) {
    return account.access_token;
  }

  const basic = btoa(`${credentials.clientId}:${credentials.clientSecret}`);
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: account.refresh_token,
      client_id: credentials.clientId
    })
  });

  if (!response.ok) {
    throw new XApiError(response.status, await response.text());
  }

  const token = (await response.json()) as TokenResponse;

  const updatedAccount: UserAccount = {
    ...account,
    access_token: token.access_token,
    // X rotates refresh tokens; keep the old one only if none came back.
    refresh_token: token.refresh_token || account.refresh_token,
    expires_at: token.expires_in
      ? Math.floor(Date.now() / 1000) + token.expires_in
      : account.expires_at,
    expires_in: token.expires_in ?? account.expires_in,
    token_type: token.token_type ?? account.token_type,
    updatedAt: new Date()
  };

  await db.saveUserAccount(updatedAccount);

  return updatedAccount.access_token;
}
