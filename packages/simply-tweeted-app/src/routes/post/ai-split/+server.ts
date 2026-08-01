/**
 * Splits an over-long part into thread parts at meaning boundaries, using Workers AI.
 *
 * The deterministic splitter in shared-lib breaks at the last whitespace that fits,
 * which is correct but blind — it will cut a sentence in half or strand a clause.
 * This asks a model for the split a person would make, and falls back to the
 * deterministic result whenever the model's answer is unusable.
 *
 * Inference runs on the `AI` binding, so there is no API key and no outbound
 * request to a third party — the call never leaves Cloudflare.
 *
 * The model is never trusted. Its output is checked for length (including the
 * numbering the app appends), part count, and — because splitting is not
 * rewriting — that concatenating the parts reproduces the original text. That
 * last check matters more here than it would with a frontier model: a 70B model
 * asked to "split, don't reword" will sometimes still tidy the prose.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	formatThreadPart,
	normalizeThreadParts,
	splitThreadText,
	MAX_TWEET_LENGTH,
	MAX_THREAD_PARTS
} from 'shared-lib';
import { log } from '$lib/server/logger.js';

/**
 * Instruction-following matters more than raw capability here — the task is
 * short, but "reproduce the text exactly" is easy to get almost right. The
 * fp8-fast variant keeps a button-click responsive, and it accepts a JSON
 * schema so the reply parses without prompt-wrangling.
 */
const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/**
 * Worst-case room for text once numbering is appended. A 10-part thread carries
 * ` 10/10`, the widest suffix any part can get, so a part within this budget is
 * valid at every thread length.
 */
const PART_BUDGET = MAX_TWEET_LENGTH - ` ${MAX_THREAD_PARTS}/${MAX_THREAD_PARTS}`.length;

const SYSTEM = `You split a long piece of text into the parts of an X (Twitter)
thread, so that every part reads like something a person wrote on purpose.

# Never change the words
Split only. Never reword, rewrite, summarise, translate, reorder, correct
spelling, or add anything of your own — no numbering, no "cont.", no "(1/5)", no
linking phrases. Concatenating your parts in order with a single space between
them must reproduce the input exactly, character for character apart from the
whitespace at the joins. If you cannot manage that, return fewer parts rather
than alter a single word.

# End parts at sentence boundaries
A part ends where a sentence ends. Never end a part mid-sentence, mid-clause,
inside a quotation, inside a URL, or between a number and its unit.

The one exception is a single sentence longer than the character limit. Only
then may you break inside it, at the strongest punctuation available — an em
dash, semicolon or colon before a comma — and never immediately after "and",
"but", "of", "to", "the", or any other word that leaves the reader hanging.

# Keep what belongs together in one part
- A claim and the example that supports it; a question and its answer; a setup
  and its punchline.
- An enumeration — "First… Second… Third…" — unless it cannot fit.
- A blank line in the input is the author's own paragraph break. Prefer to split
  there over anywhere else, and never merge across one unless the parts either
  side are too small to stand alone.
- Never leave a short closing line alone as the final part. Attach it to the
  part before it if it fits.

# Balance the parts
Aim for parts of roughly similar length rather than filling each to the limit
and leaving a stub at the end. A part that is 60% full and ends cleanly is
better than one that is 99% full and ends on a comma. Use the fewest parts that
read well — do not split text that already fits.

# Each part must stand up
The first part has to make sense alone and give a reason to read the next. Every
later part should be readable without re-reading the one before it.

# Example
Input: "Ship early. It teaches you what users actually want, which is rarely what
you assumed. The hard part is not building — it's deleting the thing you were
proud of."
Output: {"parts": ["Ship early. It teaches you what users actually want, which is rarely what you assumed.", "The hard part is not building — it's deleting the thing you were proud of."]}

Reply with JSON only.`;

