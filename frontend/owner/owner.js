// Owner dashboard: log in, see orders by day, week or month, check receipts, mark orders complete,
// and see every customer (with who agreed to email offers). All data comes from /owner/api.
// Customer data is shown with textContent only, never as HTML.
(function () {
  "use strict";

  const path = window.location.pathname;
  const basePath = path.includes("/t2andco") ? "/t2andco" : path.replace(/\/owner(\/.*)?$/, "").replace(/\/frontend(\/.*)?$/, "");
  const API = (basePath || "") + "/owner/api";
  const PKT_OFFSET_MS = 5 * 60 * 60 * 1000; // Pakistan time, UTC+5 all year
  const DAY_MS = 24 * 60 * 60 * 1000;
  const REFRESH_MS = 60 * 1000;

  const $ = (id) => document.getElementById(id);
  const state = { orders: [], period: "day", anchor: todayPkt(), status: "all", view: "orders" };
  let refreshTimer = null;

  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }

  function money(amount) {
    return `PKR ${Number(amount || 0).toLocaleString("en-US")}`;
  }

  function when(iso) {
    return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  }

  // A Pakistan calendar day, as a Date at 00:00 UTC on that date.
  function pktDay(iso) {
    const shifted = new Date(Date.parse(iso) + PKT_OFFSET_MS);
    return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
  }

  function todayPkt() {
    return pktDay(new Date().toISOString());
  }

  // Start (inclusive) and end (exclusive) of the period that contains the anchor day. Weeks start on Monday.
  function periodRange(period, anchor) {
    if (period === "all") return [new Date(0), new Date(8.64e15)];
    if (period === "day") return [anchor, new Date(anchor.getTime() + DAY_MS)];
    if (period === "week") {
      const start = new Date(anchor.getTime() - ((anchor.getUTCDay() + 6) % 7) * DAY_MS);
      return [start, new Date(start.getTime() + 7 * DAY_MS)];
    }
    const start = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
    return [start, new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1))];
  }

  function shiftAnchor(period, anchor, step) {
    if (period === "day") return new Date(anchor.getTime() + step * DAY_MS);
    if (period === "week") return new Date(anchor.getTime() + step * 7 * DAY_MS);
    return new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + step, 1));
  }

  function dateText(date, options) {
    return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...options }).format(date);
  }

  function periodLabel(period, [start, end]) {
    if (period === "day") return dateText(start, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    if (period === "month") return dateText(start, { month: "long", year: "numeric" });
    const last = new Date(end.getTime() - DAY_MS);
    return `${dateText(start, { day: "numeric", month: "short" })} – ${dateText(last, { day: "numeric", month: "short", year: "numeric" })}`;
  }

  // Pakistani numbers like 03001234567 become 923001234567 for WhatsApp links.
  function whatsappLink(digits) {
    const international = /^0\d{10}$/.test(digits) ? `92${digits.slice(1)}` : digits;
    return `https://wa.me/${international}`;
  }

  function link(href, text) {
    const a = el("a", "", text);
    a.href = href;
    if (href.startsWith("https:")) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
    return a;
  }

  async function api(path, options = {}) {
    const token = sessionStorage.getItem("t2co_owner_token");
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    const response = await fetch(API + path, {
      credentials: "same-origin",
      ...options,
      headers: Object.keys(headers).length ? headers : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && path !== "/login") {
      sessionStorage.removeItem("t2co_owner_token");
      showLogin();
    }
    return { ok: response.ok, status: response.status, data };
  }

  // ---------- Login ----------

  function showLogin(message) {
    sessionStorage.removeItem("t2co_owner_token");
    clearInterval(refreshTimer);
    state.orders = [];
    $("dashboard").hidden = true;
    $("logout").hidden = true;
    $("login-view").hidden = false;
    showError("login-error", message);
    $("login-username").focus();
  }

  function showError(id, message) {
    $(id).textContent = message || "";
    $(id).hidden = !message;
  }

  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const username = form.elements.username.value.trim();
    const password = form.elements.password.value;
    if (!username || !password) return showError("login-error", "Enter your username and password.");
    form.querySelector("button").disabled = true;
    const result = await api("/login", { method: "POST", body: JSON.stringify({ username, password }) });
    form.querySelector("button").disabled = false;
    form.elements.password.value = "";
    if (!result.ok) return showError("login-error", result.data.error || "Could not log in. Please try again.");
    if (result.data && result.data.token) {
      sessionStorage.setItem("t2co_owner_token", result.data.token);
    }
    showDashboard();
  });

  $("logout").addEventListener("click", async () => {
    await api("/logout", { method: "POST", body: "{}" });
    sessionStorage.removeItem("t2co_owner_token");
    showLogin();
  });

  async function showDashboard() {
    $("login-view").hidden = true;
    $("dashboard").hidden = false;
    $("logout").hidden = false;
    await loadOrders();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(loadOrders, REFRESH_MS);
  }

  async function loadOrders() {
    const result = await api("/orders");
    if (!result.ok) {
      if (result.status !== 401) showError("orders-error", "Could not load orders. Please refresh the page.");
      return;
    }
    showError("orders-error", "");
    state.orders = result.data.orders.sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt));
    render();
  }

  // ---------- Orders ----------

  function ordersInPeriod() {
    const [start, end] = periodRange(state.period, state.anchor);
    return state.orders.filter((o) => {
      const day = pktDay(o.submittedAt);
      return day >= start && day < end;
    });
  }

  function renderOrders() {
    const range = periodRange(state.period, state.anchor);
    $("period-nav").hidden = state.period === "all";
    $("period-label").textContent = state.period === "all" ? "" : periodLabel(state.period, range);
    document.querySelectorAll("[data-period]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.period === state.period)));

    const inPeriod = ordersInPeriod();
    const complete = inPeriod.filter((o) => o.completedAt).length;
    $("stat-orders").textContent = String(inPeriod.length);
    $("stat-complete").textContent = String(complete);
    $("stat-open").textContent = String(inPeriod.length - complete);
    $("stat-revenue").textContent = money(inPeriod.reduce((sum, o) => sum + o.total, 0));

    const shown = inPeriod.filter((o) => state.status === "all" || (state.status === "complete") === Boolean(o.completedAt));
    $("order-list").replaceChildren(...shown.map(orderCard));
    $("orders-empty").hidden = shown.length > 0;
    $("orders-empty").textContent = inPeriod.length ? "No orders match this status." : state.period === "all" ? "No orders yet." : "No orders in this period.";
  }

  function detailRow(list, label, value) {
    list.append(el("dt", "", label));
    const dd = el("dd");
    if (value instanceof Node) dd.append(value);
    else dd.textContent = value;
    list.append(dd);
  }

  function orderCard(order) {
    const c = order.customer;
    const card = el("li", `owner-order${order.completedAt ? " is-complete" : ""}`);

    const head = el("div", "owner-order-head");
    head.append(
      el("p", "owner-order-id", order.orderId),
      el("span", `owner-badge${order.completedAt ? " owner-badge--complete" : ""}`, order.completedAt ? "Complete" : "Awaiting payment check"),
      el("span", "owner-badge owner-badge--source", order.source === "website" ? "Website" : "Chat"),
      el("p", "owner-order-time", when(order.submittedAt)),
    );
    card.append(head);

    if (order.possibleDuplicateOf) {
      card.append(el("p", "owner-warning", `Possible duplicate of ${order.possibleDuplicateOf}: same items and total within 24 hours. Check before sending.`));
    }

    const body = el("div", "owner-order-body");

    const customer = el("div");
    customer.append(el("h3", "owner-section-title", "Customer"));
    const details = el("dl", "owner-details");
    detailRow(details, "Name", c.name);
    detailRow(details, "Email", link(`mailto:${encodeURIComponent(c.email)}`, c.email));
    detailRow(details, "WhatsApp", link(whatsappLink(c.whatsapp), c.whatsapp));
    detailRow(details, "Address", `${c.address}, ${c.city}`);
    detailRow(details, "Customer", `${order.customerId}${order.customerOrderNumber > 1 ? ` · returning (order no. ${order.customerOrderNumber})` : " · first order"}`);
    detailRow(details, "Email offers", order.emailOffers ? "Yes" : "No");
    customer.append(details);

    const items = el("div");
    items.append(el("h3", "owner-section-title", "Items"));
    const list = el("ul", "owner-items");
    for (const item of order.items) {
      const extras = [item.size, item.skinType && `skin: ${item.skinType}`].filter(Boolean).join(", ");
      list.append(el("li", "", `${item.quantity} × ${item.name}${extras ? ` (${extras})` : ""}: ${money(item.lineTotal)}`));
    }
    items.append(list, el("p", "owner-total", `Total: ${money(order.total)}`));

    const receipt = el("div");
    receipt.append(el("h3", "owner-section-title", "Payment receipt"));
    if (order.hasReceipt) {
      const open = el("button", "owner-receipt");
      open.type = "button";
      open.setAttribute("aria-label", `View payment receipt for ${order.orderId}`);
      const img = el("img");
      img.src = `${API}/orders/${encodeURIComponent(order.orderId)}/receipt`;
      img.alt = "";
      img.loading = "lazy";
      open.append(img);
      open.addEventListener("click", () => showReceipt(order));
      receipt.append(open);
    } else {
      receipt.append(el("p", "owner-note", "No receipt image."));
    }

    body.append(customer, items, receipt);
    card.append(body, orderActions(order));
    return card;
  }

  function orderActions(order) {
    const actions = el("div", "owner-actions");
    if (order.completedAt) {
      actions.append(el("p", "owner-done-note", `Marked complete ${when(order.completedAt)}.`));
      const undo = el("button", "btn btn-outline", "Undo complete");
      undo.type = "button";
      undo.addEventListener("click", () => setComplete(order, false, undo));
      actions.append(undo);
    } else {
      const done = el("button", "btn btn-primary", "Payment checked · Mark complete");
      done.type = "button";
      done.addEventListener("click", () => actions.replaceWith(confirmComplete(order)));
      actions.append(done);
    }
    return actions;
  }

  // Asks on the page itself (browser pop-ups can be blocked, which would silently cancel).
  function confirmComplete(order) {
    const box = el("div", "owner-actions owner-confirm");
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", `Confirm order ${order.orderId}`);
    const question = el("p", "owner-confirm-text", `Is ${money(order.total)} for ${order.orderId} in your bank account?`);
    const yes = el("button", "btn btn-primary", "Yes, mark complete");
    yes.type = "button";
    yes.addEventListener("click", () => setComplete(order, true, yes));
    const cancel = el("button", "btn btn-outline", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => box.replaceWith(orderActions(order)));
    box.append(question, yes, cancel);
    queueMicrotask(() => yes.focus());
    return box;
  }

  async function setComplete(order, complete, button) {
    button.disabled = true;
    const result = await api(`/orders/${encodeURIComponent(order.orderId)}/complete`, {
      method: "POST",
      body: JSON.stringify({ complete }),
    });
    if (!result.ok) {
      button.disabled = false;
      if (result.status !== 401) showError("orders-error", result.data.error || "Could not update the order. Please try again.");
      return;
    }
    showError("orders-error", "");
    state.orders = state.orders.map((o) => (o.orderId === order.orderId ? result.data.order : o));
    render();
  }

  function showReceipt(order) {
    $("receipt-title").textContent = `Payment receipt · ${order.orderId} · ${money(order.total)}`;
    $("receipt-image").src = `${API}/orders/${encodeURIComponent(order.orderId)}/receipt`;
    $("receipt-image").alt = `Payment receipt for ${order.orderId}`;
    $("receipt-dialog").showModal();
  }

  $("receipt-close").addEventListener("click", () => $("receipt-dialog").close());
  $("receipt-dialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });

  document.querySelectorAll("[data-period]").forEach((button) => {
    button.addEventListener("click", () => {
      state.period = button.dataset.period;
      render();
    });
  });
  $("period-prev").addEventListener("click", () => {
    state.anchor = shiftAnchor(state.period, state.anchor, -1);
    render();
  });
  $("period-next").addEventListener("click", () => {
    state.anchor = shiftAnchor(state.period, state.anchor, 1);
    render();
  });
  $("period-today").addEventListener("click", () => {
    state.anchor = todayPkt();
    render();
  });
  $("status-filter").addEventListener("change", (event) => {
    state.status = event.target.value;
    render();
  });

  // ---------- Customers ----------

  // One row per customer (the server links repeat orders by email or WhatsApp), using their latest details.
  function customers() {
    const byId = new Map();
    for (const order of [...state.orders].reverse()) {
      const key = order.customerId || order.customer.email;
      const entry = byId.get(key) ?? { id: key, orders: 0, spent: 0, first: order.submittedAt };
      Object.assign(entry, { ...order.customer, last: order.submittedAt, emailOffers: Boolean(order.emailOffers) });
      entry.orders += 1;
      entry.spent += order.total;
      byId.set(key, entry);
    }
    return [...byId.values()].sort((a, b) => Date.parse(b.last) - Date.parse(a.last));
  }

  function shownCustomers() {
    const search = $("customer-search").value.trim().toLowerCase();
    const offersOnly = $("offers-only").checked;
    return customers().filter((c) => {
      if (offersOnly && !c.emailOffers) return false;
      return !search || [c.name, c.email, c.whatsapp, c.city].some((v) => String(v).toLowerCase().includes(search));
    });
  }

  function renderCustomers() {
    const rows = shownCustomers().map((c) => {
      const row = el("tr");
      const who = el("td");
      who.append(el("strong", "", c.name), el("small", "", c.id));
      const contact = el("td");
      const email = link(`mailto:${encodeURIComponent(c.email)}`, c.email);
      const phone = el("small");
      phone.append(link(whatsappLink(c.whatsapp), c.whatsapp));
      contact.append(email, phone);
      row.append(
        who,
        contact,
        el("td", "", c.city),
        el("td", "", String(c.orders)),
        el("td", "", money(c.spent)),
        el("td", "", when(c.last)),
        el("td", "", c.emailOffers ? "Yes" : "No"),
      );
      return row;
    });
    $("customer-rows").replaceChildren(...rows);
    $("customers-empty").hidden = rows.length > 0;
  }

  // Cells starting with = + - @ are prefixed so a spreadsheet never runs them as formulas.
  function csvCell(value) {
    let text = String(value ?? "");
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  $("download-customers").addEventListener("click", () => {
    const header = ["Customer ID", "Name", "Email", "WhatsApp", "Address", "City", "Orders", "Total spent (PKR)", "First order", "Last order", "Email offers"];
    const lines = shownCustomers().map((c) =>
      [c.id, c.name, c.email, c.whatsapp, c.address, c.city, c.orders, c.spent, when(c.first), when(c.last), c.emailOffers ? "Yes" : "No"].map(csvCell).join(","),
    );
    const csv = `﻿${[header.map(csvCell).join(","), ...lines].join("\r\n")}`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = el("a");
    a.href = url;
    a.download = `t2co-customers-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  $("customer-search").addEventListener("input", renderCustomers);
  $("offers-only").addEventListener("change", renderCustomers);

  // ---------- Views ----------

  document.querySelectorAll(".owner-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      state.view = tab.dataset.view;
      render();
    });
  });

  function render() {
    document.querySelectorAll(".owner-tab").forEach((t) => t.setAttribute("aria-pressed", String(t.dataset.view === state.view)));
    $("orders-view").hidden = state.view !== "orders";
    $("customers-view").hidden = state.view !== "customers";
    if (state.view === "orders") renderOrders();
    else renderCustomers();
  }

  async function start() {
    const result = await api("/session");
    if (result.data && result.data.loggedIn) return showDashboard();
    sessionStorage.removeItem("t2co_owner_token");
    showLogin(result.data && result.data.configured ? "" : "Owner login is not set up yet. In the backend folder, run: npm.cmd run set-owner-password");
  }

  start();
})();
