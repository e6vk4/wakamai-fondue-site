// Turns a pasted URL into a File, so the rest of the app can treat it
// exactly like a dropped one.
//
// Google Fonts URLs are only ever used to work out WHICH family and style
// is wanted. The css2 stylesheet endpoint itself is never used for the font
// data: it serves unicode-range subsets and pins any axis that wasn't
// requested, so the result would not behave like an uploaded file. The
// Developer API is used instead, with capability=VF, which returns the
// complete variable font (every script, every axis) rather than a subset.

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GOOGLE_CSS_HOST = "fonts.googleapis.com";
const GOOGLE_SPECIMEN_HOST = "fonts.google.com";
const GOOGLE_FILE_HOST = "fonts.gstatic.com";
const GOOGLE_API = "https://www.googleapis.com/webfonts/v1/webfonts";

const FONT_EXT = /\.(woff2?|ttf|otf)$/i;
const MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const TOO_LARGE = "That file is larger than 25 MB.";

// Caps how many distinct family/weight/style lookups we remember for the
// life of the tab. Each entry is a tiny object, this is just a guard against
// unbounded growth in a session that pastes in hundreds of different URLs.
const LOOKUP_CACHE_LIMIT = 50;

// ---------------------------------------------------------------------------
// Types - JSDoc
// ---------------------------------------------------------------------------

/**
 * What a Google Fonts URL asked for, extracted from its `family` parameter
 * or `/specimen/` path.
 * @typedef {object} GoogleFontRequest
 * @property {string} family - font family name, e.g. "Roboto"
 * @property {boolean} italic - whether an italic style was requested
 * @property {number} weight - requested weight, or 400 if none was specified
 * @property {boolean} multipleFamilies - true if the URL asked for more than
 *   one family; only the first is ever loaded, since a File holds one font
 */

/**
 * A resolved, fetchable font file plus the name and note to show for it.
 * @typedef {object} FontTarget
 * @property {string} url - direct URL to download the font bytes from
 * @property {string} name - suggested file name for the resulting File
 * @property {string} note - user-facing note about what was loaded, empty
 *   string if there's nothing worth telling the user
 */

/**
 * @typedef {object} FetchFontResult
 * @property {File} file
 * @property {string} note - see {@link FontTarget.note}
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Messages on this class are written to be shown to the user as-is. */
export class FontUrlError extends Error {}

// ---------------------------------------------------------------------------
// Small generic helpers
// ---------------------------------------------------------------------------

/**
 * decodeURIComponent, but never throws on a malformed sequence.
 * @param {string} s
 * @returns {string}
 */
