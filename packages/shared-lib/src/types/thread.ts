/**
 * Thread helpers shared by the composer, the form action, and the scheduler.
 *
 * Kept in the root entry point (not `./backend`) so it stays dependency-free and
 * safe to import in the browser. The composer preview, the server-side
 * validation, and the text actually sent to X all run through `formatThreadPart`,
 * so what you see previewed is byte-identical to what gets posted.
 */

export const MAX_TWEET_LENGTH = 280;

/**
 * Upper bound on thread length. Also caps the per-invocation subrequest cost,
 * which is 2n+2 against a 50-subrequest limit on the Workers free plan.
 */
export const MAX_THREAD_PARTS = 10;

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
 * Width of the widest suffix a thread of `total` parts can carry. Index
 * `total - 1` is the worst case because it has the same digit count as `total`.
 */
function suffixWidth(total: number): number {
  return total <= 1 ? 0 : ` ${total}/${total}`.length;
}

/** Greedy split at the last whitespace that fits, hard-breaking unbroken runs. */
function splitAtWordBoundaries(text: string, budget: number): string[] {
  const chunks: string[] = [];
  let rest = text.trim();

  while (rest.length > budget) {
    // +1 so a break falling exactly at the boundary still counts.
    const window = rest.slice(0, budget + 1);
    let cut = window.search(/\s\S*$/);

    // A single token longer than the budget (a URL, say) has to be cut mid-word.
    if (cut <= 0) {
      cut = budget;
    }

    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }

  if (rest.length > 0) {
    chunks.push(rest);
  }
  return chunks;
}

/**
 * Splits over-long text into parts that each fit within MAX_TWEET_LENGTH *once
 * their numbering suffix is added*.
 *
 * The suffix width depends on how many parts the thread ends up with, which
 * depends on the budget, which depends on the suffix width — so this iterates to
 * a fixed point. It converges in one or two rounds because the assumed total only
 * ever grows, and it is bounded by the text length.
 *
 * @param otherParts how many parts the thread will contain besides this text.
 */
export function splitThreadText(text: string, otherParts = 0): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }

  let assumedTotal = otherParts + 1;

  for (;;) {
    const budget = MAX_TWEET_LENGTH - suffixWidth(assumedTotal);
    const chunks = splitAtWordBoundaries(trimmed, budget);
    const total = otherParts + chunks.length;

    if (total <= assumedTotal) {
      return chunks;
    }
    assumedTotal = total;
  }
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
