/**
 * Main script: writes one post and publishes it to Blogger.
 *
 * Order of work:
 *   1. Read topics.json and state.json.
 *   2. Refill the topic queue with 50 new AI ideas if fewer than 20 are unused.
 *   3. Take the next unused topic.
 *   4. Write the post with Groq (800-1200 words, clean HTML).
 *   5. Check the WEBSITE_URL link rule for this post number.
 *   6. Publish to Blogger (draft or live).
 *   7. Only after a successful publish: save topics.json and state.json.
 *
 * If any step fails, nothing is written and the process exits with code 1,
 * so the GitHub Action shows a red cross.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { OUT_DIR, loadConfig } from "./config.js";
import {
  NEW_TOPICS_PER_BATCH,
  findSimilarTitle,
  generateAlternativeTitle,
  generateNewTopics,
  generatePost,
  isUsableHtml,
} from "./ai.js";
import {
  buildLabels,
  cleanAiHtml,
  countWords,
  ensureWebsiteLink,
  hasWebsiteAnchor,
  logWarnings,
  pickCtaText,
  removeWebsiteLink,
  reviewHtml,
} from "./html.js";
import { getAccessToken, publishPost } from "./blogger.js";
import {
  allTopicTitles,
  appendTopics,
  countUnused,
  markTopicUsed,
  pickNextTopic,
  readState,
  readTopics,
  writeState,
  writeTopics,
} from "./store.js";
import { addToJobSummary, logError, logInfo, logStep, logWarn } from "./log.js";
import type { State } from "./types.js";

/** When fewer than this many unused topics are left, we generate new ones. */
const MIN_UNUSED_TOPICS = 20;

