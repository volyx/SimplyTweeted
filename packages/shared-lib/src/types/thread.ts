/**
 * Thread helpers shared by the composer, the form action, and the scheduler.
 *
 * Kept in the root entry point (not `./backend`) so it stays dependency-free and
 * safe to import in the browser. The composer preview, the server-side
 * validation, and the text actually sent to X all run through `formatThreadPart`,
 * so what you see previewed is byte-identical to what gets posted.
 */

export const MAX_TWEET_LENGTH = 280;

/** More than this is pointless against X's ~17 posts/24h free tier. */
export const MAX_THREAD_PARTS = 10;

/**
 * X free tier: roughly 17 posts per 24h, app- and user-scoped.
 * Used to defer a thread that would not fit in the remaining budget.
 */
export const DAILY_POST_BUDGET = 17;

/**
 * Appends the ` 1/3` enumeration. A single-part "thread" is just a tweet and
 * gets no suffix.
 */
export function formatThreadPart(text: string, index: number, total: number): string {
  if (total <= 1) {
    return text;
  }
  return `${text} ${index + 1}/${total}`;
}

/** Trims every part and drops the empty ones (a trailing blank box is common). */
export function normalizeThreadParts(parts: string[]): string[] {
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * Validates already-normalized parts.
 *
 * The length check runs against the formatter's real output rather than
 * reserving a hand-computed suffix width, so the two can never disagree. Index
 * `total - 1` is the worst case because it has the same digit count as `total`.
 *
 * @returns a human-readable error, or null when the parts are valid.
 */
export function validateThreadParts(parts: string[]): string | null {
  if (parts.length === 0) {
    return 'Tweet content is required';
  }

  if (parts.length > MAX_THREAD_PARTS) {
    return `A thread can have at most ${MAX_THREAD_PARTS} parts (got ${parts.length})`;
  }

  const total = parts.length;
  for (let i = 0; i < total; i++) {
    const length = formatThreadPart(parts[i], total - 1, total).length;
    if (length > MAX_TWEET_LENGTH) {
      const withSuffix = total > 1 ? ' including its numbering' : '';
      return total > 1
        ? `Part ${i + 1} is ${length} characters${withSuffix} — the limit is ${MAX_TWEET_LENGTH}`
        : `Tweet content must be ${MAX_TWEET_LENGTH} characters or less`;
    }
  }

  return null;
}
