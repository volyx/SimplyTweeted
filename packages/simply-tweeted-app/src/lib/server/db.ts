import { DB_ENCRYPTION_KEY } from '$lib/server/env';
import { DatabaseClient } from 'shared-lib/backend';

/**
 * Build a DatabaseClient for the current request from the D1 binding.
 *
 * Deliberately not a singleton: D1 has no connection to pool, and caching a
 * client in module scope would outlive the request whose bindings it captured.
 */
export function getDb(platform: App.Platform | undefined): DatabaseClient {
	const db = platform?.env?.DB;
	if (!db) {
		throw new Error(
			'D1 binding "DB" is unavailable. Check d1_databases in wrangler.jsonc, and that this code runs inside a request.'
		);
	}
	return new DatabaseClient(db, DB_ENCRYPTION_KEY());
}
