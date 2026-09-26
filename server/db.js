// REVEXON.AI database layer — SQLite via better-sqlite3.
// Gives conversations, messages, and folders a persistent home on the
// server instead of only living in the browser's localStorage, so history
// survives clearing browser data and works across devices hitting the
// same server.

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "revexon.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'New chat',
    pinned INTEGER NOT NULL DEFAULT 0,
    folder_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    api_content TEXT,
    liked INTEGER,
    attachments TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    request_count INTEGER NOT NULL DEFAULT 0,
    feature TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_usage_log_user_date ON usage_log(user_id, date);

  -- Full-text search over message content, so REVEXON (and the sidebar
  -- search box) can find relevant text from any past conversation.
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content, content='messages', content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
  END;
`);

// --- Migration: add user_id to conversations and folders -----------------
// SQLite has no "ADD COLUMN IF NOT EXISTS", so we check pragma info first.
// This runs safely against an existing database with data already in it:
// - existing rows get user_id = NULL (treated as legacy/unowned — never
//   returned to any anonymous user, never deleted automatically)
// - new rows always get a real user_id from here on
// This is idempotent: on a fresh database the columns already exist from
// the CREATE TABLE above, so these ALTERs are simply skipped.
function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}
if (!columnExists("conversations", "user_id")) {
  db.exec(`ALTER TABLE conversations ADD COLUMN user_id TEXT;`);
  console.log("Migrated: added conversations.user_id (existing rows left unowned/legacy).");
}
if (!columnExists("folders", "user_id")) {
  db.exec(`ALTER TABLE folders ADD COLUMN user_id TEXT;`);
  console.log("Migrated: added folders.user_id (existing rows left unowned/legacy).");
}
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
  CREATE INDEX IF NOT EXISTS idx_folders_user_id ON folders(user_id);
`);

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function recordUsage(userId, feature, tokensUsed, requestCount = 1, date = todayIso()) {
  if (!userId || !feature) return false;
  const safeTokens = Math.max(0, Number(tokensUsed) || 0);
  const safeRequests = Math.max(0, Number(requestCount) || 0);
  if (safeTokens === 0 && safeRequests === 0) return false;
  db.prepare(
    `INSERT INTO usage_log (user_id, date, tokens_used, request_count, feature, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, date, safeTokens, safeRequests, feature, Date.now());
  return true;
}

function getUsageForUser(userId, date = todayIso()) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(tokens_used), 0) AS tokens_used,
           COALESCE(SUM(request_count), 0) AS request_count
    FROM usage_log
    WHERE user_id = ? AND date = ?
  `).get(userId, date);
  return {
    date,
    tokensUsed: Number(row?.tokens_used || 0),
    requestCount: Number(row?.request_count || 0),
  };
}

function getFeatureUsageForUser(userId, date = todayIso()) {
  return db.prepare(`
    SELECT feature, SUM(tokens_used) AS tokens_used, SUM(request_count) AS request_count
    FROM usage_log
    WHERE user_id = ? AND date = ?
    GROUP BY feature
    ORDER BY feature ASC
  `).all(userId, date);
}

