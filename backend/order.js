// Order state for one chat session. Prices and totals always come from data/menu.json, never from the bot.
// Checkout: confirm the total -> customer details -> payment receipt (uploaded in chat) -> submitted.

import { randomBytes } from "node:crypto";

const MAX_QUANTITY = 20;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createOrder(currency) {
  return {
    orderId: null,
    items: [],
    orderType: "delivery",
    customer: { name: null, email: null, whatsapp: null, address: null, city: null },
    emailOffers: false, // true only when the customer agreed to receive offers by email
    promotion: null,
    currency,
    subtotal: 0,
    discount: 0,
    total: 0,
    confirmed: false,
    confirmedAt: null,
    receiptFile: null,
    receiptHash: null,
    source: null, // "chat" or "website", set when submitted
    customerId: null,
    customerOrderNumber: null,
    possibleDuplicateOf: null,
    submittedAt: null,
    status: "browsing",
  };
}

const SUBMISSION_FIELDS = ["orderId", "receiptFile", "receiptHash", "source", "customerId", "customerOrderNumber", "possibleDuplicateOf", "submittedAt"];

function hasCustomerDetails(order) {
  return Object.values(order.customer).every(Boolean);
}

function refresh(order) {
  order.subtotal = order.items.reduce((sum, item) => sum + item.lineTotal, 0);
  order.total = order.subtotal - order.discount;
  if (order.submittedAt) order.status = "submitted";
  else if (order.items.length === 0) order.status = "browsing";
  else if (!order.confirmed) order.status = "draft";
  else if (!hasCustomerDetails(order)) order.status = "awaiting_details";
  else order.status = "awaiting_payment";
  return order;
}

function fail(order, error, extra = {}) {
  return { ok: false, error, ...extra, order };
}

// A product with one option uses it automatically. With several, the customer must choose.
function findOption(product, optionId) {
  if (optionId) return { option: product.options.find((o) => o.id === optionId) };
  if (product.options.length === 1) return { option: product.options[0] };
  return { missing: true };
}

export function addItem(order, { productId, optionId, quantity = 1 }, menu) {
  const product = menu.items.find((item) => item.id === productId);
  if (!product) return fail(order, `Unknown productId "${productId}". Use a product id from the MENU.`);
  if (!product.available) return fail(order, `${product.name} is out of stock.`);

  const { option, missing } = findOption(product, optionId);
  if (missing) {
    return fail(order, `${product.name} comes in several options. Ask the customer which one they want.`, {
      needsOption: product.options.map((o) => ({ optionId: o.id, label: o.label, size: o.size })),
    });
  }
  if (!option) return fail(order, `Unknown optionId "${optionId}" for ${product.name}.`);

  if (!Number.isInteger(quantity) || quantity < 1) {
    return fail(order, "Quantity must be a whole number of 1 or more.");
  }
  const existing = order.items.find((item) => item.productId === product.id && item.optionId === option.id);
  const newQuantity = (existing?.quantity ?? 0) + quantity;
  if (newQuantity > MAX_QUANTITY) {
    return fail(order, `The most you can order of ${product.name} in chat is ${MAX_QUANTITY}.`);
  }

  if (existing) {
    existing.quantity = newQuantity;
    existing.lineTotal = existing.unitPrice * newQuantity;
  } else {
    order.items.push({
      productId: product.id,
      name: product.name,
      optionId: option.id,
      optionLabel: option.label,
      size: option.size,
      unitPrice: option.price,
      quantity,
      lineTotal: option.price * quantity,
      skinType: null,
    });
  }
  return { ok: true, added: { name: product.name, option: option.label, quantity }, order: refresh(order) };
}

// Finds the order line to change. optionId is only needed when the product is in the order in several options.
function findLine(order, productId, optionId) {
  const lines = order.items.filter((item) => item.productId === productId && (!optionId || item.optionId === optionId));
  if (lines.length === 1) return { line: lines[0] };
  if (lines.length === 0) return { error: `That product${optionId ? " in that option" : ""} is not in the order.` };
  return { error: "That product is in the order in several options. Say which optionId to change.", lines };
}

