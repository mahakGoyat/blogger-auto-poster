/**
 * One-time helper: gets a Google "refresh token" for the Blogger API.
 *
 * How it works:
 *   1. You pass the path to the Google OAuth client JSON you downloaded
 *      (a "Desktop app" client from the Google Cloud console).
 *   2. A small web server starts on http://127.0.0.1 on a free port.
 *   3. Your browser opens the Google consent page.
 *   4. After you click "Allow", Google sends the code back to our local server.
 *   5. We swap the code for tokens and print them in the terminal.
 *
 * SAFETY: the client JSON stays OUTSIDE this repo, nothing is written to disk,
 * and the values are only printed to your terminal. Copy them into GitHub
 * Secrets yourself.
 *
 * Usage:
 *   npm run get-token -- "C:/Users/me/Downloads/client_secret_123456.json"
 */
import http from "node:http";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** Only this permission is needed: create posts in your blog. */
const SCOPE = "https://www.googleapis.com/auth/blogger";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

interface OAuthClientFile {
  client_id?: string;
  client_secret?: string;
  installed?: { client_id?: string; client_secret?: string };
  web?: { client_id?: string; client_secret?: string };
}

/** Reads the client id / secret from the downloaded JSON (Desktop or Web app). */
async function readClientFile(filePath: string): Promise<{ clientId: string; clientSecret: string }> {
  const absolute = path.resolve(filePath);
  // Strip a possible BOM (Windows editors add one) so JSON.parse works.
  const raw = (await readFile(absolute, "utf8")).replace(/^\uFEFF/, "");

  let parsed: OAuthClientFile;
  try {
    parsed = JSON.parse(raw) as OAuthClientFile;
  } catch {
    throw new Error(`That file is not valid JSON: ${absolute}`);
  }

  // Google puts the values inside "installed" for Desktop apps and "web" for web apps.
  const clientId = parsed.client_id ?? parsed.installed?.client_id ?? parsed.web?.client_id;
  const clientSecret = parsed.client_secret ?? parsed.installed?.client_secret ?? parsed.web?.client_secret;

  if (!clientId || !clientSecret) {
    throw new Error("No client_id / client_secret found in that file. Download an OAuth client of type \"Desktop app\".");
  }

  return { clientId, clientSecret };
}

/**
 * Opens a URL in the default browser.
 *
 * On Windows we must NOT use cmd's "start", because cmd treats "&" inside the
 * URL as a command separator and cuts the URL in half (Google then complains
 * that response_type is missing). PowerShell's Start-Process with the URL in
 * single quotes keeps the whole URL intact.
 */
function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      // A single quote inside the URL would end the string early, so double it.
      const safeUrl = url.replace(/'/g, "''");
      const command = `Start-Process '${safeUrl}'`;
      spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
        stdio: "ignore",
        detached: true,
      }).unref();
      return;
    }

    const command = process.platform === "darwin" ? "open" : "xdg-open";
    // No shell here, so the URL is passed to the program untouched.
    spawn(command, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // The full URL is always printed in the terminal, so nothing is lost.
  }
}

/**
 * Creates the PKCE pair used for a safer sign-in.
 *
 * code_verifier  = a random secret we keep here and send with the token request.
 * code_challenge = SHA256(code_verifier), which we send in the browser URL.
 * Google checks that they match, so an intercepted code cannot be used.
 */
function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

/**
 * Builds the Google consent URL.
 *
 * URLSearchParams does the encoding for us, so nothing gets lost or double
 * escaped. Google needs all of these:
 *   client_id, redirect_uri, response_type, scope, access_type, prompt
 */
function buildAuthorizationUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline", // this is what gives us a refresh token
    prompt: "consent", // always ask, so we always get a refresh token
    include_granted_scopes: "true",
    state: options.state, // protects against fake callbacks
    code_challenge: options.codeChallenge, // PKCE
    code_challenge_method: "S256", // PKCE
  });

  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/**
 * Prints the parameter NAMES (never their values) so you can check that
 * nothing is missing. Some safe values are shown too, they are not secrets.
 */
