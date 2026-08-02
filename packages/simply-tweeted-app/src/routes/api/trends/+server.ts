/**
 * Refreshes the cached "what's performing" snapshot from the accounts the user
 * follows.
 *
 * Only ever runs when the user asks. X is pay-per-usage, so each call here
 * spends credits — the sidebar reads the cache on every page load and this
 * endpoint is the one place that costs anything.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { scoreEngagement, type TrendingPost } from 'shared-lib';
import { ensureAccessToken, XApiError } from 'shared-lib/backend';
import { getDb } from '$lib/server/db';
import { AUTH_TWITTER_ID, AUTH_TWITTER_SECRET } from '$lib/server/env';
import { log } from '$lib/server/logger.js';

/** Posts from followed accounts, newest first. 100 is the endpoint's maximum. */
const TIMELINE_URL = 'https://api.x.com/2/users';
const MAX_RESULTS = 100;
/** How many make it to the sidebar. */
const KEEP = 10;

interface TimelineResponse {
  data?: Array<{
    id: string;
    text: string;
    author_id: string;
    created_at: string;
    public_metrics?: {
      like_count: number;
      retweet_count: number;
      reply_count: number;
      quote_count: number;
    };
  }>;
  includes?: {
    users?: Array<{ id: string; name: string; username: string }>;
  };
}

export const POST: RequestHandler = async ({ locals, platform }) => {
  const session = await locals.auth();
  const userId = session?.user?.id;
  if (!userId) {
    return json({ error: 'Not signed in' }, { status: 401 });
  }

  const db = getDb(platform);

  const account = await db.getUserAccount(userId, 'twitter');
  if (!account) {
    return json({ error: 'No connected X account' }, { status: 400 });
  }

  const clientId = AUTH_TWITTER_ID();
  const clientSecret = AUTH_TWITTER_SECRET();
  if (!clientId || !clientSecret) {
    return json({ error: 'X credentials are not configured' }, { status: 503 });
  }

  try {
    const accessToken = await ensureAccessToken(db, account, { clientId, clientSecret });

    // providerAccountId is X's own numeric id for the account; the path needs
    // that rather than our internal user id.
    const url = new URL(
      `${TIMELINE_URL}/${account.providerAccountId}/timelines/reverse_chronological`
    );
    url.searchParams.set('max_results', String(MAX_RESULTS));
    url.searchParams.set('tweet.fields', 'public_metrics,created_at,author_id');
    url.searchParams.set('expansions', 'author_id');
    url.searchParams.set('user.fields', 'name,username');

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!response.ok) {
      const body = await response.text();
      log.error('Trends fetch failed', { status: response.status, body: body.slice(0, 300) });

      // 403 here almost always means the plan does not include reads, which is
      // worth saying plainly rather than as a generic failure.
      const message =
        response.status === 403
          ? 'X refused the read. This usually means the API plan on this account does not include reading posts.'
          : response.status === 429
            ? 'X rate-limited the request. Try again shortly.'
            : `X returned ${response.status}.`;
      return json({ error: message }, { status: 502 });
    }

    const payload = (await response.json()) as TimelineResponse;
    const authors = new Map(
      (payload.includes?.users ?? []).map((user) => [user.id, user] as const)
    );

    const fetchedAt = new Date();
    const posts: TrendingPost[] = (payload.data ?? [])
      .map((post) => {
        const metrics = {
          likeCount: post.public_metrics?.like_count ?? 0,
          retweetCount: post.public_metrics?.retweet_count ?? 0,
          replyCount: post.public_metrics?.reply_count ?? 0,
          quoteCount: post.public_metrics?.quote_count ?? 0
        };
        const author = authors.get(post.author_id);

        return {
          tweetId: post.id,
          authorName: author?.name ?? 'Unknown',
          authorUsername: author?.username ?? 'unknown',
          text: post.text,
          ...metrics,
          score: scoreEngagement(metrics),
          postedAt: new Date(post.created_at),
          fetchedAt
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, KEEP);

    await db.saveTrends(userId, posts);
    log.info('Trends refreshed', { userId, scanned: payload.data?.length ?? 0, kept: posts.length });

    return json({ posts, scanned: payload.data?.length ?? 0 });
  } catch (error) {
    const status = error instanceof XApiError ? error.status : 500;
    log.error('Trends refresh failed', { userId, error });
    return json(
      { error: status === 401 ? 'Your X connection expired — sign in again.' : 'Could not refresh trends.' },
      { status: 502 }
    );
  }
};
