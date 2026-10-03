/**
 * Loads configuration from environment variables.
 *
 * Rules we always follow:
 *  - Secrets are read ONLY from environment variables.
 *  - We never print a secret value, only variable NAMES when something is missing.
 *  - A local .env file is loaded automatically with dotenv (if one exists).
 *    Values that already exist in the real environment win, which is how
 *    GitHub Actions secrets override the file.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import type { Config } from "./types.js";

/** Repository root folder (the folder that contains topics.json). */
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Folder where the DRY_RUN preview is written. */
export const OUT_DIR = path.join(ROOT_DIR, "out");

/** Load the local .env file, if there is one. Never reads or logs its content. */
dotenv.config();

/** Returns an environment variable or undefined when it is missing/empty. */
function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Turns "true"/"1"/"yes" into a boolean. Everything else is false. */
function readBoolEnv(name: string, fallback: boolean): boolean {
  const value = readEnv(name);
  if (value === undefined) return fallback;
  return ["true", "1", "yes", "y"].includes(value.toLowerCase());
}

/**
 * Removes a trailing slash so we can build links safely:
 * "https://example.com/" becomes "https://example.com".
 */
function normaliseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Builds the Config object and checks that everything we need is present.
 *
 * In DRY_RUN mode only GROQ_API_KEY and WEBSITE_URL are required,
 * because no Blogger call is made.
 *
 * Throws a readable error listing the *names* of missing variables.
 */
export function loadConfig(): Config {
  const dryRun = readBoolEnv("DRY_RUN", false);

  // Names of required variables that are missing (we only ever show names).
  const missing: string[] = [];

  const groqApiKey = readEnv("GROQ_API_KEY");
  if (!groqApiKey) missing.push("GROQ_API_KEY");

  const websiteUrl = readEnv("WEBSITE_URL");
  if (!websiteUrl) missing.push("WEBSITE_URL");

  // Google + Blogger secrets are only needed when we publish.
  const googleClientId = readEnv("GOOGLE_CLIENT_ID");
  const googleClientSecret = readEnv("GOOGLE_CLIENT_SECRET");
  const googleRefreshToken = readEnv("GOOGLE_REFRESH_TOKEN");
  const bloggerBlogId = readEnv("BLOGGER_BLOG_ID");

  if (!dryRun) {
    if (!googleClientId) missing.push("GOOGLE_CLIENT_ID");
    if (!googleClientSecret) missing.push("GOOGLE_CLIENT_SECRET");
    if (!googleRefreshToken) missing.push("GOOGLE_REFRESH_TOKEN");
    if (!bloggerBlogId) missing.push("BLOGGER_BLOG_ID");
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `Set them in your environment or in a local .env file (see .env.example).` +
        (dryRun ? " DRY_RUN only needs GROQ_API_KEY and WEBSITE_URL." : ""),
    );
  }

  return {
    groqApiKey: groqApiKey as string,
    websiteUrl: normaliseUrl(websiteUrl as string),
    draftMode: readBoolEnv("DRAFT_MODE", true), // safe default: save as draft
    dryRun,
    googleClientId,
    googleClientSecret,
    googleRefreshToken,
    bloggerBlogId,
  };
}
