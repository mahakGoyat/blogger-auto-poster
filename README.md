# Blogger Auto Poster

This project writes one helpful blog post about **resumes and job applications** every day
and publishes it to your Google Blogger blog automatically.

- It runs on GitHub Actions, three times a day.
- Every run publishes **exactly one** post.
- The AI model (Groq, `openai/gpt-oss-120b`) writes an original 800-1200 word article.
- Nothing is published twice: the script remembers every topic and every title it used.

---

## 1. What you need before you start

| What | Where to get it |
| --- | --- |
| A Google Blogger blog | [blogger.com](https://www.blogger.com) |
| A Groq API key | [console.groq.com/keys](https://console.groq.com/keys) |
| A Pixabay API key (for the cover image) | [pixabay.com/api/docs](https://pixabay.com/api/docs) |
| A Google OAuth client (type **Desktop app**) | [Google Cloud console](https://console.cloud.google.com/apis/credentials) |
| Your blog ID | Blogger -> Settings -> Publishing -> **Blog ID** |
| Your website URL | The site you want to promote |

---

## 2. Install

You need [Node.js 20](https://nodejs.org) or newer.

```bash
git clone <your-repo-url>
cd blogger-auto-poster
npm install
```

---

## 3. Local setup (for testing)

1. Copy the example file. It only contains empty placeholders.

   ```bash
   cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
   ```

2. Open `.env` in a text editor and paste your own values. The file is gitignored, so it is
   never uploaded.

   ```
   GROQ_API_KEY=your-groq-key
   PIXABAY_API_KEY=your-pixabay-key
   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your-client-secret
   GOOGLE_REFRESH_TOKEN=your-refresh-token
   BLOGGER_BLOG_ID=1234567890123456789
   WEBSITE_URL=https://yoursite.com
   DRAFT_MODE=true
   ```

3. Run it. With `DRAFT_MODE=true` nothing is published: the post is saved as a draft in Blogger.

   ```bash
   npm run post
   ```

---

## 4. How to get the Google refresh token

You do this **once**. The refresh token lets the script publish without opening a browser.

1. Go to the [Google Cloud console](https://console.cloud.google.com/apis/credentials).
2. Create (or pick) a project and **enable the Blogger API**.
3. Click **Create credentials -> OAuth client ID**.
4. Choose application type **Desktop app** and create it.
5. Download the JSON file. It is called something like `client_secret_123456789.json`.
   **Keep that file outside this repo** (for example in your Downloads folder).
6. Run the helper and pass the file path:

   ```bash
   npm run get-token -- "C:/Users/you/Downloads/client_secret_123456789.json"
   ```

7. Your browser opens the Google consent page. Choose your account and click **Allow**.
8. The helper prints three values in your terminal:

   ```
   GOOGLE_CLIENT_ID     = ...
   GOOGLE_CLIENT_SECRET = ...
   GOOGLE_REFRESH_TOKEN = ...
   ```

The helper never saves anything to a file, so copy the values somewhere safe (a password
manager) and then close the terminal.

> If Google ever stops accepting the token, run this command again. You can also revoke access
> at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

---

## 5. GitHub setup

Push this project to a GitHub repository, then add the values under
**Settings -> Secrets and variables -> Actions**.

### Secrets (private, green "New repository secret" button)

| Secret | Value |
| --- | --- |
| `GROQ_API_KEY` | your Groq API key |
| `PIXABAY_API_KEY` | your Pixabay API key (optional, for the cover image) |
| `GOOGLE_CLIENT_ID` | from the helper |
| `GOOGLE_CLIENT_SECRET` | from the helper |
| `GOOGLE_REFRESH_TOKEN` | from the helper |
| `BLOGGER_BLOG_ID` | your Blogger blog ID |

### Variables (not secret, "New repository variable" button)

| Variable | Value |
| --- | --- |
| `WEBSITE_URL` | your website, for example `https://yoursite.com` (no trailing slash) |
| `DRAFT_MODE` | `true` while you are testing, `false` when you want live posts. Also applies to manual runs that leave `draft` empty. |
| `GROQ_PRIMARY_MODEL` | optional, default `openai/gpt-oss-120b` |
| `GROQ_FALLBACK_MODEL` | optional, default `openai/gpt-oss-20b` |

The workflow passes these straight to the process as environment variables, so no secret is ever
written to a file inside the runner.

---

## 6. Test before going live

### a) Dry run (no Blogger at all)

`DRY_RUN=true` writes the post to `out/preview.html` and stops. It needs **only**
`GROQ_API_KEY` and `WEBSITE_URL`. Blogger is not called and `topics.json` / `state.json`
are not changed.

```bash
npm run dry-run
```

Then open `out/preview.html` in your browser to read the post. The `out/` folder is gitignored.

### b) Manual workflow run (draft)

1. Go to the **Actions** tab -> **Daily Blog Post** -> **Run workflow**.
2. Leave `draft` empty (it then follows the `DRAFT_MODE` repository variable), or type
   `true` for a draft or `false` for a live post, then click the green button.
3. Watch the log. When it finishes you should see "Saved as a Blogger draft."
4. Open your Blogger dashboard: the new post is in **Drafts**.

---

## 7. Switch from draft mode to live mode

There are two ways:

- **For all runs:** change the GitHub variable `DRAFT_MODE` from `true` to `false`.
  This covers the scheduled runs and any manual run where `draft` is left empty.
  Locally, change it in your `.env` file.
- **For one run only:** start a manual workflow run and set `draft` to `false`.
  An explicit `draft` value always beats the `DRAFT_MODE` variable; if both are
  empty, the post is saved as a draft.

Before going live, check a few drafts so you are happy with the style, the length and the links.

---

## 8. How often does it run?

The workflow uses these cron times (GitHub runners use UTC, these are IST times):

| Cron | Time in India | Time in UTC |
| --- | --- | --- |
| `30 3 * * *` | 09:00 | 03:30 |
| `30 7 * * *` | 13:00 | 07:30 |
| `30 12 * * *` | 18:00 | 12:30 |

`concurrency` makes sure two runs never overlap, and `permissions: contents: write` lets the
workflow commit `topics.json` and `state.json` after a successful publish (only if they changed,
using the `github-actions[bot]` identity).

---

## 9. How topics and the website link work

- `topics.json` holds 120 resume and job-application topics. Each run takes the first unused one.
- When fewer than 20 unused topics are left, the script asks the AI for **50 new, different**
  topics and adds them to the list. New titles that are too similar to an old one are dropped.
- `state.json` remembers `postCount` and every published title, so titles never repeat.

### The website link appears on every second post

- On posts where `postCount` is even (0, 2, 4, ...) the article gets:
  1. a short **mid-article tip** about checking your resume's ATS score for free, and
  2. a **closing call-to-action box** with a real clickable link to `WEBSITE_URL`.
- On the other posts there is no link at all.
- The anchor text rotates, so the same sentence does not appear on every link post.
- The code checks the link before publishing: the link **must** be there on link posts and
  **must not** be there on the others, otherwise the run fails without publishing anything.

---

## 10. Cover images (Pixabay)

Every post starts with one cover photo, added by `src/images.ts`:

1. The AI reads the post title and writes a short image search query (2-4 words, something a photo
   can really show, for example `person writing resume` or `job interview office`). If the AI
   cannot help, the script uses `resume job interview`.
2. Pixabay is searched for a horizontal, safe-searched photo of at least 1000px wide.
3. The first photo whose id is **not** in `state.json` -> `usedImageIds` is used, so images never
   repeat. The id is only added after Blogger accepts the post.
4. The photo is inserted at the very top of the post, because Blogger uses the first image of a
   post as its thumbnail, with a short credit line ("Image by ... from Pixabay").

Two things worth knowing:

- **24 hour cache**: Pixabay asks that the same search is not repeated more than once a day, so
  search results are cached in memory for 24 hours.
- **Image hosting**: right now the script links to Pixabay's own image file. Pixabay says those
  URLs are only guaranteed to work for about **24 hours**, so old posts may lose their picture
  later. If we ever want permanent images, the fix is small: download the photo and host it
  ourselves. Only the `buildImageUrl()` function in `src/images.ts` needs to change - nothing else.
- The image is **never** a reason for a run to fail. A missing key, no results or an API error only
  prints a warning, and the post is published without an image.

---

## 11. What happens when something goes wrong?

- Rate limits (HTTP 429) and temporary errors are retried up to 3 times with exponential backoff.
- If the main model still fails, the script tries the fallback model `openai/gpt-oss-20b`.
- If that fails too, the run stops with a clear error.
- **HTTP 404** usually means the model was retired or renamed by Groq. The error message names the
  model and tells you to check <https://console.groq.com/docs/models>.
- `topics.json` and `state.json` are only changed **after** Blogger accepts the post, so a failed
  run simply retries the same topic next time.
- The script exits with a non-zero code, so the GitHub Action shows a red cross.

### Changing the AI model

The model names are read from environment variables, so a future deprecation needs no code change:

| Variable | Default |
| --- | --- |
| `GROQ_PRIMARY_MODEL` | `openai/gpt-oss-120b` |
| `GROQ_FALLBACK_MODEL` | `openai/gpt-oss-20b` |
| `GROQ_REASONING_EFFORT` | `low` |

Both models are reasoning models, so they use part of their token budget thinking before they
write. That is why the script asks for `max_completion_tokens: 6000` (otherwise the article gets cut
short) and only uses `choices[0].message.content`, never the model's `reasoning` notes.

Set the new name in your `.env` file locally, or as a GitHub **Variable** on the Actions page.

---

## 12. Files in this project

| File | What it does |
| --- | --- |
| `src/index.ts` | Main script: picks a topic, writes the post, publishes it, saves state. |
| `src/config.ts` | Loads and checks environment variables (never prints secrets). |
| `src/ai.ts` | Talks to Groq: new topics, the article, the SEO title. Retries and fallback model. |
| `src/html.ts` | Cleans the AI HTML, adds and checks the website link, builds labels. |
| `src/blogger.ts` | Google token exchange and the Blogger "create post" call. |
| `src/images.ts` | Pixabay cover image: AI search query, photo pick, credit line, 24h cache. |
| `src/store.ts` | Reads and writes `topics.json` and `state.json`. |
| `src/log.ts` | Small logging helpers. |
| `src/types.ts` | TypeScript types. |
| `scripts/get-refresh-token.ts` | One-time Google sign-in helper that prints your tokens. |
| `topics.json` | 120 blog post ideas. |
| `state.json` | Post counter and the list of published titles. |
| `.github/workflows/daily-post.yml` | The workflow that runs three times a day. |

---

## 13. Safety notes

- All secrets come from environment variables only. They are never written to a file and never
  logged.
- `.env` and Google credential JSON files are in `.gitignore`.
- `.env.example` has empty placeholder names only.
