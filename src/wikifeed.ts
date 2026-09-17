// GitHub webhook receiver: mirrors pushes to the gacha-wiki repo into the
// #wiki-updates Discord channel so the community sees the wiki is alive.
// Signature is verified against GITHUB_WEBHOOK_SECRET (HMAC-SHA256 over the
// raw body, per GitHub's x-hub-signature-256 scheme) before anything posts.

import { postChannelMessage, type DiscordEmbed } from "./discord-rest";
import { postWikiUpdateToX, xConfigured } from "./xpost";

/** Subset of the env the wiki feed needs. */
export interface WikiFeedEnv {
  DISCORD_TOKEN: string;
  /** Discord channel id for wiki commit updates. Empty/missing = disabled. */
  WIKI_UPDATES_CHANNEL_ID?: string;
  /** Shared secret configured on the GitHub webhook (wrangler secret). */
  GITHUB_WEBHOOK_SECRET?: string;
  /** X posting (all four secrets or the feature stays dormant). */
  X_FEED_CHANNEL_ID?: string;
  X_API_KEY?: string;
  X_API_SECRET?: string;
  X_ACCESS_TOKEN?: string;
  X_ACCESS_SECRET?: string;
}

/** Subset of the GitHub push payload we render. */
interface GithubPush {
  ref: string;
  /** Full push comparison URL (before...after). */
  compare: string;
  repository: { full_name: string; default_branch?: string };
  pusher: { name?: string };
  commits: GithubCommit[];
}

interface GithubCommit {
  id: string;
  message: string;
  url: string;
  author: { name?: string; username?: string } | null;
  added?: string[];
  removed?: string[];
  modified?: string[];
}

/** Embed accent for wiki updates (blue — distinct from buy/sell/burn/mint). */
const WIKI_COLOR = 0x3498db;

/** Max commits listed per embed; longer pushes truncate with "+N more". */
const MAX_COMMITS = 8;

