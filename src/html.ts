/**
 * HTML helpers.
 *
 * These functions make sure the AI output is safe to publish:
 *  - remove markdown code fences and any <html>/<body> wrapper
 *  - count words so we can check the 800-1200 word limit
 *  - insert / verify / remove the WEBSITE_URL link (every 2nd post)
 *  - build 2-4 Blogger labels from the post title
 */
import { logInfo, logWarn } from "./log.js";

/**
 * Turns the raw model answer into clean HTML that Blogger can accept.
 *
 * Removes:
 *  - ```html ... ``` or ``` ... ``` code fences
 *  - a leading "Here is the HTML:" style preface
 *  - <html>, <head>, <body>, </body>, </html> tags (Blogger adds these itself)
 *  - markdown headings (## Title) that the model sometimes adds by mistake
 */
export function cleanAiHtml(raw: string): string {
  let html = raw.trim();

  // Remove a markdown code fence from the start and the end.
  html = html.replace(/^```[a-zA-Z]*\s*/, "");
  html = html.replace(/\s*```$/, "");

  // Remove a text preface that is not HTML (text before the first "<").
  const firstTag = html.indexOf("<");
  if (firstTag > 0) {
    const preface = html.slice(0, firstTag).trim();
    // A real markup preface would contain a tag, so anything else is prose.
    if (preface !== "" && !preface.includes("<")) html = html.slice(firstTag);
  }

  // Markdown headings -> real HTML headings.
  html = html.replace(/^#{2,3}\s+(.+)$/gm, (_match, text: string) => `<h2>${text.trim()}</h2>`);

  // Blogger does not want a full document, only the content part.
  html = html.replace(/<\/?(html|head|body|!doctype)[^>]*>/gi, "");
  html = html.replace(/<title[^>]*>[\s\S]*?<\/title>/gi, "");

  return html.trim();
}

/** Removes all HTML tags so we can count real words. */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Counts the words in the HTML body (tags are not counted). */
export function countWords(html: string): number {
  const text = stripHtml(html);
  return text === "" ? 0 : text.split(" ").length;
}

/** True when the text already contains real HTML block tags. */
export function looksLikeHtml(html: string): boolean {
  return /<(p|h2|h3|ul|ol|li)\b/i.test(html);
}

/** Different CTA sentences so the promotion never looks like the same ad twice. */
const CTA_SENTENCES = [
  "Want to know your resume's ATS score?",
  "Curious how your resume scores in an ATS?",
  "Not sure if your resume will pass an ATS?",
  "Want a free ATS score for your resume?",
];

/** Different anchor texts, so every link post has a different call to action. */
const CTA_ANCHOR_TEXTS = [
  "check your resume score free",
  "free ATS resume checker",
  "best website to check your resume score",
  "resume ATS score checker",
  "check your ATS score here",
  "free resume score test",
];

/**
 * Picks the CTA sentence and anchor text for one post.
 * The post number decides which one we use, so they rotate naturally.
 */
export function pickCtaText(postNumber: number): { sentence: string; anchorText: string } {
  return {
    sentence: CTA_SENTENCES[postNumber % CTA_SENTENCES.length],
    anchorText: CTA_ANCHOR_TEXTS[postNumber % CTA_ANCHOR_TEXTS.length],
  };
}

/** The short "helpful tip" box that sits in the middle of a link post. */
function buildMidArticleTip(websiteUrl: string, anchorText: string): string {
  return [
    '<div style="border-left:4px solid #2a6ef4;background:#f4f8ff;padding:14px 16px;margin:22px 0;">',
    "<p><strong>Quick tip:</strong> before you send this resume out, check your ATS score free on ",
    `<a href="${websiteUrl}" target="_blank" rel="noopener">${anchorText}</a>.`,
    " A free ATS check shows you if your resume is easy for an applicant tracking system to read, and which keywords are missing.</p>",
    "</div>",
  ].join("");
}

/** The closing call-to-action box of a link post. */
function buildCtaBox(websiteUrl: string, anchorText: string): string {
  return [
    '<div style="border:1px solid #d9e2f2;background:#fbfdff;padding:18px;margin:26px 0;text-align:center;">',
    "<p style=\"margin:0 0 8px 0;\"><strong>Want to know your resume's ATS score?</strong></p>",
    "<p style=\"margin:0;\">Check it free on ",
    `<a href="${websiteUrl}" target="_blank" rel="noopener">${anchorText}</a>.`,
    " It is free, takes less than a minute, and tells you exactly what to fix before you apply.</p>",
    "</div>",
  ].join("");
}

/** True when the HTML already has a real clickable link to our website. */
export function hasWebsiteAnchor(html: string, websiteUrl: string): boolean {
  // Match <a ... href="URL" ...> so a bare mention of the URL does not count.
  const escaped = websiteUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<a[^>]+href=["']${escaped}["']`, "i");
  return pattern.test(html);
}

/** Inserts a snippet before the given index (or appends when index is -1). */
function insertAt(html: string, index: number, snippet: string): string {
  if (index < 0) return `${html}\n${snippet}`;
  return `${html.slice(0, index)}\n${snippet}\n${html.slice(index)}`;
}

/** Style signature of our tip box, so we never add it twice. */
const TIP_MARKER = "border-left:4px solid #2a6ef4";
/** Style signature of our call-to-action box, so we never add it twice. */
const CTA_MARKER = "border:1px solid #d9e2f2";

/** Returns the character positions of every <h2> heading. */
function headingPositions(html: string): number[] {
  const positions: number[] = [];
  const pattern = /<h2\b[^>]*>/gi;
  let match = pattern.exec(html);
  while (match !== null) {
    positions.push(match.index);
    match = pattern.exec(html);
  }
  return positions;
}

/**
 * Finds a good spot for the mid-article tip: before the third <h2> when there
 * is one, otherwise after the first paragraph.
 */
function findMidArticlePosition(html: string): number {
  const positions = headingPositions(html);
  if (positions.length >= 3) return positions[2];

  // Fall back to just after the first closing </p>.
  const firstParagraphEnd = html.indexOf("</p>");
  return firstParagraphEnd > 0 ? firstParagraphEnd + 4 : -1;
}

/**
 * True when the link really sits in the middle of the article.
 * We ignore the last two headings, because a link in the closing lines
 * counts as the closing call-to-action, not as the mid-article tip.
 */
function hasMidArticleLink(html: string, websiteUrl: string): boolean {
  const positions = headingPositions(html);
  // Everything before the second-to-last heading is "the body of the article".
  const boundary = positions.length >= 3 ? positions[positions.length - 3] : html.length;
  return hasWebsiteAnchor(html.slice(0, boundary), websiteUrl);
}

/**
 * Makes sure a link post has BOTH required link parts:
 *  (a) a short mid-article tip linking to the website
 *  (b) a closing call-to-action box linking to the website
 *
 * Our own boxes are used so the wording stays consistent and the link really is
 * a clickable <a> tag. Calling this twice is safe: nothing is added twice.
 */
export function ensureWebsiteLink(html: string, websiteUrl: string, anchorText: string): string {
  let result = html;

  // (a) Mid-article tip.
  if (!hasMidArticleLink(result, websiteUrl) && !result.includes(TIP_MARKER)) {
    result = insertAt(result, findMidArticlePosition(result), buildMidArticleTip(websiteUrl, anchorText));
    logInfo("Added the mid-article tip with the website link.");
  }

  // (b) Closing call-to-action box: it must be the last part of the article.
  const tailStart = Math.max(result.lastIndexOf("</h2>"), 0);
  const tail = result.slice(tailStart);
  if (!result.includes(CTA_MARKER) && !hasWebsiteAnchor(tail, websiteUrl)) {
    result = `${result}\n${buildCtaBox(websiteUrl, anchorText)}`;
    logInfo("Added the closing call-to-action box.");
  }

  return result;
}

/**
 * Removes every link to our website. Used on the posts that must NOT have it,
 * so the every-2nd-post pattern stays clean.
 */
export function removeWebsiteLink(html: string, websiteUrl: string): string {
  const escaped = websiteUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let result = html;

  // 1. Remove our own tip and CTA boxes (recognised by their inline style).
  result = result.replace(/<div[^>]*border-left:4px solid #2a6ef4[\s\S]*?<\/div>/gi, "");
  result = result.replace(/<div[^>]*border:1px solid #d9e2f2[\s\S]*?<\/div>/gi, "");

  // 2. Unwrap any remaining anchor that points at our website (keep the text).
  result = result.replace(
    new RegExp(`<a[^>]+href=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/a>`, "gi"),
    "$1",
  );

  // 3. Remove a plain URL that was pasted in as text.
  result = result.replace(new RegExp(escaped, "gi"), "");

  return result.replace(/\n{3,}/g, "\n\n").trim();
}

/** Keyword map used to give each post 2-4 relevant Blogger labels. */
const LABEL_KEYWORDS: Array<[RegExp, string]> = [
  [/\bats\b|applicant tracking/i, "ATS"],
  [/cover letter/i, "Cover Letter"],
  [/linkedin/i, "LinkedIn"],
  [/interview/i, "Interview Tips"],
  [/fresher|no experience|career starter|first job|entry-level|entry level|beginner/i, "Fresher Jobs"],
  [/keyword/i, "Resume Keywords"],
  [/resume|cv/i, "Resume Tips"],
  [/job search|hiring|apply|application/i, "Job Search"],
  [/career change|switching industr|career gap/i, "Career Change"],
  [/salary|offer|negotiat/i, "Salary Negotiation"],
];

/** Words we never use as a label. */
const STOP_WORDS = new Set([
  "a", "an", "and", "the", "for", "to", "of", "in", "on", "at", "with", "your", "you",
  "how", "what", "why", "when", "is", "it", "its", "are", "do", "does", "can", "my",
  "after", "before", "from", "by", "as", "or", "if", "no", "not", "vs", "still", "use",
  "using", "get", "make", "write", "writing", "job", "jobs", "every", "really", "need",
  "that", "this", "them", "then", "than", "there", "here", "into", "from", "with",
  "gets", "get", "got", "know", "need", "want", "look", "looks", "look",
  // Adjectives and adverbs that make a label meaningless on their own.
  "good", "best", "better", "easy", "easier", "simple", "quick", "quickly", "fast",
  "right", "wrong", "real", "actual", "actually", "proper", "perfect", "great",
  // Words that make a label meaningless on their own.
  "duplicate", "title", "article", "blog", "post", "posts", "step", "steps", "guide",
  "tips", "mistakes", "things", "people", "noticed", "notice", "improve", "improves",
]);

/**
 * Builds 2-4 Blogger labels for a post from its title.
 * Always includes "Resume Tips" so the blog stays easy to browse.
 */
export function buildLabels(title: string): string[] {
  const labels: string[] = [];

  // 1. Preferred labels from our keyword map (most specific first).
  for (const [pattern, label] of LABEL_KEYWORDS) {
    if (labels.length >= 3) break;
    if (pattern.test(title) && !labels.includes(label)) labels.push(label);
  }

  // 2. Fill up with real words from the title if we still need more labels.
  if (labels.length < 2) {
    // Words already used inside the labels we picked, so we do not repeat them
    // (for example "Cover Letter" must not become "Cover Letter, Cover, Letter").
    const usedWords = new Set(
      labels
        .join(" ")
        .toLowerCase()
        .split(/\s+/),
    );

    const words = title
      .replace(/[^a-zA-Z\s]/g, " ")
      .split(/\s+/)
      .map((word) => word.trim().toLowerCase())
      .filter((word) => word.length > 3 && !STOP_WORDS.has(word) && !usedWords.has(word));

    for (const word of words) {
      if (labels.length >= 3) break;
      const label = word.charAt(0).toUpperCase() + word.slice(1);
      if (!labels.includes(label)) labels.push(label);
    }
  }

  // 3. Blogger allows at most a handful of labels, keep it safe.
  const finalLabels = labels.slice(0, 4);
  if (finalLabels.length < 2) finalLabels.push("Career Tips");
  return finalLabels;
}

/**
 * Main quality check for generated HTML.
 * Returns a list of warnings (empty means everything looks good).
 */
export function reviewHtml(html: string): string[] {
  const warnings: string[] = [];

  if (!looksLikeHtml(html)) warnings.push("Output does not look like HTML.");
  if (/<h2\b/i.test(html) === false) warnings.push("No H2 headings found.");
  if (countWords(html) < 800) warnings.push(`Only ${countWords(html)} words (target is 800-1200).`);
  if (countWords(html) > 1200) warnings.push(`${countWords(html)} words (target is 800-1200).`);
  if (/<script/i.test(html)) warnings.push("Output contains a <script> tag.");

  return warnings;
}

/** Prints warnings in a consistent way. */
export function logWarnings(warnings: string[]): void {
  for (const warning of warnings) logWarn(warning);
}
