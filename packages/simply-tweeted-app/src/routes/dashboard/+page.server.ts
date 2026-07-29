import { redirect } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';

export const load = async (event: RequestEvent) => {
	const session = await event.locals.auth();
	
	if (!session) {
		throw redirect(303, '/login');
	}
	
	return {
		session
	};
}; 