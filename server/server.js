// REVEXON.AI backend — proxies chat requests to Groq's free, OpenAI-compatible
// API. The API key lives only here, in the server process (via .env), and is
// never sent to or exposed in the browser.

const express = require("express");
const cors = require("cors");
require("dotenv").config();
const db = require("./db");
const multer = require("multer");
const { PDFParse } = require("pdf-parse");
const mammoth = require("mammoth");

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// Files are handled in memory (never written to disk) since they're only
// needed briefly to extract text or convert to base64 before being sent
// to the model — nothing is persisted server-side.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 5 }, // 15MB/file, 5 files per request
});

// Vision-capable Groq model for image understanding. Groq's multimodal
// lineup changes often and this one is currently flagged "preview" by
// Groq itself — if it 404s, check https://console.groq.com/docs/vision
// for the current vision model and update this constant.
const VISION_MODEL = "qwen/qwen3.6-27b";

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static("public"));

// Maps REVEXON's model names to real Groq-hosted models.
// Keeping this mapping server-side means the frontend never needs to know
// real model identifiers, and they can be updated in one place.
const MODEL_MAP = {
  fast: "openai/gpt-oss-20b",
  pro: "openai/gpt-oss-120b",
  reason: "openai/gpt-oss-120b",
  vision: "meta-llama/llama-4-maverick-17b-128e-instruct",
};

// Groq's free-tier model lineup changes often (models get deprecated with
// only an email notice). On startup, verify our mapped models actually
// exist so a bad ID surfaces immediately in the console instead of as a
// confusing 404 mid-conversation.
let validatedModels = null;
async function validateModels() {
  if (!API_KEY) return;
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    const available = new Set((data.data || []).map((m) => m.id));
    validatedModels = available;
    for (const [label, id] of Object.entries(MODEL_MAP)) {
      if (!available.has(id)) {
        console.warn(
          `⚠️  Model "${id}" (mapped to "${label}") was not found in your Groq account's available models. It may have been deprecated — check https://console.groq.com/docs/models and update MODEL_MAP in server.js.`
        );
      }
    }
  } catch (err) {
    console.warn("Couldn't validate Groq models on startup:", err.message);
  }
}

const BASE_IDENTITY = `You are REVEXON, the AI assistant inside REVEXON.AI ("Intelligence. Reimagined."), a
premium AI chatbot product. Format responses with markdown (headings, lists, tables, code
blocks with language tags) when it aids clarity, but don't over-format simple answers.`;

const PERSONAS = {
  default: `${BASE_IDENTITY}\nBe helpful, clear, and direct. Keep a confident, modern, slightly sophisticated tone without being verbose or using excessive exclamation points.`,
  concise: `${BASE_IDENTITY}\nBe extremely concise. Answer in as few words as possible while staying correct and useful. Avoid preamble, caveats, and pleasantries. Prefer short lists over paragraphs.`,
  creative: `${BASE_IDENTITY}\nBe imaginative, vivid, and playful. Use rich language, metaphor, and unexpected angles. This persona is for brainstorming, storytelling, and creative writing — favor originality over caution.`,
  coding: `${BASE_IDENTITY}\nYou are in expert coding mode. Prioritize correct, idiomatic, production-quality code. Explain trade-offs briefly, flag edge cases, and default to showing code first, explanation second. Assume the user is an experienced developer unless they say otherwise.`,
  teacher: `${BASE_IDENTITY}\nYou are in patient teaching mode. Break concepts into small steps, check understanding, use analogies, and build from fundamentals. Prefer clarity over brevity — it's fine to be longer if it aids understanding.`,
};

