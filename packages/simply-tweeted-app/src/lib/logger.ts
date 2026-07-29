import { dev } from '$app/environment';

/**
 * Client/universal logger. pino's Node transports work in neither the browser
 * nor a Worker, so this is a thin console wrapper with the same call signature.
 */
type Fields = object | undefined;

function replacer(_key: string, value: unknown) {
	if (value instanceof Error) {
		return { name: value.name, message: value.message, stack: value.stack };
	}
	return value;
}

function emit(level: string, message: string, extra?: Fields) {
	// Match pino's old behaviour: debug is dropped outside development.
	if (level === 'debug' && !dev) return;

	const entry = {
		level,
		name: 'simply-tweeted-app',
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
