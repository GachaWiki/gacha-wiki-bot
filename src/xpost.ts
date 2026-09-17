// Posts wiki updates to X (Twitter) as @GachaJunkie888 via the v2 API and
// mirrors the posted tweet into the #x-feed Discord channel. Reading X is
// paywalled (free read paths — syndication, nitter, RSS bridges — are all
// dead as of 2026-09), so the bot publishes FIRST and mirrors its own posts;
// the channel topic stays literally true.
//
// Fully DORMANT until all four X_* secrets are set — absence is not an error.
// Signing is OAuth 1.0a (HMAC-SHA1, WebCrypto) with never-expiring Access
// Token + Secret from the developer portal's "Keys and tokens" tab.

import { postChannelMessage, type DiscordEmbed } from "./discord-rest";

/** X handle + API endpoint (api.x.com is the current canonical host). */
const X_HANDLE = "GachaJunkie888";
const TWEET_ENDPOINT = "https://api.x.com/2/tweets";

/** X brand blue for the mirror embed. */
const X_COLOR = 0x1d9bf0;

/** Env subset for X posting (all four secrets or nothing). */
export interface XPostEnv {
  DISCORD_TOKEN: string;
  /** Discord channel id of #x-feed (non-secret, wrangler.toml). */
  X_FEED_CHANNEL_ID?: string;
  X_API_KEY?: string;
  X_API_SECRET?: string;
  X_ACCESS_TOKEN?: string;
  X_ACCESS_SECRET?: string;
}

/** A successfully posted tweet. */
export interface PostedTweet {
  id: string;
  text: string;
}

/** True only when every X credential is present. */
export function xConfigured(env: XPostEnv): boolean {
  return Boolean(
    env.X_API_KEY && env.X_API_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_SECRET,
  );
}

// ---------------------------------------------------------------------------
// OAuth 1.0a signing (RFC 3986 percent-encoding, HMAC-SHA1 via WebCrypto)
// ---------------------------------------------------------------------------

/** RFC 3986 percent-encoding (encodeURIComponent misses !'()*). */
export function pct(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** Raw HMAC-SHA1, base64 — exported for signer tests. */
export async function hmacSha1B64(key: string, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(data),
  );
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

/**
 * Build the OAuth 1.0a signature base string. `extraParams` covers request
 * params (query/body-form); JSON bodies are NOT signed, which is why the v2
 * /2/tweets call passes none. Exported for signer tests.
 */
export function signatureBase(
  method: string,
  url: string,
  oauthParams: Record<string, string>,
  extraParams: Record<string, string> = {},
): string {
  const all: [string, string][] = [
    ...Object.entries(oauthParams),
    ...Object.entries(extraParams),
  ].map(([k, v]) => [pct(k), pct(v)] as [string, string]);
  // Sort by encoded key, then encoded value (OAuth 1.0a §3.4.1.3.2).
  all.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const paramString = all.map(([k, v]) => `${k}=${v}`).join("&");
  const baseUrl = url.split("?")[0]; // no query in our calls, but be correct
  return [method.toUpperCase(), pct(baseUrl), pct(paramString)].join("&");
}

/** Compose the signed Authorization header for a request. */
async function oauthHeader(
  env: XPostEnv,
  method: string,
  url: string,
): Promise<string> {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: env.X_API_KEY!,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: env.X_ACCESS_TOKEN!,
    oauth_version: "1.0",
  };
  const base = signatureBase(method, url, oauthParams);
  const signingKey = `${env.X_API_SECRET}&${env.X_ACCESS_SECRET}`;
  const signature = await hmacSha1B64(signingKey, base);
  const headerParams = { ...oauthParams, oauth_signature: signature };
  const header = Object.entries(headerParams)
    .map(([k, v]) => `${k}="${pct(v)}"`)
    .join(", ");
  return `OAuth ${header}`;
}

// ---------------------------------------------------------------------------
// Tweeting + mirroring
// ---------------------------------------------------------------------------

/**
 * Compose the wiki-update tweet. t.co wraps any URL to 23 chars for the
 * 280 limit; the bare domain is cheap and on-brand, so we keep it short.
 */
export function composeWikiTweet(subject: string, moreCount: number): string {
  const head = "📚 wiki update — ";
  const tail = "\ngachawiki.info";
  // URL counts as 23, emoji as 2: budget the subject so we never exceed 280.
  const budget = 280 - head.length - tail.length - 23 - 2 - (moreCount > 0 ? 20 : 0);
  let text = subject.length > budget ? subject.slice(0, budget - 1).trimEnd() + "…" : subject;
  if (moreCount > 0) text += ` (+${moreCount} more)`;
  return head + text + tail;
}

/** POST /2/tweets as the account. Returns the created tweet. */
export async function postTweet(env: XPostEnv, text: string): Promise<PostedTweet> {
  const auth = await oauthHeader(env, "POST", TWEET_ENDPOINT);
  let res: Response;
  try {
    res = await fetch(TWEET_ENDPOINT, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new Error(`x network: ${String(err)}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`x ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { data?: { id?: string; text?: string } };
  if (!data.data?.id) throw new Error("x: no tweet id in response");
  return { id: data.data.id, text: data.data.text ?? text };
}

/** #x-feed mirror embed for a posted tweet. */
export function tweetMirrorEmbed(tweet: PostedTweet): DiscordEmbed {
  return {
    author: { name: `@${X_HANDLE} on X` },
    url: `https://x.com/${X_HANDLE}/status/${tweet.id}`,
    description: tweet.text,
    color: X_COLOR,
    footer: { text: "posted by the GachaWiki bot" },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Tweet a wiki update and mirror it into #x-feed. Throws on X or Discord
 * failure — the caller decides how loud that should be (the #wiki-updates
 * embed has already been posted by then and must stay unaffected).
 */
export async function postWikiUpdateToX(
  env: XPostEnv,
  subject: string,
  moreCount: number,
): Promise<PostedTweet> {
  const tweet = await postTweet(env, composeWikiTweet(subject, moreCount));
  if (env.X_FEED_CHANNEL_ID) {
    await postChannelMessage(env.DISCORD_TOKEN, env.X_FEED_CHANNEL_ID, {
      embeds: [tweetMirrorEmbed(tweet)],
    });
  }
  return tweet;
}
