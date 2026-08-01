import { DatabaseClient } from 'shared-lib/backend';
import { TweetStatus, Tweet, UserAccount, getCommunityId, formatThreadPart } from 'shared-lib';
import { XClient, XApiError } from './xApi.js';
import { log } from './logger.js';

/**
 * A row stuck in `posting` gets reclaimed every 5 minutes. Give up eventually so
 * a permanently broken thread cannot cycle forever.
 */
const ABANDON_AFTER_MS = 24 * 60 * 60 * 1000;

export class TweetProcessor {
  private dbClient: DatabaseClient;
  private xClient: XClient;

  constructor(dbClient: DatabaseClient, xClient: XClient) {
    this.dbClient = dbClient;
    this.xClient = xClient;
  }

  private async markTweetsAsFailed(tweets: Tweet[], reason: string, userId?: string) {
    const forUser = userId ? ` for user ${userId}` : '';
    log.error(`Marking ${tweets.length} tweets as FAILED${forUser}. Reason: ${reason}`, {
      tweetCount: tweets.length,
      userId,
      reason
    });
    for (const tweet of tweets) {
      try {
        await this.dbClient.updateTweetStatus(tweet.id!, TweetStatus.FAILED);
      } catch (dbError) {
        log.error(`Error updating status for tweet ${tweet.id} to FAILED:`, {
          tweetId: tweet.id,
          error: dbError
        });
      }
    }
  }

  /**
   * Posts every part of a tweet as a reply chain, resuming where a previous run
   * left off.
   *
   * A single tweet is just a one-part thread, so it takes the identical path —
   * `formatThreadPart` adds no suffix when there is only one part.
   *
   * @returns the X ids posted across all runs, including ones from earlier attempts.
   * @throws the underlying error after persisting partial progress.
   */
  private async postThread(
    accessToken: string,
    tweet: Tweet,
    communityId?: string
  ): Promise<string[]> {
    const parts = tweet.parts ?? [tweet.content];
    const total = parts.length;

    // Resume rather than restart: the stale-claim reclaim in findDueTweets means
    // an evicted run WILL come back through here, and starting from 0 would
    // duplicate every part already published.
    const postedIds = [...(tweet.postedIds ?? [])];
    const startIndex = postedIds.length;

    if (startIndex >= total) {
      return postedIds;
    }

    if (startIndex > 0) {
      log.info(`Resuming thread ${tweet.id} at part ${startIndex + 1}/${total}`, {
        tweetId: tweet.id,
        startIndex,
        total
      });
    }

    for (let i = startIndex; i < total; i++) {
      const text = formatThreadPart(parts[i], i, total);
      try {
        const id = await this.xClient.postTweet(accessToken, text, {
          // The Community applies to the head of the thread; replies inherit it.
          communityId: i === 0 ? communityId : undefined,
          inReplyToTweetId: i === 0 ? undefined : postedIds[i - 1]
        });
        postedIds.push(id);
      } catch (error) {
        // Persist what did go out before unwinding, so the retry resumes
        // correctly instead of duplicating.
        if (postedIds.length > startIndex) {
          await this.dbClient.recordThreadProgress(tweet.id!, postedIds);
        }
        throw error;
      }

      // Heartbeat + progress. Skipped on the final part because the terminal
      // updateTweetStatus writes postedIds in the same statement.
      if (i < total - 1) {
        await this.dbClient.recordThreadProgress(tweet.id!, postedIds);
      }
    }

    return postedIds;
  }

