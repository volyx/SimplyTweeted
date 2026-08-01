import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://svelte.dev/docs/kit/integrations
	// for more information about preprocessors
	preprocess: vitePreprocess(),

	kit: {
		// Builds a Cloudflare Worker with static assets. Deployment config
		// (bindings, secrets, compatibility flags) lives in wrangler.jsonc.
		adapter: adapter(),

		version: {
			// Poll for a new build so an open tab learns it is stale. Without this,
			// `updated` only changes on a navigation that has already failed — and by
			// then the missing-chunk error has been thrown. The root layout turns the
			// next navigation into a full page load once this flips.
			pollInterval: 60_000
		}
	}
};

export default config;
