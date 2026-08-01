import { redirect, fail } from '@sveltejs/kit';
import type { Actions, RequestEvent } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import {
	TweetStatus,
	type Tweet,
	getAvailableCommunities,
	normalizeThreadParts,
	validateThreadParts
} from 'shared-lib';
import { fromZonedTime } from 'date-fns-tz';
import { log } from '$lib/server/logger.js';

// Helper function to convert local time to UTC
function convertToUTC(date: string, time: string, timezone: string): Date {
	try {
		// If no timezone provided, treat as UTC
		if (!timezone) {
			return new Date(`${date}T${time}:00.000Z`);
		}
		
		// Create the local datetime string
		const localDateTime = `${date} ${time}:00`;
		
		// Use date-fns-tz to convert the user's local time to UTC
		// This handles all timezone complexities including DST automatically
		const utcDate = fromZonedTime(localDateTime, timezone);
		
		return utcDate;
		
	} catch (error) {
		log.error('Error converting timezone:', { error, timezone, date, time });
		// Fallback: treat as UTC if timezone conversion fails
		return new Date(`${date}T${time}:00.000Z`);
	}
}

export const load = async (event: RequestEvent) => {
	const session = await event.locals.auth();
	
	if (!session) {
		throw redirect(303, '/login');
	}
	
	// Get available communities from shared-lib
	const availableCommunities = getAvailableCommunities();
	
	return {
		session,
		availableCommunities
	};
};

export const actions: Actions = {
	default: async ({ request, locals, platform }) => {
		// Wall-clock per phase. On Workers the clock only advances across I/O, which
		// is exactly what is being measured here — each number is real waiting.
		const startedAt = Date.now();
		const session = await locals.auth();
		const authMs = Date.now() - startedAt;
		
		if (!session || !session.user) {
			throw redirect(303, '/login');
		}
		
		const formStartedAt = Date.now();
		const formData = await request.formData();
		const formMs = Date.now() - formStartedAt;
		// The composer renders one textarea per part, all named `parts`, so getAll
		// returns them in document order.
		const parts = normalizeThreadParts(formData.getAll('parts').map((part) => String(part)));
		const scheduledDate = formData.get('scheduledDate') as string;
		const scheduledTime = formData.get('scheduledTime') as string;
		const community = formData.get('community') as string;
		const timezone = formData.get('timezone') as string;

		// Covers empty content, the per-part 280 limit including its numbering
		// suffix, and the maximum part count.
		const threadError = validateThreadParts(parts);
		if (threadError) {
			return fail(400, { error: threadError });
		}

		if (!scheduledDate || !scheduledTime) {
			return fail(400, { error: 'Date and time are required' });
		}

		// Convert the local time to UTC using the user's timezone
		const scheduledDateTime = convertToUTC(scheduledDate, scheduledTime, timezone);

		// Check if the scheduled time is in the past (compare with current UTC time)
		if (scheduledDateTime < new Date()) {
			return fail(400, { error: 'Scheduled time must be in the future' });
		}

		try {
			const tweet: Tweet = {
				userId: session.user.id as string,
				// Display/fallback text. `parts` is the authoritative post plan.
				content: parts.join('\n\n'),
				scheduledDate: scheduledDateTime, // This is now properly in UTC
				community,
				status: TweetStatus.SCHEDULED,
				createdAt: new Date(), // This is also UTC
				parts: parts.length > 1 ? parts : undefined
			};

			const saveStartedAt = Date.now();
			await getDb(platform).saveTweet(tweet);

			log.info('Scheduled a tweet', {
				parts: parts.length,
				chars: tweet.content.length,
				authMs,
				formMs,
				saveMs: Date.now() - saveStartedAt,
				totalMs: Date.now() - startedAt
			});
		} catch (error) {
			log.error('Failed to save tweet:', {
				userId: session.user.id,
				partCount: parts.length,
				error
			});
			return fail(500, { error: 'Failed to schedule tweet. Please try again.' });
		}

		redirect(303, '/scheduled');
	}
}; 