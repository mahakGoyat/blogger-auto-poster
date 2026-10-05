/**
 * Cover images from Pixabay.
 *
 * Flow for one post:
 *   1. The AI writes a short image search query based on the post title.
 *   2. We search Pixabay for a horizontal photo.
 *   3. We pick the first result we have not used before (ids are stored in
 *      state.json under "usedImageIds", so images never repeat).
 *   4. The image is added at the very top of the post HTML.
 *
 * IMPORTANT: nothing in this file may stop a post from being published.
 * Every problem (no API key, no result, API error) is only a warning and the
 * post is published without an image.
 *
 * Pixabay caching rule: an identical search may be repeated at most once every
 * 24 hours, so results are cached in memory for 24 hours.
 */
import { logInfo, logWarn } from "./log.js";
import { generateImageQuery } from "./ai.js";

const PIXABAY_URL = "https://pixabay.com/api/";

/** Used when the AI cannot give us a usable search query. */
export const FALLBACK_QUERY = "resume job interview";

/** Pixabay does not allow the same search more often than once a day. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** One photo from the Pixabay search result. */
interface PixabayHit {
  id: number;
  largeImageURL: string;
  pageURL: string;
  user: string;
  userURL: string;
  tags?: string;
}

/** One cached search, kept for 24 hours. */
interface CacheEntry {
  hits: PixabayHit[];
  expiresAt: number;
}

/** In-memory cache: search query -> results. Lives only during one run. */
const searchCache = new Map<string, CacheEntry>();

/** Everything the post HTML needs to show one photo. */
export interface CoverImage {
  /** Pixabay photo id, stored in state.json so we never use it twice. */
  id: number;
  /** The URL we put in the <img src>. */
  imageUrl: string;
  /** Alt text, based on the post title. */
  alt: string;
  /** Photographer name (never a bare number, see formatCredit). */
  credit: string;
  /** Link to the photographer's Pixabay profile ("" if not given). */
  creditUrl: string;
  /** Link to the photo page on Pixabay. */
  pageUrl: string;
  /** The search query that found this photo (for the log only). */
  query: string;
}

/**
 * Finds one cover image for a post, or returns null when something goes wrong.
 * This function never throws.
 */
export async function getCoverImage(options: {
  title: string;
  apiKey?: string;
  /** Pixabay ids we already published, so we do not repeat an image. */
  usedImageIds: number[];
}): Promise<CoverImage | null> {
  const { title, apiKey, usedImageIds } = options;

  if (!apiKey) {
    logWarn("PIXABAY_API_KEY is not set, so this post will have no cover image.");
    return null;
  }

  try {
    const query = await buildSearchQuery(title);
    logInfo(`Looking for a cover image with the query: "${query}"`);

    const hits = await searchPixabay(query, apiKey);
    const used = new Set(usedImageIds);
    const hit = hits.find((item) => !used.has(item.id));

    if (!hit) {
      logWarn(`No unused Pixabay image for "${query}". Publishing without a cover image.`);
      return null;
    }

    const image: CoverImage = {
      id: hit.id,
      imageUrl: buildImageUrl(hit),
      alt: `${title} - cover image`,
      credit: formatCredit(hit.user),
      creditUrl: hit.userURL ?? "",
      pageUrl: hit.pageURL ?? "",
      query,
    };

    logInfo(`Cover image chosen: Pixabay id ${image.id} (${image.credit}).`);
    return image;
  } catch (error) {
    // A missing image must never break the run.
    logWarn(`Cover image failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Asks the AI for a short, visual search query based on the post title.
 * Falls back to a fixed query when the AI answer is not usable.
 */
async function buildSearchQuery(title: string): Promise<string> {
  try {
    const fromAi = await generateImageQuery(title);
    if (fromAi && fromAi.length >= 2) return fromAi;
  } catch (error) {
    logWarn(`Could not ask the AI for an image query: ${error instanceof Error ? error.message : String(error)}`);
  }
  logInfo(`Using the fallback image query: "${FALLBACK_QUERY}"`);
  return FALLBACK_QUERY;
}

/**
 * Searches Pixabay. Identical queries are served from the 24 hour cache,
 * which is what the Pixabay terms ask for.
 */
async function searchPixabay(query: string, apiKey: string): Promise<PixabayHit[]> {
  const cached = searchCache.get(query);
  if (cached && cached.expiresAt > Date.now()) {
    logInfo(`Using the cached Pixabay results for "${query}".`);
    return cached.hits;
  }

  const params = new URLSearchParams({
    key: apiKey,
    q: query,
    image_type: "photo",
    orientation: "horizontal",
    safesearch: "true",
    per_page: "20",
    min_width: "1000",
  });

  const response = await fetch(`${PIXABAY_URL}?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Pixabay API returned HTTP ${response.status}.`);
  }

  const data = (await response.json()) as { total?: number; hits?: PixabayHit[] };
  // Keep only hits that really have everything the <img> and the credit need.
  const hits = (data.hits ?? []).filter((hit) => Boolean(hit?.id && hit?.largeImageURL));

  if (hits.length === 0) {
    throw new Error(`Pixabay returned no usable photos for "${query}".`);
  }

  searchCache.set(query, { hits, expiresAt: Date.now() + CACHE_TTL_MS });
  logInfo(`Pixabay returned ${hits.length} photos (total matches: ${data.total ?? hits.length}).`);
  return hits;
}

/**
 * The one place that decides which image file we link to.
 *
 * Right now we hot-link Pixabay's largeImageURL. Pixabay says those URLs are
 * only guaranteed to work for about 24 hours, so later we may download the
 * photo and host it ourselves. When that day comes, change ONLY this function
 * (for example upload the file and return our own URL); nothing else in the
 * project needs to change.
 */
export function buildImageUrl(hit: PixabayHit): string {
  return hit.largeImageURL;
}

/**
 * Pixabay returns numbers for some old accounts. Showing "Image by 123456"
 * looks bad, so those become a friendly generic credit.
 */
function formatCredit(user: string | undefined): string {
  const name = (user ?? "").trim();
  if (name === "" || /^\d+$/.test(name)) return "a Pixabay contributor";
  return name;
}

/** Makes text safe to put inside an HTML attribute. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Builds the <figure> block that goes at the very top of the post.
 * Blogger uses the first image of a post as its thumbnail, so this has to be
 * the first element in the post body.
 */
export function buildCoverFigure(image: CoverImage): string {
  const creditLink =
    image.creditUrl !== ""
      ? `<a href="${escapeHtml(image.creditUrl)}" target="_blank" rel="noopener">${escapeHtml(image.credit)}</a>`
      : escapeHtml(image.credit);

  return (
    `<figure style="text-align:center;margin:0 0 1.5em">` +
    `<img src="${escapeHtml(image.imageUrl)}" alt="${escapeHtml(image.alt)}" style="max-width:100%;height:auto">` +
    `<figcaption>Image by ${creditLink} from ` +
    `<a href="${escapeHtml(image.pageUrl)}" target="_blank" rel="noopener">Pixabay</a></figcaption>` +
    `</figure>`
  );
}

/** Puts the cover figure above the first paragraph of the post. */
export function insertCoverImage(html: string, image: CoverImage): string {
  return `${buildCoverFigure(image)}\n${html}`;
}
