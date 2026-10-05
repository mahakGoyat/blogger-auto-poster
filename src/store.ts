/**
 * Reading and writing topics.json and state.json.
 *
 * topics.json  = the list of post ideas (a big queue of topics)
 * state.json   = what we already published (count + titles)
 *
 * IMPORTANT: these two files are only written AFTER a post was published
 * successfully. If anything fails, the files stay exactly as they were and
 * the same topic is used again on the next run.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ROOT_DIR } from "./config.js";
import type { State, Topic } from "./types.js";

const TOPICS_FILE = path.join(ROOT_DIR, "topics.json");
const STATE_FILE = path.join(ROOT_DIR, "state.json");

/** Reads topics.json from disk. */
export async function readTopics(): Promise<Topic[]> {
  const raw = await readFile(TOPICS_FILE, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("topics.json must contain a JSON array.");
  return parsed as Topic[];
}

/** Writes topics.json back to disk with 2-space indentation. */
export async function writeTopics(topics: Topic[]): Promise<void> {
  await writeFile(TOPICS_FILE, `${JSON.stringify(topics, null, 2)}\n`, "utf8");
}

/** Reads state.json from disk. Missing file starts a fresh state. */
export async function readState(): Promise<State> {
  const empty: State = {
    postCount: 0,
    publishedTitles: [],
    lastPublishedAt: null,
    lastPublishedUrl: null,
    usedImageIds: [],
  };

  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      postCount: Number(parsed.postCount) || 0,
      publishedTitles: Array.isArray(parsed.publishedTitles) ? parsed.publishedTitles : [],
      lastPublishedAt: parsed.lastPublishedAt ?? null,
      lastPublishedUrl: parsed.lastPublishedUrl ?? null,
      // Older state.json files have no image list yet, so default to empty.
      usedImageIds: Array.isArray(parsed.usedImageIds) ? (parsed.usedImageIds as number[]) : [],
    };
  } catch {
    return empty;
  }
}

/** Writes state.json back to disk with 2-space indentation. */
export async function writeState(state: State): Promise<void> {
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** Counts topics that have not been used yet. */
export function countUnused(topics: Topic[]): number {
  return topics.filter((topic) => topic.used !== true).length;
}

/** Returns the first unused topic, or null when the list is empty. */
export function pickNextTopic(topics: Topic[]): Topic | null {
  return topics.find((topic) => topic.used !== true) ?? null;
}

/** Every topic title we already have, used for duplicate checking. */
export function allTopicTitles(topics: Topic[]): string[] {
  return topics.map((topic) => topic.title);
}

/**
 * Marks a topic as used (only called after a successful publish).
 * Returns true when the topic was found and updated.
 */
export function markTopicUsed(topics: Topic[], topicId: string): boolean {
  const topic = topics.find((item) => item.id === topicId);
  if (!topic) return false;
  topic.used = true;
  return true;
}

/**
 * Adds new topics to the end of the list and gives each one a fresh id.
 * The id continues after the highest existing number, so ids stay unique.
 */
export function appendTopics(topics: Topic[], titles: string[]): Topic[] {
  const highestId = topics.reduce((highest, topic) => {
    const number = Number(String(topic.id).replace(/\D/g, ""));
    return Number.isFinite(number) && number > highest ? number : highest;
  }, 0);

  const added = titles.map((title, index) => ({
    id: `t${String(highestId + index + 1).padStart(3, "0")}`,
    title: title.trim(),
    used: false,
  }));

  return [...topics, ...added];
}
