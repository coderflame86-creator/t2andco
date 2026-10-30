// T2&Co backend: serves the static frontend and POST /api/chat (T2&Co Bot via the Claude API).
// The bot's menu comes from data/menu.json; restart the server after editing it.
// Each chat has an in-memory order (see order.js) that the bot changes through tools.
// When the customer uploads their payment receipt, the order is submitted and saved (see orderStore.js).
// The website's order buttons and checkout page use /api/order/* with the same order and rules.
// After each order: an email to the customer, and a grouped summary to the owner (see notify.js).
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import express from "express";
import {
  ORDER_TOOLS,
  createOrder,
  newOrderId,
  runOrderTool,
  submitOrder,
  summarizeOrder,
  unsubmitOrder,
} from "./order.js";
import { createOrderStore, readReceiptImage } from "./orderStore.js";
import { createMailer } from "./email.js";
import { createNotifier } from "./notify.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

const PORT = Number(process.env.PORT) || 3000;
const FRONTEND_DIR = path.join(ROOT, "frontend");
const SYSTEM_PROMPT_FILE = path.join(ROOT, "prompts", "system-prompt.md");
const DATA_DIR = path.join(ROOT, "data");
const MENU_FILE = path.join(DATA_DIR, "menu.json");

const MODEL = "claude-opus-5-5";
const MAX_TOKENS = 16000;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY = 20;
const MAX_TOOL_ROUNDS = 4;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS = 1000;
const FALLBACK_REPLY =
  "Sorry, I can't reply right now. Please try again in a moment, or WhatsApp our team on 0323 0955496.";

const RECEIPT_MESSAGE = "(I uploaded my payment receipt.)";

const client = new Anthropic();
const orderStore = createOrderStore(DATA_DIR);
const mailer = createMailer(process.env);
const notifier = createNotifier({
  mailer,
  orderStore,
  summaryHours: Number(process.env.OWNER_SUMMARY_HOURS) > 0 ? Number(process.env.OWNER_SUMMARY_HOURS) : 3,
});
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
app.use(express.json({ limit: "8mb" })); // room for one receipt image (max 5 MB before base64)

// Simple per-visitor limit (by IP address) so nobody can flood the chat and run up the AI bill.
// In memory, so it resets when the server restarts.
const RATE_WINDOW_MS = 10 * 60 * 1000;
function rateLimit(maxRequests, message) {
  const hits = new Map(); // ip -> { count, windowStart }
  return (req, res, next) => {
    const now = Date.now();
    const entry = hits.get(req.ip);
    if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
      if (hits.size > 10000) hits.clear();
      hits.set(req.ip, { count: 1, windowStart: now });
      return next();
    }
    entry.count++;
    if (entry.count > maxRequests) return res.status(429).json({ ok: false, reply: message, error: message });
    next();
  };
}
const SLOW_DOWN = "You're sending messages very quickly. Please wait a few minutes and try again, or WhatsApp us on 0323 0955496.";
app.use("/api/chat", rateLimit(30, SLOW_DOWN));
app.use("/api/order", rateLimit(120, SLOW_DOWN));

function isValidTurn(turn) {
  return (
    turn !== null &&
    typeof turn === "object" &&
    (turn.role === "user" || turn.role === "assistant") &&
    typeof turn.content === "string" &&
    turn.content.trim() !== ""
  );
}

