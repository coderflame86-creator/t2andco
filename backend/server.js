// T2&Co backend: serves the static frontend and POST /api/chat (T2&Co Bot via the Claude API).
// The bot's menu comes from data/menu.json; restart the server after editing it.
// Each chat has an in-memory order (see order.js) that the bot changes through tools.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import express from "express";
import { ORDER_TOOLS, createOrder, runOrderTool, summarizeOrder } from "./order.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

const PORT = Number(process.env.PORT) || 3000;
const FRONTEND_DIR = path.join(ROOT, "frontend");
const SYSTEM_PROMPT_FILE = path.join(ROOT, "prompts", "system-prompt.md");
const MENU_FILE = path.join(ROOT, "data", "menu.json");

const MODEL = "claude-opus-5-5";
const MAX_TOKENS = 16000;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY = 20;
const MAX_TOOL_ROUNDS = 4;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS = 1000;
const FALLBACK_REPLY =
  "Sorry, I can't reply right now. Please try again in a moment, or reach us through the Contact page.";

const client = new Anthropic();
const MENU = loadMenu();
const SYSTEM_PROMPT = loadSystemPrompt();

// The menu file is the bot's only source for products and prices, so stop at startup if it is broken.
function loadMenu() {
  const menu = JSON.parse(fs.readFileSync(MENU_FILE, "utf8"));
  const categoryIds = new Set(menu.categories.map((c) => c.id));
  if (!Array.isArray(menu.skinTypes) || !menu.skinTypes.every((s) => s.id && s.label)) {
    throw new Error("data/menu.json needs a skinTypes list with an id and label for each.");
  }
  for (const item of menu.items) {
    const valid =
      typeof item.name === "string" &&
      categoryIds.has(item.category) &&
      Number.isFinite(item.price) &&
      item.price > 0 &&
      typeof item.available === "boolean";
    if (!valid) throw new Error(`Invalid menu item in data/menu.json: ${item.id ?? "(no id)"}`);
  }
  return menu;
}

function formatPrice(amount, currency) {
  return `${currency} ${amount.toLocaleString("en-US")}`;
}

function formatItem(item, currency) {
  const sizes = item.options.map((o) => o.size).filter(Boolean);
  return [
    `#### ${item.name}`,
    `- Product id: ${item.id} (options: ${item.options.map((o) => `${o.id} = ${o.label}`).join(", ")})`,
    `- Other names: ${item.aliases.join(", ") || "none"}`,
    `- Price: ${formatPrice(item.price, currency)}`,
    `- Availability: ${item.available ? "In stock" : "Out of stock"}`,
    `- Size: ${sizes.length ? sizes.join(", ") : "not confirmed"}`,
    `- Made in: ${item.origin}`,
    `- What it does: ${item.description}`,
    `- Benefits: ${item.benefits.join(", ")}`,
    `- Key actives: ${item.activeIngredients.join(", ")}`,
    `- Full ingredients: ${item.ingredients ?? "not confirmed"}`,
  ].join("\n");
}

function formatMenu(menu) {
  const skinTypes = `### Skin types\n${menu.skinTypes.map((s) => `- ${s.id} = ${s.label}`).join("\n")}`;
  const categories = menu.categories.map((category) => {
    const items = menu.items.filter((item) => item.category === category.id);
    return [`### ${category.name}`, ...items.map((item) => formatItem(item, menu.currency))].join("\n\n");
  });
  return [...categories, skinTypes].join("\n\n");
}

// Bank details live in .env (never in git) and fill the {{BANK_...}} placeholders.
function loadSystemPrompt() {
  const template = fs.readFileSync(SYSTEM_PROMPT_FILE, "utf8");
  return template
    .replace("{{MENU}}", formatMenu(MENU))
    .replace(/\{\{(BANK_[A-Z_]+)\}\}/g, (match, name) => process.env[name] || match);
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

function validateChat({ message, conversationHistory, sessionId } = {}) {
  if (typeof message !== "string" || message.trim() === "") {
    return '"message" is required and must be a non-empty string.';
  }
  if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.length > 64)) {
    return '"sessionId" must be the value returned by a previous reply.';
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

// Sessions live in memory: one order per chat, gone when the server restarts or after 2 idle hours.
const sessions = new Map(); // sessionId -> { order, lastSeen }

function removeOldSessions(now) {
  for (const [id, session] of sessions) {
    if (now - session.lastSeen > SESSION_TTL_MS) sessions.delete(id);
  }
  while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
}

function getSession(sessionId) {
  const now = Date.now();
  let session = sessions.get(sessionId);
  if (!session) {
    removeOldSessions(now);
    sessionId = randomUUID();
    session = { order: createOrder(MENU.currency) };
    sessions.set(sessionId, session);
  }
  session.lastSeen = now;
  return { sessionId, session };
}

// The API needs the conversation to start with a user turn, so drop any leading bot greeting.
// The current order rides along as a system note after the newest message.
function buildMessages(conversationHistory = [], message, order) {
  const recent = conversationHistory.slice(-MAX_HISTORY).map(({ role, content }) => ({ role, content }));
  while (recent.length > 0 && recent[0].role !== "user") recent.shift();
  return [
    ...recent,
    { role: "user", content: message.trim() },
    {
      role: "system",
      content: `Current order summary:\n${summarizeOrder(order, MENU)}\n\nCurrent order state (worked out by the server):\n${JSON.stringify(order)}`,
    },
  ];
}

function runToolCalls(response, session) {
  return response.content
    .filter((block) => block.type === "tool_use")
    .map((block) => {
      const result = runOrderTool(session.order, block.name, block.input ?? {}, MENU);
      session.order = result.order;
      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify({ ...result, summary: summarizeOrder(session.order, MENU) }),
        ...(result.ok ? {} : { is_error: true }),
      };
    });
}

// Calls Claude, running order tools until it gives its reply (at most MAX_TOOL_ROUNDS tool rounds).
async function askClaude(messages, session) {
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      cache_control: { type: "ephemeral" },
      system: SYSTEM_PROMPT,
      tools: ORDER_TOOLS,
      messages,
    });
    if (response.stop_reason !== "tool_use") return response;
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: runToolCalls(response, session) });
  }
  return null;
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

  const { sessionId, session } = getSession(req.body.sessionId);
  const orderInfo = () => ({ sessionId, order: session.order, summary: summarizeOrder(session.order, MENU) });
  try {
    const messages = buildMessages(req.body.conversationHistory, req.body.message, session.order);
    const response = await askClaude(messages, session);

    const reply = response ? replyText(response) : "";
    if (!response || response.stop_reason === "refusal" || reply === "") {
      return res.json({ reply: FALLBACK_REPLY, ...orderInfo() });
    }
    res.json({ reply, ...orderInfo() });
  } catch (err) {
    // Log only the error type, never customer messages or keys.
    logApiError(err);
    res.status(503).json({ reply: FALLBACK_REPLY, ...orderInfo() });
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
