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

export interface PostTweetOptions {
  /** Applied to the first post of a thread only; replies inherit the Community. */
  communityId?: string;
  /** Chains this post as a reply, forming the thread. */
  inReplyToTweetId?: string;
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

    await this.db.saveUserAccount(updatedAccount);
    log.info(`Saved refreshed token for user ${account.userId}`, {
      userId: account.userId,
      // Never log the token itself.
      accessTokenPrefix: token.access_token.slice(0, 10) + '...'
    });

    return updatedAccount.access_token;
  }

  /**
   * Posts a tweet, optionally into an X Community and/or as a reply.
   *
   * @returns the id of the created post — required to chain the next part of a
   *   thread.
   */
  async postTweet(
    accessToken: string,
    text: string,
    options: PostTweetOptions = {}
  ): Promise<string> {
    // `community_id` is top-level; `reply` is a nested object.
    const payload: {
      text: string;
      community_id?: string;
      reply?: { in_reply_to_tweet_id: string };
    } = { text };

    if (options.communityId) {
      payload.community_id = options.communityId;
    }
    if (options.inReplyToTweetId) {
      payload.reply = { in_reply_to_tweet_id: options.inReplyToTweetId };
    }

    const response = await fetch(TWEETS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const body = await response.text();

    if (!response.ok) {
      throw new XApiError(response.status, body);
    }

    // X can return 2xx with an `errors` array and no `data.id`. Checking
    // response.ok alone would hand back undefined, JSON.stringify would then
    // silently drop `in_reply_to_tweet_id` from the next request, and that part
    // would post as a standalone tweet — a broken thread plus a stray orphan,
    // with nothing thrown. So the id is verified here.
    let id: unknown;
    try {
      id = (JSON.parse(body) as { data?: { id?: unknown } }).data?.id;
    } catch {
      throw new XApiError(response.status, `unparseable success body: ${body.slice(0, 200)}`);
    }

    if (typeof id !== 'string' || id.length === 0) {
      throw new XApiError(response.status, `success response had no data.id: ${body.slice(0, 200)}`);
    }

    const remaining = response.headers.get('x-user-limit-24hour-remaining');
    if (remaining !== null) {
      log.info(`Posted ${id}; X reports ${remaining} posts remaining in the 24h window`, {
        tweetId: id,
        remaining
      });
    }

    return id;
  }
}
