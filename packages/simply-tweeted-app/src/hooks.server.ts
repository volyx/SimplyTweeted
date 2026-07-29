// D1 needs no connection lifecycle, and `init` runs outside request scope where
// Cloudflare bindings are not yet available — so there is nothing to set up here.
export { handle } from './auth';
