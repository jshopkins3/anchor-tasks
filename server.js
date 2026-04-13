const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const webpush = require("web-push");

/* ─── Config ─────────────────────────────────────────────────────────── */
const PORT = process.env.PORT || 8080;
const BASE = __dirname;
const DATA_DIR = path.join(BASE, "data");
const SHARED_DIR = path.join(DATA_DIR, "shared");
const USERS_DIR = path.join(DATA_DIR, "users");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");

// Legacy flat-file paths (used as fallbacks during migration)
const TASKS_FILE = path.join(DATA_DIR, "tasks.md");
const PROJECTS_FILE = path.join(DATA_DIR, "projects.md");
const GOALS_FILE = path.join(DATA_DIR, "goals.json");
const JOURNAL_FILE = path.join(DATA_DIR, "journal.json");
const GCAL_TOKEN_FILE = path.join(DATA_DIR, "gcal-token.json");
const EMAIL_CONTACTS_FILE = path.join(DATA_DIR, "email-contacts.json");
const EMAIL_SIGNATURE_FILE = path.join(DATA_DIR, "email-signature.json");
const PUSH_SUBSCRIPTIONS_FILE = path.join(DATA_DIR, "push-subscriptions.json");

/* ─── Multi-user helpers ─────────────────────────────────────────────── */
const OWNER_EMAIL = (process.env.OWNER_EMAIL || "").toLowerCase() ||
  ((process.env.ALLOWED_EMAILS || "").split(",")[0] || "").trim().toLowerCase();

function getUserDir(email) {
  return path.join(USERS_DIR, email.toLowerCase().replace(/[^a-z0-9@._-]/g, ""));
}

function ensureUserDir(email) {
  const dir = getUserDir(email);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "tasks.md"), "# Tasks\n\n## Active\n\n## Completed\n", "utf8");
    fs.writeFileSync(path.join(dir, "goals.json"), "[]", "utf8");
    fs.writeFileSync(path.join(dir, "journal.json"), "[]", "utf8");
    console.log(`[multiuser] Created workspace for ${email}`);
  }
  return dir;
}

// User-scoped file paths
function userFile(email, filename) { return path.join(getUserDir(email), filename); }
function userTasksFile(email) { return userFile(email, "tasks.md"); }
function userGoalsFile(email) { return userFile(email, "goals.json"); }
function userJournalFile(email) { return userFile(email, "journal.json"); }
function userGCalTokenFile(email) { return userFile(email, "gcal-token.json"); }
function userEmailContactsFile(email) { return userFile(email, "email-contacts.json"); }
function userEmailSignatureFile(email) { return userFile(email, "email-signature.json"); }
function userPushSubsFile(email) { return userFile(email, "push-subscriptions.json"); }

// Shared file paths
function sharedProjectsFile() { return path.join(SHARED_DIR, "projects.md"); }
function sharedProjectDetailPath(id) { return path.join(SHARED_DIR, `project-${id}.json`); }

// VAPID keys for push notifications
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "BObEhtMss78OTAVIU_2bq7RAom1BF5_Yh2HR444L7Mbq3hejOAGhJi2w07oKhqMS-sDGWYzuremKk8fYkvlnz0M";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "Ru4ias01IaUsTeo-o7xtftzEnIi5gMJwg3e06aOxOM4";
webpush.setVapidDetails("mailto:john.hopkins@mychomeloans.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

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
  "https://www.googleapis.com/auth/gmail.send",
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
const IS_PRODUCTION = !!process.env.RAILWAY_ENVIRONMENT;

// Persistent sessions (survive server restarts)
function loadSessions() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
    const now = Date.now();
    const valid = {};
    for (const [id, sess] of Object.entries(raw)) {
      if (now - sess.createdAt < 7 * 24 * 60 * 60 * 1000) valid[id] = sess;
    }
    return new Map(Object.entries(valid));
  } catch { return new Map(); }
}
function saveSessions() {
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions), null, 2), "utf8"); } catch {}
}
const sessions = loadSessions();

/* ─── Ensure data dirs + migrate to multi-user ──────────────────────── */
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SHARED_DIR)) fs.mkdirSync(SHARED_DIR, { recursive: true });
if (!fs.existsSync(USERS_DIR)) fs.mkdirSync(USERS_DIR, { recursive: true });

// Migration: move existing flat files to multi-user structure
(function migrateToMultiUser() {
  if (!OWNER_EMAIL) return; // Can't migrate without knowing the owner
  const ownerDir = getUserDir(OWNER_EMAIL);
  // Re-run migration if flat files exist and are larger than user copies
  const flatTasks = path.join(DATA_DIR, "tasks.md");
  const userTasks = path.join(ownerDir, "tasks.md");
  const needsMigration = fs.existsSync(flatTasks) && (!fs.existsSync(userTasks) || fs.statSync(flatTasks).size > fs.statSync(userTasks).size);
  if (fs.existsSync(ownerDir) && !needsMigration) return; // Already migrated

  console.log("[migration] Migrating to multi-user for:", OWNER_EMAIL);
  if (!fs.existsSync(ownerDir)) fs.mkdirSync(ownerDir, { recursive: true });

  // Move per-user files to owner's directory (overwrite if source is larger)
  const userFiles = ["tasks.md", "goals.json", "journal.json", "notebook.json",
    "gcal-token.json", "email-contacts.json", "email-signature.json",
    "push-subscriptions.json", "finance.json", "signature-img.png", "signature-img.jpg", "signature-img.gif"];
  for (const file of userFiles) {
    const src = path.join(DATA_DIR, file);
    const dest = path.join(ownerDir, file);
    if (fs.existsSync(src)) {
      const srcSize = fs.statSync(src).size;
      const destSize = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
      if (srcSize > destSize) {
        fs.copyFileSync(src, dest);
        console.log(`[migration] Copied ${file} (${srcSize} bytes) -> users/${OWNER_EMAIL}/`);
      }
    }
  }

  // Move projects to owner's user dir (projects are now per-user)
  const projSrc = path.join(DATA_DIR, "projects.md");
  const projDest = path.join(ownerDir, "projects.md");
  if (fs.existsSync(projSrc)) {
    const srcSize = fs.statSync(projSrc).size;
    const destSize = fs.existsSync(projDest) ? fs.statSync(projDest).size : 0;
    if (srcSize > destSize) {
      fs.copyFileSync(projSrc, projDest);
      console.log(`[migration] Copied projects.md (${srcSize} bytes) -> users/${OWNER_EMAIL}/`);
    }
  }
  // Also keep in shared for backward compat
  const sharedFiles = ["projects.md", "taglines.json", "content-calendar.json", "content-feedback.json"];
  for (const file of sharedFiles) {
    const src = path.join(DATA_DIR, file);
    const dest = path.join(SHARED_DIR, file);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
      console.log(`[migration] Copied ${file} -> shared/`);
    }
  }

  // Move project detail files to shared
  try {
    const allFiles = fs.readdirSync(DATA_DIR);
    for (const file of allFiles) {
      if (file.startsWith("project-") && file.endsWith(".json")) {
        const src = path.join(DATA_DIR, file);
        const dest = path.join(SHARED_DIR, file);
        if (!fs.existsSync(dest)) {
          fs.copyFileSync(src, dest);
          console.log(`[migration] Copied ${file} -> shared/`);
        }
      }
    }
  } catch {}

  // Move signature image if exists
  for (const ext of [".png", ".jpg", ".gif"]) {
    const src = path.join(DATA_DIR, `signature-img${ext}`);
    const dest = path.join(ownerDir, `signature-img${ext}`);
    if (fs.existsSync(src) && !fs.existsSync(dest)) fs.copyFileSync(src, dest);
  }

  console.log("[migration] Multi-user migration complete!");
})();

// Ensure shared projects file exists
if (!fs.existsSync(sharedProjectsFile())) {
  fs.writeFileSync(sharedProjectsFile(), "# Projects\n\n## Active\n\n## Archived\n", "utf8");
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
  ensureUserDir(userData.email);
  sessions.set(id, { ...userData, createdAt: Date.now() });
  saveSessions();
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

function parseTasks(email) {
  const file = email ? userTasksFile(email) : TASKS_FILE;
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
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
      assigneeEmail: parts[17] || "",
      done,
    });
  }
  return tasks;
}

function writeTasks(tasks, email) {
  const file = email ? userTasksFile(email) : TASKS_FILE;
  const active = tasks.filter(t => !t.done);
  const completed = tasks.filter(t => t.done);
  const fmt = t => `- [${t.done ? "x" : " "}] ${t.id} | ${t.title} | ${t.assignee} | ${t.due} | ${t.priority} | ${t.project} | ${t.status || ""} | ${t.personal ? "true" : "false"} | ${t.urgent ? "true" : "false"} | ${t.important ? "true" : "false"} | ${t.linkedGoal || ""} | ${t.todayFocus ? "true" : "false"} | ${t.todayOrder || 0} | ${t.calEventId || ""} | ${t.scheduledStart || ""} | ${t.emailId || ""} | ${t.emailSubject || ""} | ${t.assigneeEmail || ""}`;
  const md = [
    "# Tasks", "",
    "## Active", ...active.map(fmt), "",
    "## Completed", ...completed.map(fmt), "",
  ].join("\n");
  fs.writeFileSync(file, md, "utf8");
}

// Get tasks assigned TO this user from other users
function getAssignedTasks(email) {
  if (!fs.existsSync(USERS_DIR)) return [];
  const assigned = [];
  try {
    const userDirs = fs.readdirSync(USERS_DIR);
    for (const userEmail of userDirs) {
      if (userEmail === email.toLowerCase()) continue;
      const tasks = parseTasks(userEmail);
      for (const t of tasks) {
        if (t.assigneeEmail && t.assigneeEmail.toLowerCase() === email.toLowerCase()) {
          assigned.push({ ...t, _fromUser: userEmail });
        }
      }
    }
  } catch {}
  return assigned;
}

// Get all tasks for a specific project across all users
function getProjectTasks(projectName) {
  if (!fs.existsSync(USERS_DIR)) return [];
  const all = [];
  try {
    const userDirs = fs.readdirSync(USERS_DIR);
    for (const userEmail of userDirs) {
      const tasks = parseTasks(userEmail);
      for (const t of tasks) {
        if (t.project === projectName) all.push({ ...t, _userEmail: userEmail });
      }
    }
  } catch {}
  return all;
}

function parseProjects(email) {
  // Projects are now per-user, with a members field for sharing
  const file = email ? userFile(email, "projects.md") :
    (fs.existsSync(sharedProjectsFile()) ? sharedProjectsFile() : PROJECTS_FILE);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
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
      ownerEmail: parts[4] || "",
      members: parts[5] ? parts[5].split(";").filter(Boolean) : [],
      archived,
    });
  }
  return projects;
}

function writeProjects(projects, email) {
  const file = email ? userFile(email, "projects.md") : sharedProjectsFile();
  const active = projects.filter(p => !p.archived);
  const archived = projects.filter(p => p.archived);
  const fmt = p => `- [${p.archived ? "x" : " "}] ${p.id} | ${p.name} | ${p.description} | ${p.owner} | ${p.ownerEmail || ""} | ${(p.members || []).join(";")}`;
  const md = [
    "# Projects", "",
    "## Active", ...active.map(fmt), "",
    "## Archived", ...archived.map(fmt), "",
  ].join("\n");
  fs.writeFileSync(file, md, "utf8");
}

// Get all projects visible to a user (their own + ones they're a member of)
function getVisibleProjects(email) {
  if (!email) return parseProjects();
  // User's own projects
  const own = parseProjects(email);
  // Scan other users for projects where this email is a member
  const assigned = [];
  if (fs.existsSync(USERS_DIR)) {
    try {
      const userDirs = fs.readdirSync(USERS_DIR);
      for (const otherEmail of userDirs) {
        if (otherEmail === email.toLowerCase()) continue;
        const otherProjects = parseProjects(otherEmail);
        for (const p of otherProjects) {
          if ((p.members || []).some(m => m.toLowerCase() === email.toLowerCase())) {
            assigned.push({ ...p, _sharedBy: otherEmail });
          }
        }
      }
    } catch {}
  }
  // Also include legacy shared projects if they exist
  if (fs.existsSync(sharedProjectsFile())) {
    const shared = parseProjects(); // no email = shared file
    for (const p of shared) {
      if (!own.find(o => o.id === p.id) && !assigned.find(a => a.id === p.id)) {
        own.push(p);
      }
    }
  }
  return [...own, ...assigned];
}

