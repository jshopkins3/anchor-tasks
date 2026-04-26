/**
 * messaging.js — JSON-backed messaging primitive for Dan/Tasks.
 *
 * Three collections in data/messaging.json:
 *   threads:      [{ id, type, context_id, title, created_at, archived_at }]
 *   messages:     [{ id, thread_id, author, body, metadata, created_at, edited_at }]
 *   participants: [{ thread_id, user_email, notification_pref, last_read_at, added_at }]
 *
 * thread.type:
 *   loan      → context_id = ARIVE Loan Id
 *   task      → context_id = task id
 *   team      → context_id = channel slug ('anchor-ops', 'mcm-leadership')
 *   dm        → context_id = sorted-pair email hash
 *   system    → context_id = subsystem name ('workflow-engine', 'arive-webhook')
 *
 * message.author:
 *   <email>            → human
 *   'dan'              → Dan AI
 *   'system'           → generic system event
 *   'workflow:<slug>'  → fired by a specific workflow rule
 *
 * Designed for portability to MCM Supabase: same row shape, just storage swap.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_FILE = path.join(__dirname, "data", "messaging.json");

// Anchor team — kept here so messaging is self-contained. Mirrors TEAM_MAP
// in server.js. When MCM messaging absorbs this, switch to a Supabase users
// query scoped by branch.
const ANCHOR_TEAM = [
  "john@myanchormortgage.com",
  "brenda@mychomeloans.com",
  "corey@myanchormortgage.com",
  "kat@myanchormortgage.com",
];

// Default participant rules per thread type. Minimal noise = only people
// who actually need to see the thread by default. Anyone else can be added
// via addParticipant or mute via notification_pref.
function defaultParticipantsForThread(threadType) {
  switch (threadType) {
    case "loan":     return ["john@myanchormortgage.com", "brenda@mychomeloans.com"];
    case "task":     return ["john@myanchormortgage.com"]; // task creator added separately
    case "team":     return ANCHOR_TEAM;
    case "system":   return ["john@myanchormortgage.com"];
    case "dm":       return []; // DM participants set explicitly at creation
    default:         return [];
  }
}

// Pre-created team channels — seeded on first load if missing. Slugs are
// stable identifiers used as context_id.
const SEED_CHANNELS = [
  { slug: "anchor-ops",        title: "Anchor Ops" },
  { slug: "anchor-loans",      title: "Loan Pipeline" },
  { slug: "anchor-leadership", title: "Leadership" },
];

function uuid() {
  // Simple UUIDv4-ish — adequate for JSON storage; will become real UUIDs in Supabase
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

function ensureFile() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ threads: [], messages: [], participants: [] }, null, 2));
  }
}

function loadStore() {
  ensureFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      threads: Array.isArray(parsed.threads) ? parsed.threads : [],
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      participants: Array.isArray(parsed.participants) ? parsed.participants : [],
    };
  } catch (e) {
    console.error("[messaging] load error:", e.message);
    return { threads: [], messages: [], participants: [] };
  }
}

function saveStore(store) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

// ─── Threads ────────────────────────────────────────────────────────

/**
 * Upsert a thread by (type, context_id). Returns existing or newly created thread.
 */
function ensureThread({ type, context_id, title, participants }) {
  if (!type || !context_id) throw new Error("type and context_id required");
  const store = loadStore();
  const existing = store.threads.find((t) => t.type === type && t.context_id === String(context_id));
  if (existing) {
    if (title && !existing.title) {
      existing.title = title;
      saveStore(store);
    }
    return existing;
  }
  const t = {
    id: uuid(),
    type,
    context_id: String(context_id),
    title: title || null,
    created_at: new Date().toISOString(),
    archived_at: null,
  };
  store.threads.push(t);

  // Auto-populate participants per thread-type defaults. Caller can override.
  const participantList = Array.isArray(participants) && participants.length
    ? participants
    : defaultParticipantsForThread(type);
  for (const email of participantList) {
    const exists = store.participants.find((p) => p.thread_id === t.id && p.user_email === email);
    if (!exists) {
      store.participants.push({
        thread_id: t.id,
        user_email: email,
        notification_pref: "all",
        last_read_at: null,
        added_at: new Date().toISOString(),
      });
    }
  }

  saveStore(store);
  return t;
}

// Seed pre-created team channels. Idempotent — only creates missing ones.
function seedChannels() {
  for (const ch of SEED_CHANNELS) {
    ensureThread({ type: "team", context_id: ch.slug, title: ch.title });
  }
}

// DM helper — generates a stable context_id from a sorted email pair so
// "john→brenda" and "brenda→john" resolve to the same thread.
function ensureDM(emailA, emailB) {
  const pair = [emailA.toLowerCase(), emailB.toLowerCase()].sort();
  const context_id = "dm:" + crypto.createHash("sha1").update(pair.join("|")).digest("hex").slice(0, 16);
  const title = pair.join(" ↔ ");
  return ensureThread({ type: "dm", context_id, title, participants: pair });
}

function listChannels() {
  const store = loadStore();
  return store.threads.filter((t) => t.type === "team");
}

