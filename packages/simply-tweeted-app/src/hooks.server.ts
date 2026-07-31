// D1 needs no connection lifecycle, and `init` runs outside request scope where
// Cloudflare bindings are not yet available — so there is nothing to set up here.
import { sequence } from '@sveltejs/kit/hooks';
import type { Handle } from '@sveltejs/kit';
import { handle as authHandle } from './auth';

/**
 * Stops browsers reusing a stale HTML shell after a deploy.
 *
 * SvelteKit references its JS by content hash, so the hashed bundles are safe
 * to cache forever — but the HTML naming them carried no cache-control header
 * at all, which lets a browser cache it heuristically for as long as it likes.
 * A visitor could then keep rendering a previous deploy's app indefinitely,
 * loading every chunk from cache without a single request reaching the Worker,
 * so shipping a fix changed nothing for them.
 *
 * Only HTML is touched. The hashed assets under /_app/immutable are served by
 * the assets binding and keep their long-lived immutable caching.
 */
const freshHtml: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);

	if (response.headers.get('content-type')?.includes('text/html')) {
		response.headers.set('cache-control', 'no-cache, must-revalidate');
	}

	return response;
};

export const handle = sequence(authHandle, freshHtml);