function sanitizeMessages(messages, persona) {
  const cleaned = (messages || [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && hasContent(m.content))
    .map((m) => ({ role: m.role, content: m.content }));
  const systemPrompt = PERSONAS[persona] || PERSONAS.default;
  return [{ role: "system", content: systemPrompt }, ...cleaned];
}
// Content is either a plain string or an OpenAI-style content-block array
// (for multimodal messages containing images). Both need a non-empty check.
function hasContent(content) {
  if (typeof content === "string") return content.trim().length > 0;
  if (Array.isArray(content)) return content.length > 0;
  return false;
}
// True if any message in the conversation includes an image block —
// used to route the request to the vision-capable model regardless of
// which REVEXON model the user has selected, since only one Groq model
// on the free tier currently supports image input.
function conversationHasImage(messages) {
  return (messages || []).some(
    (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "image_url")
  );
}

function requireApiKey(req, res, next) {
  if (!API_KEY) {
    return res.status(500).json({
      error:
        "Server is missing GROQ_API_KEY. Add it to server/.env and restart the server.",
    });
  }
  next();
}

// Turns Groq's raw error response into a clear, actionable console message.
// The browser still only ever sees the generic user-facing string (below),
// but this makes the real cause immediately visible in the server terminal.
function friendlyGroqError(status, rawBody) {
  try {
    const parsed = JSON.parse(rawBody);
    const code = parsed?.error?.code;
    if (status === 404 && code === "model_not_found") {
      console.error(
        "👉 A model in MODEL_MAP is no longer available on Groq. Check https://console.groq.com/docs/models for current model IDs and update MODEL_MAP in server.js."
      );
    }
    if (status === 429) {
      console.error("👉 Groq rate limit hit — wait a minute before retrying.");
    }
  } catch {
    // rawBody wasn't JSON; nothing extra to log
  }
  return "REVEXON couldn't complete that request.";
}

// Non-streaming fallback endpoint (used if streaming is turned off, or the
// client can't read SSE streams).
app.post("/api/chat", requireApiKey, async (req, res) => {
  try {
    const { messages, model, persona } = req.body;
    const sanitized = sanitizeMessages(messages, persona);
    const effectiveModel = conversationHasImage(messages) ? VISION_MODEL : (MODEL_MAP[model] || MODEL_MAP.pro);
    const groqRes = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: effectiveModel,
        max_tokens: 2048,
        messages: sanitized,
      }),
    });

    if (!groqRes.ok) {
      const errBody = await groqRes.text();
      console.error("Groq API error:", groqRes.status, errBody);
      return res.status(502).json({ error: friendlyGroqError(groqRes.status, errBody) });
    }

    const data = await groqRes.json();
    const text = data.choices?.[0]?.message?.content || "";
    res.json({ text });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "REVEXON couldn't complete that request." });
  }
});

// Streaming endpoint — proxies Groq's SSE stream to the browser as
// plain text chunks, so the frontend can render tokens as they arrive.
app.post("/api/chat/stream", requireApiKey, async (req, res) => {
  try {
    const { messages, model, persona } = req.body;
    const sanitized = sanitizeMessages(messages, persona);
    const effectiveModel = conversationHasImage(messages) ? VISION_MODEL : (MODEL_MAP[model] || MODEL_MAP.pro);

    const groqRes = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: effectiveModel,
        max_tokens: 2048,
        messages: sanitized,
        stream: true,
      }),
    });

    if (!groqRes.ok || !groqRes.body) {
      const errBody = await groqRes.text().catch(() => "");
      console.error("Groq stream error:", groqRes.status, errBody);
      res.status(502).json({ error: friendlyGroqError(groqRes.status, errBody) });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const reader = groqRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    req.on("close", () => {
      reader.cancel().catch(() => {});
    });

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep last partial line in buffer

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === "[DONE]") {
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          continue;
        }
        try {
          const event = JSON.parse(payload);
          const delta = event.choices?.[0]?.delta?.content;
          if (delta) {
            res.write(`data: ${JSON.stringify({ text: delta })}\n\n`);
          }
        } catch {
          // ignore non-JSON keep-alive lines
        }
      }
    }

    res.end();
  } catch (err) {
    console.error("Stream error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "REVEXON couldn't complete that request." });
    } else {
      res.write(`data: ${JSON.stringify({ error: true })}\n\n`);
      res.end();
    }
  }
});

/* ============ FILE PROCESSING ============ */
// Extracts real, usable content from an uploaded file so REVEXON can
// actually see it — not just acknowledge a filename. Runs entirely in
// memory; nothing is written to disk.
//
// - Images: returned as base64 + mime type, for the client to attach
//   directly to the next chat message's content array (Groq's vision
//   models expect images inline in the message, not as a separate blob).
// - PDF / DOCX / TXT / CSV: text is extracted here and returned directly,
//   so the client can fold it into the message text.
app.post("/api/files/process", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  const { originalname, mimetype, buffer, size } = req.file;
  const ext = (originalname.split(".").pop() || "").toLowerCase();

  try {
    if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) {
      const normalizedMime = mimetype && mimetype.startsWith("image/") ? mimetype : `image/${ext === "jpg" ? "jpeg" : ext}`;
      return res.json({
        kind: "image",
        name: originalname,
        mimeType: normalizedMime,
        base64: buffer.toString("base64"),
        size,
      });
    }

    if (ext === "pdf") {
      const parser = new PDFParse({ data: buffer });
      try {
        const result = await parser.getText();
        const text = (result.text || "").trim();
        if (!text) {
          return res.json({ kind: "text", name: originalname, text: "", warning: "This PDF appears to have no extractable text (it may be a scanned image)." });
        }
        return res.json({ kind: "text", name: originalname, text: truncateForModel(text) });
      } finally {
        await parser.destroy();
      }
    }

    if (ext === "docx") {
      const result = await mammoth.extractRawText({ buffer });
      const text = (result.value || "").trim();
      return res.json({ kind: "text", name: originalname, text: truncateForModel(text) });
    }

    if (ext === "txt" || ext === "csv") {
      const text = buffer.toString("utf-8").trim();
      return res.json({ kind: "text", name: originalname, text: truncateForModel(text) });
    }

    return res.status(415).json({ error: `Unsupported file type: .${ext}` });
  } catch (err) {
    console.error("File processing error:", originalname, err);
    res.status(500).json({ error: `Couldn't read ${originalname}.` });
  }
});

