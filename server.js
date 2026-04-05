const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/* ─── Config ─────────────────────────────────────────────────────────── */
const PORT = process.env.PORT || 8080;
const BASE = __dirname;
const DATA_DIR = path.join(BASE, "data");
const TASKS_FILE = path.join(DATA_DIR, "tasks.md");
const PROJECTS_FILE = path.join(DATA_DIR, "projects.md");
const GOALS_FILE = path.join(DATA_DIR, "goals.json");
const JOURNAL_FILE = path.join(DATA_DIR, "journal.json");
const GCAL_TOKEN_FILE = path.join(DATA_DIR, "gcal-token.json");

// Google Calendar config
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GCAL_CALENDAR_ID = process.env.GCAL_CALENDAR_ID || "primary";
const ANCHOR_GCAL_CALENDAR_ID = process.env.ANCHOR_GCAL_CALENDAR_ID ||
  "c_973e23a22956e78db27d478e42e11cc3e472f97c6c1d6587291742f3e3029a4a@group.calendar.google.com";
const GCAL_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/drive",
].join(" ");

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
};

/* ─── Auth config (same pattern as Anchor Command) ───────────────────── */
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || "")
  .split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
const sessions = new Map(); // sessionId → { email, name, picture, createdAt }
const IS_PRODUCTION = !!process.env.RAILWAY_ENVIRONMENT;

/* ─── Ensure data dir + seed files exist ─────────────────────────────── */
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(TASKS_FILE)) {
  fs.writeFileSync(TASKS_FILE, `# Tasks\n\n## Active\n\n## Completed\n`, "utf8");
}
if (!fs.existsSync(PROJECTS_FILE)) {
  fs.writeFileSync(PROJECTS_FILE, `# Projects\n\n## Active\n\n## Archived\n`, "utf8");
}
if (!fs.existsSync(GOALS_FILE)) {
  fs.writeFileSync(GOALS_FILE, JSON.stringify([], null, 2), "utf8");
}
if (!fs.existsSync(JOURNAL_FILE)) {
  fs.writeFileSync(JOURNAL_FILE, JSON.stringify([], null, 2), "utf8");
}

/* ─── Helpers ────────────────────────────────────────────────────────── */
function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const opts = typeof url === "string" ? new URL(url) : url;
    const reqOpts = { hostname: opts.hostname, path: opts.pathname + opts.search, headers: headers || {} };
    https.get(reqOpts, res => {
      let d = "";
      res.on("data", c => (d += c));
      res.on("end", () => resolve(d));
    }).on("error", reject);
  });
}

function httpsPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const req = https.request({ hostname: opts.hostname, path: opts.pathname, method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(body) } }, res => {
      let d = "";
      res.on("data", c => (d += c));
      res.on("end", () => resolve(d));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", c => (d += c));
    req.on("end", () => resolve(d));
    req.on("error", reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/* ─── Session helpers (identical to Anchor Command) ──────────────────── */
function createSession(userData) {
  const id = crypto.randomBytes(32).toString("hex");
  sessions.set(id, { ...userData, createdAt: Date.now() });
  console.log(`[auth] Session created for ${userData.email} (${sessions.size} active)`);
  return id;
}

function getSession(req) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/anchor_tasks_session=([a-f0-9]{64})/);
  if (!match) return null;
  return sessions.get(match[1]) || null;
}

function setSessionCookie(res, sessionId) {
  const secure = IS_PRODUCTION ? " Secure;" : "";
  res.setHeader("Set-Cookie",
    `anchor_tasks_session=${sessionId}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=604800`);
}

function clearSessionCookie(res) {
  const secure = IS_PRODUCTION ? " Secure;" : "";
  res.setHeader("Set-Cookie",
    `anchor_tasks_session=; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=0`);
}

/* ─── Google token verification ──────────────────────────────────────── */
function verifyGoogleToken(idToken) {
  return new Promise((resolve, reject) => {
    const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
    httpsGet(url)
      .then(data => {
        const info = JSON.parse(data);
        if (info.aud !== GOOGLE_CLIENT_ID) return reject(new Error("Invalid audience"));
        if (!info.email_verified || info.email_verified !== "true") return reject(new Error("Email not verified"));
        resolve({ email: info.email.toLowerCase(), name: info.name || info.email, picture: info.picture || "" });
      })
      .catch(reject);
  });
}

/* ─── MD Task/Project engine ─────────────────────────────────────────── */
// Task format in MD:
//   - [ ] {id} | {title} | {assignee} | {due} | {priority} | {project} | {status}
//   - [x] {id} | {title} | {assignee} | {due} | {priority} | {project} | {status}

function generateId() {
  return crypto.randomBytes(4).toString("hex");
}

function parseTasks() {
  const raw = fs.readFileSync(TASKS_FILE, "utf8");
  const tasks = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    const m = line.match(/^- \[([ x])\] (.+)$/);
    if (!m) continue;
    const done = m[1] === "x";
    const parts = m[2].split("|").map(s => s.trim());
    tasks.push({
      id: parts[0] || generateId(),
      title: parts[1] || "",
      assignee: parts[2] || "",
      due: parts[3] || "",
      priority: parts[4] || "normal",
      project: parts[5] || "",
      status: parts[6] || "",
      personal: parts[7] === "true",
      urgent: parts[8] === "true",
      important: parts[9] === "true",
      linkedGoal: parts[10] || "",
      todayFocus: parts[11] === "true",
      todayOrder: parseInt(parts[12]) || 0,
      calEventId: parts[13] || "",
      scheduledStart: parts[14] || "",
      emailId: parts[15] || "",
      emailSubject: parts[16] || "",
      done,
    });
  }
  return tasks;
}

function writeTasks(tasks) {
  const active = tasks.filter(t => !t.done);
  const completed = tasks.filter(t => t.done);
  const fmt = t => `- [${t.done ? "x" : " "}] ${t.id} | ${t.title} | ${t.assignee} | ${t.due} | ${t.priority} | ${t.project} | ${t.status || ""} | ${t.personal ? "true" : "false"} | ${t.urgent ? "true" : "false"} | ${t.important ? "true" : "false"} | ${t.linkedGoal || ""} | ${t.todayFocus ? "true" : "false"} | ${t.todayOrder || 0} | ${t.calEventId || ""} | ${t.scheduledStart || ""} | ${t.emailId || ""} | ${t.emailSubject || ""}`;
  const md = [
    "# Tasks", "",
    "## Active", ...active.map(fmt), "",
    "## Completed", ...completed.map(fmt), "",
  ].join("\n");
  fs.writeFileSync(TASKS_FILE, md, "utf8");
}

function parseProjects() {
  const raw = fs.readFileSync(PROJECTS_FILE, "utf8");
  const projects = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    const m = line.match(/^- \[([ x])\] (.+)$/);
    if (!m) continue;
    const archived = m[1] === "x";
    const parts = m[2].split("|").map(s => s.trim());
    projects.push({
      id: parts[0] || generateId(),
      name: parts[1] || "",
      description: parts[2] || "",
      owner: parts[3] || "",
      archived,
    });
  }
  return projects;
}

function writeProjects(projects) {
  const active = projects.filter(p => !p.archived);
  const archived = projects.filter(p => p.archived);
  const fmt = p => `- [${p.archived ? "x" : " "}] ${p.id} | ${p.name} | ${p.description} | ${p.owner}`;
  const md = [
    "# Projects", "",
    "## Active", ...active.map(fmt), "",
    "## Archived", ...archived.map(fmt), "",
  ].join("\n");
  fs.writeFileSync(PROJECTS_FILE, md, "utf8");
}

/* ─── Goals engine ────────────────────────────────────────────────────── */
function readGoals() {
  try { return JSON.parse(fs.readFileSync(GOALS_FILE, "utf8")); }
  catch { return []; }
}

function writeGoals(goals) {
  fs.writeFileSync(GOALS_FILE, JSON.stringify(goals, null, 2), "utf8");
}

/* ─── Google Calendar helpers ────────────────────────────────────────────── */
function loadGCalToken() {
  try {
    if (fs.existsSync(GCAL_TOKEN_FILE)) return JSON.parse(fs.readFileSync(GCAL_TOKEN_FILE, "utf8"));
  } catch {}
  // Fallback: restore from env var (survives Railway redeploys)
  try {
    if (process.env.GCAL_TOKEN) {
      const token = JSON.parse(process.env.GCAL_TOKEN);
      fs.writeFileSync(GCAL_TOKEN_FILE, JSON.stringify(token, null, 2));
      console.log("[gcal] Restored token from GCAL_TOKEN env var");
      return token;
    }
  } catch {}
  return null;
}
function saveGCalToken(token) {
  fs.writeFileSync(GCAL_TOKEN_FILE, JSON.stringify(token, null, 2));
  // Log the token value so it can be set as GCAL_TOKEN env var on Railway
  console.log("[gcal] TOKEN_FOR_ENV:", JSON.stringify(token));
}

