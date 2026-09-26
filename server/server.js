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
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.GROQ_API_KEY;
const DAILY_TOKEN_LIMIT = Number(process.env.DAILY_TOKEN_LIMIT || 50000);
const DAILY_IMAGE_GEN_LIMIT = Number(process.env.DAILY_IMAGE_GEN_LIMIT || 10);
const IMAGE_API_KEY = process.env.IMAGE_API_KEY;
const HF_API_KEY = process.env.HF_API_KEY || (IMAGE_API_KEY?.startsWith("hf_") ? IMAGE_API_KEY : "");
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || (IMAGE_API_KEY && !IMAGE_API_KEY.startsWith("hf_") ? IMAGE_API_KEY : "");
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
const HF_IMAGE_MODEL = process.env.HF_IMAGE_MODEL || "black-forest-labs/FLUX.1-schnell";
const HF_SPACE_URL = process.env.HF_SPACE_URL || "https://black-forest-labs-flux-1-schnell.hf.space";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// Files are handled in memory (never written to disk) since they're only
// needed briefly to extract text or convert to base64 before being sent
// to the model — nothing is persisted server-side.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 5 }, // 15MB/file, 5 files per request
});

// Vision-capable Groq model for image understanding. Groq's multimodal
// lineup changes often; this must stay in sync with the model list from
// Groq's API. The previous qwen/qwen3.6-27b ID is no longer valid in the
// current account model catalog.
const VISION_MODEL = "qwen/qwen3.8-27b";

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// --- Anonymous user identity (cookie-based) -------------------------------
// Every browser gets a server-generated, cryptographically random ID the
// first time it visits, stored in an HttpOnly cookie. This is the ONLY
// source of truth for "who is making this request" — never trust a user
// id from the request body, query string, or any client-side JS. Because
// the cookie is HttpOnly, frontend JavaScript can't read or tamper with
// it either; the browser just sends it automatically on same-origin
// requests, which is exactly the behavior we want.
const USER_COOKIE = "revexon_user_id";
const isProd = process.env.NODE_ENV === "production";

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  });
  return out;
}

app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  let userId = cookies[USER_COOKIE];

  // Basic shape check — if a cookie is present but doesn't look like a
  // UUID we generated, treat it as absent rather than trusting it as-is.
  const looksLikeUuid = typeof userId === "string" && /^[0-9a-f-]{36}$/i.test(userId);
  if (!looksLikeUuid) {
    userId = crypto.randomUUID();
    res.cookie(USER_COOKIE, userId, {
      httpOnly: true,
      sameSite: "lax",
      secure: isProd, // requires HTTPS in production (Render terminates TLS at the edge)
      maxAge: 1000 * 60 * 60 * 24 * 365 * 2, // 2 years
      path: "/",
    });
  }
  req.userId = userId;
  next();
});

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

function checkDailyUsageLimit(req, res) {
  const usage = db.getUsageForUser(req.userId);
  if (usage.tokensUsed >= DAILY_TOKEN_LIMIT) {
    return res.status(429).json({
      error: "Daily usage limit reached, resets at midnight.",
      code: "daily_limit_exceeded",
      used: usage.tokensUsed,
      limit: DAILY_TOKEN_LIMIT,
      reset: "midnight",
    });
  }
  return null;
}

function checkFeatureUsageLimit(req, res, feature, limit, message) {
  if (!limit || limit <= 0) return null;
  const used = db.getFeatureRequestCount(req.userId, feature);
  if (used >= limit) {
    return res.status(429).json({
      error: message,
      code: "feature_limit_exceeded",
      feature,
      used,
      limit,
      reset: "midnight",
    });
  }
  return null;
}

