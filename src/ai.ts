/**
 * All AI work happens here: new topic ideas, the post itself and the SEO title.
 *
 * We use plain fetch against the Groq OpenAI-compatible API, so there is no
 * SDK dependency. The API key only ever comes from the environment and is
 * never printed.
 */
import { logInfo, logStep, logWarn, sleep } from "./log.js";
import { cleanAiHtml, countWords, looksLikeHtml } from "./html.js";
import type { Topic } from "./types.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

/**
 * Models.
 *
 * Both are "reasoning" models: they spend part of their token budget thinking
 * before writing the answer. We use:
 *  - MAIN_MODEL for normal writing (better quality),
 *  - FALLBACK_MODEL when the main model keeps failing.
 *
 * The names are only defaults. You can change them without touching the code:
 *   GROQ_PRIMARY_MODEL=... GROQ_FALLBACK_MODEL=...
 * This matters because Groq retires models from time to time, and a retired
 * model makes every call fail with HTTP 404.
 */
export const MAIN_MODEL = readModelEnv("GROQ_PRIMARY_MODEL", "openai/gpt-oss-120b");
export const FALLBACK_MODEL = readModelEnv("GROQ_FALLBACK_MODEL", "openai/gpt-oss-20b");

/** Reads a model name from the environment, or uses the default. */
function readModelEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

/** How many times we try a model before we give up on it. */
const MAX_ATTEMPTS = 3;
/** Wait before the 1st retry, then double it every time. */
const BACKOFF_MS = 2_000;

/**
 * Token budget per answer. Reasoning tokens are counted inside this number,
 * so we leave a lot of room: otherwise the article can be cut short.
 */
const DEFAULT_MAX_COMPLETION_TOKENS = 6_000;

/**
 * How hard the models think. "low" keeps them fast and cheap while still
 * writing good, structured articles. Change with GROQ_REASONING_EFFORT.
 */
const REASONING_EFFORT = readModelEnv("GROQ_REASONING_EFFORT", "low");

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Turns any thrown value into a readable message. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A non-2xx answer from an HTTP API, with the status code kept. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Only rate limits (429) and temporary server/network errors are worth retrying. */
function isRetryable(error: unknown): boolean {
  if (!(error instanceof HttpError)) return true; // network hiccup, timeout, ...
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(error.status);
}

/**
 * Turns a Groq error answer into a readable message.
 *
 * HTTP 404 almost always means one of two things:
 *  - the model name is wrong, or Groq retired that model,
 *  - the API key is not valid / not allowed to use it.
 * We say so explicitly and show Groq's own error text, which never contains
 * the API key.
 */
async function describeGroqError(response: Response, model: string): Promise<string> {
  let detail = "";
  try {
    const parsed = (await response.json()) as {
      error?: { message?: string; type?: string; code?: string };
    };
    detail = parsed.error?.message ?? "";
  } catch {
    // Not JSON, nothing to show.
  }

  const status = `HTTP ${response.status}`;
  const looksLikeMissingModel =
    response.status === 404 || /model|not found|does not exist|deprecat/i.test(detail);

  const lines = [
    `Groq API error (${status}) while calling model "${model}".`,
    looksLikeMissingModel
      ? `The model "${model}" may have been retired or renamed by Groq, or your key may not have access to it. ` +
        `Check the model list at https://console.groq.com/docs/models and set GROQ_PRIMARY_MODEL / GROQ_FALLBACK_MODEL if the name changed.`
      : "",
    detail ? `Groq said: ${detail}` : "Groq did not send an error message.",
  ];

  return lines.filter(Boolean).join(" ");
}

