<script lang="ts">
	import { page } from '$app/stores';
	import type { PageData } from './$types';

	export let data: PageData;

	/** Whole hours until the window rolls over, or null when X did not say. */
	$: resetInHours =
		data.headroom?.resetAt != null
			? Math.max(0, Math.round((data.headroom.resetAt - Date.now()) / 3_600_000))
			: null;

	$: observedHoursAgo = data.headroom
		? Math.floor((Date.now() - data.headroom.observedAt) / 3_600_000)
		: null;
</script>

<div class="py-2">
	<div class="card bg-base-100 shadow-xl">
		<div class="card-body">
			<h2 class="card-title text-2xl">Welcome, {$page.data.session?.user?.name || 'User'}!</h2>
			<p>This is your tweet scheduling dashboard.</p>

			<div class="divider"></div>

			<!--
				X publishes no credits or balance endpoint, so this is the figure it
				attaches to a real post rather than anything modelled locally. It is
				therefore only as fresh as the last post the scheduler made.
			-->
			<div class="stats stats-vertical sm:stats-horizontal shadow w-full">
				<div class="stat">
					<div class="stat-title">Posts left today</div>
					{#if data.headroom}
						<div class="stat-value {data.headroom.remaining === 0 ? 'text-error' : ''}">
							{data.headroom.remaining}{#if data.headroom.limit}<span class="text-base font-normal opacity-60">/{data.headroom.limit}</span>{/if}
						</div>
						<div class="stat-desc">
							Reported by X{#if observedHoursAgo !== null}
								{observedHoursAgo < 1 ? ' just now' : ` ${observedHoursAgo}h ago`}{/if}{#if resetInHours !== null}, resets in {resetInHours}h{/if}
						</div>
					{:else}
						<div class="stat-value text-base font-normal opacity-60">Not yet known</div>
						<div class="stat-desc">X reports this on a post — it appears after your next one goes out</div>
					{/if}
				</div>
			</div>

			<div class="divider"></div>
			
			<div class="grid grid-cols-1 md:grid-cols-2 gap-6">
				<div class="card bg-base-200">
					<div class="card-body">
						<h3 class="card-title">Schedule New Tweet</h3>
						<p>Create and schedule your next tweet.</p>
						<div class="card-actions justify-end">
							<a href="/post" class="btn btn-primary">Create Tweet</a>
						</div>
					</div>
				</div>
				
				<div class="card bg-base-200">
					<div class="card-body">
						<h3 class="card-title">Your Scheduled Tweets</h3>
						<p>View and manage your upcoming tweets.</p>
						<div class="card-actions justify-end">
							<a href="/scheduled" class="btn btn-primary">View All</a>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>
</div> 