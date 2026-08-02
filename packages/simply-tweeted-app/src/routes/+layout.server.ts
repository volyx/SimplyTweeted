import type { LayoutServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { log } from '$lib/server/logger.js';

export const load: LayoutServerLoad = async (event) => {
	const session = await event.locals.auth();

	// The cached snapshot only — reading it costs a D1 query, never an X credit.
	// Refreshing is a deliberate click, handled by POST /api/trends.
	let trends: Awaited<ReturnType<Awaited<ReturnType<typeof getDb>>['getTrends']>> = [];
	try {
		const userId = session?.user?.id;
		if (userId) {
			trends = await getDb(event.platform).getTrends(userId);
		}
	} catch (error) {
		// The sidebar is a nicety; never let it take the whole layout down.
		log.error('Could not load cached trends', { error });
	}

	return {
		session,
		trends
	};
};
