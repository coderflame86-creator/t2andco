// T2&Co chat widget: sends messages to the backend at /api/chat and shows the bot's replies.
(function () {
  "use strict";

  const CHAT_URL = "/api/chat";
  const MAX_LENGTH = 500;
  const HISTORY_TURNS = 10;
  const REQUEST_TIMEOUT_MS = 60000;
  const ERROR_REPLY =
    "Sorry, I can't connect right now. Please check your internet and try again, or reach us through the Contact page.";

  const ICON_CHAT =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.6.5-1.5.1-1.5-.7V16h-.3A2.5 2.5 0 0 1 4 13.5z"/></svg>';
  const ICON_CLOSE =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const ICON_SEND =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 12l16-8-6 16-2.5-6.5z"/></svg>';

  function el(tag, className, attrs) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
    return node;
  }

  function buildWidget() {
    const root = el("div", "chat-widget");

    const toggle = el("button", "chat-toggle", {
      type: "button",
      "aria-label": "Open chat",
      "aria-expanded": "false",
      "aria-controls": "chat-panel",
    });
    toggle.innerHTML = ICON_CHAT; // static icon markup, no user data

    const panel = el("section", "chat-panel", {
      id: "chat-panel",
      role: "dialog",
      "aria-modal": "false",
      "aria-labelledby": "chat-title",
      hidden: "",
    });

    const header = el("header", "chat-header");
    const titleWrap = el("div", "chat-title-wrap");
    const title = el("h2", "chat-title", { id: "chat-title" });
    title.textContent = "T2&Co Chat";
    const status = el("p", "chat-status");
    status.textContent = "We usually reply in a moment";
    titleWrap.append(title, status);
    const close = el("button", "chat-close", { type: "button", "aria-label": "Close chat" });
    close.innerHTML = ICON_CLOSE;
    header.append(titleWrap, close);

    const messages = el("div", "chat-messages", {
      role: "log",
      "aria-live": "polite",
      "aria-label": "Chat messages",
      tabindex: "0",
    });
    const empty = el("p", "chat-empty");
    empty.textContent = "Ask us about J-Beauty skincare, pink salt or Japanese cars.";
    messages.append(empty);

    const form = el("form", "chat-form");
    const label = el("label", "visually-hidden", { for: "chat-input" });
    label.textContent = "Type your message";
    const input = el("input", "chat-input", {
      id: "chat-input",
      type: "text",
      autocomplete: "off",
      maxlength: String(MAX_LENGTH),
      placeholder: "Type a message…",
    });
    const send = el("button", "chat-send", { type: "submit", "aria-label": "Send message" });
    send.innerHTML = ICON_SEND;
    form.append(label, input, send);

    panel.append(header, messages, form);
    root.append(panel, toggle);
    document.body.append(root);

    return { toggle, panel, close, messages, empty, form, input };
  }

  function addBubble(ui, text, sender) {
    ui.empty.remove();
    const bubble = el("p", "chat-bubble chat-bubble--" + sender);
    bubble.textContent = text; // plain text only
    ui.messages.append(bubble);
    ui.messages.scrollTop = ui.messages.scrollHeight;
    return bubble;
  }

  function showTyping(ui) {
    const typing = el("p", "chat-bubble chat-bubble--bot chat-typing", { "aria-label": "T2&Co Bot is typing" });
    typing.append(el("span"), el("span"), el("span"));
    ui.messages.append(typing);
    ui.messages.scrollTop = ui.messages.scrollHeight;
    return typing;
  }

  // Returns the bot's reply text, or null if the server couldn't be reached or gave no reply.
  async function fetchReply(message, history, sessionId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, conversationHistory: history.slice(-HISTORY_TURNS), sessionId }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      const reply = typeof data.reply === "string" ? data.reply.trim() : "";
      const newSessionId = typeof data.sessionId === "string" ? data.sessionId : sessionId;
      return { reply: reply || null, ok: response.ok && reply !== "", sessionId: newSessionId };
    } catch {
      return { reply: null, ok: false, sessionId };
    } finally {
      clearTimeout(timer);
    }
  }

  // Respect reduced motion: don't autoplay videos (controls stay available)
  function pauseAutoplayIfReducedMotion() {
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    document.querySelectorAll("video[autoplay]").forEach((video) => {
      video.removeAttribute("autoplay");
      video.pause();
    });
  }

  function init() {
    pauseAutoplayIfReducedMotion();
    const ui = buildWidget();

    function setOpen(open) {
      ui.panel.hidden = !open;
      ui.toggle.setAttribute("aria-expanded", String(open));
      ui.toggle.setAttribute("aria-label", open ? "Close chat" : "Open chat");
      document.body.classList.toggle("chat-open", open);
      if (open) ui.input.focus();
    }

    ui.toggle.addEventListener("click", () => setOpen(ui.panel.hidden));
    ui.close.addEventListener("click", () => {
      setOpen(false);
      ui.toggle.focus();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !ui.panel.hidden) {
        setOpen(false);
        ui.toggle.focus();
      }
    });

    const history = [];
    let sessionId; // set by the server; keeps this chat's order between messages
    let waiting = false;

    function setWaiting(isWaiting) {
      waiting = isWaiting;
      ui.form.setAttribute("aria-busy", String(isWaiting));
      ui.form.querySelector(".chat-send").disabled = isWaiting;
    }

    ui.form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = ui.input.value.trim().slice(0, MAX_LENGTH);
      if (!text || waiting) return;
      addBubble(ui, text, "user");
      ui.input.value = "";
      setWaiting(true);
      const typing = showTyping(ui);

      const result = await fetchReply(text, history, sessionId);
      const { reply, ok } = result;
      sessionId = result.sessionId;

      typing.remove();
      addBubble(ui, reply || ERROR_REPLY, "bot");
      // Only real exchanges go into history, so error messages never reach the bot.
      if (ok) history.push({ role: "user", content: text }, { role: "assistant", content: reply });
      setWaiting(false);
      ui.input.focus();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
