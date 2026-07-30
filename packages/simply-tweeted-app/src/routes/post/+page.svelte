<script lang="ts">
	import { enhance } from '$app/forms';
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$app/environment';
	import {
		formatThreadPart,
		normalizeThreadParts,
		validateThreadParts,
		splitThreadText,
		MAX_TWEET_LENGTH,
		MAX_THREAD_PARTS,
		DAILY_POST_BUDGET
	} from 'shared-lib';
	import type { PageData, ActionData } from './$types';

	export let data: PageData;
	// Without this the server's fail() messages are invisible — and threads add
	// several server-only failures, so submitting would just appear to do nothing.
	export let form: ActionData | null = null;

	let parts: string[] = [''];
	let scheduledDate = new Date().toISOString().split('T')[0]; // Today's date as default
	let scheduledTime = new Date(Math.ceil((Date.now() + 15 * 60000) / (5 * 60000)) * 5 * 60000).toTimeString().slice(0, 5); // Default time is 15 minutes from now, rounded to next 5min
	let community = '';
	let isDateTimeValid = true;
	let showEmojiPicker = false;
	let emojiPickerElement: HTMLElement;
	let activePartIndex = 0;
	let userTimezone = '';

	// Validate exactly what the server will validate, via the same shared helpers.
	$: threadError = validateThreadParts(normalizeThreadParts(parts));
	$: isValidTweet = !threadError && isDateTimeValid;

	$: {
		const now = new Date();
		// Create the scheduled date/time in the user's local timezone for validation
		const scheduledDateTime = new Date(`${scheduledDate}T${scheduledTime}`);
		isDateTimeValid = scheduledDateTime > now;
	}

	/** Length as X will see it, including the ` 1/3` suffix this part will carry. */
	function partLength(index: number): number {
		return formatThreadPart(parts[index], index, parts.length).length;
	}

	/**
	 * How many parts this one would become if split. Computed against the rest of
	 * the thread, because more parts means a wider ` n/total` suffix and so a
	 * smaller budget per part.
	 */
	function splitPreview(index: number): string[] {
		return splitThreadText(parts[index], parts.length - 1);
	}

	/** Replaces an over-long part in place with the chunks it splits into. */
	function splitPart(index: number) {
		const chunks = splitPreview(index);
		if (chunks.length < 2) return;

		parts = [...parts.slice(0, index), ...chunks, ...parts.slice(index + 1)];
		activePartIndex = index;
		showEmojiPicker = false;
	}

	function addPart() {
		parts = [...parts, ''];
		activePartIndex = parts.length - 1;
	}

	function removePart(index: number) {
		parts = parts.filter((_, i) => i !== index);
		if (activePartIndex >= parts.length) {
			activePartIndex = parts.length - 1;
		}
		showEmojiPicker = false;
	}

	function movePart(index: number, delta: number) {
		const target = index + delta;
		if (target < 0 || target >= parts.length) return;
		const next = [...parts];
		[next[index], next[target]] = [next[target], next[index]];
		parts = next;
		showEmojiPicker = false;
	}

	function toggleEmojiPicker(index: number) {
		// Reopen against the newly focused part rather than toggling it shut.
		if (showEmojiPicker && activePartIndex !== index) {
			activePartIndex = index;
			return;
		}
		activePartIndex = index;
		showEmojiPicker = !showEmojiPicker;
	}

	function handleEmojiSelect(event: CustomEvent) {
		const emoji = event.detail.unicode;
		const next = [...parts];
		next[activePartIndex] += emoji;
		parts = next;
	}

	function handleClickOutside(event: MouseEvent) {
		if (showEmojiPicker && emojiPickerElement && !emojiPickerElement.contains(event.target as Node)) {
			showEmojiPicker = false;
		}
	}

	onMount(async () => {
		if (browser) {
			await import('emoji-picker-element');
			window.addEventListener('click', handleClickOutside, true);

			// Detect user's timezone
			userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		}
	});

	onDestroy(() => {
		if (browser) {
			window.removeEventListener('click', handleClickOutside, true);
		}
	});
</script>

