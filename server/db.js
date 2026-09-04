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

  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);

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

/* ---------- Folders ---------- */
function listFolders() {
  return db.prepare("SELECT * FROM folders ORDER BY created_at ASC").all();
}
function createFolder(id, name) {
  db.prepare("INSERT INTO folders (id, name, created_at) VALUES (?, ?, ?)").run(id, name, Date.now());
}
function deleteFolder(id) {
  db.prepare("UPDATE conversations SET folder_id = NULL WHERE folder_id = ?").run(id);
  db.prepare("DELETE FROM folders WHERE id = ?").run(id);
}

/* ---------- Conversations ---------- */
function listConversations() {
  const convs = db.prepare("SELECT * FROM conversations ORDER BY updated_at DESC").all();
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
function createConversation(id, title) {
  const now = Date.now();
  db.prepare(
    "INSERT INTO conversations (id, title, pinned, folder_id, created_at, updated_at) VALUES (?, ?, 0, NULL, ?, ?)"
  ).run(id, title, now, now);
}
function touchConversation(id) {
  db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(Date.now(), id);
}
function renameConversation(id, title) {
  db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title, id);
}
function pinConversation(id, pinned) {
  db.prepare("UPDATE conversations SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id);
}
function moveConversation(id, folderId) {
  db.prepare("UPDATE conversations SET folder_id = ? WHERE id = ?").run(folderId || null, id);
}
function deleteConversation(id) {
  db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
}
function deleteAllConversations() {
  db.prepare("DELETE FROM conversations").run();
}

/* ---------- Messages ---------- */
function addMessage(conversationId, msg) {
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
  touchConversation(conversationId);
}
// Replaces all messages in a conversation (used for edit/regenerate, which
// truncate history from a point and re-send).
function replaceMessages(conversationId, messages) {
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
  touchConversation(conversationId);
}
function setMessageLiked(conversationId, messageIndex, liked) {
  const rows = db
    .prepare("SELECT id FROM messages WHERE conversation_id = ? ORDER BY id ASC")
    .all(conversationId);
  const row = rows[messageIndex];
  if (!row) return;
  db.prepare("UPDATE messages SET liked = ? WHERE id = ?").run(
    liked === null ? null : liked ? 1 : 0,
    row.id
  );
}

/* ---------- Search (full-text, across all conversations) ---------- */
function searchMessages(query, limit = 20) {
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
         WHERE messages_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(`"${safe}"`, limit);
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
  addMessage,
  replaceMessages,
  setMessageLiked,
  searchMessages,
};