// Changes quantity, skin type and/or option of one line. Everything is checked before anything changes.
export function updateItem(order, { productId, optionId, quantity, skinType, newOptionId }, menu) {
  const { line, error, lines } = findLine(order, productId, optionId);
  if (error) {
    return fail(order, error, lines ? { inOrder: lines.map((l) => ({ optionId: l.optionId, label: l.optionLabel })) } : {});
  }
  if (quantity === undefined && skinType === undefined && newOptionId === undefined) {
    return fail(order, "Nothing to change. Give a new quantity, skinType or newOptionId.");
  }

  const product = menu.items.find((item) => item.id === productId);
  if (!product) return fail(order, `${line.name} is no longer on the MENU.`);

  if (quantity !== undefined && (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY)) {
    return fail(order, `Quantity must be a whole number from 1 to ${MAX_QUANTITY}. To remove the item, use remove_from_order.`);
  }
  if (skinType !== undefined && skinType !== null && !menu.skinTypes.some((s) => s.id === skinType)) {
    return fail(order, `Unknown skinType "${skinType}".`, {
      skinTypes: menu.skinTypes.map((s) => ({ skinType: s.id, label: s.label })),
    });
  }

  let option;
  let mergeInto;
  if (newOptionId !== undefined && newOptionId !== line.optionId) {
    if (!product.available) return fail(order, `${product.name} is out of stock, so its option can't be changed.`);
    option = product.options.find((o) => o.id === newOptionId);
    if (!option) {
      return fail(order, `Unknown option "${newOptionId}" for ${product.name}.`, {
        options: product.options.map((o) => ({ optionId: o.id, label: o.label, size: o.size })),
      });
    }
    mergeInto = order.items.find((item) => item.productId === productId && item.optionId === newOptionId);
  }

  const newQuantity = (quantity ?? line.quantity) + (mergeInto?.quantity ?? 0);
  if (newQuantity > MAX_QUANTITY) {
    return fail(order, `The most you can order of ${product.name} in chat is ${MAX_QUANTITY}.`);
  }

  if (skinType !== undefined) line.skinType = skinType;
  line.quantity = newQuantity;
  if (option) {
    if (mergeInto) order.items.splice(order.items.indexOf(mergeInto), 1);
    Object.assign(line, { optionId: option.id, optionLabel: option.label, size: option.size, unitPrice: option.price });
  }
  line.lineTotal = line.unitPrice * line.quantity;
  return { ok: true, updated: { ...line }, order: refresh(order) };
}

// Takes some of an item out, or the whole line when quantity is left out or reaches zero.
export function removeItem(order, { productId, optionId, quantity }) {
  const { line, error, lines } = findLine(order, productId, optionId);
  if (error) {
    return fail(order, error, lines ? { inOrder: lines.map((l) => ({ optionId: l.optionId, label: l.optionLabel })) } : {});
  }
  if (quantity !== undefined && (!Number.isInteger(quantity) || quantity < 1)) {
    return fail(order, "Quantity to remove must be a whole number of 1 or more.");
  }
  if (quantity !== undefined && quantity > line.quantity) {
    return fail(order, `The order only has ${line.quantity} of ${line.name}.`);
  }

  const removed = quantity ?? line.quantity;
  if (removed === line.quantity) {
    order.items.splice(order.items.indexOf(line), 1);
  } else {
    line.quantity -= removed;
    line.lineTotal = line.unitPrice * line.quantity;
  }
  return { ok: true, removed: { name: line.name, option: line.optionLabel, quantity: removed }, order: refresh(order) };
}

// Empties the order ("cancel that", "start over"). Customer details are kept so they needn't retype them.
export function clearOrder(order) {
  order.items = [];
  order.confirmed = false;
  order.confirmedAt = null;
  return { ok: true, order: refresh(order) };
}