// Keeps very large documents from blowing past the model's context window
// or burning an excessive share of it on a single attachment.
function truncateForModel(text, maxChars = 24000) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n\n[...truncated — original document was ${text.length.toLocaleString()} characters]`;
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    apiKeyConfigured: Boolean(API_KEY),
    modelsValidated: Boolean(validatedModels),
  });
});

/* ============ DATA API (conversations, messages, folders) ============ */
// A small REST layer over server/db.js. The frontend uses this instead of
// localStorage, so history persists on the server rather than per-browser.

app.get("/api/state", (req, res) => {
  try {
    res.json({ conversations: db.listConversations(), folders: db.listFolders() });
  } catch (err) {
    console.error("State load error:", err);
    res.status(500).json({ error: "Couldn't load saved conversations." });
  }
});

app.post("/api/conversations", (req, res) => {
  try {
    const { id, title } = req.body;
    db.createConversation(id, title || "New chat");
    res.json({ ok: true });
  } catch (err) {
    console.error("Create conversation error:", err);
    res.status(500).json({ error: "Couldn't create conversation." });
  }
});

app.patch("/api/conversations/:id", (req, res) => {
  try {
    const { id } = req.params;
    const { title, pinned, folderId } = req.body;
    if (title !== undefined) db.renameConversation(id, title);
    if (pinned !== undefined) db.pinConversation(id, pinned);
    if (folderId !== undefined) db.moveConversation(id, folderId);
    res.json({ ok: true });
  } catch (err) {
    console.error("Update conversation error:", err);
    res.status(500).json({ error: "Couldn't update conversation." });
  }
});

app.delete("/api/conversations/:id", (req, res) => {
  try {
    db.deleteConversation(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete conversation error:", err);
    res.status(500).json({ error: "Couldn't delete conversation." });
  }
});

app.delete("/api/conversations", (req, res) => {
  try {
    db.deleteAllConversations();
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete all conversations error:", err);
    res.status(500).json({ error: "Couldn't clear conversations." });
  }
});

app.post("/api/conversations/:id/messages", (req, res) => {
  try {
    db.addMessage(req.params.id, req.body);
    res.json({ ok: true });
  } catch (err) {
    console.error("Add message error:", err);
    res.status(500).json({ error: "Couldn't save message." });
  }
});

// Replaces a conversation's full message list — used when editing a
// message or regenerating a response, both of which truncate history
// from a point and rebuild it.
app.put("/api/conversations/:id/messages", (req, res) => {
  try {
    db.replaceMessages(req.params.id, req.body.messages || []);
    res.json({ ok: true });
  } catch (err) {
    console.error("Replace messages error:", err);
    res.status(500).json({ error: "Couldn't save conversation." });
  }
});

app.patch("/api/conversations/:id/messages/:index/like", (req, res) => {
  try {
    db.setMessageLiked(req.params.id, Number(req.params.index), req.body.liked);
    res.json({ ok: true });
  } catch (err) {
    console.error("Like message error:", err);
    res.status(500).json({ error: "Couldn't save feedback." });
  }
});

app.get("/api/search", (req, res) => {
  try {
    const results = db.searchMessages(req.query.q || "");
    res.json({ results });
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ error: "Search failed." });
  }
});

app.post("/api/folders", (req, res) => {
  try {
    const { id, name } = req.body;
    db.createFolder(id, name);
    res.json({ ok: true });
  } catch (err) {
    console.error("Create folder error:", err);
    res.status(500).json({ error: "Couldn't create folder." });
  }
});

app.delete("/api/folders/:id", (req, res) => {
  try {
    db.deleteFolder(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete folder error:", err);
    res.status(500).json({ error: "Couldn't delete folder." });
  }
});

// Catches Multer errors (file too large, too many files, etc.) so they
// return a clean JSON error instead of an unhandled exception.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: "File is too large (15MB max).",
      LIMIT_FILE_COUNT: "Too many files (5 max per message).",
    };
    return res.status(400).json({ error: messages[err.code] || "Upload failed." });
  }
  if (err) {
    console.error("Unhandled server error:", err);
    return res.status(500).json({ error: "Something went wrong on the server." });
  }
  next();
});

app.listen(PORT, () => {
  console.log(`REVEXON.AI server running at http://localhost:${PORT}`);
  if (!API_KEY) {
    console.warn(
      "⚠️  GROQ_API_KEY is not set. Add it to server/.env — see .env.example."
    );
  } else {
    validateModels();
  }
});
