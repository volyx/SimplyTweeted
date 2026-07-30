import { randomUUID } from 'crypto';
import type { D1Database } from '@cloudflare/workers-types';
import { TweetStatus, Tweet, UserAccount } from '../types/types.js';
import { EncryptionService } from './encryption.js';

/**
 * A tweet claimed by the scheduler is left in `posting` for the duration of the
 * X API call. If the Worker dies mid-flight the row would be stranded, so
 * findDueTweets() reclaims any claim older than this.
 */
const STALE_CLAIM_MS = 5 * 60 * 1000;

interface TweetRow {
  id: string;
  userId: string;
  content: string;
  scheduledDate: number;
  community: string;
  status: string;
  createdAt: number;
  updatedAt: number | null;
  // JSON string[]. Optional rather than nullable so a row selected before the
  // 0002 migration lands still types.
  parts?: string | null;
  postedIds?: string | null;
}

interface AccountRow {
  id: string;
  userId: string;
  username: string;
  provider: string;
  providerAccountId: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in: number;
  token_type: string;
  scope: string;
  createdAt: number;
  updatedAt: number | null;
}

/**
 * Deliberately total: returns undefined rather than throwing for null, absent,
 * unparseable, or non-array values.
 *
 * findDueTweets maps every due row, so a single corrupt blob throwing in here
 * would take down the whole cron run for every user, not just that row.
 */
function parseStringArray(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      return undefined;
    }
    return parsed as string[];
  } catch {
    return undefined;
  }
}

function toTweet(row: TweetRow): Tweet {
  return {
    id: row.id,
    userId: row.userId,
    content: row.content,
    scheduledDate: new Date(row.scheduledDate),
    community: row.community,
    status: row.status as TweetStatus,
    createdAt: new Date(row.createdAt),
    updatedAt: row.updatedAt ? new Date(row.updatedAt) : undefined,
    parts: parseStringArray(row.parts),
    postedIds: parseStringArray(row.postedIds)
  };
}

/**
 * Data access over Cloudflare D1.
 *
 * Construct one per request / per scheduled invocation from the `DB` binding —
 * D1 needs no connection lifecycle, and a module-scope singleton is wrong in an
 * isolate model where module scope outlives no particular request.
 */
class DatabaseClient {
  private db: D1Database;
  private encryptionService: EncryptionService;

  constructor(db: D1Database, encryptionKey: string) {
    if (!db) {
      throw new Error('A D1Database binding is required for DatabaseClient initialization');
    }
    if (!encryptionKey) {
      throw new Error('An encryption key is required for DatabaseClient initialization');
    }
    this.db = db;
    this.encryptionService = new EncryptionService(encryptionKey);
  }

