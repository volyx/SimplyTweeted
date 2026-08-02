import type { PostHeadroom, UserAccount } from 'shared-lib';
import { DatabaseClient, ensureAccessToken, XApiError } from 'shared-lib/backend';
import type { XCredentials } from 'shared-lib/backend';
import { log } from './logger.js';

const TWEETS_URL = 'https://api.x.com/2/tweets';

// Token refresh lives in shared-lib: X rotates the refresh token, so a second
// copy of that logic here would race the app's and sign the account out.
export { XApiError };
export type { XCredentials };

export interface PostTweetOptions {
  /** Applied to the first post of a thread only; replies inherit the Community. */
  communityId?: string;
  /** Chains this post as a reply, forming the thread. */
  inReplyToTweetId?: string;
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

  /** Delegates to the shared implementation so both Workers rotate one token. */
  async getAccessToken(account: UserAccount): Promise<string> {
    return ensureAccessToken(this.db, account, this.credentials);
  }

  /**
   * Posts a tweet, optionally into an X Community and/or as a reply.
   *
   * @returns the id of the created post — required to chain the next part of a
   *   thread.
   */
  /**
   * The most recent 24h posting figures X reported, or null if it has not said.
   *
   * Kept on the client rather than returned from postTweet so the caller can
   * persist once per run instead of once per part. Each part is a subrequest and
   * a thread already costs 2n+2 against the free plan's 50.
   */
  lastHeadroom: PostHeadroom | null = null;

  /** Reads the x-user-limit-24hour-* headers X attaches to a successful post. */
  private captureHeadroom(response: Response, id: string): void {
    const remaining = response.headers.get('x-user-limit-24hour-remaining');
    if (remaining === null) {
      return;
    }

    const limit = response.headers.get('x-user-limit-24hour-limit');
    const reset = response.headers.get('x-user-limit-24hour-reset');

    this.lastHeadroom = {
      remaining: Number(remaining),
      limit: limit === null ? null : Number(limit),
      // X sends the reset as epoch *seconds*; everything stored here is ms.
      resetAt: reset === null ? null : Number(reset) * 1000,
      observedAt: Date.now()
    };

    log.info(`Posted ${id}; X reports ${remaining} posts remaining in the 24h window`, {
      tweetId: id,
      remaining,
      limit
    });
  }

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

    this.captureHeadroom(response, id);

    return id;
  }
}