function logChatUsage(userId, usage) {
  if (!userId || !usage || typeof usage !== "object") return;
  const prompt = Number(usage.prompt_tokens || 0);
  const completion = Number(usage.completion_tokens || 0);
  const total = Number(usage.total_tokens || prompt + completion || 0);
  const tokensUsed = total || prompt + completion;
  if (!tokensUsed) return;
  db.recordUsage(userId, "chat", tokensUsed, 1);
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

function logGroqFailure(context, { model, messages, error, status }) {
  const payload = {
    context,
    model,
    status: status ?? error?.status ?? error?.response?.status ?? "unknown",
    message: error?.message || "Unknown Groq error",
    responseData: error?.response?.data || null,
    requestPreview: {
      messageCount: Array.isArray(messages) ? messages.length : 0,
      hasImage: (messages || []).some(
        (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "image_url")
      ),
    },
  };
  console.error("Groq API failure:", JSON.stringify(payload, null, 2));
}

// Non-streaming fallback endpoint (used if streaming is turned off, or the
// client can't read SSE streams).
app.post("/api/chat", requireApiKey, async (req, res) => {
  try {
    const usageLimitError = checkDailyUsageLimit(req, res);
    if (usageLimitError) return usageLimitError;

    const { messages, model, persona } = req.body;
    const sanitized = sanitizeMessages(messages, persona);
    const effectiveModel = conversationHasImage(messages) ? VISION_MODEL : (MODEL_MAP[model] || MODEL_MAP.pro);

    try {
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
        console.error("Groq API error:", {
          status: groqRes.status,
          model: effectiveModel,
          body: errBody,
          messageCount: sanitized.length,
          hasImage: conversationHasImage(messages),
        });
        return res.status(502).json({ error: friendlyGroqError(groqRes.status, errBody) });
      }

      const data = await groqRes.json();
      const text = data.choices?.[0]?.message?.content || "";
      logChatUsage(req.userId, data.usage);
      res.json({ text });
    } catch (err) {
      logGroqFailure("/api/chat", {
        model: effectiveModel,
        messages: sanitized,
        error: err,
      });
      throw err;
    }
  } catch (err) {
    console.error("Chat error:", {
      message: err?.message,
      status: err?.status || err?.response?.status || "unknown",
      responseData: err?.response?.data || null,
      stack: err?.stack,
    });
    res.status(500).json({ error: "REVEXON couldn't complete that request." });
  }
});

