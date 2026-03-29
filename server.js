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
const GCAL_TOKEN_FILE = path.join(DATA_DIR, "gcal-token.json");

// Google Calendar config
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GCAL_CALENDAR_ID = process.env.GCAL_CALENDAR_ID || "primary";
const ANCHOR_GCAL_CALENDAR_ID = process.env.ANCHOR_GCAL_CALENDAR_ID ||
  "c_973e23a22956e78db27d478e42e11cc3e472f97c6c1d6587291742f3e3029a4a@group.calendar.google.com";
const GCAL_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
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

/* ─── Helpers ────────────────────────────────────────────────────────── */
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let d = "";
      res.on("data", c => (d += c));
      res.on("end", () => resolve(d));
    }).on("error", reject);
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
      done,
    });
  }
  return tasks;
}

function writeTasks(tasks) {
  const active = tasks.filter(t => !t.done);
  const completed = tasks.filter(t => t.done);
  const fmt = t => `- [${t.done ? "x" : " "}] ${t.id} | ${t.title} | ${t.assignee} | ${t.due} | ${t.priority} | ${t.project} | ${t.status || ""} | ${t.personal ? "true" : "false"} | ${t.urgent ? "true" : "false"} | ${t.important ? "true" : "false"} | ${t.linkedGoal || ""} | ${t.todayFocus ? "true" : "false"} | ${t.todayOrder || 0} | ${t.calEventId || ""} | ${t.scheduledStart || ""}`;
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
  try { return fs.existsSync(GCAL_TOKEN_FILE) ? JSON.parse(fs.readFileSync(GCAL_TOKEN_FILE, "utf8")) : null; }
  catch { return null; }
}
function saveGCalToken(token) {
  fs.writeFileSync(GCAL_TOKEN_FILE, JSON.stringify(token, null, 2));
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
    if (!PUBLIC_PATHS.includes(urlPath) && urlPath.startsWith("/api/")) {
      const session = getSession(req);
      if (!session) return json(res, 401, { error: "Not authenticated" });
      // Attach session to req for downstream handlers
      req.session = session;
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
        if (data.refresh_token) {
          saveGCalToken({
            refresh_token: data.refresh_token,
            access_token: data.access_token,
            expires_at: Date.now() + (data.expires_in || 3600) * 1000,
          });
          console.log("[gcal] Calendar connected successfully");
          res.writeHead(302, { Location: "/?gcal=connected" });
        } else {
          console.error("[gcal] No refresh token in response:", data);
          res.writeHead(302, { Location: "/?gcal=error" });
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
      const { startTime, endTime, allDay } = body;
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
          start: { dateTime: startTime },
          end: { dateTime: endTime },
        };
      }
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