/* ─── Goals engine ────────────────────────────────────────────────────── */
function readGoals(email) {
  const file = email ? userGoalsFile(email) : GOALS_FILE;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return []; }
}

function writeGoals(goals, email) {
  const file = email ? userGoalsFile(email) : GOALS_FILE;
  fs.writeFileSync(file, JSON.stringify(goals, null, 2), "utf8");
}

/* ─── Google Calendar helpers ────────────────────────────────────────────── */
function loadGCalToken(email) {
  // Try user-specific token first
  if (email) {
    try {
      const userFile = userGCalTokenFile(email);
      if (fs.existsSync(userFile)) return JSON.parse(fs.readFileSync(userFile, "utf8"));
    } catch {}
  }
  // Fallback to legacy flat file
  try {
    if (fs.existsSync(GCAL_TOKEN_FILE)) return JSON.parse(fs.readFileSync(GCAL_TOKEN_FILE, "utf8"));
  } catch {}
  // Fallback: restore from env var (survives Railway redeploys)
  try {
    if (process.env.GCAL_TOKEN) {
      const token = JSON.parse(process.env.GCAL_TOKEN);
      const dest = email ? userGCalTokenFile(email) : GCAL_TOKEN_FILE;
      fs.writeFileSync(dest, JSON.stringify(token, null, 2));
      console.log("[gcal] Restored token from GCAL_TOKEN env var");
      return token;
    }
  } catch {}
  return null;
}
function saveGCalToken(token, email) {
  const file = email ? userGCalTokenFile(email) : GCAL_TOKEN_FILE;
  fs.writeFileSync(file, JSON.stringify(token, null, 2));
  console.log("[gcal] TOKEN_FOR_ENV:", JSON.stringify(token));
}

async function getGCalAccessToken(email) {
  const token = loadGCalToken(email);
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
      saveGCalToken(token, email);
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

/* ─── Gmail: list messages by label with pagination ────────────────────── */
async function gmailListMessages(labelId, pageToken, maxResults = 50, query = "") {
  const accessToken = await getGCalAccessToken();
  if (!accessToken) return null;
  try {
    const params = { maxResults: String(maxResults) };
    if (labelId) params.labelIds = labelId;
    if (pageToken) params.pageToken = pageToken;
    if (query) params.q = query;
    const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams(params)}`;
    const listResp = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!listResp.ok) {
      if (listResp.status === 401 || listResp.status === 403) return { needsReauth: true };
      return null;
    }
    const listData = await listResp.json();
    const messages = listData.messages || [];
    if (!messages.length) return { emails: [], nextPageToken: null };
    const emails = await Promise.all(messages.map(async m => {
      const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata` +
        `&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Cc`;
      const msgResp = await fetch(msgUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!msgResp.ok) return null;
      const msg = await msgResp.json();
      const headers = msg.payload?.headers || [];
      const from = parseEmailHeader(headers, "From");
      const fromMatch = from.match(/^"?([^"<]+)"?\s*<?([^>]*)>?$/);
      const fromName = fromMatch ? fromMatch[1].trim() : from;
      const fromEmail = fromMatch ? fromMatch[2].trim() : from;
      return {
        id: m.id, threadId: msg.threadId,
        subject: parseEmailHeader(headers, "Subject") || "(No subject)",
        from: fromName || fromEmail, fromEmail,
        to: parseEmailHeader(headers, "To"),
        snippet: msg.snippet || "",
        date: parseEmailHeader(headers, "Date"),
        unread: (msg.labelIds || []).includes("UNREAD"),
        starred: (msg.labelIds || []).includes("STARRED"),
        labelIds: msg.labelIds || [],
      };
    }));
    return { emails: emails.filter(Boolean), nextPageToken: listData.nextPageToken || null };
  } catch (err) {
    console.error("[gmail] List messages error:", err.message);
    return null;
  }
}

/* ─── Gmail: get full thread ───────────────────────────────────────────── */
async function gmailGetThread(threadId) {
  const accessToken = await getGCalAccessToken();
  if (!accessToken) return null;
  try {
    const resp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return null;
    const thread = await resp.json();
    const messages = (thread.messages || []).map(msg => {
      const h = msg.payload?.headers || [];
      const from = parseEmailHeader(h, "From");
      const fromMatch = from.match(/^"?([^"<]+)"?\s*<?([^>]*)>?$/);
      const fromName = fromMatch ? fromMatch[1].trim() : from;
      const fromEmail = fromMatch ? fromMatch[2].trim() : from;
      const body = gmailExtractBody(msg.payload);
      const attachments = [];
      function findAttachments(p) {
        if (!p) return;
        if (p.filename && p.body?.attachmentId) {
          // Skip inline images (signature logos, etc.) - they have Content-ID headers
          const contentDisp = (p.headers || []).find(h => h.name.toLowerCase() === "content-disposition");
          const contentId = (p.headers || []).find(h => h.name.toLowerCase() === "content-id");
          const isInline = (contentDisp && /^\s*inline/i.test(contentDisp.value)) || (contentId && /^image\//i.test(p.mimeType));
          if (!isInline) {
            attachments.push({ name: p.filename, attachmentId: p.body.attachmentId, mimeType: p.mimeType, size: p.body.size || 0 });
          }
        }
        if (p.parts) p.parts.forEach(findAttachments);
      }
      findAttachments(msg.payload);
      return {
        id: msg.id, threadId: msg.threadId,
        from: fromName || fromEmail, fromEmail,
        to: parseEmailHeader(h, "To"),
        cc: parseEmailHeader(h, "Cc"),
        bcc: parseEmailHeader(h, "Bcc"),
        replyTo: parseEmailHeader(h, "Reply-To"),
        subject: parseEmailHeader(h, "Subject") || "(No subject)",
        date: parseEmailHeader(h, "Date"),
        messageId: parseEmailHeader(h, "Message-ID"),
        inReplyTo: parseEmailHeader(h, "In-Reply-To"),
        references: parseEmailHeader(h, "References"),
        body, attachments,
        unread: (msg.labelIds || []).includes("UNREAD"),
        starred: (msg.labelIds || []).includes("STARRED"),
        labelIds: msg.labelIds || [],
      };
    });
    return { id: thread.id, messages };
  } catch (err) {
    console.error("[gmail] Thread fetch error:", err.message);
    return null;
  }
}

/* ─── Gmail: send email (full RFC 2822) ────────────────────────────────── */
/* ─── Gmail: fetch user's email signature ──────────────────────────── */
let cachedSignature = null;
let signatureCacheTime = 0;
async function gmailGetSignature() {
  const now = Date.now();
  if (cachedSignature !== null && (now - signatureCacheTime) < 3600000) return cachedSignature;
  const accessToken = await getGCalAccessToken();
  if (!accessToken) return "";
  try {
    const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return "";
    const data = await resp.json();
    // Find primary sendAs (isDefault or isPrimary)
    const primary = (data.sendAs || []).find(s => s.isDefault || s.isPrimary) || (data.sendAs || [])[0];
    cachedSignature = primary?.signature || "";
    signatureCacheTime = now;
    return cachedSignature;
  } catch { return ""; }
}

async function gmailSendEmail({ to, cc, bcc, subject, body, bodyHtml, inReplyTo, references, threadId }) {
  const accessToken = await getGCalAccessToken();
  if (!accessToken) return { error: "No access token" };
  try {
    // Fetch Gmail signature and append
    const plainBody = body || "";
    // Use local signature from app settings (not Gmail API)
    let signature = "";
    try {
      const sigData = JSON.parse(fs.readFileSync(EMAIL_SIGNATURE_FILE, "utf8"));
      signature = sigData.html || "";
    } catch {}
    const rawLines = [];
    rawLines.push(`From: me`);
    if (to) rawLines.push(`To: ${to}`);
    if (cc) rawLines.push(`Cc: ${cc}`);
    if (bcc) rawLines.push(`Bcc: ${bcc}`);
    rawLines.push(`Subject: ${subject || ""}`);
    if (inReplyTo) rawLines.push(`In-Reply-To: ${inReplyTo}`);
    if (references) rawLines.push(`References: ${references}`);
    rawLines.push(`MIME-Version: 1.0`);

    // Build the raw email using base64-encoded parts to avoid boundary conflicts
    const boundary = `000000000000${crypto.randomBytes(12).toString("hex")}`;
    const escapedBody = plainBody.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>");
    const htmlContent = signature
      ? `<div dir="ltr"><div dir="ltr"><div style="font-family:Arial,sans-serif;font-size:14px;color:#000">${escapedBody}</div></div><br clear="all"><div><br></div>-- <br><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature">${signature}</div></div>`
      : `<div dir="ltr">${escapedBody}</div>`;
    const textPart = Buffer.from(plainBody, "utf8").toString("base64");
    const htmlPart = Buffer.from(htmlContent, "utf8").toString("base64");

    rawLines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    rawLines.push("");
    rawLines.push(`--${boundary}`);
    rawLines.push(`Content-Type: text/plain; charset="UTF-8"`);
    rawLines.push(`Content-Transfer-Encoding: base64`);
    rawLines.push("");
    rawLines.push(textPart);
    rawLines.push(`--${boundary}`);
    rawLines.push(`Content-Type: text/html; charset="UTF-8"`);
    rawLines.push(`Content-Transfer-Encoding: base64`);
    rawLines.push("");
    rawLines.push(htmlPart);
    rawLines.push(`--${boundary}--`);
    const rawEmail = rawLines.join("\r\n");
    const encoded = Buffer.from(rawEmail).toString("base64url");
    const payload = { raw: encoded };
    if (threadId) payload.threadId = threadId;
    const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) { const errBody = await resp.text(); console.error("[gmail] Send failed:", resp.status, errBody); return { error: `Gmail API ${resp.status}: ${errBody}` }; }
    return await resp.json();
  } catch (err) {
    console.error("[gmail] Send error:", err.message);
    return null;
  }
}

/* ─── Gmail: draft management ──────────────────────────────────────────── */
async function gmailCreateDraft({ to, cc, bcc, subject, body, bodyHtml, inReplyTo, references, threadId }) {
  const accessToken = await getGCalAccessToken();
  if (!accessToken) return null;
  try {
    const headers = [`MIME-Version: 1.0`];
    if (to) headers.push(`To: ${to}`);
    if (cc) headers.push(`Cc: ${cc}`);
    if (bcc) headers.push(`Bcc: ${bcc}`);
    headers.push(`Subject: ${subject || ""}`);
    if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
    if (references) headers.push(`References: ${references}`);
    headers.push(`Content-Type: text/plain; charset=utf-8`);
    const rawEmail = [...headers, "", body || ""].join("\r\n");
    const encoded = Buffer.from(rawEmail).toString("base64url");
    const message = { raw: encoded };
    if (threadId) message.threadId = threadId;
    const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (err) {
    console.error("[gmail] Create draft error:", err.message);
    return null;
  }
}

async function gmailListDrafts() {
  const accessToken = await getGCalAccessToken();
  if (!accessToken) return null;
  try {
    const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts?maxResults=50", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const drafts = data.drafts || [];
    // Fetch metadata for each draft
    const detailed = await Promise.all(drafts.map(async d => {
      const dResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${d.id}?format=metadata&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!dResp.ok) return null;
      const draft = await dResp.json();
      const h = draft.message?.payload?.headers || [];
      return {
        draftId: d.id,
        messageId: draft.message?.id,
        threadId: draft.message?.threadId,
        to: parseEmailHeader(h, "To"),
        subject: parseEmailHeader(h, "Subject") || "(No subject)",
        date: parseEmailHeader(h, "Date"),
        snippet: draft.message?.snippet || "",
      };
    }));
    return detailed.filter(Boolean);
  } catch (err) {
    console.error("[gmail] List drafts error:", err.message);
    return null;
  }
}