async function main(): Promise<void> {
  const config = loadConfig();

  logStep("Starting run.");
  logInfo(`Mode: ${config.dryRun ? "DRY RUN (preview only)" : config.draftMode ? "DRAFT" : "LIVE"}`);

  // ---------------------------------------------------------------- topics
  let topics = await readTopics();
  const state: State = await readState();

  const unused = countUnused(topics);
  logInfo(`Unused topics: ${unused}. Posts published so far: ${state.postCount}.`);

  // Titles we must never repeat: every topic we have, plus what we published.
  const knownTitles = [...allTopicTitles(topics), ...state.publishedTitles];

  if (unused < MIN_UNUSED_TOPICS) {
    logStep(`Only ${unused} unused topics left, so we generate ${NEW_TOPICS_PER_BATCH} new ideas.`);
    const newTitles = await generateNewTopics(knownTitles, NEW_TOPICS_PER_BATCH);

    if (newTitles.length === 0) {
      throw new Error("The AI did not return any usable new topics.");
    }

    topics = appendTopics(topics, newTitles);
    logInfo(`Topic queue now has ${countUnused(topics)} unused topics.`);

    if (config.dryRun) {
      logWarn("Dry run: the new topics are kept in memory only and topics.json is not changed.");
    }
  }

  const topic = pickNextTopic(topics);
  if (!topic) throw new Error("There is no unused topic left. Add topics to topics.json.");

  // ------------------------------------------------------------------ post
  // Even post numbers (0, 2, 4, ...) are "link posts": they carry the website
  // link, so the promotion appears on every second post.
  const isLinkPost = state.postCount % 2 === 0;
  const cta = pickCtaText(state.postCount);
  logStep(isLinkPost ? "This post will include the website link." : "This post will NOT include the website link.");

  const post = await generatePost({ topic });

  if (!isUsableHtml(post.html)) {
    throw new Error("The AI answer was not usable HTML. Nothing was published.");
  }

  // The title must be there, and it must not look like an older post.
  let title = post.title.trim();
  if (title === "") {
    logWarn("The AI did not give a title. Asking the model for a fresh one.");
    title = await generateAlternativeTitle(topic, allTopicTitles(topics));
  }

  const duplicate = findSimilarTitle(title, state.publishedTitles);
  if (duplicate) {
    logWarn(`The title "${title}" is too similar to an older post ("${duplicate}"). Asking for a new title.`);
    title = await generateAlternativeTitle(topic, [...state.publishedTitles, ...allTopicTitles(topics)]);
  }

  // A helpful warning when the title is close to a topic we have not written about yet.
  const otherTopicTitles = allTopicTitles(topics.filter((item) => item.id !== topic.id));
  if (findSimilarTitle(title, otherTopicTitles)) {
    logWarn("This title is close to another topic in the list. Watch out for a similar post later.");
  }
  logInfo(`Title: ${title}`);
  if (isLinkPost) logInfo(`Link anchor text for this post: ${cta.anchorText}`);

  // --------------------------------------------------------- link handling
  // The model never writes a link, but we normalise the HTML anyway: any link
  // to our website is removed first, then we add our own tip + CTA box on the
  // posts that are supposed to carry the link.
  let html = removeWebsiteLink(cleanAiHtml(post.html), config.websiteUrl);
  if (isLinkPost) {
    html = ensureWebsiteLink(html, config.websiteUrl, cta.anchorText);
  }

  // Final safety check: the link must be there on link posts and gone on the rest.
  if (isLinkPost && !hasWebsiteAnchor(html, config.websiteUrl)) {
    // Add our own tip + CTA box once more, then give up if it is still missing.
    html = ensureWebsiteLink(html, config.websiteUrl, cta.anchorText);
    if (!hasWebsiteAnchor(html, config.websiteUrl)) {
      throw new Error("The required WEBSITE_URL link is missing from a link post. Nothing was published.");
    }
  }

  const linkPresent = hasWebsiteAnchor(html, config.websiteUrl);
  if (!isLinkPost && linkPresent) {
    throw new Error("A non-link post still contains the WEBSITE_URL link. Nothing was published.");
  }

  logInfo(`Website link on this post: ${linkPresent ? "yes" : "no"}.`);
  logInfo(`Words: ${countWords(html)}. Labels: ${buildLabels(title).join(", ")}.`);
  logWarnings(reviewHtml(html));

  // -------------------------------------------------------------- dry run
  if (config.dryRun) {
    await savePreview(title, html, isLinkPost);
    logStep("Dry run finished. No Blogger call was made and no state file was changed.");
    addToJobSummary(`### Dry run\n- Title: ${title}\n- Preview: \`out/preview.html\` (not committed)`);
    return;
  }

  // -------------------------------------------------------------- publish
  const accessToken = await getAccessToken({
    clientId: config.googleClientId as string,
    clientSecret: config.googleClientSecret as string,
    refreshToken: config.googleRefreshToken as string,
  });

  const published = await publishPost({
    blogId: config.bloggerBlogId as string,
    accessToken,
    title,
    html,
    labels: buildLabels(title),
    isDraft: config.draftMode,
  });

  // ------------------------------------------------- state files (last!)
  // Only now, after Blogger accepted the post, do we remember it.
  markTopicUsed(topics, topic.id);
  await writeTopics(topics);

  const newState: State = {
    postCount: state.postCount + 1,
    publishedTitles: [...state.publishedTitles, title],
    lastPublishedAt: new Date().toISOString(),
    lastPublishedUrl: published.url,
  };
  await writeState(newState);

  logStep(config.draftMode ? "Saved as a Blogger draft." : "Published live on Blogger.");
  logInfo(`Post id: ${published.id || "unknown"}. postCount is now ${newState.postCount}.`);

  addToJobSummary(
    [
      `### ${config.draftMode ? "Draft" : "Published"} post`,
      `- Title: ${title}`,
      `- Topic: ${topic.title}`,
      `- Website link: ${isLinkPost ? "yes" : "no"}`,
      `- Words: ${countWords(html)}`,
      `- Post count: ${newState.postCount}`,
    ].join("\n"),
  );
}

/**
 * DRY_RUN: saves a nice standalone preview file so you can open it in a browser.
 * The out/ folder is gitignored.
 */
async function savePreview(title: string, html: string, isLinkPost: boolean): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const previewPath = path.join(OUT_DIR, "preview.html");

  const document = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} (preview)</title>
<style>
  body { font-family: Georgia, serif; max-width: 720px; margin: 40px auto; padding: 0 16px; line-height: 1.7; color: #1b1b1b; }
  h1 { font-size: 30px; line-height: 1.3; }
  .note { background: #f4f8ff; border: 1px solid #d9e2f2; padding: 12px 16px; font-family: system-ui, sans-serif; font-size: 14px; }
  a { color: #2a6ef4; }
</style>
</head>
<body>
<p class="note"><strong>DRY RUN preview.</strong> Website link on this post: ${isLinkPost ? "yes" : "no"}. Nothing was published and no state file was changed.</p>
<h1>${escapeHtml(title)}</h1>
${html}
</body>
</html>
`;

  await writeFile(previewPath, document, "utf8");
  logInfo(`Preview written to: ${previewPath}`);
}

/** Makes text safe to put inside an HTML file we generate ourselves. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Runs the program and turns any error into a red, non-zero exit. */
main()
  .then(() => {
    logStep("Done.");
  })
  .catch((error: unknown) => {
    logError(error instanceof Error ? error.message : String(error));
    logError("Nothing was published and topics.json / state.json were not changed.");
    // Non-zero exit code makes the GitHub Action fail (red cross).
    process.exit(1);
  });