// The customer must agree to the exact total the server worked out.
export function confirmOrder(order, { customerConfirmedTotal }) {
  if (order.items.length === 0) return fail(order, "The order is empty.");
  if (customerConfirmedTotal !== order.total) {
    return fail(
      order,
      `The total is ${money(order.total, order.currency)}. Repeat the order and this total to the customer and ask again.`,
    );
  }
  order.confirmed = true;
  order.confirmedAt = new Date().toISOString();
  return { ok: true, order: refresh(order) };
}

function cleanText(value, maxLength) {
  return typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ").slice(0, maxLength) : null;
}

// Saves the valid details and reports the rest. Only allowed once the order is confirmed.
export function saveCustomerDetails(order, details) {
  if (!order.confirmed) return fail(order, "Confirm the order and total with the customer before taking their details.");
  const errors = [];
  const save = (field, value, error) => {
    if (value) order.customer[field] = value;
    else errors.push(error);
  };
  if (details.name !== undefined) save("name", cleanText(details.name, 100), "Name must not be empty.");
  if (details.email !== undefined) {
    const email = cleanText(details.email, 254)?.toLowerCase();
    save("email", email && EMAIL_PATTERN.test(email) ? email : null, "That email address does not look valid.");
  }
  if (details.whatsapp !== undefined) {
    const digits = String(details.whatsapp).replace(/[\s()+-]/g, "");
    save("whatsapp", /^\d{10,15}$/.test(digits) ? digits : null, "WhatsApp number must be 10 to 15 digits.");
  }
  if (details.address !== undefined) save("address", cleanText(details.address, 300), "Address must not be empty.");
  if (details.city !== undefined) save("city", cleanText(details.city, 100), "City must not be empty.");
  if (typeof details.emailOffers === "boolean") order.emailOffers = details.emailOffers;

  refresh(order);
  const missing = Object.keys(order.customer).filter((field) => !order.customer[field]);
  return { ok: errors.length === 0, ...(errors.length ? { error: errors.join(" ") } : {}), missing, order };
}