<div class="container mx-auto max-w-3xl py-8 px-4">
	<h1 class="text-3xl font-bold mb-6">{parts.length > 1 ? 'Schedule a Thread' : 'Schedule a Tweet'}</h1>

	<div class="card bg-base-200 shadow-xl">
		<div class="card-body">
			<form method="POST" use:enhance>
				{#if form?.error}
					<div class="alert alert-error mb-4">
						<span>{form.error}</span>
					</div>
				{/if}

				<div class="form-control mb-4">
					<label class="label" for="part-0">
						<span class="label-text">
							{parts.length > 1 ? `Thread — ${parts.length} parts` : 'Tweet Content'}
						</span>
					</label>

					{#each parts as _, i}
						<div class="mb-3">
							{#if parts.length > 1}
								<div class="flex items-center justify-between mb-1">
									<span class="label-text-alt font-semibold">Part {i + 1}/{parts.length}</span>
									<div class="flex items-center gap-1">
										<button
											type="button"
											class="btn btn-ghost btn-xs"
											disabled={i === 0}
											title="Move up"
											on:click={() => movePart(i, -1)}
										>
											↑
										</button>
										<button
											type="button"
											class="btn btn-ghost btn-xs"
											disabled={i === parts.length - 1}
											title="Move down"
											on:click={() => movePart(i, 1)}
										>
											↓
										</button>
										<button
											type="button"
											class="btn btn-ghost btn-xs text-error"
											title="Remove this part"
											on:click={() => removePart(i)}
										>
											✕
										</button>
									</div>
								</div>
							{/if}

							<div class="relative">
								<textarea
									id="part-{i}"
									name="parts"
									bind:value={parts[i]}
									class="textarea textarea-bordered w-full text-lg {partLength(i) > MAX_TWEET_LENGTH ? 'textarea-error' : ''} {parts.length > 1 ? 'h-28' : 'h-40'}"
									placeholder={i === 0
										? "What's on your mind? Share your thoughts here..."
										: `Part ${i + 1} of the thread...`}
									on:focus={() => (activePartIndex = i)}
								></textarea>
								<button
									type="button"
									class="btn btn-circle btn-md absolute right-2 bottom-2"
									on:click|stopPropagation={() => toggleEmojiPicker(i)}
								>
									😊
								</button>
								{#if browser && showEmojiPicker && activePartIndex === i}
									<div class="absolute right-0 top-full mt-2 z-50" bind:this={emojiPickerElement}>
										<emoji-picker on:emoji-click={handleEmojiSelect}></emoji-picker>
									</div>
								{/if}
							</div>

							<div class="label-text-alt text-right mt-1 {partLength(i) > MAX_TWEET_LENGTH ? 'text-error' : ''}">
								{partLength(i)}/{MAX_TWEET_LENGTH}
								{#if parts.length > 1}
									<span class="opacity-60">· posts as “… {i + 1}/{parts.length}”</span>
								{/if}
							</div>

							{#if partLength(i) > MAX_TWEET_LENGTH}
								{@const chunks = splitPreview(i)}
								{@const wouldExceedMax = parts.length - 1 + chunks.length > MAX_THREAD_PARTS}
								<div class="alert alert-warning py-2 mt-1">
									<div class="flex-1 text-sm">
										{#if wouldExceedMax}
											Too long, and splitting it would need {parts.length - 1 + chunks.length} parts —
											more than the {MAX_THREAD_PARTS}-part maximum. Shorten it first.
										{:else}
											This is {partLength(i) - MAX_TWEET_LENGTH} characters over. It can be split into
											{chunks.length} parts at word boundaries.
										{/if}
									</div>
									{#if !wouldExceedMax}
										<button type="button" class="btn btn-sm" on:click={() => splitPart(i)}>
											Split into {chunks.length} parts
										</button>
									{/if}
								</div>
							{/if}
						</div>
					{/each}

					<div class="flex items-center justify-between mt-1">
						<button
							type="button"
							class="btn btn-outline btn-sm"
							disabled={parts.length >= MAX_THREAD_PARTS}
							on:click={addPart}
						>
							+ Add part
						</button>
						{#if parts.length > 1}
							<span class="label-text-alt opacity-70">
								Uses {parts.length} of ~{DAILY_POST_BUDGET} daily posts
							</span>
						{:else}
							<span class="label-text-alt opacity-70">Add a part to make this a thread</span>
						{/if}
					</div>

					{#if threadError}
						<div class="label-text-alt text-error mt-2">{threadError}</div>
					{/if}
				</div>

				<div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
					<div class="form-control">
						<label class="label" for="scheduledDate">
							<span class="label-text">Date</span>
						</label>
						<input
							type="date"
							id="scheduledDate"
							name="scheduledDate"
							bind:value={scheduledDate}
							class="input input-bordered {!isDateTimeValid ? 'input-error' : ''}"
							required
						/>
					</div>

					<div class="form-control">
						<label class="label" for="scheduledTime">
							<span class="label-text">Time</span>
						</label>
						<input
							type="time"
							id="scheduledTime"
							name="scheduledTime"
							bind:value={scheduledTime}
							class="input input-bordered {!isDateTimeValid ? 'input-error' : ''}"
							required
						/>
					</div>
				</div>

				{#if !isDateTimeValid}
					<div class="alert alert-error mb-4">
						<span>Schedule time must be in the future</span>
					</div>
				{/if}

				<div class="form-control mb-6">
					<label class="label" for="community">
						<span class="label-text">Community</span>
					</label>
					<select id="community" name="community" bind:value={community} class="select select-bordered w-full">
						<option value="">None</option>
						{#each data.availableCommunities as communityOption}
							<option value={communityOption}>{communityOption}</option>
						{/each}
					</select>
					{#if community && parts.length > 1}
						<div class="label-text-alt opacity-70 mt-1">
							The first post goes to the Community; the replies inherit it.
						</div>
					{/if}
				</div>

				<!-- Hidden input to send user's timezone -->
				<input type="hidden" name="timezone" value={userTimezone} />

				<div class="form-control mt-6">
					<button type="submit" class="btn btn-primary" disabled={!isValidTweet}>
						{parts.length > 1 ? `Schedule Thread (${parts.length} parts)` : 'Schedule Tweet'}
					</button>
				</div>
			</form>
		</div>
	</div>
</div>
