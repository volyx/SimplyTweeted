export enum TweetStatus {
  SCHEDULED = 'scheduled',
  /** Claimed by the scheduler, X API call in flight. Transient. */
  POSTING = 'posting',
  POSTED = 'posted',
  FAILED = 'failed'
}

export interface UserAccount {
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
  createdAt: Date;
  updatedAt?: Date;
}

export interface Tweet {
  id?: string;
  userId: string;
  content: string;
  scheduledDate: Date;
  community: string;
  status: TweetStatus;
  createdAt: Date;
  updatedAt?: Date;
  /**
   * Thread parts in order. Absent for an ordinary single tweet.
   * Frozen at save time: `content` is for display, this is the post plan.
   */
  parts?: string[];
  /** X post ids already created for this row, in order. Drives resume. */
  postedIds?: string[];
} 
/** What X last reported about an account's remaining posts in the 24h window. */
export interface PostHeadroom {
  remaining: number;
  limit: number | null;
  /** Epoch ms when the window rolls over, if X said. */
  resetAt: number | null;
  /** Epoch ms the figures were observed, so staleness can be shown. */
  observedAt: number;
}

/** A top-performing post from someone the user follows. */
export interface TrendingPost {
  tweetId: string;
  authorName: string;
  authorUsername: string;
  text: string;
  likeCount: number;
  retweetCount: number;
  replyCount: number;
  quoteCount: number;
  /** Weighted engagement — see scoreEngagement. */
  score: number;
  postedAt: Date;
  fetchedAt: Date;
}

/**
 * Ranks a post by how much it actually landed.
 *
 * Replies and amplification are weighted above likes because a like is the
 * cheapest possible signal — it costs a reader nothing and accrues to large
 * accounts regardless of whether the post was any good.
 */
export function scoreEngagement(metrics: {
  likeCount: number;
  retweetCount: number;
  replyCount: number;
  quoteCount: number;
}): number {
  return (
    metrics.replyCount * 3 + metrics.retweetCount * 2 + metrics.quoteCount * 2 + metrics.likeCount
  );
}
