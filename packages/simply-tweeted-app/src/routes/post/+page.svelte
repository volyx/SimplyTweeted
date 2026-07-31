<script lang="ts">
	import { enhance } from '$app/forms';
	import { onMount, onDestroy, tick } from 'svelte';
	import { browser } from '$app/environment';
	import {
		formatThreadPart,
		normalizeThreadParts,
		validateThreadParts,
		splitThreadText,
		MAX_TWEET_LENGTH,
		MAX_THREAD_PARTS
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
	/** Set when a paste was auto-split, so the new boxes don't appear unexplained. */
	let pasteNotice: string | null = null;

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
	 * What this part would become if split. Computed against the rest of the
	 * thread, because more parts means a wider ` n/total` suffix and so a smaller
	 * budget per part.
	 *
	 * Text needing more parts than the thread has room for is *not* refused —
	 * refusing left an over-long paste sitting in one box doing nothing, which
	 * reads as the split being broken. Instead the chunks that don't fit are
	 * rejoined into the final part, which then trips the ordinary over-limit
	 * warning. Every character survives and the box to trim is obvious.
	 */
	function splitPlan(index: number): string[] {
		const chunks = splitThreadText(parts[index], parts.length - 1);
		// How many parts this box may expand into, given the ones around it.
		const room = MAX_THREAD_PARTS - (parts.length - 1);
		if (chunks.length <= room) {
			return chunks;
		}
		// ' ' rejoins faithfully: the splitter only ever breaks on whitespace it drops.
		return [...chunks.slice(0, room - 1), chunks.slice(room - 1).join(' ')];
	}

	/**
	 * Replaces an over-long part in place with the parts it splits into.
	 *
	 * @returns the number of parts it became, or 0 when it was left alone.
	 */
	function splitPart(index: number): number {
		// room < 2 means the thread is already at its maximum length, so there is
		// nowhere to put a second part. The button is hidden then, but the paste
		// handler calls this unattended — so the guard lives here too.
		if (MAX_THREAD_PARTS - (parts.length - 1) < 2) return 0;

		const chunks = splitPlan(index);
		if (chunks.length < 2) return 0;

		parts = [...parts.slice(0, index), ...chunks, ...parts.slice(index + 1)];
		activePartIndex = index;
		showEmojiPicker = false;
		return chunks.length;
	}

	/**
	 * Pasting an over-long block is the usual way to end up past the limit, and
	 * unlike typing there is no half-written sentence to disturb — so split it
	 * immediately instead of waiting for the button. Deferred to a macrotask
	 * because `parts[index]` only picks up the pasted text on the `input` event
	 * that fires after this one.
	 */
	function handlePaste(index: number) {
		setTimeout(async () => {
			if (partLength(index) <= MAX_TWEET_LENGTH) return;

			const count = splitPart(index);
			if (count === 0) return;

			// A paste bigger than the whole thread can hold still splits, with the
			// overflow left in the last part for the user to trim.
			const overflowed = partLength(index + count - 1) > MAX_TWEET_LENGTH;
			pasteNotice = overflowed
				? `Pasted text was split into ${count} parts — the maximum. Part ${index + count} is still over ${MAX_TWEET_LENGTH} characters, so trim it before scheduling.`
				: `Pasted text was over ${MAX_TWEET_LENGTH} characters — split into ${count} parts.`;

			// Leave the caret where the pasted text now ends, ready to keep typing.
			await tick();
			const last = document.getElementById(`part-${index + count - 1}`);
			if (last instanceof HTMLTextAreaElement) {
				last.focus();
				last.setSelectionRange(last.value.length, last.value.length);
			}
		});
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

					{#if pasteNotice}
						<div class="alert alert-info py-2 mb-3">
							<span class="flex-1 text-sm">{pasteNotice}</span>
							<button
								type="button"
								class="btn btn-ghost btn-xs"
								title="Dismiss"
								on:click={() => (pasteNotice = null)}
							>
								✕
							</button>
						</div>
					{/if}

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
									on:paste={() => handlePaste(i)}
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
								{@const chunks = splitPlan(i)}
								{@const threadFull = MAX_THREAD_PARTS - (parts.length - 1) < 2}
								{@const total = parts.length - 1 + chunks.length}
								{@const stillOver =
									formatThreadPart(chunks[chunks.length - 1], total - 1, total).length >
									MAX_TWEET_LENGTH}
								<div class="alert alert-warning py-2 mt-1">
									<div class="flex-1 text-sm">
										{#if threadFull}
											This is {partLength(i) - MAX_TWEET_LENGTH} characters over, and the thread is
											already at its {MAX_THREAD_PARTS}-part maximum. Shorten it, or remove another
											part to make room.
										{:else if stillOver}
											This is {partLength(i) - MAX_TWEET_LENGTH} characters over — more than
											{MAX_THREAD_PARTS} parts can hold. Splitting fills the thread and leaves the
											remainder in part {i + chunks.length} for you to trim.
										{:else}
											This is {partLength(i) - MAX_TWEET_LENGTH} characters over. It can be split into
											{chunks.length} parts at word boundaries.
										{/if}
									</div>
									{#if !threadFull}
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
								Posts as {parts.length} tweets, each replying to the last
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