// Return participants list (emails) for a thread.
function getParticipantEmails(threadId) {
  const store = loadStore();
  return store.participants
    .filter((p) => p.thread_id === threadId && p.notification_pref !== "off")
    .map((p) => p.user_email);
}

function listThreads({ type, limit = 100 } = {}) {
  const store = loadStore();
  let threads = store.threads;
  if (type) threads = threads.filter((t) => t.type === type);
  return threads
    .slice()
    .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
    .slice(0, Math.min(Number(limit) || 100, 500));
}

function getThread(id) {
  const store = loadStore();
  return store.threads.find((t) => t.id === id) || null;
}

// ─── Messages ───────────────────────────────────────────────────────

function postMessage({ thread, author, body, metadata }) {
  if (!author || !body) throw new Error("author and body required");
  const store = loadStore();

  let threadRow;
  if (thread && thread.id) {
    threadRow = store.threads.find((t) => t.id === thread.id);
    if (!threadRow) throw new Error(`thread not found: ${thread.id}`);
  } else if (thread && thread.type && thread.context_id) {
    // Upsert in-place since we already have the store loaded
    threadRow = store.threads.find((t) => t.type === thread.type && t.context_id === String(thread.context_id));
    if (!threadRow) {
      threadRow = {
        id: uuid(),
        type: thread.type,
        context_id: String(thread.context_id),
        title: thread.title || null,
        created_at: new Date().toISOString(),
        archived_at: null,
      };
      store.threads.push(threadRow);
    } else if (thread.title && !threadRow.title) {
      threadRow.title = thread.title;
    }
  } else {
    throw new Error("thread.id OR thread.{type,context_id} required");
  }

  const msg = {
    id: uuid(),
    thread_id: threadRow.id,
    author,
    body: String(body),
    metadata: metadata || null,
    created_at: new Date().toISOString(),
    edited_at: null,
  };
  store.messages.push(msg);

  // Auto-add author as participant when they're a real user (email).
  // System/workflow/dan authors don't get participant rows.
  if (author.includes("@")) {
    const exists = store.participants.find((p) => p.thread_id === threadRow.id && p.user_email === author);
    if (!exists) {
      store.participants.push({
        thread_id: threadRow.id,
        user_email: author,
        notification_pref: "all",
        last_read_at: null,
        added_at: new Date().toISOString(),
      });
    }
  }

  saveStore(store);
  return { thread: threadRow, message: msg };
}

function listMessages(threadId, { limit = 200, before } = {}) {
  const store = loadStore();
  let msgs = store.messages.filter((m) => m.thread_id === threadId);
  if (before) msgs = msgs.filter((m) => m.created_at < before);
  msgs.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return msgs.slice(-Math.min(Number(limit) || 200, 500));
}

// ─── Participants + inbox ───────────────────────────────────────────

function addParticipant({ thread_id, user_email, notification_pref = "all" }) {
  const store = loadStore();
  const existing = store.participants.find((p) => p.thread_id === thread_id && p.user_email === user_email);
  if (existing) {
    existing.notification_pref = notification_pref;
    saveStore(store);
    return existing;
  }
  const p = {
    thread_id,
    user_email,
    notification_pref,
    last_read_at: null,
    added_at: new Date().toISOString(),
  };
  store.participants.push(p);
  saveStore(store);
  return p;
}

function markRead(thread_id, user_email) {
  const store = loadStore();
  let p = store.participants.find((x) => x.thread_id === thread_id && x.user_email === user_email);
  if (!p) {
    p = { thread_id, user_email, notification_pref: "all", last_read_at: null, added_at: new Date().toISOString() };
    store.participants.push(p);
  }
  p.last_read_at = new Date().toISOString();
  saveStore(store);
  return p;
}

function inboxFor(user_email) {
  const store = loadStore();
  const myParts = store.participants.filter((p) => p.user_email === user_email);
  if (!myParts.length) return [];
  const threadIds = new Set(myParts.map((p) => p.thread_id));
  const threads = store.threads.filter((t) => threadIds.has(t.id));

  // Latest message per thread
  const lastByThread = {};
  for (const m of store.messages) {
    if (!threadIds.has(m.thread_id)) continue;
    const cur = lastByThread[m.thread_id];
    if (!cur || m.created_at > cur.created_at) lastByThread[m.thread_id] = m;
  }

  return threads
    .map((t) => {
      const part = myParts.find((p) => p.thread_id === t.id);
      const last = lastByThread[t.id] || null;
      const unread = !!(last && (!part?.last_read_at || last.created_at > part.last_read_at));
      return { ...t, last_message: last, unread, notification_pref: part?.notification_pref || "all" };
    })
    .sort((a, b) => {
      const ta = a.last_message?.created_at || a.created_at;
      const tb = b.last_message?.created_at || b.created_at;
      return tb.localeCompare(ta);
    });
}

module.exports = {
  ensureThread,
  ensureDM,
  seedChannels,
  listChannels,
  listThreads,
  getThread,
  postMessage,
  listMessages,
  addParticipant,
  getParticipantEmails,
  markRead,
  inboxFor,
  ANCHOR_TEAM,
};
