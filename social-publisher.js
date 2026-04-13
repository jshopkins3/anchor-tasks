// Social Publisher — Publishes content to social platforms via Zernio API
// Supports: Facebook (Anchor page), LinkedIn (personal + company), Instagram (personal)

const ZERNIO_API_KEY = () => process.env.ZERNIO_API_KEY || "";
const ZERNIO_BASE = "https://zernio.com/api/v1";

// Platform → Zernio account mapping (populated on first call)
let accountCache = null;

async function zernioFetch(endpoint, method = "GET", body = null) {
  const key = ZERNIO_API_KEY();
  if (!key) throw new Error("ZERNIO_API_KEY not set");

  const opts = {
    method,
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${ZERNIO_BASE}${endpoint}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zernio ${endpoint}: ${res.status} ${text}`);
  }
  return res.json();
}

async function getAccounts() {
  if (accountCache) return accountCache;
  const data = await zernioFetch("/accounts");
  accountCache = data.accounts || [];
  // Refresh cache every 10 minutes
  setTimeout(() => { accountCache = null; }, 600000);
  return accountCache;
}

// Map our platform names to Zernio account IDs
// Returns { platform, accountId, profileName } for each matching account
async function resolveAccounts(platforms) {
  const accounts = await getAccounts();
  const resolved = [];

  for (const platform of platforms) {
    const p = platform.toLowerCase();
    // Find matching active accounts
    const matches = accounts.filter(a => a.platform === p && a.isActive && a.enabled);
    for (const m of matches) {
      resolved.push({
        platform: m.platform,
        accountId: m._id,
        profileName: m.profileId?.name || m.displayName,
        displayName: m.displayName,
        username: m.username,
      });
    }
  }
  return resolved;
}

// Publish a briefing recommendation to all its platforms
// rec = the recommendation object from the briefing
// options = { scheduleTime, profileFilter }
async function publishRecommendation(rec, options = {}) {
  if (!rec || !rec.platforms) throw new Error("No platforms in recommendation");

  const results = [];
  const platformKeys = Object.keys(rec.platforms);

  // Map briefing platform names to Zernio platform names
  const platformMap = {
    facebook: "facebook",
    x: "twitter",  // Zernio uses "twitter"
    linkedin: "linkedin",
    instagram: "instagram",
  };

  for (const key of platformKeys) {
    const platData = rec.platforms[key];
    if (!platData || !platData.text) continue;

    const zernioPlatform = platformMap[key];
    if (!zernioPlatform) {
      results.push({ platform: key, status: "skipped", reason: "Platform not supported for auto-publish" });
      continue;
    }

    try {
      // Find all accounts for this platform
      const accounts = await resolveAccounts([zernioPlatform]);
      if (accounts.length === 0) {
        results.push({ platform: key, status: "skipped", reason: "No connected account" });
        continue;
      }

      // Build the post for each account on this platform
      for (const account of accounts) {
        // If profile filter specified, only post to matching profiles
        if (options.profileFilter && !account.profileName.toLowerCase().includes(options.profileFilter.toLowerCase())) {
          continue;
        }

        const postBody = {
          content: platData.text,
          platforms: [{ platform: zernioPlatform, accountId: account.accountId }],
        };

        if (options.scheduleTime) {
          postBody.scheduledFor = options.scheduleTime;
          postBody.timezone = "America/New_York";
        } else {
          postBody.publishNow = true;
        }

        const result = await zernioFetch("/posts", "POST", postBody);
        results.push({
          platform: key,
          account: account.displayName,
          profile: account.profileName,
          status: "published",
          postId: result._id || result.id,
          scheduledFor: options.scheduleTime || null,
        });
        console.log(`[social-publisher] Posted to ${key} (${account.displayName}): ${platData.text.substring(0, 60)}...`);
      }
    } catch (e) {
      console.error(`[social-publisher] Error posting to ${key}:`, e.message);
      results.push({ platform: key, status: "error", error: e.message });
    }
  }

  return results;
}

// Simple post — single text to specified platforms
async function postNow(text, platforms = []) {
  if (!text) throw new Error("No text to post");

  const platformMap = { facebook: "facebook", x: "twitter", linkedin: "linkedin", instagram: "instagram" };
  const zernioPlatforms = platforms.map(p => platformMap[p] || p);

  const accounts = await resolveAccounts(zernioPlatforms);
  if (accounts.length === 0) throw new Error("No connected accounts for specified platforms");

  const postBody = {
    content: text,
    platforms: accounts.map(a => ({ platform: a.platform, accountId: a.accountId })),
    publishNow: true,
  };

  return zernioFetch("/posts", "POST", postBody);
}

// Schedule a post for later
async function schedulePost(text, platforms, scheduleTime, timezone = "America/New_York") {
  if (!text) throw new Error("No text to post");

  const platformMap = { facebook: "facebook", x: "twitter", linkedin: "linkedin", instagram: "instagram" };
  const zernioPlatforms = platforms.map(p => platformMap[p] || p);

  const accounts = await resolveAccounts(zernioPlatforms);
  if (accounts.length === 0) throw new Error("No connected accounts for specified platforms");

  const postBody = {
    content: text,
    platforms: accounts.map(a => ({ platform: a.platform, accountId: a.accountId })),
    scheduledFor: scheduleTime,
    timezone,
  };

  return zernioFetch("/posts", "POST", postBody);
}

// List connected accounts (for UI display)
async function listAccounts() {
  const accounts = await getAccounts();
  return accounts.filter(a => a.isActive && a.enabled).map(a => ({
    id: a._id,
    platform: a.platform,
    displayName: a.displayName,
    username: a.username,
    profile: a.profileId?.name || "Default",
    profileUrl: a.profileUrl,
  }));
}

module.exports = {
  publishRecommendation,
  postNow,
  schedulePost,
  listAccounts,
  getAccounts,
};