export function newOrderId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `T2-${date}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

// Called by the server (not the bot) once the payment receipt is saved.
// submission: orderId, receiptFile, receiptHash, source, customerId, customerOrderNumber, possibleDuplicateOf.
export function submitOrder(order, submission) {
  Object.assign(order, submission, { submittedAt: new Date().toISOString() });
  return refresh(order);
}

// Undoes submitOrder if the order could not be saved, so the customer can try again.
export function unsubmitOrder(order) {
  for (const field of SUBMISSION_FIELDS) order[field] = null;
  return refresh(order);
}

export const ORDER_TOOLS = [
  {
    name: "add_to_order",
    description:
      "Add one menu item to the customer's order. Call it once per product the customer wants to add. Adding a product that is already in the order increases its quantity. If the result says an option is needed, ask the customer to choose from the listed options, then call again with that optionId. The result has the correct prices and total: only quote totals from it.",
    input_schema: {
      type: "object",
      properties: {
        productId: { type: "string", description: "Product id from the MENU, e.g. aa-retinol." },
        optionId: { type: "string", description: "Option id from the MENU. Leave out only if the product has one option." },
        quantity: { type: "integer", minimum: 1, maximum: MAX_QUANTITY, description: "How many to add. Defaults to 1." },
      },
      required: ["productId"],
      additionalProperties: false,
    },
  },
  {
    name: "update_order_item",
    description:
      "Change an item that is already in the order: set its quantity (the new total, not an amount to add), record the customer's skin type for it, or switch it to another option from the MENU. Send only what changes. The result has the correct prices and total: only quote totals from it.",
    input_schema: {
      type: "object",
      properties: {
        productId: { type: "string", description: "Product id of the item in the order." },
        optionId: { type: "string", description: "Current option id. Needed only if the product is in the order in several options." },
        quantity: { type: "integer", minimum: 1, maximum: MAX_QUANTITY, description: "The new quantity for this item." },
        skinType: { type: "string", description: "Skin type id from the MENU's Skin types list." },
        newOptionId: { type: "string", description: "Option id from the MENU to switch this item to." },
      },
      required: ["productId"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_from_order",
    description:
      "Remove an item from the order, or reduce its quantity. Leave out quantity to remove the item completely; give quantity to take that many out. The result has the correct prices and total: only quote totals from it.",
    input_schema: {
      type: "object",
      properties: {
        productId: { type: "string", description: "Product id of the item in the order." },
        optionId: { type: "string", description: "Option id. Needed only if the product is in the order in several options." },
        quantity: { type: "integer", minimum: 1, description: "How many to take out. Leave out to remove the item completely." },
      },
      required: ["productId"],
      additionalProperties: false,
    },
  },
  {
    name: "clear_order",
    description:
      "Remove every item from the order, when the customer clearly wants to cancel the whole order or start over. Not for removing one item (use remove_from_order). Can't be used after the order is submitted.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "confirm_order",
    description:
      "Mark the order as confirmed. Call it only after you showed the customer the full order summary and total and they explicitly said yes. Pass the total they agreed to.",
    input_schema: {
      type: "object",
      properties: { customerConfirmedTotal: { type: "number", description: "The total the customer agreed to." } },
      required: ["customerConfirmedTotal"],
      additionalProperties: false,
    },
  },
  {
    name: "save_customer_details",
    description:
      "Save the customer's delivery details after the order is confirmed. Send whichever details the customer has given; call again for the rest. The result lists any details still missing.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Full name." },
        email: { type: "string" },
        whatsapp: { type: "string", description: "Active WhatsApp number." },
        address: { type: "string", description: "Full delivery address (house, street, area)." },
        city: { type: "string" },
        emailOffers: {
          type: "boolean",
          description: "true only if the customer clearly said yes to receiving offers and discounts by email; false if they said no.",
        },
      },
      additionalProperties: false,
    },
  },
];

const ITEM_TOOLS = ["add_to_order", "update_order_item", "remove_from_order"];

function itemsSignature(order) {
  return JSON.stringify(order.items.map((i) => [i.productId, i.optionId, i.quantity]));
}

function money(amount, currency) {
  return `${currency} ${amount.toLocaleString("en-US")}`;
}

// Short plain-text order summary for the customer. Shows the option when a product has a choice, else its size.
export function summarizeOrder(order, menu) {
  if (order.items.length === 0) return "Your order is empty.";
  const lines = order.items.map((item) => {
    const product = menu.items.find((p) => p.id === item.productId);
    const details = [];
    if (product && product.options.length > 1) details.push(item.optionLabel);
    else if (item.size) details.push(item.size);
    if (item.skinType) {
      details.push(`for ${menu.skinTypes.find((s) => s.id === item.skinType)?.label ?? item.skinType}`);
    }
    const extra = details.length ? ` (${details.join(", ")})` : "";
    return `- ${item.quantity} x ${item.name}${extra}: ${money(item.lineTotal, order.currency)}`;
  });
  return [...lines, `Total: ${money(order.total, order.currency)}`].join("\n");
}

function runItemTool(order, name, input, menu) {
  if (name === "add_to_order") return addItem(order, input, menu);
  if (name === "update_order_item") return updateItem(order, input, menu);
  return removeItem(order, input);
}

export function runOrderTool(order, name, input, menu) {
  if (order.submittedAt) {
    return fail(order, `This order was already submitted as ${order.orderId} and can't be changed in chat. The T2&Co team can help with changes.`);
  }
  if (name === "clear_order") return clearOrder(order);
  if (name === "confirm_order") return confirmOrder(order, input);
  if (name === "save_customer_details") return saveCustomerDetails(order, input);
  if (!ITEM_TOOLS.includes(name)) return fail(order, `Unknown tool "${name}".`);

  // Changing what is being bought after confirmation means the new total must be confirmed again.
  const before = itemsSignature(order);
  const result = runItemTool(order, name, input, menu);
  if (result.ok && order.confirmed && itemsSignature(order) !== before) {
    order.confirmed = false;
    order.confirmedAt = null;
    refresh(order);
    result.note = "The order changed after it was confirmed. Show the new summary and total and confirm again.";
  }
  return result;
}
