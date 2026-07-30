import { DatabaseClient } from 'shared-lib/backend';
import { Tweet } from 'shared-lib';
import { TweetProcessor } from './tweetProcessor.js';
import { XClient } from './xApi.js';
import { log } from './logger.js';

/**
 * Ceiling on X posts per cron invocation. Each post and each progress write is a
 * subrequest (free plan allows 50), and a thread costs 2n+2.
 */
const MAX_POSTS_PER_RUN = 15;

export interface Env {
  DB: D1Database;
  DB_ENCRYPTION_KEY: string;
  AUTH_TWITTER_ID: string;
  AUTH_TWITTER_SECRET: string;
}

async function processTweets(env: Env) {
  log.info('Starting tweet processing...');
  try {
    const dbClient = new DatabaseClient(env.DB, env.DB_ENCRYPTION_KEY);
    const xClient = new XClient(dbClient, {
      clientId: env.AUTH_TWITTER_ID,
      clientSecret: env.AUTH_TWITTER_SECRET
    });
    const tweetProcessor = new TweetProcessor(dbClient, xClient);

    // Step 1: Find all due tweets
    const dueTweets = await dbClient.findDueTweets();
    log.info(`Found ${dueTweets.length} tweets to process`, { tweetCount: dueTweets.length });

    if (dueTweets.length === 0) {
      return;
    }

    // Step 2: Group tweets by user
    const tweetsByUser: Record<string, Tweet[]> = {};
    dueTweets.forEach((tweet: Tweet) => {
      if (!tweetsByUser[tweet.userId]) {
        tweetsByUser[tweet.userId] = [];
      }
      tweetsByUser[tweet.userId].push(tweet);
    });

    // Step 3: Process tweets for each user, holding a shared per-run post budget.
    // Every X post and every D1 write is a subrequest, capped at 50 per
    // invocation on the free plan, and a thread costs 2n+2. Anything not reached
    // stays scheduled and goes out on the next tick.
    let remainingPosts = MAX_POSTS_PER_RUN;
    for (const userId in tweetsByUser) {
      if (remainingPosts <= 0) {
        log.info('Run post budget exhausted; remaining tweets deferred to the next tick');
        break;
      }
      remainingPosts -= await tweetProcessor.processUserTweets(
        userId,
        tweetsByUser[userId],
        remainingPosts
      );
    }
  } catch (error) {
    // Catch high-level errors (e.g., finding due tweets)
    log.error('Error in processTweets main loop:', { error });
  }
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(processTweets(env));
  }
} satisfies ExportedHandler<Env>;
