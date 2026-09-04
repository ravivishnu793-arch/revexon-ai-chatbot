# REVEXON.AI

A premium AI chatbot web app, powered live by **Groq's free API** through a small
Node/Express backend. The frontend never sees or holds the API key — it talks only to
your own server, which proxies requests to Groq.

Groq's free tier requires no credit card and no payment info, ever, to get started.

## Project structure

```
revexon-ai/
├── server/
│   ├── server.js       # Express server — proxies chat requests to Groq
│   └── .env.example    # Copy to .env in the project root and add your key
├── public/
│   └── index.html       # REVEXON.AI frontend (sidebar, chat, composer, settings)
├── package.json
└── .gitignore
```

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```
   This includes `better-sqlite3`, which compiles a small native module on
   install. On Windows, this usually works out of the box; if it fails, install
   the "Desktop development with C++" workload via
   [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
   and re-run `npm install`.

2. **Get a free Groq API key**

   Go to [console.groq.com/keys](https://console.groq.com/keys), sign in with email or
   Google (no card required), and click "Create API Key." Copy it immediately — it's
   shown only once.

3. **Add your key**

   Copy the example env file to the project root and fill in your real key:
   ```bash
   cp server/.env.example .env
   ```
   Then edit `.env`:
   ```
   GROQ_API_KEY=gsk_your-real-key-here
   PORT=3001
   ```
   **Never commit `.env` or share your key** — it's already excluded via `.gitignore`.

4. **Start the server**
   ```bash
   npm start
   ```
   or, for auto-restart during development:
   ```bash
   npm run dev
   ```

5. **Open the app**

   Visit **http://localhost:3001** in your browser. The topbar shows a live status chip:
   - 🟢 **Live · Groq connected** — everything's working
   - 🟠 **API key not configured** — check step 3
   - 🔴 **Server unreachable** — make sure `npm start` is running

## How it works

- The browser sends chat messages to your own server at `/api/chat/stream` (or `/api/chat`
  if streaming is turned off in Settings).
- The server attaches your Groq API key server-side and forwards the request to Groq's
  OpenAI-compatible endpoint, then streams the response back to the browser as it's
  generated.
- REVEXON's model selector (Fast / Pro / Reason / Vision) maps to real Groq-hosted models
  in `server/server.js` (see `MODEL_MAP`). **Groq's free-tier lineup changes often** —
  models get deprecated with only an email notice, sometimes within weeks. If a mapped
  model stops working, you'll see a `model_not_found` warning with a fix-it link printed
  to the server terminal (thanks to a startup check against Groq's live `/models` list),
  and the browser will show a normal "couldn't complete that request" error rather than
  crashing. Check current model IDs at
  [console.groq.com/docs/models](https://console.groq.com/docs/models) and update
  `MODEL_MAP` in `server/server.js` if that happens.

- Conversation history, pins, and settings are stored in the browser's `localStorage`, so
  they persist across sessions on the same device but aren't sent anywhere except as
  context for each new message.

## Free tier limits

Groq's free tier is generous but not unlimited — expect roughly 30 requests/minute and a
daily cap in the thousands, varying by model. If you hit a rate limit, REVEXON will show
an error message asking you to try again; wait a minute and retry. Check current numbers
at [console.groq.com/docs/rate-limits](https://console.groq.com/docs/rate-limits).

## Features

- **Persistent conversations (SQLite)** — conversations, messages, folders, and pins are
  stored server-side in a SQLite database at `data/revexon.db` (created automatically on
  first run). This means chat history survives clearing your browser's data, and multiple
  browsers/devices pointed at the same running server see the same conversations. The
  database also powers full-text search across every past message via the command
  palette and `/api/search`.
- **Personas** — switch REVEXON's tone and behavior in Settings → Chat: Default, Concise,
  Creative, Coding expert, or Teacher. Each maps to a distinct system prompt server-side
  (`PERSONAS` in `server/server.js`).
- **Command palette** — press `Ctrl+K` (or `Cmd+K` on Mac) to open a searchable palette
  for quick actions (new chat, toggle theme, export, clear history) and jumping to any
  past conversation by title.
- **Folders** — organize conversations into folders via the "New folder" button in the
  sidebar, then move any chat into one from its ⋯ menu.
- **Export** — download the current conversation as a Markdown file, or open a
  print-ready PDF view, from the topbar export icon or the command palette.
- **Real file understanding** — attach an image and REVEXON actually sees it (via a
  vision-capable model); attach a PDF, DOCX, TXT, or CSV and its real text is extracted
  and included in your message. See the note below for current limitations.
- **Voice input & output** — click the mic to dictate a message (or paste an image
  directly into the composer), and click the speaker icon on any REVEXON reply to have
  it read aloud. Turn on "Auto-read replies" in Settings → Chat to have every response
  spoken automatically as it finishes.

## Notes

- **Attachments (real file understanding)**: images, PDFs, TXT, CSV, and DOCX files are
  genuinely processed, not just shown as chips:
  - **Images** are base64-encoded and sent directly to Groq's vision model
    (`qwen/qwen3.6-27b`, currently the only free-tier vision-capable model — Groq's
    multimodal lineup changes often, so check `console.groq.com/docs/vision` and update
    `VISION_MODEL` in `server/server.js` if this stops working).
  - **PDF and DOCX** text is extracted server-side (via `pdf-parse` and `mammoth`) and
    folded into your message before it's sent.
  - **TXT and CSV** are read directly as plain text.
  - Extracted content is only sent for that turn — it isn't stored in the database
    (to avoid unbounded growth from large files/images), so re-opening an old
    conversation won't re-attach the original file content to future messages.
  - If a file fails to process (unsupported type, corrupt file, scanned PDF with no
    text layer), the chip shows an error and REVEXON is told the file couldn't be read
    rather than pretending it saw something it didn't.
- **Voice input and output** both use the browser's built-in Web Speech APIs
  (`SpeechRecognition` for dictation, `SpeechSynthesis` for reading replies aloud) —
  free, no API calls, entirely client-side. Voice quality and available voices depend on
  your OS and browser; Chrome/Edge on desktop generally has the best support. If either
  API isn't available, REVEXON shows a clear message rather than failing silently.
- **Switching providers later**: the backend is structured so swapping in a different
  API (Anthropic, OpenAI, Gemini) mainly means changing the request URL, auth header, and
  response parsing in `server/server.js` — the frontend and streaming protocol stay the same.
