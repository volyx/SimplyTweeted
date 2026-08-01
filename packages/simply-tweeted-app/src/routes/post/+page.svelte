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
	/** Index currently being split by the AI, or -1. Only one runs at a time. */
	let aiSplittingIndex = -1;
	/** Set when the AI split fell back or failed, so the result is never unexplained. */
	let aiNotice: string | null = null;

	// Validate exactly what the server will validate, via the same shared helpers.
	$: threadError = validateThreadParts(normalizeThreadParts(parts));
	$: isValidTweet = !threadError && isDateTimeValid;

	/**
	 * Per-part figures the markup reads, derived here rather than called from it.
	 *
	 * The markup must not call an instance function to decide what to show. The
	 * compiler emits a tracked read only for state an expression names directly:
	 * `parts[i]` becomes `get(parts)` followed by an untracked evaluation, while
	 * `partLength(i)` becomes an untracked call with no tracked read at all, so
	 * its effect never subscribes to `parts` and never re-runs. That is why the
	 * counter sat at 0/280 while typing, why the box never turned red, and why
	 * the over-limit warning holding the split button never appeared -- the
	 * `{#if}` testing it was frozen too. `+ Add part` was unaffected because the
	 * `{#each}` tracks `parts` itself, which is what made the fault look like a
	 * missing button rather than dead reactivity.
	 *
	 * These statements name `parts`, so legacy reactivity re-runs them on every
	 * change, and the markup only ever indexes the results.
	 */
	$: partLengths = parts.map((part, i) => formatThreadPart(part, i, parts.length).length);
	// Only over-long parts need a plan, so a normal keystroke costs no splitting.
	$: splitPlans = parts.map((_, i) =>
		partLengths[i] > MAX_TWEET_LENGTH ? splitPlan(i) : []
	);
	$: roomForSplit = MAX_THREAD_PARTS - (parts.length - 1) >= 2;

	$: {
		const now = new Date();
		// Create the scheduled date/time in the user's local timezone for validation
		const scheduledDateTime = new Date(`${scheduledDate}T${scheduledTime}`);
		isDateTimeValid = scheduledDateTime > now;
	}

	/**
	 * Writes a box's text into state by replacing the array, not by mutating it.
	 *
	 * `bind:value={parts[i]}` compiles to an in-place `parts[i] = value` plus a
	 * mutation notice. That reported as not reaching the counter — typing left it
	 * at 0/280 — while `+ Add part`, which assigns a whole new array, updated the
	 * UI immediately. Both routes are meant to be equivalent, so rather than rely
	 * on the one that misbehaved, every write now takes the assignment path that
	 * demonstrably works.
	 */
	function setPart(index: number, value: string) {
		if (parts[index] === value) return;

		const next = [...parts];
		next[index] = value;
		parts = next;
	}

	/**
	 * What this part would become if split. Computed against the rest of the
	 * thread, because more parts means a wider ` n/total` suffix and so a smaller
	 * budget per part.
	 *
	 * Text needing more parts than the thread has room for is *not* refused —
	 * refusing meant the button vanished exactly when the text most needed
	 * splitting. Instead the chunks that don't fit are rejoined into the final
	 * part, which then trips the ordinary over-limit warning. Every character
	 * survives and the box to trim is obvious.
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

	/** Replaces one part in place with the parts it becomes. */
	function applySplit(index: number, chunks: string[]) {
		parts = [...parts.slice(0, index), ...chunks, ...parts.slice(index + 1)];
		activePartIndex = index;
		showEmojiPicker = false;
	}

	/** Replaces an over-long part in place with the parts it splits into. */
	function splitPart(index: number) {
		// room < 2 means the thread is already at its maximum length, so there is
		// nowhere to put a second part. The button is hidden then; this mirrors the
		// guard so the two cannot drift apart.
		if (MAX_THREAD_PARTS - (parts.length - 1) < 2) return;

		const chunks = splitPlan(index);
		if (chunks.length < 2) return;

		applySplit(index, chunks);
	}

	/**
	 * Asks the server to split this part where the meaning breaks, rather than at
	 * whichever space happens to fall near the limit.
	 *
	 * The server validates the model's answer and falls back to the word-boundary
	 * split on its own, so this always returns something usable — `notice` says so
	 * when the result is not what was asked for.
	 */
	async function aiSplitPart(index: number) {
		if (aiSplittingIndex !== -1) return;

		aiSplittingIndex = index;
		aiNotice = null;
		showEmojiPicker = false;

		try {
			const response = await fetch('/post/ai-split', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text: parts[index], otherParts: parts.length - 1 })
			});
			const result = await response.json();

			if (!response.ok) {
				aiNotice = result?.error ?? 'The AI split failed.';
				return;
			}

			if (Array.isArray(result.parts) && result.parts.length > 1) {
				applySplit(index, result.parts);
			}

			// Always say which split produced this. A silent success was
			// indistinguishable from having pressed the word-boundary button, which
			// made "the AI still cuts sentences" impossible to tell apart from "the
			// AI never ran".
			aiNotice =
				result.notice ??
				(result.source === 'ai'
					? `AI split this into ${result.parts?.length ?? 0} parts.`
					: null);
		} catch {
			aiNotice = 'Could not reach the AI split. Check your connection and try again.';
		} finally {
			aiSplittingIndex = -1;
		}
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

	/**
	 * Adopts whatever the browser put in the boxes before Svelte took over.
	 *
	 * On a reload, browsers restore previously typed textarea contents, and that
	 * happens outside Svelte — no `input` event, so `parts` stays as it was
	 * initialised while the boxes visibly hold text. Everything downstream reads
	 * `parts`, so the counter shows 0/280, the over-limit warning and its split
	 * button never appear, and submitting posts text the client believed was not
	 * there. Reading the DOM once on mount puts state back in charge.
	 */
	function adoptRestoredValues() {
		const boxes = Array.from(
			document.querySelectorAll<HTMLTextAreaElement>('textarea[name="parts"]')
		);
		if (boxes.length === 0) return;

		const restored = boxes.map((box) => box.value);
		if (restored.some((value, i) => value !== parts[i])) {
			parts = restored;
		}
	}

	onMount(async () => {
		if (browser) {
			adoptRestoredValues();

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

					{#if aiNotice}
						<div class="alert alert-info py-2 mb-3">
							<span class="flex-1 text-sm">{aiNotice}</span>
							<button
								type="button"
								class="btn btn-ghost btn-xs"
								title="Dismiss"
								on:click={() => (aiNotice = null)}
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
									value={parts[i]}
									on:input={(e) => setPart(i, e.currentTarget.value)}
									class="textarea textarea-bordered w-full text-lg {partLengths[i] > MAX_TWEET_LENGTH ? 'textarea-error' : ''} {parts.length > 1 ? 'h-28' : 'h-40'}"
									placeholder={i === 0
										? "What's on your mind? Share your thoughts here..."
										: `Part ${i + 1} of the thread...`}
									on:focus={() => (activePartIndex = i)}
									on:change={(e) => setPart(i, e.currentTarget.value)}
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

							<div class="label-text-alt text-right mt-1 {partLengths[i] > MAX_TWEET_LENGTH ? 'text-error' : ''}">
								{partLengths[i]}/{MAX_TWEET_LENGTH}
								{#if parts.length > 1}
									<span class="opacity-60">· posts as “… {i + 1}/{parts.length}”</span>
								{/if}
							</div>

							{#if partLengths[i] > MAX_TWEET_LENGTH}
								{@const chunks = splitPlans[i]}
								{@const over = partLengths[i] - MAX_TWEET_LENGTH}
								{@const total = parts.length - 1 + chunks.length}
								<!-- chunks is empty when the text is all whitespace: over the limit, but
								     nothing to split. Guarding here keeps the last-chunk read below safe. -->
								{@const canSplit = roomForSplit && chunks.length > 1}
								{@const stillOver =
									canSplit &&
									formatThreadPart(chunks[chunks.length - 1], total - 1, total).length >
										MAX_TWEET_LENGTH}
								<div class="alert alert-warning py-2 mt-1">
									<div class="flex-1 text-sm">
										{#if !roomForSplit}
											This is {over} characters over, and the thread is already at its
											{MAX_THREAD_PARTS}-part maximum. Shorten it, or remove another part to make
											room.
										{:else if !canSplit}
											This is {over} characters over the {MAX_TWEET_LENGTH}-character limit. Shorten
											it.
										{:else if stillOver}
											This is {over} characters over — more than {MAX_THREAD_PARTS} parts can hold.
											Splitting fills the thread and leaves the remainder in part
											{i + chunks.length} for you to trim.
										{:else}
											This is {over} characters over. It can be split into {chunks.length} parts at
											word boundaries.
										{/if}
									</div>
									{#if canSplit}
										<div class="flex flex-col gap-1 sm:flex-row">
											<button
												type="button"
												class="btn btn-sm btn-outline"
												title="Breaks at the last space that fits — instant, but it will cut sentences"
												on:click={() => splitPart(i)}
											>
												Split at word boundaries ({chunks.length})
											</button>
											<button
												type="button"
												class="btn btn-sm btn-primary"
												disabled={aiSplittingIndex !== -1}
												title="Let AI choose where the thread should break"
												on:click={() => aiSplitPart(i)}
											>
												{#if aiSplittingIndex === i}
													<span class="loading loading-spinner loading-xs"></span>
													Splitting…
												{:else}
													✨ Split with AI
												{/if}
											</button>
										</div>
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