function getFeatureRequestCount(userId, feature, date = todayIso()) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(request_count), 0) AS request_count
    FROM usage_log
    WHERE user_id = ? AND date = ? AND feature = ?
  `).get(userId, date, feature);
  return Number(row?.request_count || 0);
}

/* ---------- Folders (scoped to a user) ---------- */
function listFolders(userId) {
  return db.prepare("SELECT * FROM folders WHERE user_id = ? ORDER BY created_at ASC").all(userId);
}
function createFolder(id, name, userId) {
  db.prepare("INSERT INTO folders (id, name, created_at, user_id) VALUES (?, ?, ?, ?)").run(id, name, Date.now(), userId);
}
// Deleting a folder only detaches/removes it if it actually belongs to
// this user — otherwise a guessed folder ID from another user is a no-op.
function deleteFolder(id, userId) {
  const folder = db.prepare("SELECT id FROM folders WHERE id = ? AND user_id = ?").get(id, userId);
  if (!folder) return false;
  db.prepare("UPDATE conversations SET folder_id = NULL WHERE folder_id = ? AND user_id = ?").run(id, userId);
  db.prepare("DELETE FROM folders WHERE id = ? AND user_id = ?").run(id, userId);
  return true;
}

/* ---------- Conversations (scoped to a user) ---------- */
function listConversations(userId) {
  const convs = db.prepare("SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC").all(userId);
  const msgStmt = db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC");
  return convs.map((c) => ({
    id: c.id,
    title: c.title,
    pinned: Boolean(c.pinned),
    folderId: c.folder_id,
    createdAt: c.created_at,
    messages: msgStmt.all(c.id).map(rowToMessage),
  }));
}
function rowToMessage(m) {
  return {
    role: m.role,
    content: m.content,
    apiContent: m.api_content || undefined,
    liked: m.liked === null ? null : Boolean(m.liked),
    attachments: m.attachments ? JSON.parse(m.attachments) : [],
    ts: m.created_at,
  };
}
// Returns true if the given conversation exists and belongs to userId.
// Every mutation below checks this first — the ownership check IS the
// security boundary, not just the read filtering.
function ownsConversation(id, userId) {
  return Boolean(db.prepare("SELECT id FROM conversations WHERE id = ? AND user_id = ?").get(id, userId));
}
function createConversation(id, title, userId) {
  const now = Date.now();
  db.prepare(
    "INSERT INTO conversations (id, title, pinned, folder_id, created_at, updated_at, user_id) VALUES (?, ?, 0, NULL, ?, ?, ?)"
  ).run(id, title, now, now, userId);
}
function touchConversation(id, userId) {
  db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?").run(Date.now(), id, userId);
}
function renameConversation(id, title, userId) {
  const info = db.prepare("UPDATE conversations SET title = ? WHERE id = ? AND user_id = ?").run(title, id, userId);
  return info.changes > 0;
}
function pinConversation(id, pinned, userId) {
  const info = db.prepare("UPDATE conversations SET pinned = ? WHERE id = ? AND user_id = ?").run(pinned ? 1 : 0, id, userId);
  return info.changes > 0;
}
function moveConversation(id, folderId, userId) {
  // If a folderId was given, it must also belong to this user — otherwise
  // silently refuse rather than letting a conversation be filed under
  // someone else's folder id.
  if (folderId) {
    const folder = db.prepare("SELECT id FROM folders WHERE id = ? AND user_id = ?").get(folderId, userId);
    if (!folder) return false;
  }
  const info = db.prepare("UPDATE conversations SET folder_id = ? WHERE id = ? AND user_id = ?").run(folderId || null, id, userId);
  return info.changes > 0;
}
function deleteConversation(id, userId) {
  const info = db.prepare("DELETE FROM conversations WHERE id = ? AND user_id = ?").run(id, userId);
  return info.changes > 0;
}
function deleteAllConversations(userId) {
  db.prepare("DELETE FROM conversations WHERE user_id = ?").run(userId);
}

/* ---------- Messages (all scoped via the parent conversation's owner) ---------- */
// Every message mutation takes userId and checks ownsConversation() first
// so a guessed conversation ID from another user can't be used to add,
// replace, or like messages in it.
function addMessage(conversationId, msg, userId) {
  if (!ownsConversation(conversationId, userId)) return false;
  db.prepare(
    `INSERT INTO messages (conversation_id, role, content, api_content, liked, attachments, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    conversationId,
    msg.role,
    msg.content || "",
    msg.apiContent || null,
    msg.liked === null || msg.liked === undefined ? null : msg.liked ? 1 : 0,
    msg.attachments ? JSON.stringify(msg.attachments) : null,
    msg.ts || Date.now()
  );
  touchConversation(conversationId, userId);
  return true;
}
// Replaces all messages in a conversation (used for edit/regenerate, which
// truncate history from a point and re-send).
function replaceMessages(conversationId, messages, userId) {
  if (!ownsConversation(conversationId, userId)) return false;
  const del = db.prepare("DELETE FROM messages WHERE conversation_id = ?");
  const ins = db.prepare(
    `INSERT INTO messages (conversation_id, role, content, api_content, liked, attachments, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const tx = db.transaction((msgs) => {
    del.run(conversationId);
    for (const msg of msgs) {
      ins.run(
        conversationId,
        msg.role,
        msg.content || "",
        msg.apiContent || null,
        msg.liked === null || msg.liked === undefined ? null : msg.liked ? 1 : 0,
        msg.attachments ? JSON.stringify(msg.attachments) : null,
        msg.ts || Date.now()
      );
    }
  });
  tx(messages);
  touchConversation(conversationId, userId);
  return true;
}
function setMessageLiked(conversationId, messageIndex, liked, userId) {
  if (!ownsConversation(conversationId, userId)) return false;
  const rows = db
    .prepare("SELECT id FROM messages WHERE conversation_id = ? ORDER BY id ASC")
    .all(conversationId);
  const row = rows[messageIndex];
  if (!row) return false;
  db.prepare("UPDATE messages SET liked = ? WHERE id = ?").run(
    liked === null ? null : liked ? 1 : 0,
    row.id
  );
  return true;
}

/* ---------- Search (full-text, scoped to this user's own conversations) ---------- */
function searchMessages(query, userId, limit = 20) {
  if (!query || !query.trim()) return [];
  // Sanitize for FTS5 MATCH syntax by quoting the phrase.
  const safe = query.replace(/"/g, '""');
  try {
    return db
      .prepare(
        `SELECT m.conversation_id as conversationId, c.title, m.role, m.content, m.created_at as ts
         FROM messages_fts f
         JOIN messages m ON m.id = f.rowid
         JOIN conversations c ON c.id = m.conversation_id
         WHERE messages_fts MATCH ? AND c.user_id = ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(`"${safe}"`, userId, limit);
  } catch {
    return []; // malformed FTS query (e.g. lone special chars) — fail soft
  }
}

module.exports = {
  listFolders,
  createFolder,
  deleteFolder,
  listConversations,
  createConversation,
  touchConversation,
  renameConversation,
  pinConversation,
  moveConversation,
  deleteConversation,
  deleteAllConversations,
  ownsConversation,
  addMessage,
  replaceMessages,
  setMessageLiked,
  searchMessages,
  recordUsage,
  getUsageForUser,
  getFeatureUsageForUser,
  getFeatureRequestCount,
};

