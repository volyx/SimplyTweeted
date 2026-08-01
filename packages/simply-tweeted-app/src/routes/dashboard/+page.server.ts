import { redirect } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { log } from '$lib/server/logger.js';

export const load = async (event: RequestEvent) => {
	const session = await event.locals.auth();

	if (!session) {
		throw redirect(303, '/login');
	}

	// What X itself last reported about the daily posting window. X publishes no
	// credits or balance endpoint, so this — captured from the headers on a real
	// post — is the only figure available that is not a local guess.
	let headroom = null;
	try {
		const userId = session.user?.id;
		if (userId) {
			headroom = await getDb(event.platform).getPostHeadroom(userId, 'twitter');
		}
	} catch (error) {
		// A missing figure is worth less than a working dashboard.
		log.error('Could not load posting headroom', { error });
	}

	return {
		session,
		headroom
	};
};