/** Escape Discord markdown so commit messages can't accidentally format. */
function esc(text: string): string {
  return text.replace(/([\\`*_~])/g, "\\$1");
}

/** First line of a commit message (the convention is subject + blank + body). */
function subject(message: string): string {
  return message.split("\n")[0].trim();
}

/**
 * Verify GitHub's x-hub-signature-256 header: HMAC-SHA256 of the raw body
 * keyed with the shared secret. Constant-time compare on the hex digests.
 */
async function verifySignature(
  rawBody: string,
  header: string | null,
  secret: string,
): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody),
  );
  const expected = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const given = header.slice("sha256=".length);
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/** Build the push embed (exported for local testing with real payloads). */
export function formatPushEmbed(push: GithubPush): DiscordEmbed {
  const shown = push.commits.slice(0, MAX_COMMITS);
  const hidden = push.commits.length - shown.length;
  const lines = shown.map((c) => {
    const who = c.author?.username ?? c.author?.name ?? push.pusher.name ?? "?";
    return `- [\`${c.id.slice(0, 7)}\`](${c.url}) ${esc(subject(c.message))} — *${who}*`;
  });
  if (hidden > 0) lines.push(`*…and ${hidden} more*`);

  const files = push.commits.reduce(
    (n, c) =>
      n + (c.added?.length ?? 0) + (c.removed?.length ?? 0) + (c.modified?.length ?? 0),
    0,
  );

  return {
    title: `📚 Wiki update — ${push.commits.length} commit${push.commits.length === 1 ? "" : "s"} pushed`,
    url: push.compare,
    color: WIKI_COLOR,
    description: lines.join("\n"),
    fields: files
      ? [{ name: "Files touched", value: `${files}`, inline: true }]
      : [],
    footer: { text: `${push.repository.full_name} · deploys to gachawiki.info` },
    timestamp: new Date().toISOString(),
  };
}

/** Embed posted on GitHub's one-time `ping` (webhook creation/edit). */
function formatPingEmbed(hookRepo: string): DiscordEmbed {
  return {
    title: "🔗 Wiki commit feed connected",
    description:
      `Every push to **${hookRepo}** will now be posted here.\n` +
      "The site auto-deploys from those pushes — gachawiki.info",
    color: WIKI_COLOR,
    footer: { text: "GitHub webhook · live" },
    timestamp: new Date().toISOString(),
  };
}

/**
 * POST /github-webhook — entry point wired from index.ts. Verifies the
 * signature, then posts for `ping` and default-branch `push` events. All
 * other events are acknowledged (200) and ignored.
 */
export async function handleGithubWebhook(
  request: Request,
  env: WikiFeedEnv,
): Promise<Response> {
  const channelId = env.WIKI_UPDATES_CHANNEL_ID ?? "";
  const secret = env.GITHUB_WEBHOOK_SECRET ?? "";
  if (!channelId || !secret) {
    return Response.json({ ok: false, error: "wiki feed not configured" }, { status: 503 });
  }

  // Verify against the RAW body before parsing anything.
  const raw = await request.text();
  if (!(await verifySignature(raw, request.headers.get("x-hub-signature-256"), secret))) {
    return new Response("invalid signature", { status: 401 });
  }

  const event = request.headers.get("x-github-event") ?? "";

  // Webhook lifecycle ping — posts the connected notice exactly when the
  // hook is created/edited, which doubles as an end-to-end channel test.
  if (event === "ping") {
    let hookRepo = "the wiki repo";
    try {
      const ping = JSON.parse(raw) as { repository?: { full_name?: string } };
      if (ping.repository?.full_name) hookRepo = ping.repository.full_name;
    } catch {
      // Ping body shape changed — the default text is still fine.
    }
    try {
      await postChannelMessage(env.DISCORD_TOKEN, channelId, {
        embeds: [formatPingEmbed(hookRepo)],
      });
    } catch (err) {
      console.error("[wikifeed] ping post failed:", err);
      return Response.json({ ok: false, error: "post failed" }, { status: 500 });
    }
    return Response.json({ ok: true, posted: "ping" });
  }

  if (event !== "push") {
    return Response.json({ ok: true, ignored: event });
  }

  let push: GithubPush;
  try {
    push = JSON.parse(raw) as GithubPush;
  } catch {
    return Response.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  // Only the default branch reaches Discord (no feature-branch noise).
  const branch = push.ref?.replace("refs/heads/", "");
  const defaultBranch = push.repository?.default_branch ?? "main";
  if (branch !== defaultBranch) {
    return Response.json({ ok: true, ignored: `branch ${branch ?? "?"}` });
  }
  // Empty commits array = branch create/delete or force-push cleanup.
  if (!push.commits?.length) {
    return Response.json({ ok: true, ignored: "no commits" });
  }

  try {
    await postChannelMessage(env.DISCORD_TOKEN, channelId, {
      embeds: [formatPushEmbed(push)],
    });
  } catch (err) {
    console.error("[wikifeed] push post failed:", err);
    return Response.json({ ok: false, error: "post failed" }, { status: 500 });
  }

  // Best-effort X crosspost (dormant until all four X_* secrets exist).
  // Never fails the delivery — #wiki-updates already got its embed.
  let x: Record<string, unknown> | null = null;
  if (xConfigured(env)) {
    const subject = push.commits[0].message.split("\n")[0].trim();
    const more = push.commits.length - 1;
    try {
      const tweet = await postWikiUpdateToX(env, subject, more);
      x = { tweeted: true, url: `https://x.com/GachaJunkie888/status/${tweet.id}` };
    } catch (err) {
      console.error("[wikifeed] x crosspost failed:", err);
      x = { tweeted: false, error: String(err).slice(0, 200) };
    }
  }

  return Response.json({ ok: true, posted: push.commits.length, x });
}
