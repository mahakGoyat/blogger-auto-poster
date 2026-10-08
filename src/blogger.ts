/**
 * Google Blogger API v3 publishing.
 *
 * Two calls are needed:
 *  1. Exchange the long-lived GOOGLE_REFRESH_TOKEN for a short access token.
 *  2. Create the post with the access token.
 *
 * Everything uses plain fetch and reads its values from environment variables.
 * Tokens and secrets are never logged.
 */
import { logInfo, logStep } from "./log.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const BLOGGER_API = "https://www.googleapis.com/blogger/v3";

export interface GoogleSecrets {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/**
 * Steps 1: refresh token -> access token.
 * The access token lives about one hour, which is plenty for one post.
 */
export async function getAccessToken(secrets: GoogleSecrets): Promise<string> {
  logStep("Getting a Google access token...");

  const body = new URLSearchParams({
    client_id: secrets.clientId,
    client_secret: secrets.clientSecret,
    refresh_token: secrets.refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    // We do not print the response body: it can contain key fragments.
    throw new Error(
      `Google token request failed (HTTP ${response.status}). ` +
        `Check GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN.`,
    );
  }

  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Google did not return an access token.");

  logInfo("Access token received.");
  return data.access_token;
}

/**
 * Blogger accepts either a numeric blog id or a full feed URL.
 * This returns the plain blog id that the API URL needs.
 */
export function normaliseBlogId(input: string): string {
  const value = input.trim();

  // Example: https://www.blogger.com/feeds/1234567890/posts/default
  const match = value.match(/\/blogs\/([0-9]+)/);
  if (match) return match[1];

  // Example: .../feeds/1234567890/posts/default
  const feedMatch = value.match(/\/feeds\/([0-9]+)/);
  if (feedMatch) return feedMatch[1];

  const digits = value.match(/([0-9]{6,})/);
  if (digits) return digits[1];

  return value;
}

export interface PublishOptions {
  blogId: string;
  accessToken: string;
  title: string;
  /** Post body as HTML. */
  html: string;
  /** 2-4 labels for the post. */
  labels: string[];
  /** true saves the post as a draft, false publishes it live. */
  isDraft: boolean;
}

export interface PublishResult {
  id: string;
  url: string;
  /** "LIVE" or "DRAFT" as reported by Blogger. */
  status: string;
}

/** Step 2: create the post in Blogger (as a draft or live). */
export async function publishPost(options: PublishOptions): Promise<PublishResult> {
  const blogId = normaliseBlogId(options.blogId);

  // Draft vs live is controlled ONLY by this query parameter.
  // The Post "status" field is read-only output (DRAFT, LIVE, SCHEDULED),
  // so "PUBLISHED" must never be sent: the API rejects it with HTTP 400.
  const url = `${BLOGGER_API}/blogs/${blogId}/posts?alt=json&isDraft=${options.isDraft}`;

  logStep(`Sending the post to Blogger (${options.isDraft ? "DRAFT" : "LIVE"})...`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.accessToken}`,
    },
    // Only writable fields: kind, title, content, labels.
    body: JSON.stringify({
      kind: "blogger#post",
      title: options.title,
      content: options.html,
      labels: options.labels,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    // Show the error message Google gives us (it is safe: it is not a secret).
    let detail = "";
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      detail = parsed.error?.message ?? "";
    } catch {
      detail = "";
    }
    throw new Error(
      `Blogger API request failed (HTTP ${response.status}).` +
        (detail ? ` ${detail}` : "") +
        (response.status === 401 || response.status === 403
          ? " The access token was rejected. Try getting a new refresh token with: npm run get-token -- <client_secret.json>"
          : ""),
    );
  }

  const data = (await response.json()) as { id?: string; url?: string; status?: string };
  const status = data.status ?? "unknown";
  const postUrl = data.url ?? "";
  // "status" and "url" are safe to print: they are plain post data, no secrets.
  logInfo(`Blogger accepted the post (id: ${data.id ?? "unknown"}).`);
  logInfo(`Blogger reports status: ${status}${postUrl ? ` | url: ${postUrl}` : ""}`);

  return { id: data.id ?? "", url: postUrl, status };
}