/* ─── Gmail: get labels with counts ────────────────────────────────────── */
let labelCache = null;
let labelCacheTime = 0;
async function gmailGetLabels(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && labelCache && (now - labelCacheTime) < 60000) return labelCache;
  const accessToken = await getGCalAccessToken();
  if (!accessToken) return null;
  try {
    const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const labels = data.labels || [];
    // Fetch detail for system labels and user labels to get counts
    const detailed = await Promise.all(labels.map(async l => {
      const lResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/labels/${l.id}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!lResp.ok) return { id: l.id, name: l.name, type: l.type, total: 0, unread: 0 };
      const detail = await lResp.json();
      return {
        id: l.id, name: l.name, type: l.type,
        total: detail.messagesTotal || 0,
        unread: detail.messagesUnread || 0,
      };
    }));
    labelCache = detailed;
    labelCacheTime = now;
    return detailed;
  } catch (err) {
    console.error("[gmail] Labels error:", err.message);
    return null;
  }
}

/* ─── Email contacts cache ─────────────────────────────────────────────── */
function loadEmailContacts(userEmail) {
  const file = userEmail ? userEmailContactsFile(userEmail) : EMAIL_CONTACTS_FILE;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; }
}
function saveEmailContacts(contacts, userEmail) {
  const file = userEmail ? userEmailContactsFile(userEmail) : EMAIL_CONTACTS_FILE;
  contacts.sort((a, b) => b.lastUsed - a.lastUsed);
  if (contacts.length > 500) contacts = contacts.slice(0, 500);
  fs.writeFileSync(file, JSON.stringify(contacts, null, 2), "utf8");
}
function updateEmailContact(email, name, userEmail) {
  if (!email) return;
  email = email.trim().toLowerCase();
  const contacts = loadEmailContacts(userEmail);
  const existing = contacts.find(c => c.email === email);
  if (existing) {
    existing.name = name || existing.name;
    existing.lastUsed = Date.now();
    existing.count = (existing.count || 0) + 1;
  } else {
    contacts.push({ email, name: name || "", lastUsed: Date.now(), count: 1 });
  }
  saveEmailContacts(contacts, userEmail);
}
function parseEmailAddress(str) {
  if (!str) return [];
  // Split by comma, parse each "Name <email>" or "email"
  return str.split(",").map(s => {
    const m = s.trim().match(/^"?([^"<]*)"?\s*<?([^>]+@[^>]+)>?$/);
    if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
    const plain = s.trim();
    if (plain.includes("@")) return { name: "", email: plain.toLowerCase() };
    return null;
  }).filter(Boolean);
}

/* ─── Push notification helpers ─────────────────────────────────────── */
function loadPushSubscriptions(userEmail) {
  const file = userEmail ? userPushSubsFile(userEmail) : PUSH_SUBSCRIPTIONS_FILE;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; }
}
function savePushSubscriptions(subs, userEmail) {
  const file = userEmail ? userPushSubsFile(userEmail) : PUSH_SUBSCRIPTIONS_FILE;
  fs.writeFileSync(file, JSON.stringify(subs, null, 2), "utf8");
}
async function sendPushToAll(payload) {
  const subs = loadPushSubscriptions();
  const failed = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        failed.push(sub.endpoint);
      }
    }
  }
  // Remove expired subscriptions
  if (failed.length) {
    const remaining = subs.filter(s => !failed.includes(s.endpoint));
    savePushSubscriptions(remaining);
  }
}

/* ─── Server-side email polling for push notifications ─────────────── */
let lastKnownInboxIds = new Set();
let emailPollStarted = false;
function startServerEmailPoll() {
  if (emailPollStarted) return;
  emailPollStarted = true;
  // Initial load of known IDs
  gmailGetInbox().then(result => {
    if (Array.isArray(result)) {
      lastKnownInboxIds = new Set(result.map(e => e.id));
    }
  }).catch(() => {});
  // Poll every 60 seconds
  setInterval(async () => {
    try {
      const result = await gmailGetInbox();
      if (!Array.isArray(result)) return;
      const currentIds = new Set(result.map(e => e.id));
      const newEmails = result.filter(e => !lastKnownInboxIds.has(e.id));
      if (newEmails.length > 0) {
        const subs = loadPushSubscriptions();
        if (subs.length > 0) {
          if (newEmails.length === 1) {
            const e = newEmails[0];
            await sendPushToAll({
              title: e.from || "New Email",
              body: e.subject || "(No subject)",
              url: "/?tab=email",
            });
          } else {
            await sendPushToAll({
              title: `${newEmails.length} new emails`,
              body: newEmails.map(e => e.subject).slice(0, 3).join(", "),
              url: "/?tab=email",
            });
          }
        }
      }
      lastKnownInboxIds = currentIds;
    } catch {}
  }, 60000);
}

/* ─── Per-project detail files (notes, ethos, docs) ──────────────────── */
function projectDetailPath(id) {
  const shared = sharedProjectDetailPath(id);
  if (fs.existsSync(shared)) return shared;
  const legacy = path.join(DATA_DIR, `project-${id}.json`);
  if (fs.existsSync(legacy)) return legacy;
  return shared; // New files go to shared
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
function loadJournal(email) {
  const file = email ? userJournalFile(email) : JOURNAL_FILE;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; }
}
function saveJournal(entries, email) {
  const file = email ? userJournalFile(email) : JOURNAL_FILE;
  fs.writeFileSync(file, JSON.stringify(entries, null, 2), "utf8");
}

