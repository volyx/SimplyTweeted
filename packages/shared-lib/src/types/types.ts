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