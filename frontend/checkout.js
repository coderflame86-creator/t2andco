// Checkout page: shows the current order (shared with the chat) and walks the customer through
// confirm -> delivery details -> bank transfer + receipt upload -> order number.
// All prices, totals and checks come from the server; this page only displays them.
(function () {
  "use strict";

  const { orderAction, updateCartCount, forgetSession, el } = window.T2CO;
  const RECEIPT_TYPES = ["image/jpeg", "image/png", "image/webp"];
  const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
  const STEP_FOR_STATUS = {
    browsing: "order",
    draft: "order",
    awaiting_details: "details",
    awaiting_payment: "payment",
    submitted: "done",
  };
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const DETAIL_FIELDS = [
    { name: "name", label: "Full name", type: "text", autocomplete: "name", empty: "Your full name needs to be filled." },
    {
      name: "email",
      label: "Email",
      type: "email",
      autocomplete: "email",
      empty: "Email needs to be filled.",
      check: (v) => (EMAIL_PATTERN.test(v) ? "" : "Please enter a valid email, for example name@gmail.com."),
    },
    {
      name: "whatsapp",
      label: "WhatsApp number",
      type: "tel",
      autocomplete: "tel",
      hint: "We'll message you about delivery.",
      empty: "Your WhatsApp number is empty.",
      check: (v) => (/^\d{10,15}$/.test(v.replace(/[\s()+-]/g, "")) ? "" : "WhatsApp number should be 10 to 15 digits, for example 0300 1234567."),
    },
    { name: "address", label: "Delivery address", type: "textarea", autocomplete: "street-address", hint: "House, street and area.", empty: "Your delivery address is empty." },
    { name: "city", label: "City", type: "text", autocomplete: "address-level2", empty: "City needs to be filled." },
  ];

  // The same rules the server uses, checked first so the customer sees what's missing right away.
  function fieldProblem(field, value) {
    const v = value.trim();
    if (!v) return field.empty;
    return field.check ? field.check(v) : "";
  }

  function setFieldError(input, message) {
    const popup = document.getElementById(`${input.id}-error`);
    popup.textContent = message;
    popup.hidden = !message;
    if (message) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }

  const root = document.getElementById("checkout");
  const message = document.querySelector(".checkout-message");
  let state = { order: null, bank: null, confirmationEmail: false };

  function money(amount) {
    return `PKR ${amount.toLocaleString("en-US")}`;
  }

  function text(tag, className, content) {
    const node = el(tag, className);
    node.textContent = content;
    return node;
  }

  function button(label, className, onClick, attrs) {
    const node = el("button", className, { type: "button", ...attrs });
    node.textContent = label;
    node.addEventListener("click", onClick);
    return node;
  }

  function showMessage(error) {
    message.textContent = error || "";
    message.hidden = !error;
  }

  // Runs an order action, shows any error, and redraws the page with the server's latest order.
  async function act(action, body) {
    root.setAttribute("aria-busy", "true");
    const result = await orderAction(action, body);
    root.removeAttribute("aria-busy");
    showMessage(result.ok ? "" : result.error);
    if (result.confirmationEmail) state.confirmationEmail = true;
    if (result.order) {
      state.order = result.order;
      if (result.order.status === "awaiting_payment" && !state.bank) await loadBankDetails();
      render();
    }
    return result;
  }

  async function loadBankDetails() {
    const result = await orderAction("payment-details", {});
    state.bank = result.ok ? result.bank : null;
  }

  function renderSteps(status) {
    const current = STEP_FOR_STATUS[status];
    const order = ["order", "details", "payment", "done"];
    document.querySelectorAll(".checkout-steps li").forEach((li) => {
      const step = li.dataset.step;
      li.classList.toggle("is-current", step === current);
      li.classList.toggle("is-done", order.indexOf(step) < order.indexOf(current));
      if (step === current) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
    });
  }

  function renderItems(order, editable) {
    const card = el("section", "checkout-card", { "aria-labelledby": "order-heading" });
    card.append(text("h2", "checkout-heading", "Your items"));
    card.firstChild.id = "order-heading";

    const list = el("ul", "checkout-items");
    for (const item of order.items) {
      const row = el("li", "checkout-item");
      const info = el("div", "checkout-item-info");
      info.append(text("p", "checkout-item-name", item.name));
      info.append(text("p", "checkout-item-meta", [item.size, `${money(item.unitPrice)} each`].filter(Boolean).join(" · ")));
      row.append(info);

      if (editable) {
        const stepper = el("div", "qty-stepper");
        stepper.append(
          button("−", "qty-btn", () => act(item.quantity > 1 ? "update" : "remove", { productId: item.productId, quantity: item.quantity - 1 }), {
            "aria-label": `One less ${item.name}`,
          }),
          text("span", "qty-value", String(item.quantity)),
          button("+", "qty-btn", () => act("update", { productId: item.productId, quantity: item.quantity + 1 }), {
            "aria-label": `One more ${item.name}`,
          }),
        );
        row.append(stepper);
      } else {
        row.append(text("span", "qty-value", `× ${item.quantity}`));
      }

      row.append(text("p", "checkout-item-total", money(item.lineTotal)));
      if (editable) {
        row.append(button("Remove", "link-btn", () => act("remove", { productId: item.productId }), { "aria-label": `Remove ${item.name}` }));
      }
      list.append(row);
    }
    card.append(list);

    const total = el("p", "checkout-total");
    total.append(text("span", "", "Total"), text("strong", "", money(order.total)));
    card.append(total);
    card.append(text("p", "checkout-note", "All orders are delivered. Any delivery charge is confirmed by our team."));
    return card;
  }

  function renderEmpty() {
    const card = el("section", "checkout-card checkout-empty");
    card.append(text("h2", "checkout-heading", "Your order is empty"));
    card.append(text("p", "", "Browse our J-Beauty skincare and tap “Order Now” on anything you like. You can also ask our chat assistant."));
    const link = el("a", "btn btn-primary", { href: "anti-aging.html" });
    link.textContent = "Shop skincare";
    card.append(link);
    return card;
  }

  function renderConfirm(order) {
    const card = el("section", "checkout-card");
    card.append(text("h2", "checkout-heading", "Ready to order?"));
    card.append(text("p", "", "Please check your items and total above. Confirm to add your delivery details."));
    card.append(button(`Confirm order · ${money(order.total)}`, "btn btn-primary btn-lg", () => act("confirm", { total: order.total })));
    return card;
  }

  function renderDetails(order) {
    const form = el("form", "checkout-card form-card", { novalidate: "" });
    form.append(text("h2", "checkout-heading", "Delivery details"));
    for (const field of DETAIL_FIELDS) {
      const id = `checkout-${field.name}`;
      const wrap = el("div", "form-field");
      const label = text("label", "", field.label);
      label.setAttribute("for", id);
      const input = el(field.type === "textarea" ? "textarea" : "input", "", {
        id,
        name: field.name,
        autocomplete: field.autocomplete,
        required: "",
        ...(field.type === "textarea" ? { rows: "3" } : { type: field.type }),
        "aria-describedby": [field.hint && `${id}-hint`, `${id}-error`].filter(Boolean).join(" "),
      });
      input.value = order.customer[field.name] || "";
      const popup = el("p", "field-popup", { id: `${id}-error`, role: "alert", hidden: "" });
      input.addEventListener("input", () => setFieldError(input, ""));
      wrap.append(label, input, popup);
      if (field.hint) {
        const hint = text("p", "field-hint", field.hint);
        hint.id = `${id}-hint`;
        wrap.append(hint);
      }
      form.append(wrap);
    }
    const saved = order.status === "awaiting_payment";
    const submit = el("button", "btn btn-primary btn-lg", { type: "submit" });
    submit.textContent = saved ? "Update details" : "Save details and continue";
    form.append(submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      let firstProblem = null;
      for (const field of DETAIL_FIELDS) {
        const input = form.elements[field.name];
        const problem = fieldProblem(field, input.value);
        setFieldError(input, problem);
        if (problem && !firstProblem) firstProblem = input;
      }
      if (firstProblem) {
        showMessage("");
        firstProblem.focus();
        return;
      }
      const values = Object.fromEntries(DETAIL_FIELDS.map((f) => [f.name, form.elements[f.name].value]));
      act("details", values);
    });
    return form;
  }

  function renderPayment(order) {
    const card = el("section", "checkout-card");
    card.append(text("h2", "checkout-heading", "Pay by bank transfer"));
    card.append(text("p", "", `Please transfer ${money(order.total)} to this account, then upload a screenshot of the receipt.`));

    if (state.bank) {
      const dl = el("dl", "bank-details");
      for (const [label, value] of [
        ["Account name", state.bank.accountName],
        ["Bank", state.bank.bankName],
        ["Account number", state.bank.accountNumber],
        ["Raast ID / IBAN", state.bank.iban],
      ]) {
        dl.append(text("dt", "", label), text("dd", "", value || "—"));
      }
      card.append(dl);
    }

    const upload = el("div", "form-field");
    const label = text("label", "", "Payment receipt (JPG, PNG or WebP, under 5 MB)");
    label.setAttribute("for", "receipt-file");
    const input = el("input", "", { id: "receipt-file", type: "file", accept: RECEIPT_TYPES.join(",") });
    const preview = el("img", "receipt-preview", { alt: "Your receipt", hidden: "" });
    upload.append(label, input, preview);
    card.append(upload);

    const send = button("Submit receipt and place order", "btn btn-primary btn-lg", () => submitReceipt(input.files[0], send), { disabled: "" });
    input.addEventListener("change", () => {
      const file = input.files[0];
      const valid = file && RECEIPT_TYPES.includes(file.type) && file.size <= MAX_RECEIPT_BYTES;
      showMessage(file && !valid ? "Please choose a JPG, PNG or WebP image under 5 MB." : "");
      send.disabled = !valid;
      preview.hidden = !valid;
      if (valid) preview.src = URL.createObjectURL(file);
    });
    card.append(send);
    return card;
  }

  function readAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  async function submitReceipt(file, send) {
    if (!file) return;
    send.disabled = true;
    send.textContent = "Uploading…";
    try {
      const data = await readAsBase64(file);
      const result = await act("receipt", { image: { mediaType: file.type, data } });
      if (!result.ok) {
        send.disabled = false;
        send.textContent = "Submit receipt and place order";
      }
    } catch {
      showMessage("Sorry, that image couldn't be read. Please try another screenshot.");
      send.disabled = false;
      send.textContent = "Submit receipt and place order";
    }
  }

  function renderDone(order) {
    forgetSession(); // the next item the customer adds starts a new order
    const card = el("section", "checkout-card checkout-done");
    card.append(text("h2", "checkout-heading", "Thank you! Your order is placed."));
    const number = el("p", "order-number");
    number.append(text("span", "", "Order number"), text("strong", "", order.orderId));
    card.append(number);
    card.append(text("p", "", "Our team will check your payment and message you on WhatsApp. Your order will be delivered in about 5–7 working days."));
    if (state.confirmationEmail) card.append(text("p", "", `A confirmation email is on its way to ${order.customer.email}.`));
    card.append(text("p", "checkout-note", "Please save your order number in case you need to contact us."));
    const link = el("a", "btn btn-outline", { href: "index.html" });
    link.textContent = "Back to home";
    card.append(link);
    return card;
  }

  function render() {
    const { order } = state;
    renderSteps(order.status);
    updateCartCount(order);
    const parts = [];
    if (order.status === "browsing") parts.push(renderEmpty());
    else if (order.status === "submitted") parts.push(renderDone(order), renderItems(order, false));
    else {
      parts.push(renderItems(order, true));
      if (order.status === "draft") parts.push(renderConfirm(order));
      if (order.status === "awaiting_details" || order.status === "awaiting_payment") parts.push(renderDetails(order));
      if (order.status === "awaiting_payment") parts.push(renderPayment(order));
    }
    root.replaceChildren(...parts);
    if (order.status === "submitted") document.querySelector(".checkout").scrollIntoView({ block: "start" });
  }

  async function start() {
    const result = await act("view", {});
    if (!result.order) root.replaceChildren(text("p", "", result.error || "Sorry, your order couldn't be loaded."));
  }

  start();
})();