function validateChat({ message, conversationHistory, sessionId, image } = {}) {
  const imageOnly = image !== undefined && (message === undefined || message === "");
  if (!imageOnly && (typeof message !== "string" || message.trim() === "")) {
    return '"message" is required and must be a non-empty string.';
  }
  if (image !== undefined && (image === null || typeof image !== "object")) {
    return '"image" must be an object with "mediaType" and base64 "data".';
  }
  if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.length > 64)) {
    return '"sessionId" must be the value returned by a previous reply.';
  }
  if (!imageOnly && message.length > MAX_MESSAGE_LENGTH) {
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

// Submits the order once its payment receipt arrives, from the chat or the website checkout.
// Only accepted when the order is confirmed and all details are in. The image is never sent to the AI.
function processReceipt(session, image, source) {
  const { order } = session;
  if (order.status !== "awaiting_payment") return { ok: false, notReady: true };
  const receipt = readReceiptImage(image);
  if (receipt.error) return { ok: false, error: receipt.error };
  const check = orderStore.checkNewOrder(order, receipt);
  if (check.error) return { ok: false, error: check.error };

  try {
    const orderId = newOrderId();
    submitOrder(order, {
      orderId,
      receiptFile: orderStore.saveReceipt(orderId, receipt),
      receiptHash: receipt.hash,
      source,
      customerId: check.customerId,
      customerOrderNumber: check.customerOrderNumber,
      possibleDuplicateOf: check.possibleDuplicateOf,
    });
    orderStore.saveOrder(order);
    notifier.orderSubmitted({ ...order }); // emails go out in the background
    return { ok: true, orderId };
  } catch (err) {
    console.error("Could not save order:", err.name);
    unsubmitOrder(order);
    return { ok: false, error: "The receipt could not be saved because of a problem on our side. Please upload it again in a minute." };
  }
}

// What the bot is told about a receipt uploaded in the chat.
function receiptNote(session, image) {
  const result = processReceipt(session, image, "chat");
  if (result.ok) {
    const email = mailer.configured
      ? `A confirmation email is being sent to ${session.order.customer.email}; tell the customer.`
      : "No confirmation email is sent, so don't promise one.";
    return `Payment receipt received and saved. The order is now submitted with order number ${result.orderId}. ${email} Thank the customer, give them the order number, and follow Step 6.`;
  }
  if (result.notReady) {
    return `The customer uploaded an image as a payment receipt, but it was NOT saved because the order is not ready for payment (status: ${session.order.status}). Explain kindly what is still needed first.`;
  }
  return `The customer's receipt upload was rejected: ${result.error} Explain this kindly and ask them to try again.`;
}

// The customer and website only see the order itself, not internal checks.
function publicOrder(order) {
  const { receiptFile, receiptHash, customerId, customerOrderNumber, possibleDuplicateOf, ...visible } = order;
  return visible;
}

// The API needs the conversation to start with a user turn, so drop any leading bot greeting.
// The current order (and any server note) rides along as a system note after the newest message.
function buildMessages(conversationHistory = [], message, order, serverNote) {
  const recent = conversationHistory.slice(-MAX_HISTORY).map(({ role, content }) => ({ role, content }));
  while (recent.length > 0 && recent[0].role !== "user") recent.shift();
  const note = [
    serverNote && `Server note: ${serverNote}`,
    `Current order summary:\n${summarizeOrder(order, MENU)}`,
    `Current order state (worked out by the server):\n${JSON.stringify(publicOrder(order))}`,
  ];
  return [
    ...recent,
    { role: "user", content: message.trim() },
    { role: "system", content: note.filter(Boolean).join("\n\n") },
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
  const orderInfo = () => ({ sessionId, order: publicOrder(session.order), summary: summarizeOrder(session.order, MENU) });
  try {
    const { image, conversationHistory } = req.body;
    const message = req.body.message?.trim() || RECEIPT_MESSAGE;
    const serverNote = image !== undefined ? receiptNote(session, image) : null;
    const messages = buildMessages(conversationHistory, message, session.order, serverNote);
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

// Website ordering ("Order Now" buttons and the checkout page). It uses the same order, rules and
// session as the chat, so a customer can mix both. sessionId travels in the body, never in the URL.
const WEBSITE_ACTIONS = {
  add: ({ productId, quantity }) => ["add_to_order", { productId, quantity }],
  update: ({ productId, quantity }) => ["update_order_item", { productId, quantity }],
  remove: ({ productId }) => ["remove_from_order", { productId }],
  clear: () => ["clear_order", {}],
  confirm: ({ total }) => ["confirm_order", { customerConfirmedTotal: total }],
  details: ({ name, email, whatsapp, address, city }) => ["save_customer_details", { name, email, whatsapp, address, city }],
};

function orderResponse(sessionId, session, result = { ok: true }) {
  return {
    ok: result.ok,
    ...(result.error ? { error: result.error } : {}),
    ...(result.missing ? { missing: result.missing } : {}),
    sessionId,
    order: publicOrder(session.order),
    summary: summarizeOrder(session.order, MENU),
  };
}

function websiteSession(body) {
  const id = typeof body?.sessionId === "string" && body.sessionId.length <= 64 ? body.sessionId : undefined;
  return getSession(id);
}

app.post("/api/order/view", (req, res) => {
  const { sessionId, session } = websiteSession(req.body);
  res.json(orderResponse(sessionId, session));
});

// Bank details are only shown once the order is confirmed and all customer details are saved.
app.post("/api/order/payment-details", (req, res) => {
  const { sessionId, session } = websiteSession(req.body);
  if (session.order.status !== "awaiting_payment") {
    return res.status(409).json(orderResponse(sessionId, session, { ok: false, error: "Confirm your order and add your details first." }));
  }
  res.json({
    ...orderResponse(sessionId, session),
    bank: {
      accountName: process.env.BANK_ACCOUNT_NAME,
      bankName: process.env.BANK_NAME,
      accountNumber: process.env.BANK_ACCOUNT_NUMBER,
      iban: process.env.BANK_IBAN,
    },
  });
});

app.post("/api/order/receipt", (req, res) => {
  const { sessionId, session } = websiteSession(req.body);
  const result = processReceipt(session, req.body?.image, "website");
  if (result.notReady) result.error = "Confirm your order and add your details before uploading the receipt.";
  res.status(result.ok ? 200 : 400).json({
    ...orderResponse(sessionId, session, result),
    orderId: result.orderId,
    confirmationEmail: Boolean(result.ok && mailer.configured),
  });
});

app.post("/api/order/:action", (req, res) => {
  const toTool = WEBSITE_ACTIONS[req.params.action];
  if (!toTool) return res.status(404).json({ error: "Not found." });
  const { sessionId, session } = websiteSession(req.body);
  const [tool, input] = toTool(req.body ?? {});
  const result = runOrderTool(session.order, tool, input, MENU);
  session.order = result.order;
  res.status(result.ok ? 200 : 400).json(orderResponse(sessionId, session, result));
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
  notifier.start();
});