/** Whitespace-insensitive comparison — the joins are the only place it may differ. */
function collapse(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/** Whether a part fits once the widest possible ` n/total` suffix is added. */
function fits(part: string, total: number): boolean {
	// total - 1 is the worst-case index: same digit count as total.
	return formatThreadPart(part, total - 1, total).length <= MAX_TWEET_LENGTH;
}

/**
 * Repairs an answer that is right about boundaries but wrong about length.
 *
 * A model cannot count characters reliably, and a sentence longer than the
 * budget cannot be kept whole however well it reasons — this draft had a
 * 296-character one. Rejecting the whole answer for that threw away every good
 * sentence break in it and fell back to cutting all of them mid-clause, which
 * is worse in exactly the way the feature exists to avoid.
 *
 * So only the over-long parts get re-split, deterministically, and the rest of
 * the model's boundaries are kept. Splitting each against a full-length thread
 * is deliberately conservative: it costs a few characters per part and can
 * never produce something the caller has to reject.
 */
function repairOverlongParts(parts: string[]): { parts: string[]; repaired: number } {
	const out: string[] = [];
	let repaired = 0;

	for (const part of parts) {
		if (fits(part, MAX_THREAD_PARTS)) {
			out.push(part);
			continue;
		}
		repaired++;
		out.push(...splitThreadText(part, MAX_THREAD_PARTS - 1));
	}

	return { parts: out, repaired };
}

/** Below this, a part reads as an orphan rather than a deliberate short line. */
const STUB_LENGTH = 60;

/**
 * Folds an orphaned fragment into its neighbour.
 *
 * Re-splitting an over-long sentence leaves whatever did not fit as its own
 * part, which can be a few words — a 23-character part sat mid-thread in
 * testing. Merging is safe here for the same reason it is safe when getting
 * under the cap: joining two parts cannot move a break to a worse place, it
 * only removes one.
 */
function absorbStubs(parts: string[]): string[] {
	const out: string[] = [];

	for (const part of parts) {
		const previous = out[out.length - 1];
		const orphaned = part.length < STUB_LENGTH || (previous?.length ?? Infinity) < STUB_LENGTH;

		if (previous !== undefined && orphaned && fits(`${previous} ${part}`, MAX_THREAD_PARTS)) {
			out[out.length - 1] = `${previous} ${part}`;
			continue;
		}
		out.push(part);
	}

	return out;
}

/** Offsets in `text` immediately after a sentence ends, closing quotes included. */
function sentenceEnds(text: string): number[] {
	const ends: number[] = [];
	const pattern = /[.!?…][")'”»\]]*\s+/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		ends.push(match.index + match[0].length);
	}
	return ends;
}

/** Offsets immediately after any run of whitespace — the last-resort cut points. */
function wordEnds(text: string): number[] {
	const ends: number[] = [];
	const pattern = /\s+/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		ends.push(match.index + match[0].length);
	}
	return ends;
}

/** The candidate nearest `target`, or null if none lies within `window`. */
function nearest(target: number, candidates: number[], window: number): number | null {
	let best: number | null = null;
	let bestDistance = Infinity;
	for (const candidate of candidates) {
		const distance = Math.abs(candidate - target);
		if (distance <= window && distance < bestDistance) {
			best = candidate;
			bestDistance = distance;
		}
	}
	return best;
}

/**
 * Cuts the *original* text where the model chose to break it.
 *
 * The model is a good judge of where a thread should break and an unreliable
 * transcriber of what it breaks: on this draft it merged and re-split correctly
 * and still came back having inserted a comma, which the verbatim guard rightly
 * rejected — leaving the user with word boundaries. Tightening the prompt failed
 * twice, so the model's text is no longer used at all.
 *
 * Only the *positions* survive: each part's cumulative length gives an
 * approximate offset, that offset snaps to the nearest real sentence end in the
 * original, and the original is sliced there. Any rewording changes the offsets
 * slightly, which snapping absorbs, and cannot reach the output — the parts are
 * substrings of the input by construction.
 */
