import type { UserAccount } from 'shared-lib';
import type { DatabaseClient } from 'shared-lib/backend';
import { log } from './logger.js';

const TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const TWEETS_URL = 'https://api.x.com/2/tweets';

/** Refresh when the access token expires within this window. */
const REFRESH_SKEW_MS = 60_000;

export interface XCredentials {
  clientId: string;
  clientSecret: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

/**
 * Replaces twitter-api-v2 + its token-refresher plugin, both of which are built
 * on Node's https.request transport and pull significant weight into a Worker
 * bundle. Everything we need is two fetch calls.
 */
export class XClient {
  constructor(
    private db: DatabaseClient,
    private credentials: XCredentials
  ) {}

  /**
   * Returns a usable access token for the account, refreshing and persisting it
   * first if it is at or near expiry.
   */
  async getAccessToken(account: UserAccount): Promise<string> {
    const expiresAtMs = account.expires_at * 1000;
    if (expiresAtMs - REFRESH_SKEW_MS > Date.now()) {
      return account.access_token;
    }

    log.info(`Refreshing access token for user ${account.userId}`, { userId: account.userId });

    const basic = btoa(`${this.credentials.clientId}:${this.credentials.clientSecret}`);
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: account.refresh_token,
        client_id: this.credentials.clientId
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Token refresh failed (${response.status}): ${body}`);
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

    await this.db.saveUserAccount(updatedAccount);
    log.info(`Saved refreshed token for user ${account.userId}`, {
      userId: account.userId,
      // Never log the token itself.
      accessTokenPrefix: token.access_token.slice(0, 10) + '...'
    });

    return updatedAccount.access_token;
  }

  /** Posts a tweet, optionally into an X Community. */
  async postTweet(accessToken: string, text: string, communityId?: string): Promise<void> {
    const payload: { text: string; community_id?: string } = { text };
    if (communityId) {
      payload.community_id = communityId;
    }

    const response = await fetch(TWEETS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Tweet POST failed (${response.status}): ${body}`);
    }
  }
}
