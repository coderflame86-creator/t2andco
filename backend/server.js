// T2&Co backend: serves the static frontend and POST /api/chat (T2&Co Bot via the Claude API).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import express from "express";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

const PORT = Number(process.env.PORT) || 3000;
const FRONTEND_DIR = path.join(ROOT, "frontend");
const SYSTEM_PROMPT_FILE = path.join(ROOT, "prompts", "system-prompt.md");

const MODEL = "claude-opus-5-5";
const MAX_TOKENS = 16000;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY = 20;
const FALLBACK_REPLY =
  "Sorry, I can't reply right now. Please try again in a moment, or reach us through the Contact page.";

const client = new Anthropic();
const SYSTEM_PROMPT = loadSystemPrompt();

// Bank details live in .env (never in git) and fill the {{BANK_...}} placeholders.
function loadSystemPrompt() {
  const template = fs.readFileSync(SYSTEM_PROMPT_FILE, "utf8");
  return template.replace(/\{\{(BANK_[A-Z_]+)\}\}/g, (match, name) => process.env[name] || match);
}

const app = express();
app.disable("x-powered-by");
app.use(express.static(FRONTEND_DIR));
app.use(express.json({ limit: "20kb" }));

function isValidTurn(turn) {
  return (
    turn !== null &&
    typeof turn === "object" &&
    (turn.role === "user" || turn.role === "assistant") &&
    typeof turn.content === "string" &&
    turn.content.trim() !== ""
  );
}

function validateChat({ message, conversationHistory } = {}) {
  if (typeof message !== "string" || message.trim() === "") {
    return '"message" is required and must be a non-empty string.';
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return `"message" must be ${MAX_MESSAGE_LENGTH} characters or fewer.`;
  }
  if (conversationHistory !== undefined) {
    if (!Array.isArray(conversationHistory)) return '"conversationHistory" must be an array.';
    if (!conversationHistory.every(isValidTurn)) {
      return 'Each history item needs a "role" ("user" or "assistant") and non-empty "content" text.';
    }
  }
  return null;
}

// The API needs the conversation to start with a user turn, so drop any leading bot greeting.
function buildMessages(conversationHistory = [], message) {
  const recent = conversationHistory.slice(-MAX_HISTORY).map(({ role, content }) => ({ role, content }));
  while (recent.length > 0 && recent[0].role !== "user") recent.shift();
  return [...recent, { role: "user", content: message.trim() }];
}

function replyText(response) {
  return response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function logApiError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    console.error("Claude API: invalid or missing API key (check ANTHROPIC_API_KEY in .env)");
  } else if (err instanceof Anthropic.RateLimitError) {
    console.error("Claude API: rate limited");
  } else if (err instanceof Anthropic.APIConnectionError) {
    console.error("Claude API: connection failed");
  } else if (err instanceof Anthropic.APIError) {
    console.error(`Claude API error: ${err.status} ${err.name}`);
  } else {
    console.error("Chat error:", err.name);
  }
}

app.post("/api/chat", async (req, res) => {
  const error = validateChat(req.body);
  if (error) return res.status(400).json({ error });

  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      cache_control: { type: "ephemeral" },
      system: SYSTEM_PROMPT,
      messages: buildMessages(req.body.conversationHistory, req.body.message),
    });

    const reply = replyText(response);
    if (response.stop_reason === "refusal" || reply === "") {
      return res.json({ reply: FALLBACK_REPLY });
    }
    res.json({ reply });
  } catch (err) {
    // Log only the error type, never customer messages or keys.
    logApiError(err);
    res.status(503).json({ reply: FALLBACK_REPLY });
  }
});

app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Request body must be valid JSON." });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Message is too long." });
  }
  console.error("Unexpected error:", err.name);
  res.status(500).json({ error: "Something went wrong." });
});

app.listen(PORT, () => {
  const keySet = Boolean(process.env.ANTHROPIC_API_KEY);
  console.log(`T2&Co server running at http://localhost:${PORT}`);
  console.log(`Serving frontend from ${FRONTEND_DIR}`);
  console.log(`ANTHROPIC_API_KEY loaded: ${keySet ? "yes" : "no"}`);
  console.log(`Chat model: ${MODEL}`);
});