async function getGCalAccessToken() {
  const token = loadGCalToken();
  if (!token || !token.refresh_token) return null;
  if (token.access_token && token.expires_at && Date.now() < token.expires_at - 300000) {
    return token.access_token;
  }
  try {
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    });
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const data = await resp.json();
    if (data.access_token) {
      token.access_token = data.access_token;
      token.expires_at = Date.now() + (data.expires_in || 3600) * 1000;
      saveGCalToken(token);
      return data.access_token;
    }
    console.error("[gcal] Token refresh failed:", data);
    return null;
  } catch (err) {
    console.error("[gcal] Token refresh error:", err.message);
    return null;
  }
}

async function gcalCreateOrUpdateEvent(eventId, eventData) {
  const accessToken = await getGCalAccessToken();
  if (!accessToken) return null;
  const baseUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GCAL_CALENDAR_ID)}/events`;
  try {
    if (eventId) {
      const resp = await fetch(`${baseUrl}/${eventId}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(eventData),
      });
      if (resp.ok) return await resp.json();
      if (resp.status !== 404) { console.error("[gcal] Update failed:", resp.status); return null; }
    }
    const resp = await fetch(baseUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(eventData),
    });
    if (resp.ok) return await resp.json();
    console.error("[gcal] Create failed:", resp.status, await resp.text());
    return null;
  } catch (err) {
    console.error("[gcal] API error:", err.message);
    return null;
  }
}

async function gcalDeleteEvent(eventId) {
  const accessToken = await getGCalAccessToken();
  if (!accessToken || !eventId) return;
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GCAL_CALENDAR_ID)}/events/${eventId}`;
  try {
    await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (err) {
    console.error("[gcal] Delete error:", err.message);
  }
}

async function gcalFetchEvents(calendarId, timeMin, timeMax, source, accessToken, maxResults = 50) {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?` +
    new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: String(maxResults) }).toString();
  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) { console.error(`[gcal] Events fetch failed (${source}):`, resp.status); return []; }
    const data = await resp.json();
    return (data.items || []).map(ev => ({
      id: ev.id,
      title: ev.summary || "(No title)",
      start: ev.start?.dateTime || ev.start?.date || "",
      end: ev.end?.dateTime || ev.end?.date || "",
      allDay: !ev.start?.dateTime,
      location: ev.location || "",
      source,
    }));
  } catch (err) {
    console.error(`[gcal] Events error (${source}):`, err.message);
    return [];
  }
}

async function gcalGetTodayEvents() {
  const accessToken = await getGCalAccessToken();
  if (!accessToken) return null;
  const now = new Date();
  const y = now.getFullYear(), mo = now.getMonth(), d = now.getDate();
  const timeMin = new Date(y, mo, d, 0, 0, 0).toISOString();
  const timeMax = new Date(y, mo, d, 23, 59, 59).toISOString();
  const [personal, anchor] = await Promise.all([
    gcalFetchEvents(GCAL_CALENDAR_ID, timeMin, timeMax, "personal", accessToken, 20),
    gcalFetchEvents(ANCHOR_GCAL_CALENDAR_ID, timeMin, timeMax, "anchor", accessToken, 20),
  ]);
  return [...personal, ...anchor].sort((a, b) => a.start.localeCompare(b.start));
}

async function gcalGetRangeEvents(startDate, endDate) {
  const accessToken = await getGCalAccessToken();
  if (!accessToken) return null;
  const timeMin = new Date(startDate + "T00:00:00").toISOString();
  const timeMax = new Date(endDate + "T23:59:59").toISOString();
  const [personal, anchor] = await Promise.all([
    gcalFetchEvents(GCAL_CALENDAR_ID, timeMin, timeMax, "personal", accessToken, 100),
    gcalFetchEvents(ANCHOR_GCAL_CALENDAR_ID, timeMin, timeMax, "anchor", accessToken, 100),
  ]);
  return [...personal, ...anchor].sort((a, b) => a.start.localeCompare(b.start));
}

