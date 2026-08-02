<script lang="ts">
	import '../app.css';
	import { page, updated } from '$app/stores';
	import { beforeNavigate, invalidateAll } from '$app/navigation';
	import { signOut } from '@auth/sveltekit/client';

	let { children, data } = $props();

	let refreshing = $state(false);
	let refreshError: string | null = $state(null);

	/**
	 * The only place in the app that spends X credits, so it is a deliberate
	 * click rather than anything automatic. The sidebar otherwise renders the
	 * cached snapshot the layout load returns.
	 */
	async function refreshTrends() {
		if (refreshing) return;
		refreshing = true;
		refreshError = null;
		try {
			const response = await fetch('/api/trends', { method: 'POST' });
			const result = await response.json();
			if (!response.ok) {
				refreshError = result?.error ?? 'Could not refresh.';
				return;
			}
			await invalidateAll();
		} catch {
			refreshError = 'Could not reach the server.';
		} finally {
			refreshing = false;
		}
	}

	/** Compact counts, the way X renders them. */
	function short(n: number): string {
		if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
		if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
		return String(n);
	}

	/**
	 * Survive a deploy that happens while the page is open.
	 *
	 * Every build hashes its JS afresh and the previous chunks stop being served,
	 * so a tab left open across a deploy still holds the old filenames. The next
	 * client-side navigation asks for a chunk that no longer exists and fails with
	 * `Failed to fetch dynamically imported module`, leaving the app stuck.
	 *
	 * `updated` goes true once SvelteKit notices a new build. Turning that
	 * navigation into a full page load fetches the current HTML and its current
	 * chunk names, which is the only way back to a working page.
	 */
	beforeNavigate((navigation) => {
		if ($updated && navigation.to?.url && !navigation.willUnload) {
			navigation.cancel();
			location.href = navigation.to.url.href;
		}
	});
</script>