  /**
   * @returns the number of X posts made, so the caller can hold a per-run budget.
   */
  async processUserTweets(userId: string, tweets: Tweet[], maxPosts: number): Promise<number> {
    log.info(`Processing ${tweets.length} tweets for user ${userId}`, {
      userId,
      tweetCount: tweets.length
    });

    let postsMade = 0;

    try {
      const userAccounts = await this.dbClient.getUserAccounts(userId);
      if (userAccounts.length === 0) {
        await this.markTweetsAsFailed(tweets, `No accounts found for user ${userId}`, userId);
        return postsMade;
      }

      const twitterAccount = userAccounts.find(
        (account: UserAccount) => account.provider === 'twitter'
      );
      if (!twitterAccount) {
        await this.markTweetsAsFailed(tweets, `No Twitter account found for user ${userId}`, userId);
        return postsMade;
      }

      const accessToken = await this.xClient.getAccessToken(twitterAccount);

      for (const tweet of tweets) {
        const partCount = tweet.parts?.length ?? 1;
        const alreadyPosted = tweet.postedIds?.length ?? 0;

        // Each part is a subrequest, and so is each progress write. Stop cleanly
        // rather than risk the 50-subrequest cap; untouched rows stay scheduled
        // and go out on the next tick, 60s later.
        if (postsMade + (partCount - alreadyPosted) > maxPosts) {
          log.info(`Run budget reached, deferring tweet ${tweet.id} to the next tick`, {
            tweetId: tweet.id,
            postsMade,
            maxPosts
          });
          break;
        }

        // A row cycling through the stale-claim reclaim forever is worse than a
        // visible failure.
        if (Date.now() - tweet.scheduledDate.getTime() > ABANDON_AFTER_MS) {
          await this.markTweetsAsFailed(
            [tweet],
            `Abandoned: still unposted 24h after its scheduled time`,
            userId
          );
          continue;
        }

        try {
          // Take ownership before calling X, so an overlapping run cannot double-post.
          if (!(await this.dbClient.claimTweet(tweet.id!))) {
            log.info(`Tweet ${tweet.id} already claimed by another run, skipping`, {
              tweetId: tweet.id,
              userId
            });
            continue;
          }

          log.info(`Attempting to post tweet ${tweet.id} for user ${userId}`, {
            tweetId: tweet.id,
            userId,
            community: tweet.community,
            parts: partCount,
            resumingFrom: alreadyPosted
          });

          const communityId = getCommunityId(tweet.community);

          // Validate community mapping if community is specified
          if (tweet.community && tweet.community.trim() !== '') {
            if (!communityId) {
              throw new Error(`No community mapping found for: ${tweet.community}`);
            }
          }

          const postedIds = await this.postThread(accessToken, tweet, communityId ?? undefined);
          postsMade += postedIds.length - alreadyPosted;

          await this.dbClient.updateTweetStatus(tweet.id!, TweetStatus.POSTED, postedIds);
          log.info(`Successfully posted tweet ${tweet.id}`, {
            tweetId: tweet.id,
            userId,
            parts: partCount,
            community: tweet.community,
            communityId: communityId || 'none'
          });
        } catch (error) {
          log.error(`Error posting tweet ${tweet.id} for user ${userId}:`, {
            tweetId: tweet.id,
            userId,
            error
          });

          if (error instanceof XApiError && error.status === 429) {
            // A 429 consumes no quota. Leave the row in `posting` with a fresh
            // updatedAt — the 5-minute reclaim then resumes it from the exact
            // part it stopped at, with natural backoff and no new machinery.
            log.info(`Rate limited; leaving tweet ${tweet.id} to resume on a later run`, {
              tweetId: tweet.id
            });
            break;
          }

          if (error instanceof XApiError && (error.status === 401 || error.status === 403)) {
            // The token is unusable for every remaining row, so stop early
            // rather than marking the whole batch failed one call at a time.
            await this.markTweetsAsFailed(
              [tweet],
              `Authorization rejected (${error.status}) for tweet ${tweet.id}`,
              userId
            );
            break;
          }

          await this.markTweetsAsFailed(
            [tweet],
            `API error during posting for tweet ${tweet.id}`,
            userId
          );
        }
      }
      // One write per run, not per post: the figures only change as a result of
      // the posts just made, and each write costs a subrequest.
      if (this.xClient.lastHeadroom) {
        await this.dbClient.savePostHeadroom(userId, 'twitter', this.xClient.lastHeadroom);
      }
    } catch (error) {
      // Catch errors related to fetching user accounts or refreshing the token
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.markTweetsAsFailed(
        tweets,
        `Failed to process batch for user ${userId}: ${errorMessage}`,
        userId
      );
    }

    return postsMade;
  }
}
