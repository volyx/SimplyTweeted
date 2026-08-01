import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { TweetStatus } from 'shared-lib';
import { log } from '$lib/server/logger.js';

const TWEETS_PER_PAGE = 10;

export const load: PageServerLoad = async ({ locals, url, platform }) => {
	// The action redirects here, so this load is part of the wait the user feels.
	const startedAt = Date.now();
	const session = await locals.auth();
	const authMs = Date.now() - startedAt;
	if (!session?.user?.id) {
		throw redirect(303, '/signin');
	}
	const userId = session.user.id;

	const page = parseInt(url.searchParams.get('page') || '1');

	// A tweet the scheduler has claimed is briefly in POSTING; keep it visible
	// here rather than having it vanish from both listings mid-flight.
	const pendingStatuses = [TweetStatus.SCHEDULED, TweetStatus.POSTING];

	try {
		const db = getDb(platform);
		// Use the generic utility functions from db for cleaner code
		const queryStartedAt = Date.now();
		const [tweets, totalTweets] = await Promise.all([
			db.getTweets(userId, page, TWEETS_PER_PAGE, pendingStatuses, 1),
			db.countTweets(userId, pendingStatuses)
		]);

		log.info('Scheduled list loaded', {
			tweets: tweets.length,
			authMs,
			queryMs: Date.now() - queryStartedAt,
			totalMs: Date.now() - startedAt
		});

		return {
			tweets,
			currentPage: page,
			totalPages: Math.ceil(totalTweets / TWEETS_PER_PAGE),
			session
		};
	} catch (error) {
		log.error("Error loading scheduled tweets:", { userId, page, error });
		return fail(500, { error: "Failed to load scheduled tweets." });
	}
};

export const actions: Actions = {
	deleteTweet: async ({ request, locals, platform }) => {
		const session = await locals.auth();
		if (!session?.user?.id) {
			return fail(401, { error: 'Unauthorized' });
		}
		const userId = session.user.id;

		const formData = await request.formData();
		const tweetId = formData.get('tweetId')?.toString();

		if (!tweetId) {
			return fail(400, { error: 'Tweet ID is required' });
		}

		try {
			const result = await getDb(platform).deleteTweet(tweetId, userId);

			if (!result.success) {
				return fail(404, { error: 'Tweet not found or you do not have permission to delete it' });
			}

			return { success: true, deletedTweetId: tweetId };
		} catch (error) {
			log.error('Error deleting tweet:', { userId, tweetId, error });
			return fail(500, { error: 'Failed to delete tweet' });
		}
	}
}; 