<div class="drawer lg:drawer-open">
	<input id="my-drawer" type="checkbox" class="drawer-toggle" />
	
	<div class="drawer-content flex flex-col min-h-screen">
		<header class="navbar bg-base-100/80 backdrop-blur-md border-b border-base-300 sticky top-0 z-30">
			<div class="navbar-start">
				<label for="my-drawer" class="btn btn-square btn-ghost lg:hidden" aria-label="Open menu">
					<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="inline-block w-5 h-5 stroke-current">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path>
					</svg>
				</label>
				<a href="/" class="btn btn-ghost text-xl font-bold">Simply Tweeted</a>
			</div>
			<div class="navbar-end">
				{#if $page.data.session}
					<a href="/dashboard" class="btn btn-ghost btn-sm mr-2">Dashboard</a>
					<div class="dropdown dropdown-end">
						<div tabindex="0" role="button" class="btn btn-ghost btn-circle avatar" aria-label="User menu">
							<div class="w-10 rounded-full">
								<img alt="User avatar" src={$page.data.session.user?.image || 'https://via.placeholder.com/40'} />
							</div>
						</div>
						<div class="dropdown-content menu menu-sm mt-3 z-[1] p-2 shadow bg-base-100 rounded-box w-52">
							<button onclick={() => signOut()} class="w-full text-left px-4 py-2 hover:bg-base-200 rounded-btn">Sign out</button>
						</div>
					</div>
				{:else}
					<a href="/login" class="btn btn-primary btn-sm">Login</a>
				{/if}
			</div>
		</header>

		<div class="flex-grow flex justify-center w-full">
			<main class="w-full max-w-2xl border-x border-base-300 p-4">
				{@render children()}
			</main>

			{#if data.session}
				<aside class="hidden xl:block w-80 p-4">
					<div class="card bg-base-200 sticky top-20">
						<div class="card-body p-4">
							<div class="flex items-center justify-between mb-2">
								<h2 class="text-xl font-bold">Trends</h2>
								<button
									class="btn btn-sm btn-ghost"
									disabled={refreshing}
									title="Fetches from X — this spends API credits"
									onclick={refreshTrends}
								>
									{#if refreshing}
										<span class="loading loading-spinner loading-xs"></span>
									{:else}
										Refresh
									{/if}
								</button>
							</div>

							{#if refreshError}
								<p class="text-sm text-error mb-2">{refreshError}</p>
							{/if}

							{#if data.trends.length === 0}
								<p class="text-sm text-base-content/60">
									Nothing yet. Refresh to pull the best-performing posts from the accounts you
									follow — it spends X API credits, so it only runs when you ask.
								</p>
							{:else}
								<p class="text-xs text-base-content/50 mb-2">
									Best of what you follow · {new Date(data.trends[0].fetchedAt).toLocaleString()}
								</p>
								<ul class="flex flex-col">
									{#each data.trends as post, i}
										<li class="border-t border-base-300 py-3 first:border-t-0">
											<a
												href={`https://x.com/${post.authorUsername}/status/${post.tweetId}`}
												target="_blank"
												rel="noopener noreferrer"
												class="block hover:opacity-80"
											>
												<div class="flex items-baseline gap-2">
													<span class="text-xs text-base-content/50">{i + 1}</span>
													<span class="font-bold text-sm truncate">{post.authorName}</span>
													<span class="text-xs text-base-content/50 truncate">
														@{post.authorUsername}
													</span>
												</div>
												<p class="text-sm mt-1 line-clamp-3">{post.text}</p>
												<div class="flex gap-3 mt-2 text-xs text-base-content/50">
													<span>{short(post.replyCount)} replies</span>
													<span>{short(post.retweetCount)} reposts</span>
													<span>{short(post.likeCount)} likes</span>
												</div>
											</a>
										</li>
									{/each}
								</ul>
							{/if}
						</div>
					</div>
				</aside>
			{/if}
		</div>

		<footer class="footer footer-center p-4 bg-base-100 border-t border-base-300 text-base-content/60 text-sm">
			<div>
				<p>
					Simply Tweeted - Powered by the community, for the community |
					<a href="https://github.com/timotme/SimplyTweeted" target="_blank" rel="noopener noreferrer" class="link link-primary">GitHub</a>
				</p>
			</div>
		</footer>
	</div>
	
	<div class="drawer-side">
		<label for="my-drawer" aria-label="close sidebar" class="drawer-overlay"></label>
		<div class="menu p-4 w-72 min-h-full bg-base-100 border-r border-base-300 text-base-content flex flex-col">
			<div class="mb-4">
				<a href="/" class="flex items-center gap-2 px-2 py-3">
					<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
					</svg>
					<span class="text-xl font-bold">Simply Tweeted</span>
				</a>
			</div>

			<div class="border-b border-base-300 mb-4"></div>

			<ul class="menu menu-lg gap-2">
				<li>
					<a href="/" class="flex items-center gap-4 text-lg">
						<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
						</svg>
						Home
					</a>
				</li>
				{#if $page.data.session}
					<li>
						<a href="/post" class="flex items-center gap-4 text-lg">
							<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
							</svg>
							Post a Tweet
						</a>
					</li>
					<li>
						<a href="/scheduled" class="flex items-center gap-4 text-lg">
							<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
							</svg>
							Scheduled Tweets
						</a>
					</li>
					<li>
						<a href="/history" class="flex items-center gap-4 text-lg">
							<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
							</svg>
							Tweet History
						</a>
					</li>
				{:else}
					<li>
						<a href="/login" class="flex items-center gap-4 text-lg">
							<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
							</svg>
							Login
						</a>
					</li>
				{/if}
			</ul>

				{#if $page.data.session}
					<!-- X's signature call to action: a full-width blue pill under the nav. -->
					<a href="/post" class="btn btn-primary btn-block btn-lg mt-4 text-base font-bold">
						Post
					</a>
				{/if}
			
			{#if $page.data.session}
				<div class="mt-auto border-t border-base-300 pt-4">
					<div class="flex items-center gap-3 mb-3 px-3">
						<div class="avatar">
							<div class="w-10 rounded-full ring ring-primary ring-offset-base-100 ring-offset-2">
								<img src={$page.data.session.user?.image || 'https://via.placeholder.com/40'} alt="Profile" />
							</div>
						</div>
						<div>
							<div class="font-medium">
								{$page.data.session.user?.name || 'User'}
							</div>
							<div class="text-sm text-base-content/70">
								@{($page.data.session.user as any)?.username || 'username'}
							</div>
						</div>
					</div>
					<button onclick={() => signOut()} class="btn btn-outline btn-sm w-full gap-2">
						<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
						</svg>
						Sign out
					</button>
				</div>
			{/if}
		</div>
	</div>
</div>
