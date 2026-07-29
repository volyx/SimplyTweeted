/**
 * Workers has no process.stdout, so pino's transports do not apply here.
 * console.* is what the Workers runtime captures for Workers Logs / `wrangler tail`.
 */
type Fields = object | undefined;

// JSON.stringify turns an Error into {}, and callers routinely pass { error }.
function replacer(_key: string, value: unknown) {
	if (value instanceof Error) {
		return { name: value.name, message: value.message, stack: value.stack };
	}
	return value;
}

function emit(level: string, message: string, extra?: Fields) {
	const entry = {
		level,
		name: 'simply-tweeted-app-server',
		time: new Date().toISOString(),
		msg: message,
		...(extra ?? {})
	};
	const line = JSON.stringify(entry, replacer);
	if (level === 'error' || level === 'fatal') {
		console.error(line);
	} else if (level === 'warn') {
		console.warn(line);
	} else {
		console.log(line);
	}
}

export const log = {
	debug: (message: string, extra?: Fields) => emit('debug', message, extra),
	info: (message: string, extra?: Fields) => emit('info', message, extra),
	warn: (message: string, extra?: Fields) => emit('warn', message, extra),
	error: (message: string, extra?: Fields) => emit('error', message, extra),
	fatal: (message: string, extra?: Fields) => emit('fatal', message, extra)
};