function cutAtModelBoundaries(text: string, modelParts: string[]): string[] {
	const ends = sentenceEnds(text);
	const words = wordEnds(text);

	const cuts: number[] = [];
	let offset = 0;
	for (const part of modelParts.slice(0, -1)) {
		offset += part.length + 1; // +1 for the space the parts are joined by
		if (offset >= text.length) break;

		// A sentence end well away from the target still beats a mid-clause cut, so
		// the sentence window is wide and the whitespace fallback deliberately tight.
		const cut = nearest(offset, ends, 140) ?? nearest(offset, words, 60) ?? offset;
		const previous = cuts[cuts.length - 1] ?? 0;
		if (cut > previous && cut < text.length) cuts.push(cut);
	}

	const parts: string[] = [];
	let start = 0;
	for (const cut of cuts) {
		parts.push(text.slice(start, cut).trim());
		start = cut;
	}
	parts.push(text.slice(start).trim());

	return parts.filter((part) => part.length > 0);
}

/** JSON mode returns either a parsed object or the JSON as a string, depending on model. */
function readParts(response: unknown): string[] {
	const payload = typeof response === 'string' ? JSON.parse(response) : response;
	const parts = (payload as { parts?: unknown })?.parts;
	return Array.isArray(parts) ? normalizeThreadParts(parts.map(String)) : [];
}

/**
 * Packs consecutive parts together while they fit, to get under the thread's
 * maximum length.
 *
 * The model over-splits — it returned 19 parts for a draft the thread can hold
 * in 15 — because being told to prefer short clean parts pushes it towards one
 * part per sentence. Rejecting that answer wasted a set of breaks that were all
 * at sentence ends, and handed the user word boundaries instead.
 *
 * Merging is always safe in a way splitting is not: a part ending at a sentence
 * boundary, joined to the next, still ends at one. This can only remove breaks,
 * never introduce a bad one.
 */
