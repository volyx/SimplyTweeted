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

const SYSTEM = `You split text into the parts of an X (Twitter) thread.

You split only. Never reword, rewrite, summarise, translate, reorder, or add
anything of your own — no numbering, no "cont.", no linking phrases. Concatenating
your parts in order with a single space between them must reproduce the input text
exactly, character for character apart from the whitespace at the joins.

Break where a reader would want a pause: between complete thoughts, at sentence
ends, before a contrast or a new example. Prefer a slightly short part over one
that splits a clause, a quoted phrase, or a URL. The first part should stand alone
well enough to make someone want the next.

Reply with JSON only.`;

/** Whitespace-insensitive comparison — the joins are the only place it may differ. */
function collapse(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/** Every part must fit once its ` n/total` suffix is added, and the thread must fit. */
function isUsable(parts: string[], otherParts: number): boolean {
	const total = otherParts + parts.length;
	if (parts.length < 1 || total > MAX_THREAD_PARTS) return false;

	// total - 1 is the worst-case index: same digit count as total.
	return parts.every((part) => formatThreadPart(part, total - 1, total).length <= MAX_TWEET_LENGTH);
}

/** JSON mode returns either a parsed object or the JSON as a string, depending on model. */
function readParts(response: unknown): string[] {
	const payload = typeof response === 'string' ? JSON.parse(response) : response;
	const parts = (payload as { parts?: unknown })?.parts;
	return Array.isArray(parts) ? normalizeThreadParts(parts.map(String)) : [];
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
		return json(
			{ error: 'The AI binding is unavailable. Run `wrangler dev` rather than `vite dev`.' },
			{ status: 503 }
		);
	}

	// Longer than the thread can hold however it is cut — no call is worth making.
	if (text.length > room * PART_BUDGET) {
		return json({
			parts: deterministic,
			source: 'fallback',
			notice: `This is too long for a ${MAX_THREAD_PARTS}-part thread however it is split, so it was split at word boundaries instead.`
		});
	}

	let parts: string[] = [];
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
						`Split the text below into between ${Math.min(deterministic.length, room)} and ${room} parts.`,
						`Each part must be at most ${PART_BUDGET} characters.`,
						otherParts > 0
							? `It joins a thread that already has ${otherParts} other ${otherParts === 1 ? 'part' : 'parts'}.`
							: '',
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

		parts = readParts((result as { response?: unknown }).response);
	} catch (error) {
		log.error('AI split request failed', { error, model: MODEL });
		return json({
			parts: deterministic,
			source: 'fallback',
			notice: 'The AI split could not be reached, so the text was split at word boundaries.'
		});
	}

	if (!isUsable(parts, otherParts)) {
		return json({
			parts: deterministic,
			source: 'fallback',
			notice: 'The AI split did not fit the character limit, so word boundaries were used instead.'
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

	return json({ parts, source: 'ai' });
};