// Streaming endpoint — proxies Groq's SSE stream to the browser as
// plain text chunks, so the frontend can render tokens as they arrive.
app.post("/api/chat/stream", requireApiKey, async (req, res) => {
  try {
    const usageLimitError = checkDailyUsageLimit(req, res);
    if (usageLimitError) return usageLimitError;

    const { messages, model, persona } = req.body;
    const sanitized = sanitizeMessages(messages, persona);
    const effectiveModel = conversationHasImage(messages) ? VISION_MODEL : (MODEL_MAP[model] || MODEL_MAP.pro);

    try {
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
        console.error("Groq stream error:", {
          status: groqRes.status,
          model: effectiveModel,
          body: errBody,
          messageCount: sanitized.length,
          hasImage: conversationHasImage(messages),
        });
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
    let usageLogged = false;

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
          if (!usageLogged && event.usage) {
            logChatUsage(req.userId, event.usage);
            usageLogged = true;
          }
        } catch {
          // ignore non-JSON keep-alive lines
        }
      }
    }

    if (!usageLogged) {
      // Some streaming responses don't expose usage in the per-chunk events;
      // this is a best-effort log for the request, and it won't block the stream.
      // The non-streaming endpoint is still the authoritative place for usage.
    }

    res.end();
    } catch (err) {
      logGroqFailure("/api/chat/stream", {
        model: effectiveModel,
        messages: sanitized,
        error: err,
      });
      throw err;
    }
  } catch (err) {
    console.error("Stream error:", {
      message: err?.message,
      status: err?.status || err?.response?.status || "unknown",
      responseData: err?.response?.data || null,
      stack: err?.stack,
    });
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

app.post("/api/generate-image", async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || "").trim();
    if (!prompt) {
      return res.status(400).json({ error: "A prompt is required to generate an image." });
    }

    const limitError = checkFeatureUsageLimit(
      req,
      res,
      "image_gen",
      DAILY_IMAGE_GEN_LIMIT,
      "Daily image generation limit reached, resets at midnight."
    );
    if (limitError) return limitError;

    if (!HF_API_KEY && !GEMINI_API_KEY) {
      return res.status(500).json({
        error: "Image generation is not configured. Add HF_API_KEY to your environment.",
      });
    }

    if (HF_API_KEY) {
      const response = await fetch(`${HF_SPACE_URL}/gradio_api/call/infer`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${HF_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          data: [prompt, 0, true, 1024, 1024, 4],
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        console.error("Hugging Face image generation error:", { status: response.status, body });
        if (response.status === 401 || response.status === 403) {
          return res.status(502).json({ error: "Hugging Face rejected the API key. Check HF_API_KEY and restart the server." });
        }
        return res.status(502).json({ error: "Hugging Face image generation failed. Try again in a moment." });
      }

      const { event_id: eventId } = await response.json();
      const resultResponse = await fetch(`${HF_SPACE_URL}/gradio_api/call/infer/${eventId}`, {
        headers: HF_API_KEY ? { Authorization: `Bearer ${HF_API_KEY}` } : {},
      });
      const eventText = await resultResponse.text();
      const dataLine = eventText.split("\n").find((line) => line.startsWith("data: "));
      const eventData = dataLine ? JSON.parse(dataLine.slice(6)) : null;
      const generatedFile = Array.isArray(eventData) ? eventData[0] : null;
      const imageUrl = generatedFile?.url;
      if (!resultResponse.ok || !imageUrl) {
        console.error("Hugging Face Space returned no image:", eventText);
        return res.status(502).json({ error: "Hugging Face did not return an image. Try again in a moment." });
      }

      const imageResponse = await fetch(imageUrl, {
        headers: HF_API_KEY ? { Authorization: `Bearer ${HF_API_KEY}` } : {},
      });
      if (!imageResponse.ok) {
        return res.status(502).json({ error: "The generated image could not be downloaded from Hugging Face." });
      }
      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
      db.recordUsage(req.userId, "image_gen", 1, 1);
      return res.json({
        kind: "image",
        source: "generated",
        name: generatedFile.orig_name || "generated-image.webp",
        mimeType: generatedFile.mime_type || imageResponse.headers.get("content-type") || "image/webp",
        url: null,
        base64: imageBuffer.toString("base64"),
      });
    }

    const activeKey = GEMINI_API_KEY;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_IMAGE_MODEL)}:generateContent?key=${encodeURIComponent(activeKey)}`,
      {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      }),
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error("Gemini image generation error:", { status: response.status, body });
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        return res.status(502).json({
          error: "Gemini rejected the image request. Check that the Gemini API key is valid and the image model is available for your project.",
        });
      }
      if (response.status === 429) {
        return res.status(429).json({
          error: "Gemini image generation is unavailable because this project has no free image-generation quota. Enable billing or use an image provider with an available quota.",
        });
      }
      return res.status(502).json({ error: "Image generation failed. Please try a shorter prompt or another image style." });
    }

    const data = await response.json();
    const imagePart = data?.candidates?.[0]?.content?.parts?.find((part) => part.inlineData || part.inline_data);
    const inlineData = imagePart?.inlineData || imagePart?.inline_data;
    const imageBase64 = inlineData?.data || null;
    const imageMimeType = inlineData?.mimeType || inlineData?.mime_type || "image/png";

    const result = {
      kind: "image",
      source: "generated",
      name: "generated-image.png",
      mimeType: imageMimeType,
      url: null,
      base64: imageBase64 || null,
    };

    if (!imageBase64) {
      console.error("Gemini returned no image data:", JSON.stringify(data));
      return res.status(502).json({ error: "Image generation API returned an unexpected payload." });
    }

    db.recordUsage(req.userId, "image_gen", 1, 1);
    return res.json(result);
  } catch (err) {
    console.error("Image generation route error:", err);
    return res.status(500).json({ error: "Image generation failed." });
  }
});

app.get("/api/usage", (req, res) => {
  const usage = db.getUsageForUser(req.userId);
  const breakdown = db.getFeatureUsageForUser(req.userId);
  const featureMap = Object.fromEntries(
    (breakdown || []).map((row) => [row.feature, { tokensUsed: Number(row.tokens_used || 0), requestCount: Number(row.request_count || 0) }])
  );
  res.json({
    ok: true,
    date: usage.date,
    tokensUsed: usage.tokensUsed,
    requestCount: usage.requestCount,
    limit: DAILY_TOKEN_LIMIT,
    remaining: Math.max(0, DAILY_TOKEN_LIMIT - usage.tokensUsed),
    reset: "midnight",
    featureBreakdown: breakdown,
    featureUsage: {
      chat: featureMap.chat || { tokensUsed: 0, requestCount: 0 },
      image_gen: featureMap.image_gen || { tokensUsed: 0, requestCount: 0 },
    },
    limits: {
      chat: DAILY_TOKEN_LIMIT,
      image_gen: DAILY_IMAGE_GEN_LIMIT,
    },
  });
});

/* ============ DATA API (conversations, messages, folders) ============ */
// A small REST layer over server/db.js. The frontend uses this instead of
// localStorage, so history persists on the server rather than per-browser.
//
// Every route below scopes reads and writes to req.userId (set by the
// cookie middleware above). Mutations additionally verify ownership
// in server/db.js before touching a row — a request for a conversation
// ID that doesn't belong to req.userId gets a 404, not the other user's
// data and not a silent success. 404 (rather than 403) is used
// deliberately: it avoids confirming to a caller that a given ID exists
// at all if they don't own it.

app.get("/api/state", (req, res) => {
  try {
    res.json({ conversations: db.listConversations(req.userId), folders: db.listFolders(req.userId) });
  } catch (err) {
    console.error("State load error:", err);
    res.status(500).json({ error: "Couldn't load saved conversations." });
  }
});

app.post("/api/conversations", (req, res) => {
  try {
    const { id, title } = req.body;
    db.createConversation(id, title || "New chat", req.userId);
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
    if (!db.ownsConversation(id, req.userId)) {
      return res.status(404).json({ error: "Conversation not found." });
    }
    if (title !== undefined) db.renameConversation(id, title, req.userId);
    if (pinned !== undefined) db.pinConversation(id, pinned, req.userId);
    if (folderId !== undefined) db.moveConversation(id, folderId, req.userId);
    res.json({ ok: true });
  } catch (err) {
    console.error("Update conversation error:", err);
    res.status(500).json({ error: "Couldn't update conversation." });
  }
});

app.delete("/api/conversations/:id", (req, res) => {
  try {
    const deleted = db.deleteConversation(req.params.id, req.userId);
    if (!deleted) return res.status(404).json({ error: "Conversation not found." });
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete conversation error:", err);
    res.status(500).json({ error: "Couldn't delete conversation." });
  }
});

app.delete("/api/conversations", (req, res) => {
  try {
    // Scoped to req.userId — this only ever clears the caller's own
    // conversations, never the whole table.
    db.deleteAllConversations(req.userId);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete all conversations error:", err);
    res.status(500).json({ error: "Couldn't clear conversations." });
  }
});

app.post("/api/conversations/:id/messages", (req, res) => {
  try {
    const added = db.addMessage(req.params.id, req.body, req.userId);
    if (!added) return res.status(404).json({ error: "Conversation not found." });
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
    const replaced = db.replaceMessages(req.params.id, req.body.messages || [], req.userId);
    if (!replaced) return res.status(404).json({ error: "Conversation not found." });
    res.json({ ok: true });
  } catch (err) {
    console.error("Replace messages error:", err);
    res.status(500).json({ error: "Couldn't save conversation." });
  }
});

app.patch("/api/conversations/:id/messages/:index/like", (req, res) => {
  try {
    const updated = db.setMessageLiked(req.params.id, Number(req.params.index), req.body.liked, req.userId);
    if (!updated) return res.status(404).json({ error: "Conversation or message not found." });
    res.json({ ok: true });
  } catch (err) {
    console.error("Like message error:", err);
    res.status(500).json({ error: "Couldn't save feedback." });
  }
});

app.get("/api/search", (req, res) => {
  try {
    const results = db.searchMessages(req.query.q || "", req.userId);
    res.json({ results });
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ error: "Search failed." });
  }
});

app.post("/api/folders", (req, res) => {
  try {
    const { id, name } = req.body;
    db.createFolder(id, name, req.userId);
    res.json({ ok: true });
  } catch (err) {
    console.error("Create folder error:", err);
    res.status(500).json({ error: "Couldn't create folder." });
  }
});

app.delete("/api/folders/:id", (req, res) => {
  try {
    const deleted = db.deleteFolder(req.params.id, req.userId);
    if (!deleted) return res.status(404).json({ error: "Folder not found." });
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

