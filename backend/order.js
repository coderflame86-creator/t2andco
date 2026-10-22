// Order state for one chat session. Prices and totals always come from data/menu.json, never from the bot.
// For now the bot can add, change and remove items. Checkout comes later.

const MAX_QUANTITY = 20;

export function createOrder(currency) {
  return {
    items: [],
    orderType: "delivery",
    customer: { name: null, email: null, whatsapp: null },
    promotion: null,
    currency,
    subtotal: 0,
    discount: 0,
    total: 0,
    confirmed: false,
    confirmedAt: null,
    status: "browsing",
  };
}

function refresh(order) {
  order.subtotal = order.items.reduce((sum, item) => sum + item.lineTotal, 0);
  order.total = order.subtotal - order.discount;
  order.status = order.items.length === 0 ? "browsing" : "draft";
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
];

function money(amount, currency) {
  return `${currency} ${amount.toLocaleString("en-US")}`;
}

// Short plain-text order summary for the customer. Options are shown only when a product has a choice.
export function summarizeOrder(order, menu) {
  if (order.items.length === 0) return "Your order is empty.";
  const lines = order.items.map((item) => {
    const product = menu.items.find((p) => p.id === item.productId);
    const details = [];
    if (product && product.options.length > 1) details.push(item.optionLabel);
    if (item.skinType) {
      details.push(`for ${menu.skinTypes.find((s) => s.id === item.skinType)?.label ?? item.skinType}`);
    }
    const extra = details.length ? ` (${details.join(", ")})` : "";
    return `- ${item.quantity} x ${item.name}${extra}: ${money(item.lineTotal, order.currency)}`;
  });
  return [...lines, `Total: ${money(order.total, order.currency)}`].join("\n");
}

export function runOrderTool(order, name, input, menu) {
  if (name === "add_to_order") return addItem(order, input, menu);
  if (name === "update_order_item") return updateItem(order, input, menu);
  if (name === "remove_from_order") return removeItem(order, input);
  return fail(order, `Unknown tool "${name}".`);
}
