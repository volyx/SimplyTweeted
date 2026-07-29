import { SvelteKitAuth } from '@auth/sveltekit';
import Twitter from '@auth/sveltekit/providers/twitter';
import {
	ALLOWED_TWITTER_ACCOUNTS,
	AUTH_SECRET,
	AUTH_TWITTER_ID,
	AUTH_TWITTER_SECRET
} from '$lib/server/env';
import { getDb } from '$lib/server/db';
import { log } from '$lib/server/logger';
import type { UserAccount } from 'shared-lib';

const USERINFO_URL = 'https://api.x.com/2/users/me?user.fields=profile_image_url';

/**
 * The stock provider does `profile({ data }) { return { id: data.id, ... } }`,
 * which throws an opaque TypeError whenever X returns anything other than a
 * success envelope — a rate limit, a scope problem, an app not attached to a
 * Project. Fetch it ourselves so the actual response reaches the logs.
 */
async function fetchXProfile({ tokens }: { tokens: { access_token?: string } }) {
	const response = await fetch(USERINFO_URL, {
		headers: { Authorization: `Bearer ${tokens.access_token}` }
	});

	const body = await response.text();
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		parsed = body;
	}

	if (!response.ok || !parsed || typeof parsed !== 'object' || !('data' in parsed)) {
		log.error('X userinfo request failed', {
			status: response.status,
			body: typeof parsed === 'string' ? parsed.slice(0, 500) : parsed
		});
		throw new Error(`X userinfo ${response.status}: ${body.slice(0, 300)}`);
	}

	return parsed as { data: { id: string; username: string; name?: string } };
}

/**
 * Lazy (per-event) config. On Cloudflare the secrets and the D1 binding only
 * exist inside a request, so the config cannot be built at module scope.
 */
export const { handle, signIn, signOut } = SvelteKitAuth(async (event) => {
	const allowedAccounts = ALLOWED_TWITTER_ACCOUNTS()
		.split(',')
		.map((account: string) => account.trim())
		.filter(Boolean);

	return {
		// Behind Cloudflare the forwarded host is authoritative.
		trustHost: true,
		secret: AUTH_SECRET(),
		providers: [
			Twitter({
				clientId: AUTH_TWITTER_ID(),
				clientSecret: AUTH_TWITTER_SECRET(),
				authorization: {
					url: 'https://x.com/i/oauth2/authorize',
					params: {
						scope: 'tweet.read tweet.write users.read offline.access'
					}
				},
				userinfo: {
					url: USERINFO_URL,
					request: fetchXProfile
				}
			})
		],
		callbacks: {
			async signIn({ account, profile }) {
				if (account?.provider === 'twitter') {
					// Ensure profile and profile.data exist
					if (profile && 'data' in profile) {
						const twitterProfile = profile.data as { username: string; id: string };
						const twitterUsername = twitterProfile?.username || '';

						// Allow if the Twitter username is in our allowed list
						const isAllowed = allowedAccounts.includes(twitterUsername);

						if (isAllowed && account) {
							// Save the user credentials to the database
							const userAccount: UserAccount = {
								userId: twitterProfile.id,
								username: twitterUsername,
								provider: account.provider,
								providerAccountId: account.providerAccountId,
								access_token: account.access_token || '',
								refresh_token: account.refresh_token || '',
								expires_at: account.expires_at || 0,
								expires_in: (account.expires_in as number) || 0,
								token_type: account.token_type || 'bearer',
								scope: account.scope || '',
								createdAt: new Date()
							};

							// Save to database
							await getDb(event.platform).saveUserAccount(userAccount);
						}

						return isAllowed;
					}
					// If profile.data is not as expected, deny sign-in
					return false;
				}
				// Deny other providers by default
				return false;
			},
			async jwt({ token, account, profile }) {
				// Persist the user id to the token right after signin
				if (account && profile && 'data' in profile) {
					// It's important to check the provider here if you have multiple.
					if (account.provider === 'twitter') {
						const twitterProfile = profile.data as { id: string; username: string };
						token.userId = twitterProfile.id; // Store the stable Twitter ID
						token.twitterUsername = twitterProfile.username; // Optionally store username
					}
				}
				return token;
			},
			async session({ session, token }) {
				// Send properties to the client, like user id from a provider.
				if (session.user) {
					if (token.userId) {
						(session.user as { id: string }).id = token.userId as string;
					}
					if (token.twitterUsername) {
						(session.user as { username?: string }).username = token.twitterUsername as string;
					}
				}
				return session;
			}
		}
	};
});