/* ─── Auth bypass paths ──────────────────────────────────────────────── */
const PUBLIC_PATHS = ["/login.html", "/api/auth", "/api/auth-config", "/api/health", "/favicon.ico", "/api/gcal-callback", "/manifest.json", "/sw.js", "/icon.svg", "/icon-192.png", "/icon-512.png", "/dan-icon-180.png", "/dan-avatar.svg", "/api/signature-image-file", "/api/content-trigger"];

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
      return json(res, 200, { ok: true, app: "anchor-tasks", uptime: process.uptime(), ownerEmail: OWNER_EMAIL || "(not set)" });
    }

    // Debug: list data directory contents (temp - remove later)
    if (urlPath === "/api/debug-files" && req.method === "GET") {
      const session = getSession(req);
      if (!session) return json(res, 401, { error: "Not authenticated" });
      const listDir = (dir, prefix = "") => {
        const result = [];
        try {
          const items = fs.readdirSync(dir);
          for (const item of items) {
            const full = path.join(dir, item);
            const stat = fs.statSync(full);
            if (stat.isDirectory()) {
              result.push({ path: prefix + item + "/", type: "dir" });
              result.push(...listDir(full, prefix + item + "/"));
            } else {
              result.push({ path: prefix + item, type: "file", size: stat.size });
            }
          }
        } catch {}
        return result;
      };
      return json(res, 200, { dataDir: DATA_DIR, ownerEmail: OWNER_EMAIL, files: listDir(DATA_DIR) });
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

    // Dan: Projects CRUD
    if (urlPath === "/api/dan/projects-list" && req.method === "POST") {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const email = req.session?.email || "john@myanchormortgage.com";
      const projects = getVisibleProjects(email);
      return json(res, 200, { projects });
    }

    if (urlPath === "/api/dan/projects-create" && req.method === "POST") {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      const email = req.session?.email || "john@myanchormortgage.com";
      const projects = parseProjects(email);
      const project = {
        id: generateId(),
        name: String(body.name || "").substring(0, 200),
        description: String(body.description || "").substring(0, 500),
        owner: String(body.owner || "").substring(0, 100),
        ownerEmail: email,
        members: body.members || [],
        archived: false,
      };
      if (!project.name) return json(res, 400, { error: "Project name required" });
      projects.push(project);
      writeProjects(projects, email);
      // Create project detail if notes/ethos provided
      if (body.notes || body.ethos) {
        writeProjectDetail(project.id, {
          notes: body.notes || "",
          ethos: body.ethos || "",
          docs: [],
          folderId: "",
          folderUrl: "",
        });
      }
      return json(res, 201, { project });
    }

    if (urlPath === "/api/dan/projects-update" && req.method === "POST") {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      if (!body.id) return json(res, 400, { error: "Project id required" });
      const email = req.session?.email || "john@myanchormortgage.com";
      const projects = parseProjects(email);
      const idx = projects.findIndex(p => p.id === body.id);
      if (idx === -1) return json(res, 404, { error: "Project not found" });
      if (body.name !== undefined) projects[idx].name = String(body.name).substring(0, 200);
      if (body.description !== undefined) projects[idx].description = String(body.description).substring(0, 500);
      if (body.owner !== undefined) projects[idx].owner = String(body.owner).substring(0, 100);
      if (body.archived !== undefined) projects[idx].archived = !!body.archived;
      writeProjects(projects, email);
      // Update detail if provided
      if (body.notes !== undefined || body.ethos !== undefined) {
        const detail = readProjectDetail(projects[idx].id);
        if (body.notes !== undefined) detail.notes = body.notes;
        if (body.ethos !== undefined) detail.ethos = body.ethos;
        writeProjectDetail(projects[idx].id, detail);
      }
      return json(res, 200, { project: projects[idx] });
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

    // Dan: list shared drives
    if (urlPath === "/api/dan/drive-shared-drives" && (req.method === "GET" || req.method === "POST")) {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const accessToken = await getGCalAccessToken();
      if (!accessToken) return json(res, 200, { error: "Drive not connected", drives: [] });
      try {
        const resp = await fetch("https://www.googleapis.com/drive/v3/drives?pageSize=50", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!resp.ok) return json(res, 200, { error: `Drive API: ${resp.status}`, drives: [] });
        const data = await resp.json();
        return json(res, 200, { drives: (data.drives || []).map(d => ({ id: d.id, name: d.name })) });
      } catch (e) { return json(res, 200, { error: e.message, drives: [] }); }
    }

    // Dan: rename shared drive
    if (urlPath === "/api/dan/drive-rename" && req.method === "POST") {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      const accessToken = await getGCalAccessToken();
      if (!accessToken) return json(res, 200, { error: "Drive not connected" });
      try {
        const resp = await fetch(`https://www.googleapis.com/drive/v3/drives/${body.driveId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ name: body.name }),
        });
        if (!resp.ok) return json(res, 200, { error: `Rename failed: ${resp.status}` });
        console.log(`[dan-drive] Renamed shared drive ${body.driveId} to "${body.name}"`);
        return json(res, 200, { success: true, driveId: body.driveId, name: body.name });
      } catch (e) { return json(res, 200, { error: e.message }); }
    }

    // Dan: delete file/folder from Drive
    if (urlPath === "/api/dan/drive-delete" && req.method === "POST") {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      const accessToken = await getGCalAccessToken();
      if (!accessToken) return json(res, 200, { error: "Drive not connected" });
      try {
        const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${body.fileId}?supportsAllDrives=true`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!resp.ok && resp.status !== 204) return json(res, 200, { error: `Delete failed: ${resp.status}` });
        console.log(`[dan-drive] Deleted file/folder ${body.fileId}`);
        return json(res, 200, { success: true, fileId: body.fileId });
      } catch (e) { return json(res, 200, { error: e.message }); }
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
      const myTasks = parseTasks(req.session.email);
      const assignedToMe = getAssignedTasks(req.session.email).map(t => ({ ...t, _assigned: true }));
      return json(res, 200, { tasks: [...myTasks, ...assignedToMe] });
    }

    // Get all tasks for a specific project (across all users)
    if (urlPath.match(/^\/api\/projects\/[^/]+\/tasks$/) && req.method === "GET") {
      const id = urlPath.split("/")[3];
      const project = parseProjects().find(p => p.id === id);
      if (!project) return json(res, 404, { error: "Project not found" });
      return json(res, 200, { tasks: getProjectTasks(project.name) });
    }

    if (urlPath === "/api/tasks" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const tasks = parseTasks(req.session.email);
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
        todayFocus: !!body.todayFocus,
        todayOrder: parseInt(body.todayOrder) || 0,
        calEventId: "",
        scheduledStart: "",
        emailId: String(body.emailId || "").substring(0, 200),
        emailSubject: String(body.emailSubject || "").substring(0, 500),
        assigneeEmail: String(body.assigneeEmail || "").substring(0, 200),
        done: false,
      };
      if (!task.title) return json(res, 400, { error: "Title required" });
      tasks.push(task);
      writeTasks(tasks, req.session.email);
      return json(res, 201, { task });
    }

    if (urlPath.startsWith("/api/tasks/") && req.method === "PATCH") {
      const id = urlPath.split("/")[3];
      const body = JSON.parse(await readBody(req));
      const tasks = parseTasks(req.session.email);
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
      writeTasks(tasks, req.session.email);
      return json(res, 200, { task: tasks[idx] });
    }

    if (urlPath.startsWith("/api/tasks/") && req.method === "DELETE") {
      const id = urlPath.split("/")[3];
      const tasks = parseTasks(req.session.email);
      const filtered = tasks.filter(t => t.id !== id);
      if (filtered.length === tasks.length) return json(res, 404, { error: "Task not found" });
      writeTasks(filtered, req.session.email);
      // Clean up task detail file
      const detailFile = userFile(req.session.email, `task-${id}.json`);
      try { if (fs.existsSync(detailFile)) fs.unlinkSync(detailFile); } catch {}
      return json(res, 200, { ok: true });
    }

    /* ── Task notes & attachments ──────────────────────────────── */
    const taskDetailMatch = urlPath.match(/^\/api\/tasks\/([^/]+)\/detail$/);
    if (taskDetailMatch && req.method === "GET") {
      const id = taskDetailMatch[1];
      const detailFile = userFile(req.session.email, `task-${id}.json`);
      try {
        if (fs.existsSync(detailFile)) return json(res, 200, JSON.parse(fs.readFileSync(detailFile, "utf8")));
      } catch {}
      return json(res, 200, { notes: "", attachments: [] });
    }

    if (taskDetailMatch && req.method === "PATCH") {
      const id = taskDetailMatch[1];
      const body = JSON.parse(await readBody(req));
      const detailFile = userFile(req.session.email, `task-${id}.json`);
      let detail = { notes: "", attachments: [] };
      try { if (fs.existsSync(detailFile)) detail = JSON.parse(fs.readFileSync(detailFile, "utf8")); } catch {}
      if (body.notes !== undefined) detail.notes = String(body.notes).substring(0, 10000);
      if (body.attachments !== undefined) detail.attachments = (body.attachments || []).slice(0, 20);
      fs.writeFileSync(detailFile, JSON.stringify(detail, null, 2), "utf8");
      return json(res, 200, detail);
    }

    const taskAttachMatch = urlPath.match(/^\/api\/tasks\/([^/]+)\/attachment$/);
    if (taskAttachMatch && req.method === "POST") {
      const id = taskAttachMatch[1];
      const contentType = req.headers["content-type"] || "";
      const filename = url.searchParams.get("name") || "attachment";
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      // Save to user's task attachments directory
      const attachDir = userFile(req.session.email, `task-${id}-attachments`);
      if (!fs.existsSync(attachDir)) fs.mkdirSync(attachDir, { recursive: true });
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_").substring(0, 100);
      const filepath = path.join(attachDir, safeName);
      fs.writeFileSync(filepath, buf);
      // Add to task detail
      const detailFile = userFile(req.session.email, `task-${id}.json`);
      let detail = { notes: "", attachments: [] };
      try { if (fs.existsSync(detailFile)) detail = JSON.parse(fs.readFileSync(detailFile, "utf8")); } catch {}
      detail.attachments.push({ name: filename, file: safeName, size: buf.length, type: contentType, addedAt: Date.now() });
      fs.writeFileSync(detailFile, JSON.stringify(detail, null, 2), "utf8");
      return json(res, 200, { ok: true, attachment: detail.attachments[detail.attachments.length - 1] });
    }

    const taskAttachFileMatch = urlPath.match(/^\/api\/tasks\/([^/]+)\/attachment\/(.+)$/);
    if (taskAttachFileMatch && req.method === "GET") {
      const [, id, filename] = taskAttachFileMatch;
      const filepath = path.join(userFile(req.session.email, `task-${id}-attachments`), decodeURIComponent(filename));
      if (!fs.existsSync(filepath)) return json(res, 404, { error: "Attachment not found" });
      const buf = fs.readFileSync(filepath);
      const ext = path.extname(filepath).toLowerCase();
      const mimeMap = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
      res.writeHead(200, { "Content-Type": mimeMap[ext] || "application/octet-stream", "Content-Disposition": `attachment; filename="${decodeURIComponent(filename)}"`, "Content-Length": buf.length });
      return res.end(buf);
    }

    /* ── PROJECTS API ──────────────────────────────────────────────── */
    if (urlPath === "/api/projects" && req.method === "GET") {
      return json(res, 200, { projects: getVisibleProjects(req.session.email) });
    }

    if (urlPath === "/api/projects" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const projects = parseProjects(req.session.email);
      const project = {
        id: generateId(),
        name: String(body.name || "").substring(0, 200),
        description: String(body.description || "").substring(0, 500),
        owner: String(body.owner || req.session.name || "").substring(0, 100),
        ownerEmail: req.session.email,
        members: body.members || [],
        archived: false,
      };
      if (!project.name) return json(res, 400, { error: "Name required" });
      projects.push(project);
      writeProjects(projects, req.session.email);
      return json(res, 201, { project });
    }

    if (urlPath.startsWith("/api/projects/") && req.method === "PATCH") {
      const id = urlPath.split("/")[3];
      const body = JSON.parse(await readBody(req));
      const projects = parseProjects(req.session.email);
      const idx = projects.findIndex(p => p.id === id);
      if (idx === -1) return json(res, 404, { error: "Project not found" });
      if (body.name !== undefined) projects[idx].name = String(body.name).substring(0, 200);
      if (body.description !== undefined) projects[idx].description = String(body.description).substring(0, 500);
      if (body.owner !== undefined) projects[idx].owner = String(body.owner).substring(0, 100);
      if (body.archived !== undefined) projects[idx].archived = !!body.archived;
      if (body.members !== undefined) projects[idx].members = body.members;
      writeProjects(projects, req.session.email);
      return json(res, 200, { project: projects[idx] });
    }

    if (urlPath.startsWith("/api/projects/") && req.method === "DELETE") {
      const id = urlPath.split("/")[3];
      const projects = parseProjects(req.session.email);
      const filtered = projects.filter(p => p.id !== id);
      if (filtered.length === projects.length) return json(res, 404, { error: "Project not found" });
      writeProjects(filtered, req.session.email);
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
      // Save existing refresh_token before revoking, in case Google doesn't issue a new one
      let savedRefreshToken = null;
      try {
        const existing = loadGCalToken();
        if (existing?.refresh_token) savedRefreshToken = existing.refresh_token;
        // Revoke the old token so Google forces full re-consent
        if (existing?.access_token) {
          fetch(`https://oauth2.googleapis.com/revoke?token=${existing.access_token}`, { method: "POST" }).catch(() => {});
        }
      } catch {}
      try { if (fs.existsSync(GCAL_TOKEN_FILE)) fs.unlinkSync(GCAL_TOKEN_FILE); } catch {}
      // Stash refresh token in memory for the callback
      if (savedRefreshToken) global._savedRefreshToken = savedRefreshToken;
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
        include_granted_scopes: "true",
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
        console.log("[gcal-callback] Google returned:", JSON.stringify({ access_token: !!data.access_token, refresh_token: !!data.refresh_token, scope: data.scope, error: data.error }));
        if (data.access_token) {
          // Keep existing refresh_token if Google didn't issue a new one (re-auth scenario)
          const existing = loadGCalToken();
          const refresh_token = data.refresh_token || (existing && existing.refresh_token) || global._savedRefreshToken || null;
          console.log("[gcal-callback] refresh_token sources: google=", !!data.refresh_token, "existing=", !!(existing?.refresh_token), "stashed=", !!global._savedRefreshToken, "final=", !!refresh_token);
          if (global._savedRefreshToken) delete global._savedRefreshToken;
          if (refresh_token) {
            saveGCalToken({
              refresh_token,
              access_token: data.access_token,
              expires_at: Date.now() + (data.expires_in || 3600) * 1000,
              scope: data.scope || "",
            });
            const hasGmailSend = (data.scope || "").includes("gmail.send");
            console.log("[gcal] Connected successfully. Scopes:", data.scope || "(not returned)");
            console.log("[gcal] gmail.send scope:", hasGmailSend ? "YES" : "NO - re-auth needed with consent prompt");
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
      const tasks = parseTasks(req.session.email);
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
      writeTasks(tasks, req.session.email);
      return json(res, 200, { task: tasks[idx], eventId: evt.id });
    }

    // Remove task from calendar
    if (scheduleMatch && req.method === "DELETE") {
      const id = scheduleMatch[1];
      const tasks = parseTasks(req.session.email);
      const idx = tasks.findIndex(t => t.id === id);
      if (idx === -1) return json(res, 404, { error: "Task not found" });
      if (tasks[idx].calEventId) await gcalDeleteEvent(tasks[idx].calEventId);
      tasks[idx].calEventId = "";
      tasks[idx].scheduledStart = "";
      writeTasks(tasks, req.session.email);
      return json(res, 200, { task: tasks[idx] });
    }

    // AI Prioritize — scoring algorithm
    if (urlPath === "/api/ai-prioritize" && req.method === "GET") {
      const tasks = parseTasks(req.session.email).filter(t => !t.done);
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
        const h = msg.payload?.headers || [];
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
        const from = parseEmailHeader(h, "From");
        const fromMatch = from.match(/^"?([^"<]+)"?\s*<?([^>]*)>?$/);
        return json(res, 200, {
          id: msg.id, threadId: msg.threadId,
          from: fromMatch ? fromMatch[1].trim() : from,
          fromEmail: fromMatch ? fromMatch[2].trim() : from,
          to: parseEmailHeader(h, "To"),
          cc: parseEmailHeader(h, "Cc"),
          bcc: parseEmailHeader(h, "Bcc"),
          replyTo: parseEmailHeader(h, "Reply-To"),
          subject: parseEmailHeader(h, "Subject") || "(No subject)",
          date: parseEmailHeader(h, "Date"),
          messageId: parseEmailHeader(h, "Message-ID"),
          inReplyTo: parseEmailHeader(h, "In-Reply-To"),
          references: parseEmailHeader(h, "References"),
          body, attachments,
          unread: (msg.labelIds || []).includes("UNREAD"),
          starred: (msg.labelIds || []).includes("STARRED"),
          labelIds: msg.labelIds || [],
        });
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

    /* ── GMAIL: Messages by folder with pagination ───────────────── */
    if (urlPath === "/api/gmail-messages" && req.method === "GET") {
      const label = url.searchParams.get("label") || "INBOX";
      const pageToken = url.searchParams.get("page") || "";
      const max = parseInt(url.searchParams.get("max") || "50", 10);
      const result = await gmailListMessages(label, pageToken || undefined, max);
      if (!result) return json(res, 200, { emails: [], connected: false });
      if (result.needsReauth) return json(res, 200, { emails: [], connected: false, needsReauth: true });
      return json(res, 200, { emails: result.emails, nextPageToken: result.nextPageToken, connected: true });
    }

    /* ── GMAIL: Thread view ────────────────────────────────────── */
    if (urlPath.match(/^\/api\/gmail-thread\//) && req.method === "GET") {
      const threadId = urlPath.split("/").pop();
      const thread = await gmailGetThread(threadId);
      if (!thread) return json(res, 500, { error: "Failed to fetch thread" });
      // Update contacts cache from thread participants
      for (const msg of thread.messages) {
        if (msg.fromEmail) updateEmailContact(msg.fromEmail, msg.from);
        for (const addr of parseEmailAddress(msg.to)) updateEmailContact(addr.email, addr.name);
        for (const addr of parseEmailAddress(msg.cc)) updateEmailContact(addr.email, addr.name);
      }
      return json(res, 200, thread);
    }

    /* ── GMAIL: Labels with counts ─────────────────────────────── */
    if (urlPath === "/api/gmail-labels" && req.method === "GET") {
      const labels = await gmailGetLabels(url.searchParams.get("refresh") === "1");
      if (!labels) return json(res, 200, { labels: [], connected: false });
      return json(res, 200, { labels, connected: true });
    }

    /* ── GMAIL: Send email ─────────────────────────────────────── */
    if (urlPath === "/api/gmail-send" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const result = await gmailSendEmail(body);
      if (!result || result.error) return json(res, 500, { error: result?.error || "Send failed. You may need to re-authorize: click ⚙ in email toolbar." });
      // Update contacts cache
      for (const addr of parseEmailAddress(body.to)) updateEmailContact(addr.email, addr.name);
      for (const addr of parseEmailAddress(body.cc)) updateEmailContact(addr.email, addr.name);
      for (const addr of parseEmailAddress(body.bcc)) updateEmailContact(addr.email, addr.name);
      console.log(`[gmail] Sent email to ${body.to}: "${body.subject}"`);
      return json(res, 200, { success: true, messageId: result.id, threadId: result.threadId });
    }

    /* ── GMAIL: Star/unstar ────────────────────────────────────── */
    if (urlPath.match(/^\/api\/gmail-star\//) && req.method === "POST") {
      const msgId = urlPath.split("/").pop();
      const body = JSON.parse(await readBody(req));
      const accessToken = await getGCalAccessToken();
      if (!accessToken) return json(res, 401, { error: "Not authorized" });
      const modBody = body.starred
        ? { addLabelIds: ["STARRED"] }
        : { removeLabelIds: ["STARRED"] };
      try {
        const resp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/modify`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(modBody),
        });
        return json(res, 200, { ok: resp.ok });
      } catch { return json(res, 500, { ok: false }); }
    }

    /* ── GMAIL: Search ─────────────────────────────────────────── */
    if (urlPath === "/api/gmail-search" && req.method === "GET") {
      const q = url.searchParams.get("q") || "";
      const pageToken = url.searchParams.get("page") || "";
      const max = parseInt(url.searchParams.get("max") || "25", 10);
      if (!q) return json(res, 200, { emails: [], nextPageToken: null });
      const result = await gmailListMessages(null, pageToken || undefined, max, q);
      if (!result) return json(res, 200, { emails: [], connected: false });
      return json(res, 200, { emails: result.emails, nextPageToken: result.nextPageToken, connected: true });
    }

    /* ── GMAIL: Drafts ─────────────────────────────────────────── */
    if (urlPath === "/api/gmail-drafts" && req.method === "GET") {
      const drafts = await gmailListDrafts();
      if (!drafts) return json(res, 200, { drafts: [], connected: false });
      return json(res, 200, { drafts, connected: true });
    }

    if (urlPath === "/api/gmail-draft" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const result = await gmailCreateDraft(body);
      if (!result) return json(res, 500, { error: "Failed to create draft" });
      return json(res, 200, { success: true, draftId: result.id });
    }

    if (urlPath.match(/^\/api\/gmail-draft\//) && req.method === "DELETE") {
      const draftId = urlPath.split("/").pop();
      const accessToken = await getGCalAccessToken();
      if (!accessToken) return json(res, 401, { error: "Not authorized" });
      try {
        const resp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${draftId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        return json(res, 200, { ok: resp.ok || resp.status === 204 });
      } catch { return json(res, 500, { ok: false }); }
    }

    /* ── GMAIL: Contact autocomplete ───────────────────────────── */
    if (urlPath === "/api/gmail-contacts" && req.method === "GET") {
      const q = (url.searchParams.get("q") || "").toLowerCase();
      if (!q || q.length < 2) return json(res, 200, { contacts: [] });
      const contacts = loadEmailContacts();
      const matches = contacts.filter(c =>
        c.email.toLowerCase().includes(q) || (c.name && c.name.toLowerCase().includes(q))
      ).slice(0, 10);
      return json(res, 200, { contacts: matches });
    }

    /* ── GMAIL: Email signature ────────────────────────────────── */
    /* ── Signature image upload ───────────────────────────────── */
    if (urlPath === "/api/signature-image" && req.method === "POST") {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const buf = Buffer.concat(chunks);
        const contentType = req.headers["content-type"] || "image/png";
        const ext = contentType.includes("jpeg") || contentType.includes("jpg") ? ".jpg" : contentType.includes("gif") ? ".gif" : ".png";
        const filename = `signature-img${ext}`;
        const filepath = path.join(DATA_DIR, filename);
        fs.writeFileSync(filepath, buf);
        console.log("[signature] Image uploaded:", filename, buf.length, "bytes");
        return json(res, 200, { url: `/api/signature-image-file`, size: buf.length });
      } catch (e) {
        console.error("[signature] Upload failed:", e.message);
        return json(res, 500, { error: e.message });
      }
    }

    if (urlPath === "/api/signature-image-file" && req.method === "GET") {
      const pngPath = path.join(DATA_DIR, "signature-img.png");
      const jpgPath = path.join(DATA_DIR, "signature-img.jpg");
      const gifPath = path.join(DATA_DIR, "signature-img.gif");
      let filepath, mime;
      if (fs.existsSync(pngPath)) { filepath = pngPath; mime = "image/png"; }
      else if (fs.existsSync(jpgPath)) { filepath = jpgPath; mime = "image/jpeg"; }
      else if (fs.existsSync(gifPath)) { filepath = gifPath; mime = "image/gif"; }
      else return json(res, 404, { error: "No signature image" });
      const buf = fs.readFileSync(filepath);
      res.writeHead(200, { "Content-Type": mime, "Content-Length": buf.length, "Cache-Control": "public, max-age=86400" });
      return res.end(buf);
    }

    if (urlPath === "/api/gmail-signature" && req.method === "GET") {
      try {
        const sig = JSON.parse(fs.readFileSync(EMAIL_SIGNATURE_FILE, "utf8"));
        return json(res, 200, sig);
      } catch { return json(res, 200, { html: "", text: "" }); }
    }

    if (urlPath === "/api/gmail-signature" && req.method === "POST") {
      try {
        const body = JSON.parse(await readBody(req));
        const html = body.html || "";
        console.log("[signature] Saving signature, length:", html.length);
        fs.writeFileSync(EMAIL_SIGNATURE_FILE, JSON.stringify({ html, text: body.text || "" }), "utf8");
        return json(res, 200, { ok: true });
      } catch (e) {
        console.error("[signature] Save failed:", e.message);
        return json(res, 500, { error: e.message });
      }
    }

    /* ── Push notifications ───────────────────────────────────── */
    if (urlPath === "/api/push/vapid-key" && req.method === "GET") {
      return json(res, 200, { publicKey: VAPID_PUBLIC_KEY });
    }

    if (urlPath === "/api/push/subscribe" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      if (!body.endpoint) return json(res, 400, { error: "Missing subscription" });
      const subs = loadPushSubscriptions();
      // Avoid duplicates
      if (!subs.find(s => s.endpoint === body.endpoint)) {
        subs.push(body);
        savePushSubscriptions(subs);
      }
      // Start server-side polling if not already running
      startServerEmailPoll();
      return json(res, 200, { ok: true });
    }

    if (urlPath === "/api/push/unsubscribe" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const subs = loadPushSubscriptions();
      const remaining = subs.filter(s => s.endpoint !== body.endpoint);
      savePushSubscriptions(remaining);
      return json(res, 200, { ok: true });
    }

    if (urlPath === "/api/push/test" && req.method === "POST") {
      await sendPushToAll({ title: "Anchor Tasks", body: "Push notifications are working!", url: "/" });
      return json(res, 200, { ok: true });
    }

    /* ── GMAIL: Borrower/project email search (CRM) ──────────── */
    const borrowerEmailMatch = urlPath.match(/^\/api\/projects\/([^/]+)\/emails$/);
    if (borrowerEmailMatch && req.method === "GET") {
      const projectId = borrowerEmailMatch[1];
      const p = parseProjects().find(p => p.id === projectId);
      if (!p) return json(res, 404, { error: "Project not found" });
      const searchName = url.searchParams.get("q") || p.name;
      const pageToken = url.searchParams.get("page") || "";
      // Search Gmail for emails matching the borrower/project name
      const query = `"${searchName}"`;
      const result = await gmailListMessages(null, pageToken || undefined, 25, query);
      if (!result) return json(res, 200, { emails: [], connected: false });
      return json(res, 200, { emails: result.emails, nextPageToken: result.nextPageToken, projectName: p.name });
    }

    /* ── GOALS API ──────────────────────────────────────────────── */
    if (urlPath === "/api/goals" && req.method === "GET") {
      const goals = readGoals(req.session.email);
      return json(res, 200, { goals });
    }

    if (urlPath === "/api/goals" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const goals = readGoals(req.session.email);
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
      writeGoals(goals, req.session.email);
      return json(res, 201, { goal });
    }

    const goalMatch = urlPath.match(/^\/api\/goals\/([a-f0-9]+)$/);
    if (goalMatch && req.method === "PATCH") {
      const id = goalMatch[1];
      const body = JSON.parse(await readBody(req));
      const goals = readGoals(req.session.email);
      const idx = goals.findIndex(g => g.id === id);
      if (idx === -1) return json(res, 404, { error: "Goal not found" });
      if (body.title !== undefined) goals[idx].title = String(body.title).substring(0, 200);
      if (body.description !== undefined) goals[idx].description = String(body.description).substring(0, 1000);
      if (body.targetDate !== undefined) goals[idx].targetDate = String(body.targetDate).substring(0, 10);
      if (body.category !== undefined && ["personal", "professional"].includes(body.category)) goals[idx].category = body.category;
      if (body.progress !== undefined) goals[idx].progress = Math.min(100, Math.max(0, parseInt(body.progress) || 0));
      if (body.linkedTasks !== undefined && Array.isArray(body.linkedTasks)) goals[idx].linkedTasks = body.linkedTasks.map(id => String(id).substring(0, 20));
      writeGoals(goals, req.session.email);
      return json(res, 200, { goal: goals[idx] });
    }

    if (goalMatch && req.method === "DELETE") {
      const id = goalMatch[1];
      const goals = readGoals(req.session.email);
      const filtered = goals.filter(g => g.id !== id);
      if (filtered.length === goals.length) return json(res, 404, { error: "Goal not found" });
      writeGoals(filtered, req.session.email);
      return json(res, 200, { ok: true });
    }

    /* ── FINANCE MANAGER ────────────────────────────────────────── */
    if (urlPath === "/api/finance" && req.method === "GET") {
      const fm = require("./finance-manager");
      const fin = fm.loadFinance();
      return json(res, 200, { accounts: fin.accounts, categories: fin.categories || fm.DEFAULT_CATEGORIES, salary: fin.salary, budgets: fin.budgets || [], transactionCount: (fin.transactions || []).length });
    }

    if (urlPath === "/api/finance/accounts" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const fm = require("./finance-manager");
      const account = fm.addAccount(body);
      return json(res, 201, { ok: true, account });
    }

    if (urlPath === "/api/finance/import" && req.method === "POST") {
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      const fm = require("./finance-manager");
      const result = fm.importCSV(parsed.csv, parsed.accountId);
      if (result.imported > 0) {
        // AI categorize in background
        const fin = fm.loadFinance();
        fm.categorizeTransactions(fin.transactions).then(txns => {
          fin.transactions = txns;
          fm.saveFinance(fin);
          console.log(`[finance] Categorized ${result.imported} transactions`);
        }).catch(e => console.error("[finance] Categorization error:", e.message));
      }
      return json(res, 200, result);
    }

    if (urlPath === "/api/finance/transactions" && req.method === "GET") {
      const fm = require("./finance-manager");
      const fin = fm.loadFinance();
      const params = url.searchParams;
      let txns = fin.transactions || [];
      if (params.get("account")) txns = txns.filter(t => t.accountId === params.get("account"));
      if (params.get("month")) txns = txns.filter(t => t.date.substring(0, 7) === params.get("month"));
      if (params.get("category")) txns = txns.filter(t => t.category === params.get("category"));
      const page = parseInt(params.get("page") || "0");
      const limit = parseInt(params.get("limit") || "100");
      return json(res, 200, { transactions: txns.slice(page * limit, (page + 1) * limit), total: txns.length, page, limit });
    }

    if (urlPath.match(/^\/api\/finance\/transactions\//) && req.method === "PATCH") {
      const id = urlPath.split("/").pop();
      const body = JSON.parse(await readBody(req));
      const fm = require("./finance-manager");
      const fin = fm.loadFinance();
      const idx = fin.transactions.findIndex(t => t.id === id);
      if (idx === -1) return json(res, 404, { error: "Transaction not found" });
      if (body.category !== undefined) { fin.transactions[idx].category = body.category; fin.transactions[idx].categoryOverride = true; }
      if (body.description !== undefined) fin.transactions[idx].description = body.description;
      fm.saveFinance(fin);
      return json(res, 200, { ok: true });
    }

    if (urlPath === "/api/finance/monthly" && req.method === "GET") {
      const fm = require("./finance-manager");
      const params = url.searchParams;
      const breakdown = fm.getMonthlyBreakdown(params.get("account"), params.get("month"));
      return json(res, 200, breakdown);
    }

    if (urlPath === "/api/finance/trends" && req.method === "GET") {
      const fm = require("./finance-manager");
      const params = url.searchParams;
      return json(res, 200, { trends: fm.getMonthlyTrends(params.get("account"), parseInt(params.get("months") || "6")) });
    }

    if (urlPath === "/api/finance/budget" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const fm = require("./finance-manager");
      fm.setBudget(body.categoryId, body.monthlyLimit);
      return json(res, 200, { ok: true });
    }

    if (urlPath === "/api/finance/budget-status" && req.method === "GET") {
      const fm = require("./finance-manager");
      return json(res, 200, { budgets: fm.getBudgetStatus(url.searchParams.get("month")) });
    }

    if (urlPath === "/api/finance/salary" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const fm = require("./finance-manager");
      const salary = fm.setSalaryPlan(body.monthly, body.notes);
      return json(res, 200, { ok: true, salary });
    }

    // Dan API: finance
    if (urlPath === "/api/dan/finance-summary" && (req.method === "GET" || req.method === "POST")) {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const fm = require("./finance-manager");
      const fin = fm.loadFinance();
      const currentMonth = new Date().toISOString().substring(0, 7);
      const breakdown = fm.getMonthlyBreakdown(null, currentMonth);
      const trends = fm.getMonthlyTrends(null, 3);
      const budgets = fm.getBudgetStatus(currentMonth);
      return json(res, 200, { accounts: fin.accounts.length, currentMonth: breakdown, trends, budgets, salary: fin.salary });
    }

    /* ── NOTEBOOK ─────────────────────────────────────────────────── */
    const NOTEBOOK_FILE = path.join(DATA_DIR, "notebook.json");
    function loadNotebook() { try { return JSON.parse(fs.readFileSync(NOTEBOOK_FILE, "utf8")); } catch { return { tabs: [{ id: "tab-general", name: "General", color: "#3b82f6" }], notes: [] }; } }
    function saveNotebook(nb) { fs.writeFileSync(NOTEBOOK_FILE, JSON.stringify(nb, null, 2)); }

    // Get full notebook
    if (urlPath === "/api/notebook" && req.method === "GET") {
      return json(res, 200, loadNotebook());
    }

    // Add/update/delete tabs
    if (urlPath === "/api/notebook/tabs" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const nb = loadNotebook();
      const tab = { id: `tab-${generateId()}`, name: body.name || "New Tab", color: body.color || "#3b82f6" };
      nb.tabs.push(tab);
      saveNotebook(nb);
      return json(res, 201, { ok: true, tab });
    }

    if (urlPath.match(/^\/api\/notebook\/tabs\//) && req.method === "PATCH") {
      const id = urlPath.split("/").pop();
      const body = JSON.parse(await readBody(req));
      const nb = loadNotebook();
      const idx = nb.tabs.findIndex(t => t.id === id);
      if (idx === -1) return json(res, 404, { error: "Tab not found" });
      if (body.name !== undefined) nb.tabs[idx].name = body.name;
      if (body.color !== undefined) nb.tabs[idx].color = body.color;
      saveNotebook(nb);
      return json(res, 200, { ok: true, tab: nb.tabs[idx] });
    }

    if (urlPath.match(/^\/api\/notebook\/tabs\//) && req.method === "DELETE") {
      const id = urlPath.split("/").pop();
      const nb = loadNotebook();
      if (nb.tabs.length <= 1) return json(res, 400, { error: "Cannot delete last tab" });
      nb.tabs = nb.tabs.filter(t => t.id !== id);
      nb.notes = nb.notes.filter(n => n.tabId !== id);
      saveNotebook(nb);
      return json(res, 200, { ok: true });
    }

    // Add note
    if (urlPath === "/api/notebook/notes" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const nb = loadNotebook();
      const note = {
        id: `note-${generateId()}`,
        tabId: body.tabId || nb.tabs[0]?.id || "tab-general",
        content: String(body.content || "").substring(0, 50000),
        projectId: body.projectId || null,
        projectName: body.projectName || null,
        followUp: !!body.followUp,
        followUpDate: body.followUpDate || null,
        pinned: !!body.pinned,
        tags: Array.isArray(body.tags) ? body.tags : [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      nb.notes.push(note);
      saveNotebook(nb);
      return json(res, 201, { ok: true, note });
    }

    // Update note
    if (urlPath.match(/^\/api\/notebook\/notes\//) && !urlPath.includes("/to-task") && req.method === "PATCH") {
      const id = urlPath.split("/").pop();
      const body = JSON.parse(await readBody(req));
      const nb = loadNotebook();
      const idx = nb.notes.findIndex(n => n.id === id);
      if (idx === -1) return json(res, 404, { error: "Note not found" });
      const allowed = ["content", "tabId", "projectId", "projectName", "followUp", "followUpDate", "pinned", "tags"];
      for (const key of allowed) {
        if (body[key] !== undefined) nb.notes[idx][key] = body[key];
      }
      nb.notes[idx].updatedAt = new Date().toISOString();
      saveNotebook(nb);
      return json(res, 200, { ok: true, note: nb.notes[idx] });
    }

    // Delete note
    if (urlPath.match(/^\/api\/notebook\/notes\//) && !urlPath.includes("/to-task") && req.method === "DELETE") {
      const id = urlPath.split("/").pop();
      const nb = loadNotebook();
      nb.notes = nb.notes.filter(n => n.id !== id);
      saveNotebook(nb);
      return json(res, 200, { ok: true });
    }

    // Convert note to task
    if (urlPath.match(/^\/api\/notebook\/notes\/[^/]+\/to-task$/) && req.method === "POST") {
      const parts = urlPath.split("/");
      const noteId = parts[4];
      const nb = loadNotebook();
      const note = nb.notes.find(n => n.id === noteId);
      if (!note) return json(res, 404, { error: "Note not found" });
      const tasks = parseTasks(req.session.email);
      const task = {
        id: generateId(),
        title: note.content.split("\n")[0].substring(0, 200),
        assignee: req.session?.name || "",
        due: note.followUpDate || "",
        priority: "normal",
        project: note.projectName || "",
        status: "",
        personal: false,
        urgent: false,
        important: false,
        done: false,
        fromNote: noteId,
      };
      tasks.push(task);
      writeTasks(tasks, req.session.email);
      // Mark note as converted
      const idx = nb.notes.findIndex(n => n.id === noteId);
      if (idx >= 0) { nb.notes[idx].convertedToTask = task.id; nb.notes[idx].updatedAt = new Date().toISOString(); }
      saveNotebook(nb);
      return json(res, 200, { ok: true, task });
    }

    // Search notes
    if (urlPath === "/api/notebook/search" && req.method === "GET") {
      const q = (url.searchParams.get("q") || "").toLowerCase();
      const nb = loadNotebook();
      const results = nb.notes.filter(n => n.content.toLowerCase().includes(q) || (n.tags || []).some(t => t.toLowerCase().includes(q)));
      return json(res, 200, { query: q, results });
    }

    // Dan API: notebook
    if (urlPath === "/api/dan/notebook-full" && (req.method === "GET" || req.method === "POST")) {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const nb = loadNotebook();
      // Return summary: tabs + recent notes + follow-ups
      const followUps = nb.notes.filter(n => n.followUp && !n.convertedToTask);
      const recent = nb.notes.slice(-20);
      return json(res, 200, { tabs: nb.tabs, totalNotes: nb.notes.length, followUps, recentNotes: recent });
    }

    if (urlPath === "/api/dan/notebook-add" && req.method === "POST") {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      const nb = loadNotebook();
      // Find tab by name if provided
      let tabId = body.tabId;
      if (body.tabName && !tabId) {
        const tab = nb.tabs.find(t => t.name.toLowerCase() === body.tabName.toLowerCase());
        if (tab) tabId = tab.id;
      }
      const note = {
        id: `note-${generateId()}`,
        tabId: tabId || nb.tabs[0]?.id || "tab-general",
        content: body.content || "",
        projectId: body.projectId || null,
        projectName: body.projectName || null,
        followUp: !!body.followUp,
        followUpDate: body.followUpDate || null,
        pinned: false,
        tags: body.tags ? body.tags.split(",").map(t => t.trim()) : [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      nb.notes.push(note);
      saveNotebook(nb);
      return json(res, 200, { ok: true, note });
    }

    /* ── TAGLINE BANK ──────────────────────────────────────────────── */
    const TAGLINES_FILE = path.join(DATA_DIR, "taglines.json");
    function loadTaglines() { try { return JSON.parse(fs.readFileSync(TAGLINES_FILE, "utf8")); } catch { return []; } }
    function saveTaglines(t) { fs.writeFileSync(TAGLINES_FILE, JSON.stringify(t, null, 2)); }

    if (urlPath === "/api/taglines" && req.method === "GET") {
      return json(res, 200, { taglines: loadTaglines() });
    }

    if (urlPath === "/api/taglines" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const taglines = loadTaglines();
      const tag = {
        id: `tag-${Date.now().toString(36)}`,
        line: body.line,
        category: body.category || "general",
        locked: !!body.locked,
        source: body.source || "John",
        addedAt: new Date().toISOString().split("T")[0],
      };
      taglines.push(tag);
      saveTaglines(taglines);
      return json(res, 201, { ok: true, tagline: tag });
    }

    if (urlPath.match(/^\/api\/taglines\//) && req.method === "DELETE") {
      const id = urlPath.split("/").pop();
      const taglines = loadTaglines();
      const t = taglines.find(t => t.id === id);
      if (t && t.locked) return json(res, 400, { error: "This tagline is locked and cannot be deleted" });
      saveTaglines(taglines.filter(t => t.id !== id));
      return json(res, 200, { ok: true });
    }

    // Dan API: taglines
    if (urlPath === "/api/dan/taglines" && (req.method === "GET" || req.method === "POST")) {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      if (req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        if (body.add) {
          const taglines = loadTaglines();
          const tag = { id: `tag-${Date.now().toString(36)}`, line: body.add, category: body.category || "general", locked: false, source: body.source || "Dan", addedAt: new Date().toISOString().split("T")[0] };
          taglines.push(tag);
          saveTaglines(taglines);
          return json(res, 200, { ok: true, tagline: tag });
        }
      }
      return json(res, 200, { taglines: loadTaglines() });
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

    // ── Content Intelligence Feed (Reactor Feed) ──────────────────────
    // GET /api/content-feed — list triggers
    if (urlPath === "/api/content-feed" && req.method === "GET") {
      const cw = require("./content-watcher");
      const status = url.searchParams.get("status") || "new";
      const limit = parseInt(url.searchParams.get("limit") || "20");
      const result = cw.getTriggers({ status, limit });
      return json(res, 200, result);
    }

    // POST /api/content-feed/poll — manually trigger a poll
    if (urlPath === "/api/content-feed/poll" && req.method === "POST") {
      const cw = require("./content-watcher");
      try {
        const result = await cw.pollFeeds();
        return json(res, 200, { ok: true, ...result });
      } catch (e) {
        console.error("[content-feed] Poll error:", e.message);
        return json(res, 500, { error: e.message });
      }
    }

    // POST /api/content-feed/update — update trigger status
    if (urlPath === "/api/content-feed/update" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      if (!body.id || !body.status) return json(res, 400, { error: "id and status required" });
      const cw = require("./content-watcher");
      const trigger = cw.updateTrigger(body.id, { status: body.status, reactedContent: body.reactedContent });
      if (!trigger) return json(res, 404, { error: "Trigger not found" });
      return json(res, 200, { ok: true, trigger });
    }

    // POST /api/content-trigger — webhook receiver (Zapier LinkedIn alerts, etc.)
    // Bypasses session auth — open endpoint for webhooks
    if (urlPath === "/api/content-trigger" && req.method === "POST") {
      try {
        const body = JSON.parse(await readBody(req));
        if (!body.title) return json(res, 400, { error: "title is required" });
        const cw = require("./content-watcher");
        const trigger = cw.addWebhookTrigger(body);
        return json(res, 200, { ok: true, id: trigger.id });
      } catch (e) {
        console.error("[content-trigger] Webhook error:", e.message);
        return json(res, 500, { error: e.message });
      }
    }

    // Dan API: content feed access
    if (urlPath === "/api/dan/content-triggers" && (req.method === "GET" || req.method === "POST")) {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const cw = require("./content-watcher");
      const body = req.method === "POST" ? JSON.parse(await readBody(req)) : {};
      const result = cw.getTriggers({ status: body.status || "new", limit: 10 });
      if (result.triggers.length === 0) return json(res, 200, { message: `No ${body.status || "new"} content triggers right now.`, triggers: [] });
      const summary = result.triggers.map((t, i) => `${i + 1}. [${t.sourceIcon}] ${t.title} (${t.source}) — ID: ${t.id}`).join("\n");
      return json(res, 200, { message: `Found ${result.triggers.length} trigger${result.triggers.length !== 1 ? "s" : ""}:\n${summary}`, triggers: result.triggers, lastPoll: result.lastPoll });
    }

    // Dan API: dismiss trigger
    if (urlPath === "/api/dan/content-dismiss" && req.method === "POST") {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      if (!body.trigger_id) return json(res, 400, { error: "trigger_id required" });
      const cw = require("./content-watcher");
      const trigger = cw.updateTrigger(body.trigger_id, { status: "dismissed" });
      if (!trigger) return json(res, 404, { error: "Trigger not found" });
      return json(res, 200, { message: `Dismissed: "${trigger.title}"`, ok: true });
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

    /* ── MARKETING BRIEFING API ────────────────────────────────────── */

    // Get today's briefing (or latest)
    if (urlPath === "/api/briefing" && req.method === "GET") {
      if (!req.session) return json(res, 401, { error: "Not authenticated" });
      const me = require("./marketing-engine");
      const date = url.searchParams.get("date");
      const briefing = date ? me.loadBriefing(date) : me.getLatestBriefing();
      if (!briefing) return json(res, 200, { briefing: null, message: "No briefing available. Click 'Run Meeting' to generate one." });
      return json(res, 200, { briefing });
    }

    // List recent briefings
    if (urlPath === "/api/briefings" && req.method === "GET") {
      if (!req.session) return json(res, 401, { error: "Not authenticated" });
      const me = require("./marketing-engine");
      return json(res, 200, { briefings: me.listBriefings(14) });
    }

    // Manually trigger daily meeting
    if (urlPath === "/api/briefing/generate" && req.method === "POST") {
      if (!req.session) return json(res, 401, { error: "Not authenticated" });
      try {
        const me = require("./marketing-engine");
        const body = req.method === "POST" ? JSON.parse(await readBody(req)) : {};
        const briefing = await me.runDailyMeeting({ customInstructions: body.instructions || "" });
        return json(res, 200, { briefing });
      } catch (e) {
        console.error("[briefing] Generation error:", e.message);
        return json(res, 500, { error: e.message });
      }
    }

    // Approve a recommendation (and optionally publish)
    if (urlPath === "/api/briefing/approve" && req.method === "POST") {
      if (!req.session) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      if (!body.date || !body.recId) return json(res, 400, { error: "date and recId required" });
      const me = require("./marketing-engine");
      const rec = me.approveRecommendation(body.date, body.recId);
      if (!rec) return json(res, 404, { error: "Recommendation not found" });

      // Auto-publish if requested (or publish by default)
      let publishResults = null;
      if (body.publish !== false && process.env.ZERNIO_API_KEY) {
        try {
          const publisher = require("./social-publisher");
          publishResults = await publisher.publishRecommendation(rec, {
            scheduleTime: body.scheduleTime || null,
          });
          // Mark published platforms on the recommendation
          for (const r of publishResults) {
            if (r.status === "published") {
              me.markPublished(body.date, body.recId, r.platform);
            }
          }
        } catch (e) {
          console.error("[briefing] Publish error:", e.message);
          publishResults = [{ status: "error", error: e.message }];
        }
      }

      return json(res, 200, { rec, publishResults });
    }

    // Publish a specific recommendation to specific platforms
    if (urlPath === "/api/briefing/publish" && req.method === "POST") {
      if (!req.session) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      if (!body.date || !body.recId) return json(res, 400, { error: "date and recId required" });
      try {
        const me = require("./marketing-engine");
        const briefing = me.loadBriefing(body.date);
        if (!briefing) return json(res, 404, { error: "Briefing not found" });
        const rec = (briefing.contentRecommendations || []).find(r => r.id === body.recId);
        if (!rec) return json(res, 404, { error: "Recommendation not found" });

        const publisher = require("./social-publisher");
        const results = await publisher.publishRecommendation(rec, {
          scheduleTime: body.scheduleTime || null,
          profileFilter: body.profileFilter || null,
        });
        for (const r of results) {
          if (r.status === "published") me.markPublished(body.date, body.recId, r.platform);
        }
        return json(res, 200, { results });
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // List connected social accounts
    if (urlPath === "/api/social/accounts" && req.method === "GET") {
      if (!req.session) return json(res, 401, { error: "Not authenticated" });
      try {
        const publisher = require("./social-publisher");
        const accounts = await publisher.listAccounts();
        return json(res, 200, { accounts });
      } catch (e) {
        return json(res, 200, { accounts: [], error: e.message });
      }
    }

    // Reject a recommendation
    if (urlPath === "/api/briefing/reject" && req.method === "POST") {
      if (!req.session) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      if (!body.date || !body.recId) return json(res, 400, { error: "date and recId required" });
      const me = require("./marketing-engine");
      const rec = me.rejectRecommendation(body.date, body.recId, body.reason);
      if (!rec) return json(res, 404, { error: "Recommendation not found" });
      return json(res, 200, { rec });
    }

    // Get market data snapshot
    if (urlPath === "/api/market-data" && req.method === "GET") {
      if (!req.session) return json(res, 401, { error: "Not authenticated" });
      try {
        const md = require("./market-data");
        const data = await md.gatherMarketIntelligence();
        return json(res, 200, data);
      } catch (e) {
        return json(res, 500, { error: e.message });
      }
    }

    // Dan API: briefing access
    if (urlPath === "/api/dan/briefing" && (req.method === "GET" || req.method === "POST")) {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const me = require("./marketing-engine");
      const briefing = me.getLatestBriefing();
      if (!briefing) return json(res, 200, { message: "No briefing available yet." });
      return json(res, 200, { briefing });
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

    /* ── PIPELINE REVIEW API ───────────────────────────────────────── */
    const PIPELINE_REVIEWS_FILE = path.join(DATA_DIR, "pipeline-reviews.json");

    function loadPipelineReviews() {
      try { return JSON.parse(fs.readFileSync(PIPELINE_REVIEWS_FILE, "utf8")); }
      catch { return { reviews: [] }; }
    }
    function savePipelineReviews(data) {
      fs.writeFileSync(PIPELINE_REVIEWS_FILE, JSON.stringify(data, null, 2));
    }

    // Fetch loans from Arive via MCP (reuses same Zapier MCP as mortgage app)
    if (urlPath === "/api/pipeline/loans" && req.method === "GET") {
      if (!req.session) return json(res, 401, { error: "Not authenticated" });
      try {
        // Lazy-load MCP SDK
        let Client, StreamableHTTPClientTransport;
        try {
          Client = require("@modelcontextprotocol/sdk/client/index.js").Client;
          StreamableHTTPClientTransport = require("@modelcontextprotocol/sdk/client/streamableHttp.js").StreamableHTTPClientTransport;
        } catch (sdkErr) {
          return json(res, 500, { error: "MCP SDK not available: " + sdkErr.message });
        }

        const mcpToken = process.env.ZAPIER_MCP_TOKEN || "";
        const mcpUrl = process.env.ZAPIER_MCP_URL || "https://mcp.zapier.com/api/v1/connect";
        if (!mcpToken) return json(res, 500, { error: "ZAPIER_MCP_TOKEN not configured" });

        const fullUrl = mcpUrl.includes("token=") ? mcpUrl : `${mcpUrl}?token=${mcpToken}`;
        const transport = new StreamableHTTPClientTransport(new URL(fullUrl));
        const client = new Client({ name: "anchor-tasks-pipeline", version: "1.0.0" });
        await client.connect(transport);

        // Fetch all loans (paginate in blocks of 100)
        let allLoans = [];
        for (let page = 0; page < 10; page++) {
          const result = await client.callTool({
            name: "arive_api_1_0_23_get_loan_list",
            arguments: {
              instructions: "Get the loan list with all fields.",
              output_hint: "Return every row with original API field names exactly as-is.",
              limit: "100",
              offset: String(page * 100),
            },
          });

          let parsed = null;
          if (result.content && Array.isArray(result.content)) {
            const text = result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
            try { parsed = JSON.parse(text); } catch { parsed = null; }
          }

          let loans = [];
          if (Array.isArray(parsed)) loans = parsed;
          else if (parsed && Array.isArray(parsed.loans)) loans = parsed.loans;
          else if (parsed && Array.isArray(parsed.data)) loans = parsed.data;
          else if (parsed && parsed.results && Array.isArray(parsed.results)) loans = parsed.results;
          else if (parsed && parsed.results && Array.isArray(parsed.results.rows)) loans = parsed.results.rows;

          allLoans = allLoans.concat(loans);
          if (loans.length < 100) break;
        }

        await client.close().catch(() => {});

        // Normalize loan fields for the UI
        const normalized = allLoans.map(l => ({
          id: l.loan_id || l.ariveLoanId || l.id || "",
          displayId: l.display_loan_id || l.ariveLoanId || "",
          borrowerFirst: l.borrower_first_name || l.loanBorrower1_firstName || "",
          borrowerLast: l.borrower_last_name || l.loanBorrower1_lastName || "",
          borrowerName: `${l.borrower_first_name || l.loanBorrower1_firstName || ""} ${l.borrower_last_name || l.loanBorrower1_lastName || ""}`.trim(),
          loanAmount: parseFloat(l.loan_amount || l.baseLoanAmount || 0),
          loanPurpose: l.loan_purpose || l.loanPurpose || "",
          loanStatus: l.loan_status || l.currentLoanStatus_status || "",
          propertyAddress: l.property_address || l.subjectProperty_streetAddress || "",
          propertyCity: l.property_city || l.subjectProperty_city || "",
          propertyState: l.property_state || l.subjectProperty_state || "",
          loanProgram: l.loan_program || l.mortgageType || "",
          loanOfficer: l.loan_officer_name || l.loanOfficer_name || "",
          lastStatusChange: l.last_status_change_date || "",
          closingDate: l.closing_date || l.keyDates_closingDate || "",
        }));

        console.log(`[pipeline] Fetched ${normalized.length} loans from Arive`);
        return json(res, 200, { loans: normalized });
      } catch (e) {
        console.error("[pipeline] Error fetching loans:", e.message);
        return json(res, 500, { error: e.message });
      }
    }

    // Get previous pipeline reviews
    if (urlPath === "/api/pipeline/reviews" && req.method === "GET") {
      if (!req.session) return json(res, 401, { error: "Not authenticated" });
      const data = loadPipelineReviews();
      return json(res, 200, data);
    }

    // Save a pipeline review
    if (urlPath === "/api/pipeline/reviews" && req.method === "POST") {
      if (!req.session) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      const data = loadPipelineReviews();
      const review = {
        id: generateId(),
        date: new Date().toISOString().substring(0, 10),
        createdAt: new Date().toISOString(),
        notes: body.notes || {}, // { loanId: "free-form text", ... }
        summary: body.summary || null,
        tasksCreated: body.tasksCreated || [],
      };
      data.reviews.unshift(review);
      // Keep last 52 reviews (one year of weeklies)
      if (data.reviews.length > 52) data.reviews = data.reviews.slice(0, 52);
      savePipelineReviews(data);
      return json(res, 201, { review });
    }

    // Parse review notes into tasks (AI-powered via Anthropic API)
    if (urlPath === "/api/pipeline/parse-notes" && req.method === "POST") {
      if (!req.session) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      const notes = body.notes || {}; // { loanId: { borrowerName, note, loanStatus, loanAmount } }

      // Build prompt for Claude to parse notes into structured tasks
      const noteEntries = Object.entries(notes).filter(([, v]) => v.note && v.note.trim());
      if (noteEntries.length === 0) return json(res, 200, { tasks: [], summary: "No notes to process." });

      const notesText = noteEntries.map(([loanId, info]) =>
        `Loan: ${info.borrowerName} (${info.loanStatus}, $${(info.loanAmount || 0).toLocaleString()})\nNotes: ${info.note}`
      ).join("\n\n");

      const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
      if (!ANTHROPIC_KEY) {
        // Fallback: create one task per note without AI parsing
        const fallbackTasks = noteEntries.map(([loanId, info]) => ({
          title: `[Pipeline] ${info.borrowerName}: ${info.note.substring(0, 100)}`,
          assignee: "John",
          due: "",
          priority: "normal",
          project: "Pipeline",
          loanId,
        }));
        return json(res, 200, { tasks: fallbackTasks, summary: `Created ${fallbackTasks.length} task(s) from pipeline notes.` });
      }

      try {
        const prompt = `You are Dan, John's mortgage business AI assistant. Parse these pipeline review notes into structured tasks and follow-ups.

For each note, extract:
- Actionable tasks (things to do)
- Follow-ups (things to check on later)
- Status updates (changes to communicate)
- Escalations (urgent items)

Notes from pipeline review:
${notesText}

Return a JSON object with:
{
  "tasks": [
    { "title": "task description", "assignee": "John or team member name", "due": "YYYY-MM-DD or empty", "priority": "low|normal|high|urgent", "project": "Pipeline", "category": "task|followup|escalation", "loanId": "loan id if relevant" }
  ],
  "summary": "Brief summary of what was captured from this review"
}

Be specific and actionable. Use borrower names in task titles. If a note mentions a date, calculate the due date. Today is ${new Date().toISOString().substring(0, 10)}.`;

        const aiResp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 2000,
            messages: [{ role: "user", content: prompt }],
          }),
        });

        if (!aiResp.ok) {
          const errText = await aiResp.text();
          console.error("[pipeline] AI parse error:", errText);
          // Fallback to simple tasks
          const fallbackTasks = noteEntries.map(([loanId, info]) => ({
            title: `[Pipeline] ${info.borrowerName}: ${info.note.substring(0, 100)}`,
            assignee: "John",
            due: "",
            priority: "normal",
            project: "Pipeline",
            loanId,
          }));
          return json(res, 200, { tasks: fallbackTasks, summary: `Created ${fallbackTasks.length} task(s) from pipeline notes (AI unavailable).` });
        }

        const aiData = await aiResp.json();
        const aiText = aiData.content?.[0]?.text || "{}";
        // Extract JSON from response (may be wrapped in markdown code blocks)
        const jsonMatch = aiText.match(/\{[\s\S]*\}/);
        const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { tasks: [], summary: "Could not parse AI response." };

        return json(res, 200, parsed);
      } catch (e) {
        console.error("[pipeline] AI parse error:", e.message);
        const fallbackTasks = noteEntries.map(([loanId, info]) => ({
          title: `[Pipeline] ${info.borrowerName}: ${info.note.substring(0, 100)}`,
          assignee: "John",
          due: "",
          priority: "normal",
          project: "Pipeline",
          loanId,
        }));
        return json(res, 200, { tasks: fallbackTasks, summary: `Created ${fallbackTasks.length} task(s) from pipeline notes.` });
      }
    }

    /* ── Leads API ────────────────────────────────────────────── */
    const LEADS_FILE = path.join(DATA_DIR, "pipeline-leads.json");

    function loadLeadsData() {
      try { return JSON.parse(fs.readFileSync(LEADS_FILE, "utf8")); }
      catch { return { leads: [] }; }
    }
    function saveLeadsData(data) {
      fs.writeFileSync(LEADS_FILE, JSON.stringify(data, null, 2));
    }

    if (urlPath === "/api/pipeline/leads" && req.method === "GET") {
      if (!req.session) return json(res, 401, { error: "Not authenticated" });
      return json(res, 200, loadLeadsData());
    }

    if (urlPath === "/api/pipeline/leads" && req.method === "POST") {
      if (!req.session) return json(res, 401, { error: "Not authenticated" });
      const body = JSON.parse(await readBody(req));
      const data = loadLeadsData();
      const lead = {
        id: body.id || "lead-" + generateId(),
        name: String(body.name || "").substring(0, 200),
        phone: String(body.phone || "").substring(0, 30),
        email: String(body.email || "").substring(0, 200),
        source: String(body.source || "").substring(0, 50),
        status: String(body.status || "new").substring(0, 30),
        loanType: String(body.loanType || "").substring(0, 30),
        notes: String(body.notes || "").substring(0, 2000),
        createdAt: body.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      if (!lead.name) return json(res, 400, { error: "Name required" });

      // Upsert: if id exists, update; otherwise add
      const existingIdx = data.leads.findIndex(l => l.id === lead.id);
      if (existingIdx !== -1) {
        lead.createdAt = data.leads[existingIdx].createdAt;
        data.leads[existingIdx] = lead;
      } else {
        data.leads.unshift(lead);
      }
      saveLeadsData(data);
      return json(res, existingIdx !== -1 ? 200 : 201, { lead });
    }

    const leadDeleteMatch = urlPath.match(/^\/api\/pipeline\/leads\/([^/]+)$/);
    if (leadDeleteMatch && req.method === "DELETE") {
      if (!req.session) return json(res, 401, { error: "Not authenticated" });
      const id = leadDeleteMatch[1];
      const data = loadLeadsData();
      data.leads = data.leads.filter(l => l.id !== id);
      saveLeadsData(data);
      return json(res, 200, { ok: true });
    }

    // Dan API: leads access
    if (urlPath === "/api/dan/pipeline-leads" && (req.method === "GET" || req.method === "POST")) {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const data = loadLeadsData();
      const active = data.leads.filter(l => l.status !== "converted" && l.status !== "dead");
      return json(res, 200, {
        totalLeads: data.leads.length,
        activeLeads: active.length,
        leads: active,
      });
    }

    // Dan API: pipeline review access
    if (urlPath === "/api/dan/pipeline-reviews" && (req.method === "GET" || req.method === "POST")) {
      if (!req.session && !isDanApiKey()) return json(res, 401, { error: "Not authenticated" });
      const data = loadPipelineReviews();
      const latest = data.reviews[0] || null;
      return json(res, 200, {
        totalReviews: data.reviews.length,
        latestReview: latest,
        recentReviews: data.reviews.slice(0, 5),
      });
    }

    /* ── JOURNAL API ────────────────────────────────────────────────── */
    if (urlPath === "/api/journal" && req.method === "GET") {
      const entries = loadJournal(req.session.email);
      entries.sort((a, b) => (b.date > a.date ? 1 : -1));
      return json(res, 200, { entries });
    }

    if (urlPath === "/api/journal" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const date = String(body.date || "").substring(0, 10);
      const content = String(body.content || "").substring(0, 50000);
      const title = String(body.title || "").substring(0, 200);
      if (!date) return json(res, 400, { error: "date required" });
      const entries = loadJournal(req.session.email);
      const existing = entries.findIndex(e => e.date === date);
      if (existing !== -1) {
        entries[existing].content = content;
        entries[existing].title = title;
        entries[existing].updatedAt = new Date().toISOString();
        saveJournal(entries, req.session.email);
        return json(res, 200, { entry: entries[existing] });
      }
      const entry = { id: generateId(), date, title, content, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      entries.push(entry);
      saveJournal(entries, req.session.email);
      return json(res, 201, { entry });
    }

    const journalMatch = urlPath.match(/^\/api\/journal\/([a-f0-9]+)$/);
    if (journalMatch && req.method === "DELETE") {
      const id = journalMatch[1];
      const entries = loadJournal(req.session.email);
      const filtered = entries.filter(e => e.id !== id);
      if (filtered.length === entries.length) return json(res, 404, { error: "Entry not found" });
      saveJournal(filtered, req.session.email);
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
  // Start email polling for push notifications if subscriptions exist
  const subs = loadPushSubscriptions();
  if (subs.length > 0) {
    console.log(`[push] Starting email poll (${subs.length} subscription(s))`);
    startServerEmailPoll();
  }
  // Content watcher: initial poll after 30s, then every 2 hours
  setTimeout(async () => {
    try {
      const cw = require("./content-watcher");
      const result = await cw.pollFeeds();
      console.log(`[content-watcher] Initial poll: ${result.newCount} new triggers (${result.total} total)`);
    } catch (e) { console.error("[content-watcher] Initial poll error:", e.message); }
  }, 30000);
  setInterval(async () => {
    try {
      const cw = require("./content-watcher");
      const result = await cw.pollFeeds();
      if (result.newCount > 0) console.log(`[content-watcher] Found ${result.newCount} new triggers`);
    } catch (e) { console.error("[content-watcher] Poll error:", e.message); }
  }, 2 * 60 * 60 * 1000); // every 2 hours
  console.log(`[content-watcher] RSS polling: every 2 hours (initial in 30s)`);

  // Daily marketing meeting scheduler — runs at 5:00 AM ET
  function scheduleDailyMeeting() {
    const now = new Date();
    // Calculate next 5:00 AM ET
    const etNow = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const target = new Date(etNow);
    target.setHours(5, 0, 0, 0);
    if (target <= etNow) target.setDate(target.getDate() + 1);

    // Convert back to system time
    const delayMs = target.getTime() - etNow.getTime();
    const hoursUntil = (delayMs / 3600000).toFixed(1);
    console.log(`[marketing-engine] Next daily meeting in ${hoursUntil}h (5:00 AM ET)`);

    setTimeout(async () => {
      async function runMeeting() {
        try {
          const me = require("./marketing-engine");
          const briefing = await me.runDailyMeeting();
          console.log(`[marketing-engine] Daily briefing generated: ${(briefing.contentRecommendations || []).length} recommendations`);
        } catch (e) {
          console.error("[marketing-engine] Daily meeting error:", e.message);
        }
      }
      await runMeeting();
      // Then every 24 hours
      setInterval(runMeeting, 24 * 60 * 60 * 1000);
    }, delayMs);
  }

  if (process.env.ANTHROPIC_API_KEY) {
    scheduleDailyMeeting();
  } else {
    console.log("[marketing-engine] ANTHROPIC_API_KEY not set — daily meeting disabled");
  }
});