function safeDecode(s) {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

/**
 * Pulls a URL out of free-form pasted text. People paste whatever Google
 * hands them: a bare URL, a <link> tag, or an @import rule, so grabbing the
 * first https URL in the string handles all three without needing to parse
 * HTML or CSS.
 * @param {string} input
 * @returns {URL}
 * @throws {FontUrlError} if no https URL is found, or it doesn't parse
 */
function extractUrl(input) {
	const match = input.match(/https:\/\/[^\s"'<>)]+/);
	if (!match) throw new FontUrlError("Paste an https URL.");
	try {
		return new URL(match[0].replace(/&amp;/g, "&"));
	} catch {
		throw new FontUrlError("That doesn't look like a valid URL.");
	}
}

/**
 * Derives a display file name from a direct font-file URL's last path
 * segment.
 * @param {URL} url
 * @returns {string}
 */
function fileNameFrom(url) {
	return safeDecode(url.pathname.split("/").pop() || "font");
}

/**
 * Whether a URL points at one of Google Fonts' own hosts (css2 delivery or
 * the specimen page), regardless of whether {@link parseGoogleUrl} can make
 * sense of its contents. Used to give a more specific error than "not a
 * font URL" when it clearly was meant to be one.
 * @param {URL} url
 * @returns {boolean}
 */
function isGoogleFontsHost(url) {
	return (
		url.hostname === GOOGLE_CSS_HOST ||
		url.hostname === GOOGLE_SPECIMEN_HOST
	);
}

// ---------------------------------------------------------------------------
// Google Fonts URL parsing
// ---------------------------------------------------------------------------

/**
 * Reads which family and style a Google Fonts URL is asking for.
 *
 * Handles the css2 stylesheet URL, e.g.
 *   family=Roboto:ital,wght@0,100..900;1,100..900
 * and a fonts.google.com/specimen/<Family> page URL. Only the family and
 * requested style are read here, the css2 response body itself is never
 * used, see the file header for why.
 *
 * @param {URL} url
 * @returns {GoogleFontRequest | null} null if this isn't a recognizable
 *   Google Fonts URL, or the family couldn't be determined
 */
function parseGoogleUrl(url) {
	let families;

	if (url.hostname === GOOGLE_CSS_HOST && url.pathname.startsWith("/css")) {
		// searchParams already turns "+" into spaces. The css endpoint joins
		// several families with "|" inside one "family" parameter.
		families = url.searchParams
			.getAll("family")
			.flatMap((f) => f.split("|"));
	} else if (
		url.hostname === GOOGLE_SPECIMEN_HOST &&
		url.pathname.startsWith("/specimen/")
	) {
		families = [
			safeDecode(url.pathname.split("/")[2] ?? "").replace(/\+/g, " "),
		];
	} else {
		return null;
	}

	if (!families.length || !families[0]) return null;

	const colon = families[0].indexOf(":");
	const family = (
		colon === -1 ? families[0] : families[0].slice(0, colon)
	).trim();
	const spec = colon === -1 ? "" : families[0].slice(colon + 1);
	// Malformed spec (e.g. "family=:wght@400"): nothing to look up
	if (!family) return null;

	// "ital,wght@0,100..900;1,100..900": axis tags, then one comma-separated
	// tuple per requested style. Only the first tuple is used, a File can
	// only hold one font.
	const [axes = "", tuples = ""] = spec.split("@");
	const tags = axes.split(",");
	const firstTuple = tuples.split(";")[0].split(",");
	const valueOf = (tag) => firstTuple[tags.indexOf(tag)];

	return {
		family,
		italic: valueOf("ital") === "1",
		// For a range like "100..900" parseInt stops at the first non-digit, so
		// this reads the start of the range. A variable file carries the whole
		// range regardless of which weight was asked for.
		weight: Number.parseInt(valueOf("wght"), 10) || 400,
		multipleFamilies: families.length > 1,
	};
}

// ---------------------------------------------------------------------------
// Google Fonts Developer API lookup
// ---------------------------------------------------------------------------

/**
 * Picks which entry of a webfonts-API `files` object matches a request.
 *
 * Static families list one file per weight and style ("regular", "700",
 * "700italic"). Variable families (what capability=VF returns) list only
 * "regular" and "italic", each file already carrying the full axis range,
 * so any requested weight maps to the same file. Falls back to the
 * family's base style, then to whatever's first, rather than failing
 * outright, since "close" is more useful here than an error.
 *
 * @param {Record<string, string>} files
 * @param {{ italic: boolean, weight: number }} request
 * @returns {{ key: string, exact: boolean }} exact is false when a fallback
 *   was used, so the caller can be honest about it in the user-facing note
 */
function chooseVariant(files, { italic, weight }) {
	const slope = italic ? "italic" : "";
	const wanted = weight === 400 ? slope || "regular" : `${weight}${slope}`;
	const base = slope || "regular";

	if (files[wanted]) return { key: wanted, exact: true };
	if (files[base]) return { key: base, exact: false };
	return { key: Object.keys(files)[0], exact: false };
}

/**
 * In-flight/completed lookups, keyed by API key + family + weight + style,
 * so pasting the same Google Fonts URL twice in a session (or two FileDrop
 * instances asking for the same family at once) doesn't hit the network
 * twice. Only the small JSON metadata is cached, never the font bytes
 * themselves, see fetchFontFile for why those stay uncached.
 * @type {Map<string, Promise<FontTarget>>}
 */
const lookupCache = new Map();

/**
 * Resolves a {@link GoogleFontRequest} to a downloadable font file via the
 * Google Fonts Developer API, using and populating {@link lookupCache}.
 *
 * Deliberately does not take the caller's AbortSignal: the promise here can
 * be shared across unrelated callers (that's the point of the cache), and
 * tying it to one caller's component-lifecycle signal would mean a second
 * caller's request gets cancelled if the first caller unmounts first. It
 * gets its own fixed timeout instead.
 *
 * @param {GoogleFontRequest} request
 * @param {string | undefined} apiKey
 * @returns {Promise<FontTarget>}
 * @throws {FontUrlError} if there's no API key, the family doesn't exist,
 *   or the API returns something unexpected
 */
function lookupGoogleFile(request, apiKey) {
	// Fail loudly rather than falling back to the css2 subsets: a partial
	// font that looks complete is worse than an error.
	if (!apiKey) {
		throw new FontUrlError("Google Fonts lookup isn't configured.");
	}

	const cacheKey = `${apiKey}|${request.family}|${request.weight}|${request.italic}`;
	const cached = lookupCache.get(cacheKey);
	if (cached) return cached;

	if (lookupCache.size >= LOOKUP_CACHE_LIMIT) lookupCache.clear();

	const promise = fetchGoogleFontMeta(request, apiKey);
	// A transient failure (network blip, typo corrected on retry) shouldn't
	// be remembered as permanent, only successes stay cached.
	promise.catch(() => lookupCache.delete(cacheKey));
	lookupCache.set(cacheKey, promise);
	return promise;
}

/**
 * The actual network call behind {@link lookupGoogleFile}
 * @param {GoogleFontRequest} request
 * @param {string} apiKey
 * @returns {Promise<FontTarget>}
 */
async function fetchGoogleFontMeta(request, apiKey) {
	const api = new URL(GOOGLE_API);
	api.searchParams.set("key", apiKey);
	api.searchParams.set("family", request.family);
	// Variable font file, with axis metadata, instead of static instances
	api.searchParams.set("capability", "VF");

	// This call needs to send the origin as referrer: a key restricted by
	// HTTP referrer is rejected with a 403 when there isn't one. Its own
	// timeout, not the caller's signal, see the doc comment on lookupGoogleFile.
	const res = await get(api.href, AbortSignal.timeout(TIMEOUT_MS), {
		referrerPolicy: "strict-origin-when-cross-origin",
	});
	const { items } = await res.json();
	const item = items?.[0];
	if (!item?.files) {
		throw new FontUrlError(
			`Google Fonts has no family called "${request.family}".`
		);
	}

	const isVariable = item.axes?.length > 0;
	const { key, exact } = chooseVariant(item.files, request);
	const fileUrl = new URL(item.files[key]);
	// Older API responses used http, which browsers block fetching from an https page
	fileUrl.protocol = "https:";
	if (fileUrl.hostname !== GOOGLE_FILE_HOST) {
		throw new FontUrlError(
			"Google Fonts returned an unexpected file location."
		);
	}

	const ext = fileUrl.pathname.match(FONT_EXT)?.[0] ?? ".ttf";
	let note = isVariable
		? `Loaded ${request.family} Variable Font from Google Fonts.`
		: `Loaded ${request.family} (${key}) from Google Fonts.`;

	if (!isVariable && !exact && request.weight !== 400) {
		note += ` Weight ${request.weight} isn't available for this family, so ${key} was used instead.`;
	}
	if (request.multipleFamilies) {
		note += " Only the first family in the URL was loaded.";
	}

	return {
		url: fileUrl.href,
		// Google's file names are hashes, the family name means more to a
		// person looking at their downloads folder
		name: `${request.family.replace(/[^\w.-]+/g, "")}-${key}${ext}`,
		note,
	};
}

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

/**
 * fetch with the defaults this file wants everywhere: no cookies, no
 * referrer (unless overridden), and a non-2xx status turned into a
 * FontUrlError so callers don't each need their own res.ok check.
 * @param {string} url
 * @param {AbortSignal} signal
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 * @throws {FontUrlError} on a non-2xx response
 */
async function get(url, signal, init = {}) {
	// Public assets, so there's no reason to send cookies or a referrer by
	// default; fetchGoogleFontMeta overrides referrerPolicy since its key
	// requires one
	const res = await fetch(url, {
		signal,
		credentials: "omit",
		referrerPolicy: "no-referrer",
		...init,
	});
	if (!res.ok)
		throw new FontUrlError(`The server responded with ${res.status}.`);
	return res;
}

/**
 * Reads a Response body into a Blob, aborting the download as soon as it
 * exceeds `limit` bytes instead of buffering the whole thing into memory
 * first and only checking afterward. Backstops the Content-Length check in
 * fetchFontFile for servers that under-report or omit that header.
 * @param {Response} response
 * @param {number} limit - max bytes allowed
 * @param {string} type - Content-Type to give the resulting Blob
 * @returns {Promise<Blob>}
 * @throws {FontUrlError} if the body exceeds `limit`
 */
async function readBlobWithLimit(response, limit, type) {
	// No streaming body available (very old browser, or an opaque response):
	// fall back to buffering it whole. The Content-Length check before this
	// runs already caught the common oversized case.
	if (!response.body) {
		const blob = await response.blob();
		if (blob.size > limit) throw new FontUrlError(TOO_LARGE);
		return blob;
	}

	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel(); // stop pulling bytes we're about to reject
			throw new FontUrlError(TOO_LARGE);
		}
		chunks.push(value);
	}

	return new Blob(chunks, { type });
}

/**
 * Normalizes any error into a FontUrlError with a message safe to show the
 * user, without swallowing an AbortError the caller needs to see.
 * @param {unknown} e
 * @returns {Error}
 */
function toFontUrlError(e) {
	if (e instanceof FontUrlError || e.name === "AbortError") return e;
	if (e.name === "TimeoutError")
		return new FontUrlError("The request timed out.");
	// fetch reports CORS, DNS and offline failures all as the same TypeError,
	// there's no way to tell them apart from here
	return new FontUrlError(
		"This font URL doesn't allow cross-origin requests."
	);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolves a pasted URL (a Google Fonts link or a direct font file link) to
 * a File, ready to hand to the same code path a dropped file goes through.
 *
 * Requires a minimum browser support level for AbortSignal.any/.timeout
 * (Chrome 116+, Firefox 124+, Safari 17.4+), matching what this project
 * already needs for other reasons.
 *
 * @param {string} input - pasted URL, or text containing one (a <link> tag
 *   or @import rule both work, see extractUrl)
 * @param {AbortSignal} signal - aborted if the caller (e.g. an unmounting
 *   component) needs to cancel; only governs the font-bytes download, see
 *   the doc comment on lookupGoogleFile for why the lookup step is separate
 * @param {{ apiKey?: string }} [options] - Google Fonts Developer API key,
 *   required only for Google Fonts URLs, not for direct file links
 * @returns {Promise<FetchFontResult>}
 * @throws {FontUrlError} for anything that should be shown to the user
 *   as-is; AbortError is rethrown untouched so the caller can tell a
 *   cancelled request from a failed one
 */
export async function fetchFontFile(input, signal, { apiKey } = {}) {
	try {
		const url = extractUrl(input);
		const google = parseGoogleUrl(url);

		/** @type {FontTarget} */
		let target;
		if (google) {
			target = await lookupGoogleFile(google, apiKey);
		} else if (isGoogleFontsHost(url)) {
			throw new FontUrlError(
				"That Google Fonts link isn't in a format I recognize."
			);
		} else if (FONT_EXT.test(url.pathname)) {
			target = { url: url.href, name: fileNameFrom(url), note: "" };
		} else {
			throw new FontUrlError(
				"Use a Google Fonts link or a direct link to a .woff2, .woff, .ttf or .otf file."
			);
		}

		// Own deadline for the actual font download, tied to the caller's
		// lifecycle (see fetchGoogleFontMeta's doc comment for why the lookup
		// step above isn't on this same signal)
		const timed = AbortSignal.any([
			signal,
			AbortSignal.timeout(TIMEOUT_MS),
		]);
		const res = await get(target.url, timed);

		// Content-Length lets us bail before downloading anything, the
		// streaming read below is the backstop for servers that lie about it
		// or don't send it at all
		if (Number(res.headers.get("content-length")) > MAX_BYTES) {
			throw new FontUrlError(TOO_LARGE);
		}
		const blob = await readBlobWithLimit(
			res,
			MAX_BYTES,
			res.headers.get("content-type") || ""
		);

		return {
			file: new File([blob], target.name, { type: blob.type }),
			note: target.note,
		};
	} catch (e) {
		throw toFontUrlError(e);
	}
}
