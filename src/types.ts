/**
 * Shared TypeScript types for the whole project.
 *
 * Keep this file small: it only describes the shape of our data,
 * nothing else.
 */

/** One idea for a future blog post, stored in topics.json. */
export interface Topic {
  /** Stable id such as "t001". Never reused. */
  id: string;
  /** The angle / idea of the post. */
  title: string;
  /** True once a post was successfully published for this topic. */
  used: boolean;
}

/** Everything we remember between runs. Stored in state.json. */
export interface State {
  /** Number of posts we have published so far (drafts included). */
  postCount: number;
  /** SEO titles of every published post, used to avoid duplicates. */
  publishedTitles: string[];
  /** ISO date/time of the last successful publish, or null. */
  lastPublishedAt: string | null;
  /** Link to the last published Blogger post, or null. */
  lastPublishedUrl: string | null;
  /** Pixabay photo ids already used, so cover images never repeat. */
  usedImageIds: number[];
}

/** The values the program needs. Built by src/config.ts from env variables. */
export interface Config {
  groqApiKey: string;
  websiteUrl: string;
  /** "true" saves posts as Blogger drafts, "false" publishes them live. */
  draftMode: boolean;
  /** "true" generates a preview only: no Blogger call, no state changes. */
  dryRun: boolean;
  /**
   * Optional Pixabay key. When it is missing we only warn and publish the post
   * without a cover image, so a run never fails because of the image.
   */
  pixabayApiKey?: string;
  /** Only needed when we actually publish (not in dry-run mode). */
  googleClientId?: string;
  googleClientSecret?: string;
  googleRefreshToken?: string;
  bloggerBlogId?: string;
}