/* ─── Gmail helpers ──────────────────────────────────────────────────────── */
function parseEmailHeader(headers, name) {
  const h = (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}

function decodeEmailBody(payload) {
  // Try to get plain text body
  function findPart(p) {
    if (!p) return "";
    if (p.mimeType === "text/plain" && p.body?.data) return p.body.data;
    if (p.parts) { for (const part of p.parts) { const r = findPart(part); if (r) return r; } }
    return "";
  }
  const raw = findPart(payload);
  if (!raw) return "";
  try {
    return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch { return ""; }
}

function gmailExtractBody(payload) {
  // Recursively find the best body part (prefer text/html, fallback to text/plain)
  function findPart(p, mimeType) {
    if (!p) return null;
    if (p.mimeType === mimeType && p.body?.data) return p.body.data;
    if (p.parts) {
      for (const part of p.parts) {
        const found = findPart(part, mimeType);
        if (found) return found;
      }
    }
    return null;
  }
  const htmlData = findPart(payload, "text/html");
  if (htmlData) return { type: "html", data: Buffer.from(htmlData.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") };
  const textData = findPart(payload, "text/plain");
  if (textData) return { type: "text", data: Buffer.from(textData.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") };
  return null;
}

async function gmailGetInbox() {
  const accessToken = await getGCalAccessToken();
  if (!accessToken) return null;
  try {
    // List unread messages
    const listUrl = "https://gmail.googleapis.com/gmail/v1/users/me/messages?" +
      new URLSearchParams({ q: "is:unread in:inbox", maxResults: "30" }).toString();
    const listResp = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!listResp.ok) {
      const errText = await listResp.text();
      console.error("[gmail] List failed:", listResp.status, errText);
      let errReason = "unknown";
      try { errReason = JSON.parse(errText)?.error?.errors?.[0]?.reason || JSON.parse(errText)?.error?.status || "unknown"; } catch {}
      if (listResp.status === 401 || listResp.status === 403) return { needsReauth: true, reason: errReason };
      return null;
    }
    const listData = await listResp.json();
    const messages = listData.messages || [];
    if (!messages.length) return [];

    // Fetch metadata for each
    const emails = await Promise.all(messages.slice(0, 30).map(async m => {
      const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`;
      const msgResp = await fetch(msgUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!msgResp.ok) return null;
      const msg = await msgResp.json();
      const headers = msg.payload?.headers || [];
      const from = parseEmailHeader(headers, "From");
      const subject = parseEmailHeader(headers, "Subject") || "(No subject)";
      const date = parseEmailHeader(headers, "Date");
      // Parse display name from "Name <email>" format
      const fromMatch = from.match(/^"?([^"<]+)"?\s*<?([^>]*)>?$/);
      const fromName = fromMatch ? fromMatch[1].trim() : from;
      const fromEmail = fromMatch ? fromMatch[2].trim() : from;
      return {
        id: m.id,
        threadId: msg.threadId,
        subject,
        from: fromName || fromEmail,
        fromEmail,
        snippet: msg.snippet || "",
        date,
        unread: (msg.labelIds || []).includes("UNREAD"),
      };
    }));
    return emails.filter(Boolean);
  } catch (err) {
    console.error("[gmail] Inbox error:", err.message);
    return null;
  }
}

async function gmailMarkRead(messageId) {
  const accessToken = await getGCalAccessToken();
  if (!accessToken) return false;
  try {
    const resp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
    });
    return resp.ok;
  } catch (err) {
    console.error("[gmail] Mark read error:", err.message);
    return false;
  }
}

async function gmailArchive(messageId) {
  const accessToken = await getGCalAccessToken();
  if (!accessToken) return false;
  try {
    const resp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ removeLabelIds: ["INBOX", "UNREAD"] }),
    });
    return resp.ok;
  } catch (err) {
    console.error("[gmail] Archive error:", err.message);
    return false;
  }
}

/* ─── Per-project detail files (notes, ethos, docs) ──────────────────── */
function projectDetailPath(id) {
  return path.join(DATA_DIR, `project-${id}.json`);
}

function readProjectDetail(id) {
  const fp = projectDetailPath(id);
  if (!fs.existsSync(fp)) return { notes: "", ethos: "", docs: [], folderId: "", folderUrl: "" };
  try { return JSON.parse(fs.readFileSync(fp, "utf8")); }
  catch { return { notes: "", ethos: "", docs: [] }; }
}

function writeProjectDetail(id, detail) {
  fs.writeFileSync(projectDetailPath(id), JSON.stringify(detail, null, 2), "utf8");
}

function deleteProjectDetail(id) {
  const fp = projectDetailPath(id);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
}

/* ─── Journal helpers ────────────────────────────────────────────────── */
function loadJournal() {
  try { return JSON.parse(fs.readFileSync(JOURNAL_FILE, "utf8")); } catch { return []; }
}
function saveJournal(entries) {
  fs.writeFileSync(JOURNAL_FILE, JSON.stringify(entries, null, 2), "utf8");
}

/* ─── Auth bypass paths ──────────────────────────────────────────────── */
const PUBLIC_PATHS = ["/login.html", "/api/auth", "/api/auth-config", "/api/health", "/favicon.ico", "/api/gcal-callback"];

/* ─── HTTP server ────────────────────────────────────────────────────── */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const urlPath = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  try {
    /* ── Health ─────────────────────────────────────────────────────── */
    if (urlPath === "/api/health") {
      return json(res, 200, { ok: true, app: "anchor-tasks", uptime: process.uptime() });
    }

    /* ── Auth config (public — login page needs client ID) ─────────── */
    if (urlPath === "/api/auth-config") {
      return json(res, 200, { clientId: GOOGLE_CLIENT_ID });
    }

    /* ── Auth: POST /api/auth ──────────────────────────────────────── */
    if (urlPath === "/api/auth" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      try {
        const user = await verifyGoogleToken(body.token);
        if (ALLOWED_EMAILS.length && !ALLOWED_EMAILS.includes(user.email)) {
          console.log(`[auth] Denied: ${user.email} not in whitelist`);
          return json(res, 403, { error: "Not authorized. Your email is not on the approved list." });
        }
        const sessionId = createSession(user);
        setSessionCookie(res, sessionId);
        return json(res, 200, { ok: true, user });
      } catch (e) {
        console.error("[auth] Verification failed:", e.message);
        return json(res, 401, { error: "Token verification failed." });
      }
    }

    /* ── Logout: POST /api/logout ──────────────────────────────────── */
    if (urlPath === "/api/logout" && req.method === "POST") {
      const cookie = (req.headers.cookie || "").match(/anchor_tasks_session=([a-f0-9]{64})/);
      if (cookie) {
        const session = sessions.get(cookie[1]);
        if (session) console.log(`[auth] Logout: ${session.email}`);
        sessions.delete(cookie[1]);
      }
      clearSessionCookie(res);
      return json(res, 200, { ok: true });
    }

    /* ── Session check: GET /api/me ────────────────────────────────── */
    if (urlPath === "/api/me" && req.method === "GET") {
      const session = getSession(req);
      if (!session) return json(res, 401, { error: "Not authenticated" });
      return json(res, 200, session);
    }

    /* ── Auth wall — everything below requires a valid session ──────── */
    if (!PUBLIC_PATHS.includes(urlPath) && urlPath.startsWith("/api/") && !urlPath.startsWith("/api/dan/")) {
      const session = getSession(req);
      if (!session) return json(res, 401, { error: "Not authenticated" });
      // Attach session to req for downstream handlers
      req.session = session;
    }

    /* ── DAN API: Gmail & Calendar (callable from Command via API key) ── */
    const isDanApiKey = () => {
      const apiKey = req.headers["x-api-key"];
      return apiKey && apiKey === (process.env.COMMAND_API_KEY || "");
    };

    // Gmail: search/inbox
    if (urlPath === "/api/dan/gmail-search" && req.method === "POST") {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      const query = body.query || "is:unread in:inbox";
      const maxResults = body.maxResults || 15;
      const accessToken = await getGCalAccessToken();
      if (!accessToken) return json(res, 200, { error: "Gmail not connected", emails: [] });
      try {
        const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q: query, maxResults: String(maxResults) })}`;
        const listResp = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!listResp.ok) return json(res, 200, { error: `Gmail API: ${listResp.status}`, emails: [] });
        const listData = await listResp.json();
        const messages = listData.messages || [];
        const emails = await Promise.all(messages.slice(0, maxResults).map(async m => {
          const msgResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (!msgResp.ok) return null;
          const msg = await msgResp.json();
          const h = msg.payload?.headers || [];
          return {
            id: m.id, threadId: msg.threadId,
            from: parseEmailHeader(h, "From"), to: parseEmailHeader(h, "To"),
            subject: parseEmailHeader(h, "Subject") || "(No subject)",
            date: parseEmailHeader(h, "Date"), snippet: msg.snippet || "",
            unread: (msg.labelIds || []).includes("UNREAD"),
          };
        }));
        return json(res, 200, { emails: emails.filter(Boolean) });
      } catch (e) { return json(res, 200, { error: e.message, emails: [] }); }
    }

    // Gmail: read full message
    if (urlPath === "/api/dan/gmail-read" && req.method === "POST") {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      const accessToken = await getGCalAccessToken();
      if (!accessToken) return json(res, 200, { error: "Gmail not connected" });
      try {
        const msgResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${body.messageId}?format=full`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!msgResp.ok) return json(res, 200, { error: `Gmail API: ${msgResp.status}` });
        const msg = await msgResp.json();
        const h = msg.payload?.headers || [];
        const bodyContent = decodeEmailBody(msg.payload);
        return json(res, 200, {
          id: msg.id, threadId: msg.threadId,
          from: parseEmailHeader(h, "From"), to: parseEmailHeader(h, "To"),
          subject: parseEmailHeader(h, "Subject"), date: parseEmailHeader(h, "Date"),
          body: bodyContent, snippet: msg.snippet,
        });
      } catch (e) { return json(res, 200, { error: e.message }); }
    }

    // Gmail: send email
    if (urlPath === "/api/dan/gmail-send" && req.method === "POST") {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      const accessToken = await getGCalAccessToken();
      if (!accessToken) return json(res, 200, { error: "Gmail not connected" });
      try {
        const rawEmail = [
          `To: ${body.to}`,
          `Subject: ${body.subject}`,
          `Content-Type: text/plain; charset=utf-8`,
          ``,
          body.body,
        ].join("\r\n");
        const encoded = Buffer.from(rawEmail).toString("base64url");
        const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ raw: encoded }),
        });
        if (!resp.ok) return json(res, 200, { error: `Send failed: ${resp.status}` });
        const sent = await resp.json();
        console.log(`[dan-gmail] Sent email to ${body.to}: "${body.subject}"`);
        return json(res, 200, { success: true, messageId: sent.id, to: body.to, subject: body.subject });
      } catch (e) { return json(res, 200, { error: e.message }); }
    }

    // Calendar: list events
    if (urlPath === "/api/dan/calendar-list" && req.method === "POST") {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      const days = body.days || 7;
      const now = new Date();
      const future = new Date(now); future.setDate(now.getDate() + days);
      const accessToken = await getGCalAccessToken();
      if (!accessToken) return json(res, 200, { error: "Calendar not connected", events: [] });
      try {
        // Fetch from primary calendar (John's personal)
        const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?${new URLSearchParams({
          timeMin: now.toISOString(), timeMax: future.toISOString(),
          singleEvents: "true", orderBy: "startTime", maxResults: "50",
        })}`;
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!resp.ok) return json(res, 200, { error: `Calendar API: ${resp.status}`, events: [] });
        const data = await resp.json();
        const events = (data.items || []).map(e => ({
          id: e.id, title: e.summary || "(No title)",
          date: e.start?.date || e.start?.dateTime?.split("T")[0],
          time: e.start?.dateTime ? e.start.dateTime.split("T")[1]?.substring(0, 5) : "all-day",
          endTime: e.end?.dateTime ? e.end.dateTime.split("T")[1]?.substring(0, 5) : null,
          location: e.location || "", description: (e.description || "").substring(0, 200),
        }));
        return json(res, 200, { events });
      } catch (e) { return json(res, 200, { error: e.message, events: [] }); }
    }

    // Calendar: create event
    if (urlPath === "/api/dan/calendar-create" && req.method === "POST") {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      const accessToken = await getGCalAccessToken();
      if (!accessToken) return json(res, 200, { error: "Calendar not connected" });
      try {
        let eventData;
        if (body.time) {
          // Pass local time directly — do NOT convert through Date/UTC
          const duration = body.duration || 60;
          const [h, m] = body.time.split(":").map(Number);
          const endH = h + Math.floor((m + duration) / 60);
          const endM = (m + duration) % 60;
          const startStr = `${body.date}T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:00`;
          const endStr = `${body.date}T${String(endH).padStart(2,"0")}:${String(endM).padStart(2,"0")}:00`;
          eventData = {
            summary: body.title,
            start: { dateTime: startStr, timeZone: "America/New_York" },
            end: { dateTime: endStr, timeZone: "America/New_York" },
            description: body.description || "", location: body.location || "",
          };
        } else {
          const nextDay = new Date(body.date + "T12:00:00Z");
          nextDay.setUTCDate(nextDay.getUTCDate() + 1);
          eventData = {
            summary: body.title, start: { date: body.date }, end: { date: nextDay.toISOString().split("T")[0] },
            description: body.description || "",
          };
        }
        const resp = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(eventData),
        });
        if (!resp.ok) return json(res, 200, { error: `Create failed: ${resp.status}` });
        const created = await resp.json();
        console.log(`[dan-calendar] Created: "${body.title}" on ${body.date}`);
        return json(res, 200, { success: true, eventId: created.id, title: body.title, date: body.date });
      } catch (e) { return json(res, 200, { error: e.message }); }
    }

    // Dan: full Anchor Tasks data access (tasks, projects, goals)
    if (urlPath === "/api/dan/tasks-overview" && req.method === "POST") {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const tasks = parseTasks();
      const projects = parseProjects();
      const goals = readGoals();
      const open = tasks.filter(t => !t.done);
      const today = open.filter(t => t.todayFocus);
      const overdue = open.filter(t => t.due && t.due < new Date().toISOString().substring(0, 10));
      const urgent = open.filter(t => t.urgent);
      return json(res, 200, {
        tasks: { total: tasks.length, open: open.length, today: today.length, overdue: overdue.length, urgent: urgent.length },
        openTasks: open.map(t => ({ id: t.id, title: t.title, assignee: t.assignee, due: t.due, priority: t.priority, project: t.project, urgent: t.urgent, important: t.important, todayFocus: t.todayFocus, status: t.status })),
        projects: projects.map(p => ({ id: p.id, name: p.name, status: p.status, color: p.color })),
        goals: goals.map(g => ({ id: g.id, title: g.title, targetDate: g.targetDate, progress: g.progress, category: g.category })),
      });
    }

    if (urlPath === "/api/dan/tasks-create" && req.method === "POST") {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      const tasks = parseTasks();
      const task = {
        id: generateId(),
        title: String(body.title || "").substring(0, 200),
        assignee: String(body.assignee || "").substring(0, 100),
        due: String(body.due || "").substring(0, 10),
        priority: ["low", "normal", "high", "urgent"].includes(body.priority) ? body.priority : "normal",
        project: String(body.project || "").substring(0, 100),
        status: String(body.status || "").substring(0, 50),
        personal: !!body.personal,
        urgent: !!body.urgent,
        important: !!body.important,
        done: false,
      };
      if (!task.title) return json(res, 400, { error: "Title required" });
      tasks.push(task);
      writeTasks(tasks);
      return json(res, 201, { task });
    }

    if (urlPath === "/api/dan/tasks-update" && req.method === "POST") {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      if (!body.id) return json(res, 400, { error: "Task id required" });
      const tasks = parseTasks();
      const idx = tasks.findIndex(t => t.id === body.id);
      if (idx === -1) return json(res, 404, { error: "Task not found" });
      if (body.title !== undefined) tasks[idx].title = String(body.title).substring(0, 200);
      if (body.assignee !== undefined) tasks[idx].assignee = String(body.assignee).substring(0, 100);
      if (body.due !== undefined) tasks[idx].due = String(body.due).substring(0, 10);
      if (body.priority !== undefined) tasks[idx].priority = body.priority;
      if (body.project !== undefined) tasks[idx].project = String(body.project).substring(0, 100);
      if (body.done !== undefined) tasks[idx].done = !!body.done;
      if (body.status !== undefined) tasks[idx].status = String(body.status).substring(0, 50);
      if (body.urgent !== undefined) tasks[idx].urgent = !!body.urgent;
      if (body.important !== undefined) tasks[idx].important = !!body.important;
      if (body.todayFocus !== undefined) tasks[idx].todayFocus = !!body.todayFocus;
      writeTasks(tasks);
      return json(res, 200, { task: tasks[idx] });
    }

    // Dan: Google Drive access
    if (urlPath === "/api/dan/drive-search" && req.method === "POST") {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      const accessToken = await getGCalAccessToken();
      if (!accessToken) return json(res, 200, { error: "Drive not connected", files: [] });
      try {
        const q = body.query || "";
        const mimeFilter = body.mimeType ? ` and mimeType='${body.mimeType}'` : "";
        const searchQ = `name contains '${q.replace(/'/g, "\\'")}'${mimeFilter} and trashed=false`;
        const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(searchQ)}&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives&fields=files(id,name,mimeType,webViewLink,modifiedTime,size)&orderBy=modifiedTime desc&pageSize=${body.maxResults || 10}`;
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!resp.ok) return json(res, 200, { error: `Drive API: ${resp.status}`, files: [] });
        const data = await resp.json();
        return json(res, 200, { files: (data.files || []).map(f => ({ id: f.id, name: f.name, type: f.mimeType, url: f.webViewLink, modified: f.modifiedTime, size: f.size })) });
      } catch (e) { return json(res, 200, { error: e.message, files: [] }); }
    }

    if (urlPath === "/api/dan/drive-list-folder" && req.method === "POST") {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      const accessToken = await getGCalAccessToken();
      if (!accessToken) return json(res, 200, { error: "Drive not connected", files: [] });
      try {
        const folderId = body.folderId || "root";
        const url = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+trashed=false&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name,mimeType,webViewLink,modifiedTime)&orderBy=name&pageSize=50`;
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!resp.ok) return json(res, 200, { error: `Drive API: ${resp.status}`, files: [] });
        const data = await resp.json();
        return json(res, 200, { folderId, files: (data.files || []).map(f => ({ id: f.id, name: f.name, type: f.mimeType, url: f.webViewLink, modified: f.modifiedTime, isFolder: f.mimeType === "application/vnd.google-apps.folder" })) });
      } catch (e) { return json(res, 200, { error: e.message, files: [] }); }
    }

    // Dan: Gmail management (archive, delete, label)
    if (urlPath === "/api/dan/gmail-archive" && req.method === "POST") {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      const ok = await gmailArchive(body.messageId);
      return json(res, 200, { ok, messageId: body.messageId });
    }

    if (urlPath === "/api/dan/gmail-delete" && req.method === "POST") {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      const accessToken = await getGCalAccessToken();
      if (!accessToken) return json(res, 200, { error: "Gmail not connected" });
      try {
        const resp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${body.messageId}/trash`, {
          method: "POST", headers: { Authorization: `Bearer ${accessToken}` },
        });
        return json(res, 200, { ok: resp.ok, messageId: body.messageId });
      } catch (e) { return json(res, 200, { error: e.message }); }
    }

    if (urlPath === "/api/dan/gmail-label" && req.method === "POST") {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      const accessToken = await getGCalAccessToken();
      if (!accessToken) return json(res, 200, { error: "Gmail not connected" });
      try {
        const modBody = {};
        if (body.addLabels) modBody.addLabelIds = body.addLabels;
        if (body.removeLabels) modBody.removeLabelIds = body.removeLabels;
        const resp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${body.messageId}/modify`, {
          method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(modBody),
        });
        return json(res, 200, { ok: resp.ok, messageId: body.messageId });
      } catch (e) { return json(res, 200, { error: e.message }); }
    }

    if (urlPath === "/api/dan/gmail-labels" && (req.method === "GET" || req.method === "POST")) {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const accessToken = await getGCalAccessToken();
      if (!accessToken) return json(res, 200, { error: "Gmail not connected", labels: [] });
      try {
        const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!resp.ok) return json(res, 200, { error: `Gmail API: ${resp.status}`, labels: [] });
        const data = await resp.json();
        return json(res, 200, { labels: (data.labels || []).map(l => ({ id: l.id, name: l.name, type: l.type })) });
      } catch (e) { return json(res, 200, { error: e.message, labels: [] }); }
    }

    // Dan: create folder in Drive
    if (urlPath === "/api/dan/drive-create-folder" && req.method === "POST") {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      const accessToken = await getGCalAccessToken();
      if (!accessToken) return json(res, 200, { error: "Drive not connected" });
      try {
        const metadata = {
          name: body.name,
          mimeType: "application/vnd.google-apps.folder",
        };
        if (body.parentId) metadata.parents = [body.parentId];
        const resp = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(metadata),
        });
        if (!resp.ok) return json(res, 200, { error: `Create failed: ${resp.status}` });
        const folder = await resp.json();
        console.log(`[dan-drive] Created folder: ${body.name} (${folder.id})`);
        return json(res, 200, { success: true, folderId: folder.id, name: body.name });
      } catch (e) { return json(res, 200, { error: e.message }); }
    }

    // Dan: move file to a different folder
    if (urlPath === "/api/dan/drive-move" && req.method === "POST") {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      const accessToken = await getGCalAccessToken();
      if (!accessToken) return json(res, 200, { error: "Drive not connected" });
      try {
        // Get current parents
        const metaResp = await fetch(`https://www.googleapis.com/drive/v3/files/${body.fileId}?fields=parents&supportsAllDrives=true`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!metaResp.ok) return json(res, 200, { error: `File not found: ${metaResp.status}` });
        const meta = await metaResp.json();
        const previousParents = (meta.parents || []).join(",");

        // Move to new parent
        const moveResp = await fetch(`https://www.googleapis.com/drive/v3/files/${body.fileId}?addParents=${body.targetFolderId}&removeParents=${previousParents}&supportsAllDrives=true`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!moveResp.ok) return json(res, 200, { error: `Move failed: ${moveResp.status}` });
        console.log(`[dan-drive] Moved ${body.fileId} to folder ${body.targetFolderId}`);
        return json(res, 200, { success: true, fileId: body.fileId, targetFolderId: body.targetFolderId });
      } catch (e) { return json(res, 200, { error: e.message }); }
    }

    // Dan: read Google Doc/Sheet content
    if (urlPath === "/api/dan/drive-read" && req.method === "POST") {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      const fileId = body.fileId;
      if (!fileId) return json(res, 400, { error: "fileId required" });
      const accessToken = await getGCalAccessToken();
      if (!accessToken) return json(res, 200, { error: "Drive not connected" });
      try {
        // First get file metadata to determine type
        const metaResp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType,size&supportsAllDrives=true`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!metaResp.ok) return json(res, 200, { error: `File not found: ${metaResp.status}` });
        const meta = await metaResp.json();

        let content = "";
        if (meta.mimeType === "application/vnd.google-apps.document") {
          // Google Doc → export as plain text
          const expResp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (expResp.ok) content = await expResp.text();
          else content = `Export failed: ${expResp.status}`;
        } else if (meta.mimeType === "application/vnd.google-apps.spreadsheet") {
          // Google Sheet → export as CSV
          const expResp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/csv`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (expResp.ok) content = await expResp.text();
          else content = `Export failed: ${expResp.status}`;
        } else if (meta.mimeType === "application/vnd.google-apps.presentation") {
          // Google Slides → export as plain text
          const expResp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (expResp.ok) content = await expResp.text();
          else content = `Export failed: ${expResp.status}`;
        } else if (meta.mimeType === "application/pdf") {
          content = "[PDF file - cannot read content directly. Use the link to view.]";
        } else if (meta.mimeType?.startsWith("text/") || meta.mimeType === "application/json") {
          // Plain text files → download directly
          const dlResp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (dlResp.ok) content = await dlResp.text();
          else content = `Download failed: ${dlResp.status}`;
        } else {
          content = `[${meta.mimeType} file - cannot read content. Use the link to view.]`;
        }

        // Truncate if huge
        if (content.length > 50000) content = content.substring(0, 50000) + "\n\n[Truncated - content exceeds 50,000 characters]";

        return json(res, 200, { name: meta.name, mimeType: meta.mimeType, content, charCount: content.length });
      } catch (e) { return json(res, 200, { error: e.message }); }
    }

    // Dan: search Drive content (search inside docs, not just by name)
    if (urlPath === "/api/dan/knowledge-search" && req.method === "POST") {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      const query = body.query || "";
      const accessToken = await getGCalAccessToken();
      if (!accessToken) return json(res, 200, { error: "Drive not connected", results: [] });
      try {
        // Use Drive's fullText search to find docs containing the query
        const searchQ = `fullText contains '${query.replace(/'/g, "\\'")}' and trashed=false`;
        const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(searchQ)}&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives&fields=files(id,name,mimeType,webViewLink,modifiedTime)&orderBy=modifiedTime desc&pageSize=${body.maxResults || 10}`;
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!resp.ok) return json(res, 200, { error: `Drive API: ${resp.status}`, results: [] });
        const data = await resp.json();
        const files = (data.files || []).map(f => ({ id: f.id, name: f.name, type: f.mimeType, url: f.webViewLink, modified: f.modifiedTime }));

        // For the top results, try to read a snippet of content
        const results = [];
        for (const file of files.slice(0, 5)) {
          let snippet = "";
          if (file.type === "application/vnd.google-apps.document" || file.type === "application/vnd.google-apps.spreadsheet") {
            try {
              const exportType = file.type.includes("spreadsheet") ? "text/csv" : "text/plain";
              const expResp = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=${exportType}`, {
                headers: { Authorization: `Bearer ${accessToken}` },
              });
              if (expResp.ok) {
                const full = await expResp.text();
                // Find the section containing the query
                const lower = full.toLowerCase();
                const idx = lower.indexOf(query.toLowerCase());
                if (idx >= 0) {
                  const start = Math.max(0, idx - 200);
                  const end = Math.min(full.length, idx + 500);
                  snippet = (start > 0 ? "..." : "") + full.substring(start, end) + (end < full.length ? "..." : "");
                } else {
                  snippet = full.substring(0, 500) + (full.length > 500 ? "..." : "");
                }
              }
            } catch (e) {}
          }
          results.push({ ...file, snippet });
        }

        return json(res, 200, { query, results });
      } catch (e) { return json(res, 200, { error: e.message, results: [] }); }
    }

    // Dan: journal access
    if (urlPath === "/api/dan/journal-add" && req.method === "POST") {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      const entries = loadJournal();
      const entry = {
        id: generateId(),
        date: String(body.date || new Date().toISOString().substring(0, 10)).substring(0, 10),
        title: String(body.title || "").substring(0, 200),
        content: String(body.content || "").substring(0, 50000),
        createdAt: new Date().toISOString(),
        source: "anchor-dan",
      };
      entries.push(entry);
      saveJournal(entries);
      console.log(`[dan-journal] Added: "${(body.title || body.content || "").substring(0, 60)}"`);
      return json(res, 201, { ok: true, entry });
    }

    /* ── ANCHOR DAN PROXY (to Command API) ──────────────────────── */
    if (urlPath === "/api/anchor-dan" && req.method === "POST") {
      if (!req.session) return json(res, 401, { error: "Not authenticated" });
      const body = await readBody(req);
      const COMMAND_URL = process.env.COMMAND_API_URL || "https://anchorcommand.myanchormortgage.com";
      const COMMAND_API_KEY = process.env.COMMAND_API_KEY || "";
      const proxyReq = https.request(`${COMMAND_URL}/api/ai-context`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": COMMAND_API_KEY,
          "X-Proxy-User": req.session.email,
        },
      }, proxyRes => {
        let d = "";
        proxyRes.on("data", c => d += c);
        proxyRes.on("end", () => {
          try { return json(res, 200, JSON.parse(d)); }
          catch { return json(res, 200, { response: d }); }
        });
      });
      proxyReq.on("error", e => json(res, 500, { error: e.message }));
      proxyReq.write(body);
      proxyReq.end();
      return;
    }

    /* ── DRIVE FOLDER SEARCH (proxy for Anchor Command) ────────── */
    if (urlPath === "/api/drive-search" && req.method === "POST") {
      const apiKey = req.headers["x-api-key"];
      if (!req.session && !(apiKey && apiKey === (process.env.COMMAND_API_KEY || ""))) {
        return json(res, 401, { error: "Not authenticated" });
      }
      try {
        const body = JSON.parse(await readBody(req));
        const borrowerName = body.borrowerName || "";
        const parentId = body.parentId || "";
        // Get access token from Tasks' OAuth token
        const tokenFile = path.join(DATA_DIR, "gcal-token.json");
        const tokenData = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
        if (!tokenData.refresh_token) return json(res, 500, { error: "No refresh token" });
        // Refresh access token
        const tokenResp = await httpsPost("https://oauth2.googleapis.com/token", JSON.stringify({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          refresh_token: tokenData.refresh_token,
          grant_type: "refresh_token",
        }), { "Content-Type": "application/json" });
        const tokenJson = JSON.parse(tokenResp);
        const accessToken = tokenJson.access_token;
        if (!accessToken) return json(res, 500, { error: "Failed to get access token" });
        // Search Drive
        const lastName = borrowerName.split(" ").pop().replace(/'/g, "\\'");
        const queries = [
          `name contains '${borrowerName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
          `name contains '${lastName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        ];
        for (const q of queries) {
          const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives&fields=files(id,name,webViewLink)`;
          const searchResp = await httpsGet(searchUrl, { Authorization: `Bearer ${accessToken}` });
          const searchJson = JSON.parse(searchResp);
          if (searchJson.files && searchJson.files.length > 0) {
            const firstName = borrowerName.split(" ")[0].toLowerCase();
            const best = searchJson.files.find(f => f.name.toLowerCase().includes(firstName)) || searchJson.files[0];
            return json(res, 200, { result: { folderId: best.id, folderUrl: best.webViewLink || `https://drive.google.com/drive/u/0/folders/${best.id}`, folderName: best.name } });
          }
        }
        return json(res, 200, { result: null });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    /* ── TASKS API ─────────────────────────────────────────────────── */
    if (urlPath === "/api/tasks" && req.method === "GET") {
      return json(res, 200, { tasks: parseTasks() });
    }

    if (urlPath === "/api/tasks" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const tasks = parseTasks();
      const task = {
        id: generateId(),
        title: String(body.title || "").substring(0, 200),
        assignee: String(body.assignee || req.session.name || "").substring(0, 100),
        due: String(body.due || "").substring(0, 10),
        priority: ["low", "normal", "high", "urgent"].includes(body.priority) ? body.priority : "normal",
        project: String(body.project || "").substring(0, 100),
        status: String(body.status || "").substring(0, 50),
        personal: !!body.personal,
        urgent: !!body.urgent,
        important: !!body.important,
        linkedGoal: String(body.linkedGoal || "").substring(0, 50),
        done: false,
      };
      if (!task.title) return json(res, 400, { error: "Title required" });
      tasks.push(task);
      writeTasks(tasks);
      return json(res, 201, { task });
    }

    if (urlPath.startsWith("/api/tasks/") && req.method === "PATCH") {
      const id = urlPath.split("/")[3];
      const body = JSON.parse(await readBody(req));
      const tasks = parseTasks();
      const idx = tasks.findIndex(t => t.id === id);
      if (idx === -1) return json(res, 404, { error: "Task not found" });
      if (body.title !== undefined) tasks[idx].title = String(body.title).substring(0, 200);
      if (body.assignee !== undefined) tasks[idx].assignee = String(body.assignee).substring(0, 100);
      if (body.due !== undefined) tasks[idx].due = String(body.due).substring(0, 10);
      if (body.priority !== undefined && ["low", "normal", "high", "urgent"].includes(body.priority)) tasks[idx].priority = body.priority;
      if (body.project !== undefined) tasks[idx].project = String(body.project).substring(0, 100);
      if (body.done !== undefined) tasks[idx].done = !!body.done;
      if (body.status !== undefined) tasks[idx].status = String(body.status).substring(0, 50);
      if (body.personal !== undefined) tasks[idx].personal = !!body.personal;
      if (body.urgent !== undefined) tasks[idx].urgent = !!body.urgent;
      if (body.important !== undefined) tasks[idx].important = !!body.important;
      if (body.linkedGoal !== undefined) tasks[idx].linkedGoal = String(body.linkedGoal).substring(0, 50);
      if (body.todayFocus !== undefined) tasks[idx].todayFocus = !!body.todayFocus;
      if (body.todayOrder !== undefined) tasks[idx].todayOrder = Math.max(0, parseInt(body.todayOrder) || 0);
      if (body.calEventId !== undefined) tasks[idx].calEventId = String(body.calEventId).substring(0, 200);
      if (body.scheduledStart !== undefined) tasks[idx].scheduledStart = String(body.scheduledStart).substring(0, 50);
      if (body.emailId !== undefined) tasks[idx].emailId = String(body.emailId).substring(0, 200);
      if (body.emailSubject !== undefined) tasks[idx].emailSubject = String(body.emailSubject).substring(0, 500);
      writeTasks(tasks);
      return json(res, 200, { task: tasks[idx] });
    }

    if (urlPath.startsWith("/api/tasks/") && req.method === "DELETE") {
      const id = urlPath.split("/")[3];
      const tasks = parseTasks();
      const filtered = tasks.filter(t => t.id !== id);
      if (filtered.length === tasks.length) return json(res, 404, { error: "Task not found" });
      writeTasks(filtered);
      return json(res, 200, { ok: true });
    }

    /* ── PROJECTS API ──────────────────────────────────────────────── */
    if (urlPath === "/api/projects" && req.method === "GET") {
      return json(res, 200, { projects: parseProjects() });
    }

    if (urlPath === "/api/projects" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const projects = parseProjects();
      const project = {
        id: generateId(),
        name: String(body.name || "").substring(0, 200),
        description: String(body.description || "").substring(0, 500),
        owner: String(body.owner || req.session.name || "").substring(0, 100),
        archived: false,
      };
      if (!project.name) return json(res, 400, { error: "Name required" });
      projects.push(project);
      writeProjects(projects);
      return json(res, 201, { project });
    }

    if (urlPath.startsWith("/api/projects/") && req.method === "PATCH") {
      const id = urlPath.split("/")[3];
      const body = JSON.parse(await readBody(req));
      const projects = parseProjects();
      const idx = projects.findIndex(p => p.id === id);
      if (idx === -1) return json(res, 404, { error: "Project not found" });
      if (body.name !== undefined) projects[idx].name = String(body.name).substring(0, 200);
      if (body.description !== undefined) projects[idx].description = String(body.description).substring(0, 500);
      if (body.owner !== undefined) projects[idx].owner = String(body.owner).substring(0, 100);
      if (body.archived !== undefined) projects[idx].archived = !!body.archived;
      writeProjects(projects);
      return json(res, 200, { project: projects[idx] });
    }

    if (urlPath.startsWith("/api/projects/") && req.method === "DELETE") {
      const id = urlPath.split("/")[3];
      const projects = parseProjects();
      const filtered = projects.filter(p => p.id !== id);
      if (filtered.length === projects.length) return json(res, 404, { error: "Project not found" });
      writeProjects(filtered);
      deleteProjectDetail(id);
      return json(res, 200, { ok: true });
    }

    /* ── PROJECT DETAIL API (notes, ethos, docs) ───────────────────── */
    const detailMatch = urlPath.match(/^\/api\/projects\/([a-f0-9]+)\/detail$/);
    if (detailMatch && req.method === "GET") {
      const id = detailMatch[1];
      return json(res, 200, readProjectDetail(id));
    }

    if (detailMatch && req.method === "PATCH") {
      const id = detailMatch[1];
      const body = JSON.parse(await readBody(req));
      const detail = readProjectDetail(id);
      if (body.notes !== undefined) detail.notes = String(body.notes).substring(0, 5000);
      if (body.ethos !== undefined) detail.ethos = String(body.ethos).substring(0, 2000);
      if (body.folderId !== undefined) detail.folderId = String(body.folderId).substring(0, 100);
      if (body.folderUrl !== undefined) detail.folderUrl = String(body.folderUrl).substring(0, 500);
      if (body.docs !== undefined && Array.isArray(body.docs)) {
        detail.docs = body.docs.slice(0, 50).map(d => ({
          name: String(d.name || "").substring(0, 200),
          url: String(d.url || "").substring(0, 500),
          notes: String(d.notes || "").substring(0, 500),
        }));
      }
      writeProjectDetail(id, detail);
      return json(res, 200, detail);
    }

    /* ── PROJECT DETAIL: add/remove single doc ─────────────────────── */
    const docMatch = urlPath.match(/^\/api\/projects\/([a-f0-9]+)\/docs$/);
    if (docMatch && req.method === "POST") {
      const id = docMatch[1];
      const body = JSON.parse(await readBody(req));
      const detail = readProjectDetail(id);
      if (!detail.docs) detail.docs = [];
      detail.docs.push({
        name: String(body.name || "").substring(0, 200),
        url: String(body.url || "").substring(0, 500),
        notes: String(body.notes || "").substring(0, 500),
      });
      writeProjectDetail(id, detail);
      return json(res, 201, detail);
    }

    if (docMatch && req.method === "DELETE") {
      const id = docMatch[1];
      const body = JSON.parse(await readBody(req));
      const detail = readProjectDetail(id);
      if (detail.docs && typeof body.index === "number") {
        detail.docs.splice(body.index, 1);
        writeProjectDetail(id, detail);
      }
      return json(res, 200, detail);
    }

    /* ── GOOGLE CALENDAR API ──────────────────────────────────── */
    // Status
    if (urlPath === "/api/gcal-status" && req.method === "GET") {
      const token = loadGCalToken();
      return json(res, 200, { connected: !!(token && token.refresh_token) });
    }

    // OAuth redirect
    if (urlPath === "/api/gcal-auth" && req.method === "GET") {
      if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
        return json(res, 500, { error: "Google OAuth not configured" });
      }
      // Delete old token to force fresh consent with new scopes
      try { if (fs.existsSync(GCAL_TOKEN_FILE)) fs.unlinkSync(GCAL_TOKEN_FILE); console.log("[gcal] Deleted old token for re-auth"); } catch {}
      const host = req.headers.host || "";
      const proto = IS_PRODUCTION ? "https" : "http";
      const redirectUri = `${proto}://${host}/api/gcal-callback`;
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: GCAL_SCOPES,
        access_type: "offline",
        prompt: "consent",
      }).toString();
      res.writeHead(302, { Location: authUrl });
      return res.end();
    }

    // OAuth callback (public — no auth required)
    if (urlPath === "/api/gcal-callback" && req.method === "GET") {
      const code = url.searchParams.get("code");
      if (!code) { res.writeHead(302, { Location: "/?gcal=error" }); return res.end(); }
      const host = req.headers.host || "";
      const proto = IS_PRODUCTION ? "https" : "http";
      const redirectUri = `${proto}://${host}/api/gcal-callback`;
      try {
        const params = new URLSearchParams({
          code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri, grant_type: "authorization_code",
        });
        const resp = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
        });
        const data = await resp.json();
        if (data.access_token) {
          // Keep existing refresh_token if Google didn't issue a new one (re-auth scenario)
          const existing = loadGCalToken();
          const refresh_token = data.refresh_token || (existing && existing.refresh_token) || null;
          if (refresh_token) {
            saveGCalToken({
              refresh_token,
              access_token: data.access_token,
              expires_at: Date.now() + (data.expires_in || 3600) * 1000,
              scope: data.scope || "",
            });
            console.log("[gcal] Connected successfully. Scopes:", data.scope || "(not returned)");
            res.writeHead(302, { Location: "/?gcal=connected" });
          } else {
            console.error("[gcal] No refresh token available:", data);
            res.writeHead(302, { Location: "/?gcal=error&reason=no_refresh_token" });
          }
        } else {
          console.error("[gcal] Token exchange failed:", data);
          res.writeHead(302, { Location: "/?gcal=error&reason=" + encodeURIComponent(data.error || "unknown") });
        }
      } catch (err) {
        console.error("[gcal] Callback error:", err.message);
        res.writeHead(302, { Location: "/?gcal=error" });
      }
      return res.end();
    }

    // Today's events
    if (urlPath === "/api/gcal-events" && req.method === "GET") {
      const events = await gcalGetTodayEvents();
      if (events === null) return json(res, 200, { events: [], connected: false });
      return json(res, 200, { events, connected: true });
    }

    // Range events (for calendar view)
    if (urlPath === "/api/calendar-events" && req.method === "GET") {
      const start = url.searchParams.get("start") || new Date().toISOString().substring(0, 10);
      const end = url.searchParams.get("end") || start;
      const events = await gcalGetRangeEvents(start, end);
      if (events === null) return json(res, 200, { events: [], connected: false });
      return json(res, 200, { events, connected: true });
    }

    // Schedule task to calendar
    const scheduleMatch = urlPath.match(/^\/api\/tasks\/([a-f0-9]+)\/schedule$/);
    if (scheduleMatch && req.method === "POST") {
      const id = scheduleMatch[1];
      const body = JSON.parse(await readBody(req));
      const tasks = parseTasks();
      const idx = tasks.findIndex(t => t.id === id);
      if (idx === -1) return json(res, 404, { error: "Task not found" });
      const t = tasks[idx];
      const { startTime, endTime, allDay, recurrence, timeZone } = body;
      const tz = timeZone || "America/New_York";
      let eventData;
      if (allDay) {
        const dateStr = (startTime || "").substring(0, 10);
        const nextDay = dateStr ? new Date(new Date(dateStr + "T12:00:00Z").getTime() + 86400000).toISOString().substring(0, 10) : dateStr;
        eventData = {
          summary: t.title,
          description: t.project ? `Project: ${t.project}` : "",
          start: { date: dateStr },
          end: { date: nextDay },
        };
      } else {
        eventData = {
          summary: t.title,
          description: t.project ? `Project: ${t.project}` : "",
          start: { dateTime: startTime, timeZone: tz },
          end: { dateTime: endTime, timeZone: tz },
        };
      }
      if (Array.isArray(recurrence) && recurrence.length) eventData.recurrence = recurrence;
      const evt = await gcalCreateOrUpdateEvent(t.calEventId || null, eventData);
      if (!evt) return json(res, 500, { error: "Failed to create calendar event" });
      tasks[idx].calEventId = evt.id;
      tasks[idx].scheduledStart = startTime || "";
      writeTasks(tasks);
      return json(res, 200, { task: tasks[idx], eventId: evt.id });
    }

    // Remove task from calendar
    if (scheduleMatch && req.method === "DELETE") {
      const id = scheduleMatch[1];
      const tasks = parseTasks();
      const idx = tasks.findIndex(t => t.id === id);
      if (idx === -1) return json(res, 404, { error: "Task not found" });
      if (tasks[idx].calEventId) await gcalDeleteEvent(tasks[idx].calEventId);
      tasks[idx].calEventId = "";
      tasks[idx].scheduledStart = "";
      writeTasks(tasks);
      return json(res, 200, { task: tasks[idx] });
    }

    // AI Prioritize — scoring algorithm
    if (urlPath === "/api/ai-prioritize" && req.method === "GET") {
      const tasks = parseTasks().filter(t => !t.done);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const scored = tasks.map(t => {
        let score = 0;
        // Priority
        if (t.priority === "urgent") score += 40;
        else if (t.priority === "high") score += 25;
        else if (t.priority === "normal") score += 10;
        else score += 2;
        // Due date
        if (t.due) {
          const due = new Date(t.due + "T00:00:00");
          const diff = Math.floor((due - today) / 86400000);
          if (diff < 0) score += 50;          // overdue
          else if (diff === 0) score += 40;   // due today
          else if (diff <= 2) score += 30;    // due in 2 days
          else if (diff <= 7) score += 20;    // due this week
          else if (diff <= 14) score += 10;   // due next 2 weeks
        }
        // Eisenhower flags
        if (t.urgent && t.important) score += 20;
        else if (t.important) score += 10;
        else if (t.urgent) score += 8;
        // Already in focus
        if (t.todayFocus) score += 5;
        return { ...t, _score: score };
      });
      scored.sort((a, b) => b._score - a._score);
      return json(res, 200, { tasks: scored.slice(0, 10).map(t => { const { _score, ...rest } = t; return { ...rest, score: _score }; }) });
    }

    /* ── GMAIL API ──────────────────────────────────────────────── */
    if (urlPath === "/api/gmail-inbox" && req.method === "GET") {
      const result = await gmailGetInbox();
      if (result === null) return json(res, 200, { emails: [], connected: false });
      if (result && result.needsReauth) return json(res, 200, { emails: [], connected: false, needsReauth: true });
      return json(res, 200, { emails: result, connected: true });
    }

    if (urlPath.match(/^\/api\/gmail-mark-read\//) && req.method === "POST") {
      const msgId = urlPath.split("/").pop();
      const ok = await gmailMarkRead(msgId);
      return json(res, 200, { ok });
    }

    if (urlPath.match(/^\/api\/gmail-message\/[^/]+$/) && req.method === "GET") {
      const msgId = urlPath.split("/").pop();
      const accessToken = await getGCalAccessToken();
      if (!accessToken) return json(res, 401, { error: "Not authorized" });
      try {
        const msgResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=full`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!msgResp.ok) return json(res, msgResp.status, { error: "Failed to fetch message" });
        const msg = await msgResp.json();
        const body = gmailExtractBody(msg.payload);
        // Collect attachments
        const attachments = [];
        function findAttachments(p) {
          if (!p) return;
          if (p.filename && p.body?.attachmentId) {
            attachments.push({ name: p.filename, attachmentId: p.body.attachmentId, mimeType: p.mimeType, size: p.body.size || 0 });
          }
          if (p.parts) p.parts.forEach(findAttachments);
        }
        findAttachments(msg.payload);
        return json(res, 200, { body, attachments });
      } catch (err) {
        console.error("[gmail] Message fetch error:", err.message);
        return json(res, 500, { error: "Failed to fetch message" });
      }
    }

    // Download attachment
    const attachMatch = urlPath.match(/^\/api\/gmail-message\/([^/]+)\/attachment\/([^/]+)$/);
    if (attachMatch && req.method === "GET") {
      const [, msgId, attachmentId] = attachMatch;
      const name = url.searchParams.get("name") || "attachment";
      const mimeType = url.searchParams.get("mime") || "application/octet-stream";
      const accessToken = await getGCalAccessToken();
      if (!accessToken) return json(res, 401, { error: "Not authorized" });
      try {
        const attResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/attachments/${attachmentId}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!attResp.ok) return json(res, attResp.status, { error: "Failed to fetch attachment" });
        const attData = await attResp.json();
        const buf = Buffer.from(attData.data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
        res.writeHead(200, {
          "Content-Type": mimeType,
          "Content-Disposition": `attachment; filename="${name.replace(/"/g, "")}"`,
          "Content-Length": buf.length,
        });
        return res.end(buf);
      } catch (err) {
        console.error("[gmail] Attachment fetch error:", err.message);
        return json(res, 500, { error: "Failed to fetch attachment" });
      }
    }

    if (urlPath.match(/^\/api\/gmail-archive\//) && req.method === "POST") {
      const msgId = urlPath.split("/").pop();
      const ok = await gmailArchive(msgId);
      return json(res, 200, { ok });
    }

    if (urlPath.match(/^\/api\/gmail-delete\//) && req.method === "POST") {
      const msgId = urlPath.split("/").pop();
      const accessToken = await getGCalAccessToken();
      if (!accessToken) return json(res, 401, { error: "Not authorized" });
      try {
        const resp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/trash`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        return json(res, 200, { ok: resp.ok });
      } catch { return json(res, 500, { ok: false }); }
    }

    /* ── GOALS API ──────────────────────────────────────────────── */
    if (urlPath === "/api/goals" && req.method === "GET") {
      const goals = readGoals();
      return json(res, 200, { goals });
    }

    if (urlPath === "/api/goals" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const goals = readGoals();
      const goal = {
        id: generateId(),
        title: String(body.title || "").substring(0, 200),
        description: String(body.description || "").substring(0, 1000),
        targetDate: String(body.targetDate || "").substring(0, 10),
        category: ["personal", "professional"].includes(body.category) ? body.category : "professional",
        progress: Math.min(100, Math.max(0, parseInt(body.progress) || 0)),
        linkedTasks: Array.isArray(body.linkedTasks) ? body.linkedTasks.map(id => String(id).substring(0, 20)) : [],
      };
      if (!goal.title) return json(res, 400, { error: "Title required" });
      goals.push(goal);
      writeGoals(goals);
      return json(res, 201, { goal });
    }

    const goalMatch = urlPath.match(/^\/api\/goals\/([a-f0-9]+)$/);
    if (goalMatch && req.method === "PATCH") {
      const id = goalMatch[1];
      const body = JSON.parse(await readBody(req));
      const goals = readGoals();
      const idx = goals.findIndex(g => g.id === id);
      if (idx === -1) return json(res, 404, { error: "Goal not found" });
      if (body.title !== undefined) goals[idx].title = String(body.title).substring(0, 200);
      if (body.description !== undefined) goals[idx].description = String(body.description).substring(0, 1000);
      if (body.targetDate !== undefined) goals[idx].targetDate = String(body.targetDate).substring(0, 10);
      if (body.category !== undefined && ["personal", "professional"].includes(body.category)) goals[idx].category = body.category;
      if (body.progress !== undefined) goals[idx].progress = Math.min(100, Math.max(0, parseInt(body.progress) || 0));
      if (body.linkedTasks !== undefined && Array.isArray(body.linkedTasks)) goals[idx].linkedTasks = body.linkedTasks.map(id => String(id).substring(0, 20));
      writeGoals(goals);
      return json(res, 200, { goal: goals[idx] });
    }

    if (goalMatch && req.method === "DELETE") {
      const id = goalMatch[1];
      const goals = readGoals();
      const filtered = goals.filter(g => g.id !== id);
      if (filtered.length === goals.length) return json(res, 404, { error: "Goal not found" });
      writeGoals(filtered);
      return json(res, 200, { ok: true });
    }

    /* ── CONTENT ENGINE ─────────────────────────────────────────────── */
    if (urlPath === "/api/content" && req.method === "GET") {
      const contentEngine = require("./content-engine");
      const params = url.searchParams;
      const start = params.get("start");
      const end = params.get("end");
      if (start && end) return json(res, 200, { posts: contentEngine.getPostsByDateRange(start, end) });
      return json(res, 200, { posts: contentEngine.getUpcomingPosts(14), framework: contentEngine.CONTENT_FRAMEWORK });
    }

    if (urlPath === "/api/content/generate" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const contentEngine = require("./content-engine");
      try {
        console.log("[content] Generating two-week plan...");
        const pipelineCtx = await contentEngine.fetchPipelineContext();
        const posts = await contentEngine.generateTwoWeekPlan(pipelineCtx, body.instructions || "");
        console.log(`[content] Generated ${posts.length} posts`);
        return json(res, 200, { ok: true, posts });
      } catch (e) {
        console.error("[content] Generation error:", e.message);
        return json(res, 500, { error: e.message });
      }
    }

    if (urlPath === "/api/content/generate-single" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const contentEngine = require("./content-engine");
      try {
        const pipelineCtx = await contentEngine.fetchPipelineContext();
        const post = await contentEngine.generateSinglePost(body.date, body.dayName, body.theme, pipelineCtx, body.instructions || "");
        return json(res, 200, { ok: true, post });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }

    const contentPostMatch = urlPath.match(/^\/api\/content\/([a-z0-9-]+)$/);
    if (contentPostMatch && req.method === "PATCH") {
      const body = JSON.parse(await readBody(req));
      const contentEngine = require("./content-engine");
      const post = contentEngine.updatePost(contentPostMatch[1], body);
      if (!post) return json(res, 404, { error: "Post not found" });
      return json(res, 200, { ok: true, post });
    }

    if (contentPostMatch && req.method === "DELETE") {
      const contentEngine = require("./content-engine");
      contentEngine.deletePost(contentPostMatch[1]);
      return json(res, 200, { ok: true });
    }

    if (urlPath === "/api/content/feedback" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const contentEngine = require("./content-engine");
      if (!body.postId || !body.feedback) return json(res, 400, { error: "postId and feedback required" });
      contentEngine.recordPostFeedback(body.postId, body.feedback);
      return json(res, 200, { ok: true });
    }

    // Dan API: content access
    if (urlPath === "/api/dan/content-upcoming" && (req.method === "GET" || req.method === "POST")) {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const contentEngine = require("./content-engine");
      return json(res, 200, { posts: contentEngine.getUpcomingPosts(14) });
    }

    if (urlPath === "/api/dan/content-generate" && req.method === "POST") {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      const contentEngine = require("./content-engine");
      try {
        const pipelineCtx = await contentEngine.fetchPipelineContext();
        const posts = await contentEngine.generateTwoWeekPlan(pipelineCtx, body.instructions || "");
        return json(res, 200, { ok: true, posts });
      } catch (e) { return json(res, 500, { error: e.message }); }
    }

    /* ── GCAL EVENT EDIT ────────────────────────────────────────────── */
    const gcalEventMatch = urlPath.match(/^\/api\/gcal-event\/([^/]+)$/);
    if (gcalEventMatch && (req.method === "PATCH" || req.method === "DELETE")) {
      const eventId = gcalEventMatch[1];
      const accessToken = await getGCalAccessToken();
      if (!accessToken) return json(res, 401, { error: "Not authorized" });

      // Determine which calendar (source param tells us)
      const sourceParam = url.searchParams.get("source") || "personal";
      const calId = sourceParam === "anchor" ? ANCHOR_GCAL_CALENDAR_ID : GCAL_CALENDAR_ID;

      if (req.method === "DELETE") {
        const delUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${eventId}`;
        const delResp = await fetch(delUrl, { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } });
        return json(res, delResp.ok || delResp.status === 404 ? 200 : 500, { ok: delResp.ok });
      }

      // PATCH — update event
      const body = JSON.parse(await readBody(req));
      const { title, startTime, endTime, allDay, timeZone, location } = body;
      const tz = timeZone || "America/New_York";
      let eventData;
      if (allDay) {
        const dateStr = (startTime || "").substring(0, 10);
        const nextDay = dateStr ? new Date(new Date(dateStr + "T12:00:00Z").getTime() + 86400000).toISOString().substring(0, 10) : dateStr;
        eventData = { summary: title, start: { date: dateStr }, end: { date: nextDay } };
      } else {
        eventData = { summary: title, start: { dateTime: startTime, timeZone: tz }, end: { dateTime: endTime, timeZone: tz } };
      }
      if (location !== undefined) eventData.location = location;

      const patchUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${eventId}`;
      const patchResp = await fetch(patchUrl, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(eventData),
      });
      if (!patchResp.ok) {
        const err = await patchResp.text();
        console.error("[gcal] Event patch failed:", patchResp.status, err);
        return json(res, 500, { error: "Failed to update event" });
      }
      return json(res, 200, { ok: true });
    }

    /* ── JOURNAL API ────────────────────────────────────────────────── */
    if (urlPath === "/api/journal" && req.method === "GET") {
      const entries = loadJournal();
      entries.sort((a, b) => (b.date > a.date ? 1 : -1));
      return json(res, 200, { entries });
    }

    if (urlPath === "/api/journal" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const date = String(body.date || "").substring(0, 10);
      const content = String(body.content || "").substring(0, 50000);
      const title = String(body.title || "").substring(0, 200);
      if (!date) return json(res, 400, { error: "date required" });
      const entries = loadJournal();
      const existing = entries.findIndex(e => e.date === date);
      if (existing !== -1) {
        entries[existing].content = content;
        entries[existing].title = title;
        entries[existing].updatedAt = new Date().toISOString();
        saveJournal(entries);
        return json(res, 200, { entry: entries[existing] });
      }
      const entry = { id: generateId(), date, title, content, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      entries.push(entry);
      saveJournal(entries);
      return json(res, 201, { entry });
    }

    const journalMatch = urlPath.match(/^\/api\/journal\/([a-f0-9]+)$/);
    if (journalMatch && req.method === "DELETE") {
      const id = journalMatch[1];
      const entries = loadJournal();
      const filtered = entries.filter(e => e.id !== id);
      if (filtered.length === entries.length) return json(res, 404, { error: "Entry not found" });
      saveJournal(filtered);
      return json(res, 200, { ok: true });
    }

    /* ── Static files / SPA fallback ───────────────────────────────── */
    // Auth wall for HTML pages
    if (!PUBLIC_PATHS.includes(urlPath) && !urlPath.startsWith("/api/")) {
      const session = getSession(req);
      if (!session && (urlPath === "/" || urlPath.endsWith(".html"))) {
        const loginPath = path.join(BASE, "login.html");
        if (fs.existsSync(loginPath)) {
          const html = fs.readFileSync(loginPath, "utf8");
          res.writeHead(200, { "Content-Type": "text/html" });
          return res.end(html);
        }
      }
    }

    // Serve static file
    let filePath = path.join(BASE, urlPath === "/" ? "app.html" : urlPath);
    filePath = path.normalize(filePath);
    if (!filePath.startsWith(BASE)) return json(res, 403, { error: "Forbidden" });

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const ct = MIME[ext] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": ct });
      return res.end(fs.readFileSync(filePath));
    }

    json(res, 404, { error: "Not found" });

  } catch (err) {
    console.error("[server] Error:", err);
    json(res, 500, { error: "Internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`[anchor-tasks] Listening on :${PORT}`);
  console.log(`[anchor-tasks] Auth: ${GOOGLE_CLIENT_ID ? "Google OAuth configured" : "⚠ GOOGLE_CLIENT_ID not set"}`);
  console.log(`[anchor-tasks] Allowed emails: ${ALLOWED_EMAILS.length || "any (no whitelist)"}`);
  console.log(`[anchor-tasks] Data dir: ${DATA_DIR}`);
});
