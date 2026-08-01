// See https://kit.svelte.dev/docs/types#app
// for information about these interfaces

import type { D1Database } from '@cloudflare/workers-types';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			// Populated by the @auth/sveltekit `handle` hook.
			auth: () => Promise<import('@auth/sveltekit').Session | null>;
		}
		interface PageData {
			session: import('@auth/sveltekit').Session | null;
		}
		interface Platform {
			env: {
				DB: D1Database;
			};
			cf: CfProperties;
			ctx: ExecutionContext;
		}
	}
}

export {};