function mergeToFit(parts: string[]): string[] {
	const merged: string[] = [];

	for (const part of parts) {
		const previous = merged[merged.length - 1];
		if (previous !== undefined && fits(`${previous} ${part}`, MAX_THREAD_PARTS)) {
			merged[merged.length - 1] = `${previous} ${part}`;
			continue;
		}
		merged.push(part);
	}

	return merged;
}

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const session = await locals.auth();
	if (!session?.user) {
		return json({ error: 'Not signed in' }, { status: 401 });
	}

	let body: { text?: unknown; otherParts?: unknown };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Expected a JSON body' }, { status: 400 });
	}

	const text = typeof body.text === 'string' ? body.text.trim() : '';
	const otherParts = Number.isInteger(body.otherParts) ? (body.otherParts as number) : 0;

	if (text.length === 0) {
		return json({ error: 'Nothing to split' }, { status: 400 });
	}

	const room = MAX_THREAD_PARTS - otherParts;
	if (room < 2) {
		return json({ error: 'The thread is already at its maximum length' }, { status: 400 });
	}

	// What we fall back to, and also the floor for how many parts to ask for.
	const deterministic = splitThreadText(text, otherParts);

	const ai = platform?.env?.AI;
	if (!ai) {
		log.error('AI split unavailable: no AI binding on platform.env');
		return json(
			{ error: 'The AI binding is unavailable. Run `wrangler dev` rather than `vite dev`.' },
			{ status: 503 }
		);
	}

	// Longer than the thread can hold however it is cut — no call is worth making.
	if (text.length > room * PART_BUDGET) {
		log.info('AI split skipped: text cannot fit the thread at any split', {
			chars: text.length,
			capacity: room * PART_BUDGET
		});
		return json({
			parts: deterministic,
			source: 'fallback',
			notice: `This is too long for a ${MAX_THREAD_PARTS}-part thread however it is split, so it was split at word boundaries instead.`
		});
	}

	let modelParts: string[] = [];
	try {
		const result = await ai.run(MODEL, {
			// temperature 0: the same draft should split the same way twice.
			temperature: 0,
			max_tokens: 2048,
			response_format: {
				type: 'json_schema',
				json_schema: {
					type: 'object',
					properties: {
						parts: {
							type: 'array',
							description: 'The thread parts, in order.',
							items: { type: 'string' }
						}
					},
					required: ['parts'],
					additionalProperties: false
				}
			},
			messages: [
				{ role: 'system', content: SYSTEM },
				{
					role: 'user',
					content: [
						`Split the text below into at least ${Math.min(deterministic.length, room)} and at most ${room} parts —`,
						'the fewest that let every part end at a sentence boundary.',
						`Each part must be at most ${PART_BUDGET} characters, counted after trimming.`,
						otherParts > 0
							? `It joins a thread that already has ${otherParts} other ${otherParts === 1 ? 'part' : 'parts'}.`
							: '',
						'',
						'Any blank line below is the author\'s own paragraph break — split there by preference.',
						'',
						'<text>',
						text,
						'</text>'
					]
						.filter(Boolean)
						.join('\n')
				}
			]
		});

		modelParts = readParts((result as { response?: unknown }).response);
	} catch (error) {
		log.error('AI split request failed', { error, model: MODEL });
		return json({
			parts: deterministic,
			source: 'fallback',
			notice: 'The AI split could not be reached, so the text was split at word boundaries.'
		});
	}

	if (modelParts.length < 2) {
		log.warn('AI split returned nothing to work with', { parts: modelParts.length });
		return json({
			parts: deterministic,
			source: 'fallback',
			notice: 'The AI returned nothing to split, so word boundaries were used instead.'
		});
	}

	// The model's boundaries, applied to the original text. Its wording never
	// reaches the output, so it cannot alter what the user wrote.
	let parts = cutAtModelBoundaries(text, modelParts);

	const { parts: repairedParts, repaired } = repairOverlongParts(parts);
	if (repaired > 0) {
		log.info('AI split had over-long parts, re-split those', {
			repaired,
			before: parts.length,
			after: repairedParts.length,
			longest: Math.max(...parts.map((part) => part.length))
		});
	}
	parts = absorbStubs(repairedParts);

	// Too many parts is recoverable in the other direction: joining two parts that
	// each end at a sentence boundary leaves a part that also ends at one, so
	// merging can only ever remove breaks, never create a bad one.
	if (otherParts + parts.length > MAX_THREAD_PARTS) {
		const merged = mergeToFit(parts);
		if (merged.length < parts.length) {
			log.info('AI split returned more parts than the thread allows, merged them', {
				before: parts.length,
				after: merged.length,
				max: MAX_THREAD_PARTS
			});
			parts = merged;
		}
	}

	// Only length the thread still cannot hold is unrecoverable.
	if (otherParts + parts.length > MAX_THREAD_PARTS) {
		log.warn('AI split needed more parts than the thread allows', {
			needed: otherParts + parts.length,
			max: MAX_THREAD_PARTS
		});
		return json({
			parts: deterministic,
			source: 'fallback',
			notice: `The AI split needed more than ${MAX_THREAD_PARTS} parts, so word boundaries were used instead.`
		});
	}

	// Splitting is not rewriting. Anything else is the user's text altered without asking.
	if (collapse(parts.join(' ')) !== collapse(text)) {
		log.warn('AI split altered the text', { partCount: parts.length });
		return json({
			parts: deterministic,
			source: 'fallback',
			notice: 'The AI changed the wording rather than only splitting it, so word boundaries were used instead.'
		});
	}

	log.info('AI split applied', { parts: parts.length, repaired });

	return json({
		parts,
		source: 'ai',
		notice:
			repaired > 0
				? `AI split this into ${parts.length} parts. ${repaired === 1 ? 'One sentence was' : `${repaired} sentences were`} longer than a tweet, so ${repaired === 1 ? 'it' : 'they'} had to be broken mid-sentence.`
				: undefined
	});
};
