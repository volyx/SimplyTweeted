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
 * Upper bound on thread length.
 *
 * Two ceilings apply, and this is the lower of them. The subrequest cost is
 * 2n+2 against a 50-subrequest limit on the Workers free plan, which would
 * allow 24. The binding one is the scheduler: it defers a whole thread that
 * does not fit a single run's MAX_POSTS_PER_RUN budget, so a thread longer
 * than that budget would be deferred every tick and never post at all.
 *
 * Raised from 10 because 10 was too tight to split real prose without cutting
 * sentences in half: 2,400 characters of it needs 11 parts to break only at
 * sentence ends, and at 10 every part has to run 99% full, which forces a
 * mid-sentence break no matter how good the splitter is.
 */
export const MAX_THREAD_PARTS = 15;

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
 * A piece of text plus the whitespace that followed it in the original.
 *
 * Carrying the separator is what lets two units rejoin exactly as they were
 * written — a blank line between paragraphs stays a blank line instead of
 * collapsing to a space.
 */
interface Unit {
  text: string;
  separator: string;
}

/**
 * Splits on blank lines — the author's own paragraph divisions.
 *
 * Only a *blank* line counts. A single newline is as often a soft wrap sitting
 * inside a sentence ("я больше не\nработаю с огромными системами") and breaking
 * there produces exactly the mid-sentence cut this ordering exists to avoid.
 * Single newlines are still used, but below sentences rather than above them.
 */
function segmentParagraphs(text: string): Unit[] {
  const units: Unit[] = [];
  const pattern = /\n[ \t]*\n[ \t\n]*/g;

  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    units.push({ text: text.slice(start, match.index), separator: match[0] });
    start = match.index + match[0].length;
  }
  units.push({ text: text.slice(start), separator: '' });

  return units.filter((unit) => unit.text.trim().length > 0);
}

/**
 * Splits on sentence ends: terminal punctuation, any closing bracket or quote
 * after it, then whitespace.
 *
 * Requiring the whitespace is what keeps `x.com/watch?v=abc` in one piece — the
 * dots and question marks inside a URL are never followed by a space.
 */
function segmentSentences(text: string): Unit[] {
  const units: Unit[] = [];
  const pattern = /(?<=[.!?…][)"'”»\]]*)\s+/g;

  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    units.push({ text: text.slice(start, match.index), separator: match[0] });
    start = match.index + match[0].length;
  }
  units.push({ text: text.slice(start), separator: '' });

  return units.filter((unit) => unit.text.trim().length > 0);
}

/** Splits on single line breaks — softer than a paragraph, firmer than a space. */
function segmentLines(text: string): Unit[] {
  const units: Unit[] = [];
  const pattern = /\n[ \t]*/g;

  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    units.push({ text: text.slice(start, match.index), separator: match[0] });
    start = match.index + match[0].length;
  }
  units.push({ text: text.slice(start), separator: '' });

  return units.filter((unit) => unit.text.trim().length > 0);
}

/**
 * Packs units into parts, splitting any single unit that cannot fit on its own.
 *
 * Greedy is right here: a unit is only carried to the next part when it cannot
 * fit in the current one, so the author's divisions survive wherever the budget
 * allows.
 */
function packUnits(units: Unit[], budget: number, breakUp: (text: string) => string[]): string[] {
  const parts: string[] = [];
  let current = '';
  let pending = '';

  for (const unit of units) {
    const joined = current === '' ? unit.text : current + pending + unit.text;

    if (joined.length <= budget) {
      current = joined;
      pending = unit.separator;
      continue;
    }

    if (current !== '') {
      parts.push(current.trim());
      current = '';
      pending = '';
    }

    // Alone and still too long: hand it to the next level down.
    if (unit.text.length > budget) {
      const pieces = breakUp(unit.text);
      parts.push(...pieces.slice(0, -1).map((piece) => piece.trim()));
      current = pieces[pieces.length - 1] ?? '';
    } else {
      current = unit.text;
    }
    pending = unit.separator;
  }

  if (current.trim().length > 0) {
    parts.push(current.trim());
  }

  return parts;
}

/**
 * Breaks text at the strongest division that fits, falling back a level at a
 * time: blank lines, then sentence ends, then single line breaks, then
 * whitespace.
 *
 * Word boundaries alone cut sentences in half — the thing that makes a thread
 * read badly — so they are now the last resort rather than the only rule. A
 * blank line is the author saying "these belong apart"; a sentence end is the
 * next place a reader expects to pause; a lone newline sits below both because
 * it is so often just where the line happened to wrap.
 */
function splitByStructure(text: string, budget: number): string[] {
  return packUnits(segmentParagraphs(text), budget, (paragraph) =>
    packUnits(segmentSentences(paragraph), budget, (sentence) =>
      packUnits(segmentLines(sentence), budget, (line) =>
        splitAtWordBoundaries(line, budget)
      )
    )
  );
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
    const chunks = splitByStructure(trimmed, budget);
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