/** Tries one model, retrying rate limits and temporary errors with backoff. */
async function requestWithRetries(
  model: string,
  messages: ChatMessage[],
  options: { temperature: number; maxCompletionTokens: number },
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      logInfo(`Calling model ${model} (attempt ${attempt} of ${MAX_ATTEMPTS})...`);

      const response = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // The key is read from the environment and never logged.
          Authorization: `Bearer ${process.env.GROQ_API_KEY ?? ""}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature,
          reasoning_effort: REASONING_EFFORT,
          max_completion_tokens: options.maxCompletionTokens,
        }),
      });

      if (!response.ok) {
        throw new HttpError(response.status, await describeGroqError(response, model));
      }

      const data = (await response.json()) as {
        choices?: Array<{
          message?: {
            content?: string;
            // Reasoning models also send a "reasoning" field. We must ignore it
            // and only use "content", otherwise the article would start with
            // the model's private thinking notes.
          };
        }>;
      };
      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error(`The model "${model}" returned an empty answer.`);
      return content;
    } catch (error) {
      const lastAttempt = attempt === MAX_ATTEMPTS;
      const message = errorMessage(error);

      if (lastAttempt || !isRetryable(error)) {
        throw new Error(message);
      }

      const waitMs = BACKOFF_MS * 2 ** (attempt - 1);
      logWarn(`${message} Retrying in ${waitMs / 1000}s...`);
      await sleep(waitMs);
    }
  }

  throw new Error(`The model "${model}" did not return an answer.`);
}

/**
 * Calls the main model. If it fails after all retries, we try the fallback
 * model once before giving up with a clear error.
 */
async function chat(
  messages: ChatMessage[],
  options: { temperature?: number; maxCompletionTokens?: number } = {},
): Promise<string> {
  const settings = {
    temperature: options.temperature ?? 0.7,
    maxCompletionTokens: options.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
  };

  let mainError: unknown;
  try {
    return await requestWithRetries(MAIN_MODEL, messages, settings);
  } catch (error) {
    mainError = error;
    logWarn(`Main model ${MAIN_MODEL} failed: ${errorMessage(error)}`);
    logInfo(`Switching to fallback model ${FALLBACK_MODEL}...`);
  }

  try {
    return await requestWithRetries(FALLBACK_MODEL, messages, settings);
  } catch (fallbackError) {
    throw new Error(
      `AI generation failed with both models. ` +
        `Main model "${MAIN_MODEL}" error: ${errorMessage(mainError)}. ` +
        `Fallback model "${FALLBACK_MODEL}" error: ${errorMessage(fallbackError)}. ` +
        `Check that GROQ_API_KEY is valid, and that the model names still exist ` +
        `(set GROQ_PRIMARY_MODEL / GROQ_FALLBACK_MODEL if Groq retired them).`,
    );
  }
}

/* ------------------------------------------------------------------------- */
/* Duplicate title checking                                                   */
/* ------------------------------------------------------------------------- */

/** Small word list we ignore when comparing two titles. */
const STOP_WORDS = new Set([
  "a", "an", "and", "the", "for", "to", "of", "in", "on", "at", "with", "your", "you",
  "how", "what", "why", "when", "is", "are", "do", "does", "can", "my", "from", "by",
  "as", "or", "if", "that", "this", "it", "its", "be", "will", "s",
  // Generic words that appear in almost every title, so they tell us nothing.
  "write", "writing", "get", "make", "use", "using", "job", "jobs",
]);

/** Lower-cases a title and keeps only its meaningful words. */
function titleKeywords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );
}

/**
 * How similar two titles are, from 0 (nothing in common) to 1 (same words).
 * We use the Jaccard score: shared words divided by all words.
 */
export function similarity(titleA: string, titleB: string): number {
  const wordsA = titleKeywords(titleA);
  const wordsB = titleKeywords(titleB);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let shared = 0;
  for (const word of wordsA) if (wordsB.has(word)) shared++;

  return shared / new Set([...wordsA, ...wordsB]).size;
}

/** Anything above this score counts as "too similar". */
const SIMILARITY_LIMIT = 0.6;

/**
 * Finds the existing title that is closest to the new one.
 * Returns the matching title, or null when the new title is fresh enough.
 */
export function findSimilarTitle(newTitle: string, existingTitles: string[]): string | null {
  let bestMatch: string | null = null;
  let bestScore = 0;

  for (const existing of existingTitles) {
    const score = similarity(newTitle, existing);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = existing;
    }
  }

  return bestScore >= SIMILARITY_LIMIT ? bestMatch : null;
}

/** Pulls a JSON array of strings out of a model answer. */
function parseTitleArray(raw: string): string[] {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  // Take the part between the first [ and the last ].
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1) return [];

  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 8 && item.length <= 140);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------------- */
/* 1. New topic ideas                                                         */
/* ------------------------------------------------------------------------- */

/** How many new topics we generate when the queue gets short. */
export const NEW_TOPICS_PER_BATCH = 50;

/** Asks the model for brand new, distinct topic ideas. */
export async function generateNewTopics(
  existingTitles: string[],
  count: number = NEW_TOPICS_PER_BATCH,
): Promise<string[]> {
  logStep(`Asking the AI for ${count} new topic ideas...`);

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "You are a blog editor for a niche blog about resumes and job applications.",
        "You write short, clear, practical topic ideas for job seekers.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        `Give me exactly ${count} DIFFERENT blog post topic ideas about resumes and job applications.`,
        "",
        "Rules:",
        "- Every idea must be about resumes, ATS screening, cover letters, LinkedIn or job interviews.",
        "- Each idea must be a single, specific question or topic a job seeker would search for.",
        "- Start most of them with a search phrase like 'how to', 'what is', 'why', or a role name.",
        "- Between 8 and 100 characters. No numbering, no extra text.",
        "- Do NOT repeat or closely match any of the titles below.",
        "",
        "Titles that already exist (do not use them or a close variant):",
        ...existingTitles.map((title) => `- ${title}`),
        "",
        `Answer with ONLY a JSON array of exactly ${count} strings. Example: ["How to improve your ATS score", "..."]`,
      ].join("\n"),
    },
  ];

  const raw = await chat(messages, { temperature: 0.9, maxCompletionTokens: DEFAULT_MAX_COMPLETION_TOKENS });
  const parsed = parseTitleArray(raw);

  if (parsed.length === 0) {
    throw new Error("The AI did not return a usable list of new topics.");
  }

  // Drop anything too similar to a title we already have (topic list or published).
  const unique = new Set(existingTitles.map((title) => title.toLowerCase()));
  const fresh: string[] = [];
  for (const title of parsed) {
    if (findSimilarTitle(title, existingTitles) !== null) continue;
    const key = title.toLowerCase();
    if (unique.has(key)) continue;
    unique.add(key);
    fresh.push(title);
  }

  logInfo(`Received ${parsed.length} ideas, kept ${fresh.length} that are new and different.`);
  return fresh;
}

/* ------------------------------------------------------------------------- */
/* 2. The post                                                                */
/* ------------------------------------------------------------------------- */

export interface GeneratedPost {
  /** SEO friendly title, used as the Blogger post title. */
  title: string;
  /** Clean HTML body, ready for Blogger. */
  html: string;
}

/**
 * Writes the full post for one topic.
 *
 * The model never adds a link or a URL. The website tip and the closing
 * call-to-action box are added and verified in src/html.ts, so the link is
 * always a real, clickable <a> tag pointing at WEBSITE_URL.
 */
export async function generatePost(options: {
  topic: Topic;
  /** Set when the model already used a title that is too close to an older one. */
  duplicateTitle?: string;
}): Promise<GeneratedPost> {
  const { topic, duplicateTitle } = options;

  logStep(`Writing the post about: "${topic.title}"`);

  // We add the website tip and the call-to-action box ourselves (src/html.ts),
  // so the model must never write a URL. This keeps the promotion tidy and
  // stops the model from inventing a wrong link.
  const linkInstructions = [
    "",
    "IMPORTANT: do not mention any website, do not add any link and do not write any URL.",
    "We will add a short tip and a call-to-action box with a link ourselves after you finish.",
  ].join("\n");

  const titleInstruction = duplicateTitle
    ? `The title "${duplicateTitle}" is already used, so write a DIFFERENT title with different keywords.`
    : "";

  const systemPrompt = [
    "You are a friendly blog writer for a resumes and job search blog.",
    "You write original, helpful, practical articles in simple English.",
    "You always answer with clean HTML only.",
  ].join(" ");

  const userPrompt = [
    `Write one blog post about this topic: "${topic.title}"`,
    "",
    "Requirements:",
    "- 800 to 1200 words in total.",
    "- Start with a short intro of 2-3 sentences that explains the benefit.",
    "- Use at least four <h2> section headings and a few <h3> subheadings.",
    "- Give practical, specific tips with short real examples.",
    "- Use <ul> and <li> lists where they help, and <strong> for key words.",
    "- End with a short <h2> conclusion and 2-4 quick takeaways.",
    "- Friendly, simple English (like you are advising a friend). Short sentences.",
    "- No fluff, no fake statistics, no promises like 'guaranteed job'.",
    linkInstructions,
    titleInstruction,
    "",
    "Answer with the post TITLE on the very first line as plain text (no tags, no quotes),",
    "then the article HTML. Use only <p>, <h2>, <h3>, <ul>, <ol>, <li>, <strong>, <em>, <a> and <div> tags.",
    "Do NOT use <html>, <head>, <body>, <title>, <style>, <script> or markdown (no # or **).",
    "Do NOT wrap the answer in ``` code fences.",
  ]
    .filter(Boolean)
    .join("\n");

  const raw = await chat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    { temperature: 0.75, maxCompletionTokens: DEFAULT_MAX_COMPLETION_TOKENS },
  );

  const { title, html } = splitTitleAndHtml(raw);
  const words = countWords(html);

  // The model sometimes returns something too short. One more try is enough.
  if (words < 800 || words > 1200) {
    logWarn(`The post has ${words} words. Asking the model to fix the length...`);
    const secondTry = await chat(
      [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content:
            `${userPrompt}\n\nYour previous answer was only ${words} words long. ` +
            `Rewrite it with ${words < 800 ? "more detail" : "less detail"} so the total is between 900 and 1100 words.`,
        },
      ],
      { temperature: 0.75, maxCompletionTokens: DEFAULT_MAX_COMPLETION_TOKENS },
    );
    const retried = splitTitleAndHtml(secondTry);
    logInfo(`The fixed version has ${countWords(retried.html)} words.`);
    return { title: retried.title || title, html: retried.html || html };
  }

  logInfo(`The post is ${words} words long.`);
  return { title, html };
}

