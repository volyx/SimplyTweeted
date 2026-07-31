/**
 * Splits an over-long part into thread parts at meaning boundaries, using Claude.
 *
 * The deterministic splitter in shared-lib breaks at the last whitespace that fits,
 * which is correct but blind — it will cut a sentence in half or strand a clause.
 * This asks a model for the split a person would make, and falls back to the
 * deterministic result whenever the model's answer is unusable.
 *
 * The model is never trusted. Its output is checked for length (including the
 * numbering the app appends), part count, and — because splitting is not
 * rewriting — that concatenating the parts reproduces the original text.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import Anthropic from '@anthropic-ai/sdk';
import {
	formatThreadPart,
	normalizeThreadParts,
	splitThreadText,
	MAX_TWEET_LENGTH,
	MAX_THREAD_PARTS
} from 'shared-lib';
import { ANTHROPIC_API_KEY } from '$lib/server/env';
import { log } from '$lib/server/logger.js';

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
well enough to make someone want the next.`;

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

export const POST: RequestHandler = async ({ request, locals }) => {
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

	const apiKey = ANTHROPIC_API_KEY();
	if (!apiKey) {
		return json({ error: 'AI splitting is not configured on this deployment' }, { status: 501 });
	}

	// Longer than the thread can hold however it is cut — no call is worth making.
	if (text.length > room * PART_BUDGET) {
		return json({
			parts: deterministic,
			source: 'fallback',
			notice: `This is too long for a ${MAX_THREAD_PARTS}-part thread however it is split, so it was split at word boundaries instead.`
		});
	}

	const client = new Anthropic({ apiKey });

	let response;
	try {
		response = await client.beta.messages.create({
			model: 'claude-opus-5',
			max_tokens: 16000,
			// Routes a safety refusal to Anthropic's recommended fallback model rather
			// than returning the refusal to us.
			betas: ['server-side-fallback-2026-07-01'],
			fallbacks: 'default',
			output_config: {
				// A short, well-specified task — low effort keeps the button responsive.
				effort: 'low',
				format: {
					type: 'json_schema',
					schema: {
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
				}
			},
			system: SYSTEM,
			messages: [
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
	} catch (error) {
		log.error('AI split request failed', { error });
		return json({
			parts: deterministic,
			source: 'fallback',
			notice: 'The AI split could not be reached, so the text was split at word boundaries.'
		});
	}

	// Check before reading content: a refusal carries no usable text.
	if (response.stop_reason === 'refusal') {
		log.warn('AI split refused', { category: response.stop_details?.category ?? null });
		return json({
			parts: deterministic,
			source: 'fallback',
			notice: 'The AI declined to split this text, so it was split at word boundaries.'
		});
	}

	const block = response.content.find((entry) => entry.type === 'text');
	let parts: string[] = [];
	try {
		const parsed = block?.type === 'text' ? JSON.parse(block.text) : null;
		parts = Array.isArray(parsed?.parts) ? normalizeThreadParts(parsed.parts.map(String)) : [];
	} catch (error) {
		log.error('AI split returned unparseable output', { error, stopReason: response.stop_reason });
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