  /**
   * D1 intermittently rejects a statement with "storage operation exceeded
   * timeout which caused object to be reset" — a transient fault in the backing
   * Durable Object, not a problem with the SQL. It surfaced here as a failed
   * sign-in even though the identical statement succeeds on retry, so retry the
   * transient classes briefly.
   *
   * The delay is I/O wait, which does not count against the Worker's CPU budget.
   */
  private async withRetry<T>(label: string, op: () => Promise<T>): Promise<T> {
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; ; attempt++) {
      try {
        return await op();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isTransient =
          /exceeded timeout|object to be reset|Network connection lost|storage operation/i.test(
            message
          );

        if (!isTransient || attempt >= MAX_ATTEMPTS) {
          throw error;
        }

        console.warn(
          JSON.stringify({
            level: 'warn',
            time: new Date().toISOString(),
            msg: `D1 ${label} hit a transient error, retrying`,
            attempt,
            error: message
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
      }
    }
  }

  private toAccount(row: AccountRow): UserAccount {
    return {
      userId: row.userId,
      username: row.username,
      provider: row.provider,
      providerAccountId: row.providerAccountId,
      access_token: this.encryptionService.decrypt(row.access_token),
      refresh_token: this.encryptionService.decrypt(row.refresh_token),
      expires_at: row.expires_at,
      expires_in: row.expires_in,
      token_type: row.token_type,
      scope: row.scope,
      createdAt: new Date(row.createdAt),
      updatedAt: row.updatedAt ? new Date(row.updatedAt) : undefined
    };
  }

  async saveTweet(tweet: Tweet): Promise<string> {
    const id = tweet.id ?? randomUUID();
    // Only a genuine thread gets `parts`. A single tweet keeps parts NULL, so
    // existing rows and the single-tweet path stay byte-identical to before.
    const parts = tweet.parts && tweet.parts.length > 1 ? JSON.stringify(tweet.parts) : null;

    await this.withRetry('saveTweet', () =>
      this.db
        .prepare(
          `INSERT INTO tweets (id, userId, content, scheduledDate, community, status, createdAt, updatedAt, parts, postedIds)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
        )
        .bind(
          id,
          tweet.userId,
          tweet.content,
          tweet.scheduledDate.getTime(),
          tweet.community ?? '',
          tweet.status,
          tweet.createdAt.getTime(),
          tweet.updatedAt ? tweet.updatedAt.getTime() : null,
          parts,
          tweet.postedIds && tweet.postedIds.length > 0 ? JSON.stringify(tweet.postedIds) : null
        )
        .run()
    );
    return id;
  }

  async getTweets(
    userId: string,
    page: number,
    limit: number,
    status: TweetStatus | TweetStatus[] = TweetStatus.SCHEDULED,
    sortDirection: 1 | -1 = 1 // 1 for ascending (default for scheduled), -1 for descending (for history)
  ): Promise<Tweet[]> {
    const statuses = Array.isArray(status) ? status : [status];
    const placeholders = statuses.map((_, i) => `?${i + 2}`).join(', ');
    const order = sortDirection === -1 ? 'DESC' : 'ASC';
    const offset = (page - 1) * limit;

    const { results } = await this.withRetry('getTweets', () =>
      this.db
        .prepare(
          `SELECT * FROM tweets
         WHERE userId = ?1 AND status IN (${placeholders})
         ORDER BY scheduledDate ${order}
         LIMIT ?${statuses.length + 2} OFFSET ?${statuses.length + 3}`
        )
        .bind(userId, ...statuses, limit, offset)
        .all<TweetRow>()
    );

    return results.map(toTweet);
  }

  async countTweets(
    userId: string,
    status: TweetStatus | TweetStatus[] = TweetStatus.SCHEDULED
  ): Promise<number> {
    const statuses = Array.isArray(status) ? status : [status];
    const placeholders = statuses.map((_, i) => `?${i + 2}`).join(', ');

    const row = await this.withRetry('countTweets', () =>
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM tweets WHERE userId = ?1 AND status IN (${placeholders})`
        )
        .bind(userId, ...statuses)
        .first<{ n: number }>()
    );

    return row?.n ?? 0;
  }

  /**
   * Refuses to delete a row the scheduler has claimed. Without the status guard,
   * deleting mid-thread removes the row while the poster is still iterating: the
   * remaining progress writes silently update 0 rows and the thread finishes
   * posting anyway, with no record of it.
   */
  async deleteTweet(tweetId: string, userId: string) {
    const result = await this.withRetry('deleteTweet', () =>
      this.db
        .prepare('DELETE FROM tweets WHERE id = ?1 AND userId = ?2 AND status != ?3')
        .bind(tweetId, userId, TweetStatus.POSTING)
        .run()
    );

    const deletedCount = result.meta.changes ?? 0;
    return { success: deletedCount > 0, deletedCount };
  }

  /**
   * Posts this app has made in a window, for the thread quota precondition.
   *
   * Counts parts, not rows: a posted 5-part thread consumed 5 of X's ~17/24h.
   * Partially-posted threads (`failed` with a non-empty postedIds) consumed
   * whatever actually went out. Summed in JS because both are JSON columns.
   *
   * Approximate by nature — it cannot see posts made by other tools.
   */
  async countPostsSince(userId: string, sinceMs: number): Promise<number> {
    const { results } = await this.withRetry('countPostsSince', () =>
      this.db
        .prepare(
          `SELECT status, parts, postedIds FROM tweets
           WHERE userId = ?1 AND COALESCE(updatedAt, createdAt) >= ?2
             AND status IN (?3, ?4, ?5)`
        )
        .bind(userId, sinceMs, TweetStatus.POSTED, TweetStatus.FAILED, TweetStatus.POSTING)
        .all<Pick<TweetRow, 'status' | 'parts' | 'postedIds'>>()
    );

    return results.reduce((total, row) => {
      const postedIds = parseStringArray(row.postedIds);
      if (row.status === TweetStatus.POSTED) {
        // Older posted rows predate postedIds, so fall back to the part count.
        return total + (postedIds?.length ?? parseStringArray(row.parts)?.length ?? 1);
      }
      // failed / still-posting: only what actually reached X counts.
      return total + (postedIds?.length ?? 0);
    }, 0);
  }

  // Create or update a user account. The UNIQUE (userId, provider) constraint
  // turns this into a single upsert.
  async saveUserAccount(userAccount: UserAccount): Promise<string> {
    const now = Date.now();
    const id = randomUUID();
    const accessToken = this.encryptionService.encrypt(userAccount.access_token);
    const refreshToken = this.encryptionService.encrypt(userAccount.refresh_token);

    const row = await this.withRetry('saveUserAccount', () =>
      this.db
        .prepare(
          `INSERT INTO accounts (
           id, userId, username, provider, providerAccountId,
           access_token, refresh_token, expires_at, expires_in,
           token_type, scope, createdAt, updatedAt
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT (userId, provider) DO UPDATE SET
           username          = excluded.username,
           providerAccountId = excluded.providerAccountId,
           access_token      = excluded.access_token,
           refresh_token     = excluded.refresh_token,
           expires_at        = excluded.expires_at,
           expires_in        = excluded.expires_in,
           token_type        = excluded.token_type,
           scope             = excluded.scope,
           updatedAt         = excluded.updatedAt
         RETURNING id`
        )
        .bind(
          id,
          userAccount.userId,
          userAccount.username,
          userAccount.provider,
          userAccount.providerAccountId,
          accessToken,
          refreshToken,
          userAccount.expires_at,
          userAccount.expires_in,
          userAccount.token_type,
          userAccount.scope,
          userAccount.createdAt ? userAccount.createdAt.getTime() : now,
          now
        )
        .first<{ id: string }>()
    );

    return row?.id ?? id;
  }

  // Get user account with decrypted tokens
  async getUserAccount(userId: string, provider: string): Promise<UserAccount | null> {
    const row = await this.withRetry('getUserAccount', () =>
      this.db
        .prepare('SELECT * FROM accounts WHERE userId = ?1 AND provider = ?2')
        .bind(userId, provider)
        .first<AccountRow>()
    );

    return row ? this.toAccount(row) : null;
  }

  // Get all user accounts for a user, with decrypted tokens
  async getUserAccounts(userId: string): Promise<UserAccount[]> {
    const { results } = await this.withRetry('getUserAccounts', () =>
      this.db.prepare('SELECT * FROM accounts WHERE userId = ?1').bind(userId).all<AccountRow>()
    );

    return results.map((row) => this.toAccount(row));
  }

  /**
   * Tweets that are due to be posted: everything still scheduled whose time has
   * passed, plus any stale `posting` claim left behind by an interrupted run.
   */
  async findDueTweets(limit = 20): Promise<Tweet[]> {
    const now = Date.now();
    const { results } = await this.withRetry('findDueTweets', () =>
      this.db
        .prepare(
          `SELECT * FROM tweets
         WHERE (status = ?1 AND scheduledDate <= ?3)
            OR (status = ?2 AND COALESCE(updatedAt, createdAt) <= ?4)
         ORDER BY scheduledDate ASC
         LIMIT ?5`
        )
        .bind(TweetStatus.SCHEDULED, TweetStatus.POSTING, now, now - STALE_CLAIM_MS, limit)
        .all<TweetRow>()
    );

    return results.map(toTweet);
  }

  /**
   * Atomically take ownership of a tweet before calling the X API, so that two
   * overlapping scheduler runs cannot post the same tweet twice.
   *
   * @returns true if this caller won the claim.
   */
  async claimTweet(tweetId: string): Promise<boolean> {
    const now = Date.now();
    const result = await this.withRetry('claimTweet', () =>
      this.db
        .prepare(
          `UPDATE tweets SET status = ?1, updatedAt = ?2
         WHERE id = ?3
           AND (status = ?4 OR (status = ?1 AND COALESCE(updatedAt, createdAt) <= ?5))`
        )
        .bind(TweetStatus.POSTING, now, tweetId, TweetStatus.SCHEDULED, now - STALE_CLAIM_MS)
        .run()
    );

    return (result.meta.changes ?? 0) > 0;
  }

  /**
   * Records the X ids posted so far WITHOUT changing status.
   *
   * The `updatedAt` bump is load-bearing: it is the heartbeat that stops
   * findDueTweets' 5-minute stale-claim reclaim from firing underneath a thread
   * that is legitimately still in flight (and reposting it from part 1).
   */
  async recordThreadProgress(tweetId: string, postedIds: string[]): Promise<void> {
    await this.withRetry('recordThreadProgress', () =>
      this.db
        .prepare('UPDATE tweets SET postedIds = ?1, updatedAt = ?2 WHERE id = ?3')
        .bind(JSON.stringify(postedIds), Date.now(), tweetId)
        .run()
    );
  }

  /**
   * Update the status of a tweet, optionally recording the posted X ids in the
   * same statement — one write rather than two, which matters against the
   * 50-subrequest-per-invocation cap on the free plan.
   */
  async updateTweetStatus(
    tweetId: string,
    status: TweetStatus,
    postedIds?: string[]
  ): Promise<void> {
    await this.withRetry('updateTweetStatus', () =>
      postedIds
        ? this.db
            .prepare('UPDATE tweets SET status = ?1, updatedAt = ?2, postedIds = ?4 WHERE id = ?3')
            .bind(status, Date.now(), tweetId, JSON.stringify(postedIds))
            .run()
        : this.db
            .prepare('UPDATE tweets SET status = ?1, updatedAt = ?2 WHERE id = ?3')
            .bind(status, Date.now(), tweetId)
            .run()
    );
  }
}

export { DatabaseClient };