/** Splits "TITLE first line + HTML" into its two parts. */
function splitTitleAndHtml(raw: string): { title: string; html: string } {
  let answer = raw.trim();
  answer = answer.replace(/^```(?:html)?\s*/i, "").replace(/\s*```$/, "");

  let title = "";

  // The title is the first line when it is plain text (no tag on that line).
  const lines = answer.split("\n");
  if (lines.length > 1 && !lines[0].trim().startsWith("<")) {
    title = lines[0].trim().replace(/^["'#*\s]+|["'\s]+$/g, "");
    answer = lines.slice(1).join("\n");
  }

  const html = cleanAiHtml(answer);
  return { title, html };
}

/* ------------------------------------------------------------------------- */
/* 3. SEO title only (used when a title looks like an older one)              */
/* ------------------------------------------------------------------------- */

/** Asks the model for one fresh title that is not similar to an existing one. */
export async function generateAlternativeTitle(topic: Topic, existingTitles: string[]): Promise<string> {
  const raw = await chat(
    [
      {
        role: "system",
        content: "You write short, click-worthy, SEO friendly blog titles. You answer with one title only.",
      },
      {
        role: "user",
        content: [
          `Write ONE blog post title (60 characters or less) about: "${topic.title}".`,
          "It must be different from these titles and must not use the same main words:",
          ...existingTitles.slice(-40).map((title) => `- ${title}`),
          "",
          "Answer with the title only. No quotes, no explanation.",
        ].join("\n"),
      },
    ],
    { temperature: 0.9, maxCompletionTokens: 1_000 },
  );

  return raw
    .trim()
    .split("\n")[0]
    .replace(/^["'#*\s]+|["'\s]+$/g, "")
    .slice(0, 140);
}

/** True when the answer looks usable as a post body. */
export function isUsableHtml(html: string): boolean {
  return looksLikeHtml(html) && countWords(html) > 200;
}