function printAuthUrlDebug(authUrl: string): void {
  const params = new URL(authUrl).searchParams;
  const names = [...params.keys()];

  console.log("Authorization URL parameters (names only):");
  for (const name of names) console.log(`  - ${name}`);

  const required = [
    "client_id",
    "redirect_uri",
    "response_type",
    "scope",
    "access_type",
    "prompt",
    "code_challenge",
    "code_challenge_method",
  ];
  const missing = required.filter((name) => !params.has(name));
  console.log(
    missing.length === 0
      ? "  All required parameters are present.\n"
      : `  MISSING: ${missing.join(", ")}\n`,
  );

  // These values are not secret, so showing them helps to spot a wrong URL.
  console.log("  response_type =", params.get("response_type"));
  console.log("  scope          =", params.get("scope"));
  console.log("  access_type    =", params.get("access_type"));
  console.log("  prompt         =", params.get("prompt"));
  console.log("  redirect_uri   =", params.get("redirect_uri"));
  console.log("");
}

/** Sends one small HTML page to the browser and closes the server. */
function sendPage(response: http.ServerResponse, status: number, title: string, message: string): void {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  response.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
      `<body style="font-family:system-ui;max-width:600px;margin:80px auto;text-align:center">` +
      `<h1>${title}</h1><p>${message}</p>` +
      `<p style="color:#666">You can close this tab now.</p></body></html>`,
  );
}

async function main(): Promise<void> {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: npm run get-token -- <path to client_secret_xxx.json>");
    console.error("Download a Google OAuth client of type \"Desktop app\" first.");
    process.exit(1);
  }

  const { clientId, clientSecret } = await readClientFile(filePath);

  // A random value that we check later, so nobody can send us a fake code.
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);

  // Ask the OS for a free port by listening on port 0.
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not start the local server.");
  }
  const redirectUri = `http://127.0.0.1:${address.port}`;

  // PKCE: we keep the verifier and send the challenge in the browser URL.
  const { codeVerifier, codeChallenge } = createPkcePair();

  const authUrl = buildAuthorizationUrl({ clientId, redirectUri, state, codeChallenge });

  console.log("\nGoogle sign-in helper");
  console.log("--------------------");
  console.log("1. Your browser will open the Google consent page.");
  console.log("2. Choose your Google account and click \"Allow\".");
  console.log("3. The tokens will be printed here in the terminal.\n");

  // Show what we are sending (names, not secret values).
  printAuthUrlDebug(authUrl);

  // The full URL is always printed, so you can copy-paste it into a browser
  // yourself if the automatic open fails.
  console.log("If the browser does not open, copy this whole line into your browser:");
  console.log("");
  console.log(authUrl);
  console.log("");

  openBrowser(authUrl);

  // Wait for Google to redirect back with ?code=... (or an error).
  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Timed out after 10 minutes. Please run the command again."));
    }, 10 * 60 * 1000);

    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", redirectUri);
      const params = url.searchParams;

      // The browser asks for /favicon.ico: just ignore it.
      if (!params.has("code") && !params.has("error")) {
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end("Waiting for the Google sign-in...");
        return;
      }

      clearTimeout(timer);
      server.close();

      if (params.get("error")) {
        sendPage(response, 400, "Sign-in failed", `Google said: ${params.get("error")}.`);
        reject(new Error(`Google returned an error: ${params.get("error")}`));
        return;
      }

      if (params.get("state") !== state) {
        sendPage(response, 400, "Sign-in failed", "The security check failed. Please try again.");
        reject(new Error("The OAuth state did not match. Please try again."));
        return;
      }

      sendPage(response, 200, "All done", "Your tokens were printed in the terminal.");
      resolve(params.get("code") as string);
    });
  });

  // Step 2: exchange the code for tokens.
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier, // PKCE: proves this is our sign-in
    }),
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed (HTTP ${response.status}). Try the command again.`);
  }

  const tokens = (await response.json()) as { refresh_token?: string; access_token?: string };

  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not send a refresh token. Revoke the app's access at " +
        "https://myaccount.google.com/permissions and run the command again.",
    );
  }

  // Print to the terminal only. Nothing is saved to any file.
  console.log("\n============================================================");
  console.log(" COPY THESE VALUES INTO YOUR GITHUB SECRETS");
  console.log("============================================================");
  console.log(`GOOGLE_CLIENT_ID     = ${clientId}`);
  console.log(`GOOGLE_CLIENT_SECRET = ${clientSecret}`);
  console.log(`GOOGLE_REFRESH_TOKEN = ${tokens.refresh_token}`);
  console.log("============================================================");
  console.log("\nAlso add BLOGGER_BLOG_ID (Settings -> Publishing on blogger.com) and");
  console.log("the variable WEBSITE_URL in your GitHub repository settings.");
  console.log("\nKeep these values private. Close this window when you are done.\n");

  // The access token is short-lived and not needed, so we do not print it.
}

main().catch((error: unknown) => {
  console.error(`\nERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
