// T2&Co site script:
// - chat widget: sends messages (and payment receipt images) to /api/chat and shows the bot's replies
// - "Order Now" buttons on product cards add items to the same order the chat uses
// - the header "Order Now" button shows how many items are in the order
(function () {
  "use strict";

  const CHAT_URL = "/api/chat";
  const ORDER_URL = "/api/order/";
  const SESSION_KEY = "t2co-session"; // one order per browser tab, shared by chat and website
  const TOAST_MS = 4000;
  const MAX_LENGTH = 500;
  const HISTORY_TURNS = 10;
  const REQUEST_TIMEOUT_MS = 60000;
  const ERROR_REPLY =
    "Sorry, I can't connect right now. Please check your internet and try again, or WhatsApp our team on 0323 0955496.";
  const RECEIPT_TYPES = ["image/jpeg", "image/png", "image/webp"];
  const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
  const RECEIPT_HISTORY_TEXT = "(I uploaded my payment receipt.)";
  const START_CHOICES = ["I'd like to order", "I'd like to know about skincare"];

  const ICON_CHAT =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.6.5-1.5.1-1.5-.7V16h-.3A2.5 2.5 0 0 1 4 13.5z"/></svg>';
  const ICON_CLOSE =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const ICON_SEND =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 12l16-8-6 16-2.5-6.5z"/></svg>';
  const ICON_ATTACH =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M16.5 6.5l-7.8 7.8a1.8 1.8 0 0 0 2.5 2.5l7.8-7.8a3.5 3.5 0 0 0-5-5l-8 8a5.2 5.2 0 0 0 7.4 7.4l7.1-7.1"/></svg>';

  function el(tag, className, attrs) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
    return node;
  }

  // Session storage can be blocked (private mode); the order then lasts for this page only.
  function loadSessionId() {
    try {
      return sessionStorage.getItem(SESSION_KEY) || undefined;
    } catch {
      return undefined;
    }
  }

  function saveSessionId(id) {
    try {
      if (id) sessionStorage.setItem(SESSION_KEY, id);
    } catch {
      /* not available */
    }
  }

  // After an order is submitted, the next item starts a brand-new order.
  function forgetSession() {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* not available */
    }
  }

  // Calls a website order action. Returns the server's answer, or { ok: false, error } if it can't be reached.
  async function orderAction(action, body) {
    try {
      const response = await fetch(ORDER_URL + action, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, sessionId: loadSessionId() }),
      });
      const data = await response.json();
      saveSessionId(data.sessionId);
      return data;
    } catch {
      return { ok: false, error: "Sorry, we couldn't reach the shop. Please check your internet and try again." };
    }
  }

  function updateCartCount(order) {
    const count = order && order.status !== "submitted" ? order.items.reduce((sum, item) => sum + item.quantity, 0) : 0;
    document.querySelectorAll(".cart-count").forEach((badge) => {
      badge.textContent = String(count);
      badge.hidden = count === 0;
      badge.parentElement.setAttribute("aria-label", count ? `Order Now, ${count} item${count > 1 ? "s" : ""} in your order` : "Order Now");
    });
  }

  function showToast(message, linkText) {
    let toast = document.querySelector(".toast");
    if (!toast) {
      toast = el("div", "toast", { role: "status" });
      document.body.append(toast);
    }
    toast.replaceChildren(document.createTextNode(message));
    if (linkText) {
      const link = el("a", "toast-link", { href: "checkout.html" });
      link.textContent = linkText;
      toast.append(link);
    }
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => (toast.hidden = true), TOAST_MS);
  }

  function initOrderButtons() {
    document.querySelectorAll("[data-product-id]").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        const item = { productId: button.dataset.productId, quantity: 1 };
        let result = await orderAction("add", item);
        if (!result.ok && result.order?.status === "submitted") {
          forgetSession();
          result = await orderAction("add", item);
        }
        button.disabled = false;
        if (result.order) updateCartCount(result.order);
        if (result.ok) showToast("Added to your order.", "View order");
        else showToast(result.error || "Sorry, that couldn't be added.");
      });
    });
  }

  window.T2CO = { orderAction, updateCartCount, forgetSession, el }; // used by checkout.js

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
    const empty = el("div", "chat-start");
    const welcome = el("p", "chat-empty");
    welcome.textContent = "Welcome to T2&Co! How can we help you today?";
    const choices = START_CHOICES.map((text) => {
      const choice = el("button", "btn btn-outline", { type: "button" });
      choice.textContent = text;
      return choice;
    });
    empty.append(welcome, ...choices);
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
    const attach = el("button", "chat-attach", { type: "button", "aria-label": "Upload payment receipt" });
    attach.innerHTML = ICON_ATTACH;
    const file = el("input", "visually-hidden", {
      type: "file",
      accept: RECEIPT_TYPES.join(","),
      tabindex: "-1",
      "aria-hidden": "true",
    });
    form.append(attach, file, label, input, send);

    panel.append(header, messages, form);
    root.append(panel, toggle);
    document.body.append(root);

    return { toggle, panel, close, messages, empty, choices, form, input, send, attach, file };
  }

  function addBubble(ui, text, sender) {
    ui.empty.remove();
    const bubble = el("p", "chat-bubble chat-bubble--" + sender);
    bubble.textContent = text; // plain text only
    ui.messages.append(bubble);
    ui.messages.scrollTop = ui.messages.scrollHeight;
    return bubble;
  }

  function addReceiptBubble(ui, file) {
    ui.empty.remove();
    const bubble = el("figure", "chat-bubble chat-bubble--user chat-receipt");
    const img = el("img", "", { alt: "Your payment receipt" });
    img.src = URL.createObjectURL(file);
    img.addEventListener("load", () => URL.revokeObjectURL(img.src), { once: true });
    const caption = el("figcaption");
    caption.textContent = "Payment receipt";
    bubble.append(img, caption);
    ui.messages.append(bubble);
    ui.messages.scrollTop = ui.messages.scrollHeight;
  }

  // Reads the file as base64 (without the "data:...;base64," prefix).
  function readAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function showTyping(ui) {
    const typing = el("p", "chat-bubble chat-bubble--bot chat-typing", { "aria-label": "T2&Co Bot is typing" });
    typing.append(el("span"), el("span"), el("span"));
    ui.messages.append(typing);
    ui.messages.scrollTop = ui.messages.scrollHeight;
    return typing;
  }

  // Returns the bot's reply text, or null if the server couldn't be reached or gave no reply.
  async function fetchReply(message, history, sessionId, image) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, conversationHistory: history.slice(-HISTORY_TURNS), sessionId, image }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      const reply = typeof data.reply === "string" ? data.reply.trim() : "";
      const newSessionId = typeof data.sessionId === "string" ? data.sessionId : sessionId;
      return { reply: reply || null, ok: response.ok && reply !== "", sessionId: newSessionId, order: data.order };
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

  // Browsers block autoplay with sound until the visitor has interacted, so fall back to muted.
  async function playWithSoundIfAllowed(video) {
    try {
      await video.play();
    } catch {
      video.muted = true;
      video.play().catch(() => {});
    }
  }

  function initPlayOnView() {
    const videos = document.querySelectorAll("video[data-play-on-view]");
    if (!videos.length || !("IntersectionObserver" in window)) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(({ target, isIntersecting }) => {
        if (isIntersecting) playWithSoundIfAllowed(target);
        else target.pause();
      });
    }, { threshold: 0.6 });
    videos.forEach((video) => observer.observe(video));
  }

  function initHeroVideos() {
    document.querySelectorAll(".slide--video").forEach((video) => {
      const playFromStart = () => {
        video.currentTime = 0;
        video.play().catch(() => {});
      };
      video.addEventListener("animationstart", playFromStart);
      video.addEventListener("animationiteration", playFromStart);
    });
  }

  function initConcernPicker() {
    const select = document.getElementById("concern-select");
    if (!select) return;
    const panels = document.querySelectorAll(".concern [data-concern]");
    const showSelected = () => {
      panels.forEach((panel) => {
        panel.hidden = panel.dataset.concern !== select.value;
      });
    };
    select.addEventListener("change", showSelected);
    showSelected();
  }

  function init() {
    pauseAutoplayIfReducedMotion();
    initOrderButtons();
    initConcernPicker();
    initPlayOnView();
    initHeroVideos();
    if (loadSessionId()) orderAction("view", {}).then((result) => updateCartCount(result.order));
    const ui = buildWidget();

    function setOpen(open) {
      ui.panel.hidden = !open;
      ui.toggle.setAttribute("aria-expanded", String(open));
      ui.toggle.setAttribute("aria-label", open ? "Close chat" : "Open chat");
      document.body.classList.toggle("chat-open", open);
      if (open) (ui.empty.isConnected ? ui.choices[0] : ui.input).focus();
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
    let waiting = false;

    function setWaiting(isWaiting) {
      waiting = isWaiting;
      ui.form.setAttribute("aria-busy", String(isWaiting));
      ui.send.disabled = isWaiting;
      ui.attach.disabled = isWaiting;
    }

    // historyText is what the bot sees in later turns (a receipt is never re-sent).
    async function send(text, historyText, image) {
      setWaiting(true);
      const typing = showTyping(ui);

      const result = await fetchReply(text, history, loadSessionId(), image);
      const { reply, ok } = result;
      saveSessionId(result.sessionId);
      if (result.order) updateCartCount(result.order);

      typing.remove();
      addBubble(ui, reply || ERROR_REPLY, "bot");
      // Only real exchanges go into history, so error messages never reach the bot.
      if (ok) history.push({ role: "user", content: historyText }, { role: "assistant", content: reply });
      setWaiting(false);
      ui.input.focus();
    }

    function sendText(text) {
      addBubble(ui, text, "user");
      send(text, text);
    }

    ui.form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = ui.input.value.trim().slice(0, MAX_LENGTH);
      if (!text || waiting) return;
      ui.input.value = "";
      sendText(text);
    });

    ui.choices.forEach((choice) => {
      choice.addEventListener("click", () => sendText(choice.textContent));
    });

    ui.attach.addEventListener("click", () => ui.file.click());
    ui.file.addEventListener("change", async () => {
      const file = ui.file.files[0];
      ui.file.value = "";
      if (!file || waiting) return;
      if (!RECEIPT_TYPES.includes(file.type) || file.size > MAX_RECEIPT_BYTES) {
        addBubble(ui, "Please upload your receipt as a JPG, PNG or WebP image under 5 MB.", "bot");
        return;
      }
      addReceiptBubble(ui, file);
      try {
        const data = await readAsBase64(file);
        await send("", RECEIPT_HISTORY_TEXT, { mediaType: file.type, data });
      } catch {
        addBubble(ui, "Sorry, that image couldn't be read. Please try another screenshot.", "bot");
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
