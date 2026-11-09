// Saves submitted orders to data/orders.json and payment receipts to data/receipts/. Both are git-ignored.
// Also links returning customers, catches duplicate orders, and keeps data/orders.xlsx up to date.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeOrdersWorkbook } from "./ordersExcel.js";

const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const IMAGE_TYPES = {
  "image/jpeg": { ext: "jpg", magic: [0xff, 0xd8, 0xff] },
  "image/png": { ext: "png", magic: [0x89, 0x50, 0x4e, 0x47] },
  "image/webp": { ext: "webp", magic: [0x52, 0x49, 0x46, 0x46] },
};

// Returns the decoded image, or an error message. Checks the real file bytes, not just the declared type.
export function readReceiptImage(image) {
  const type = IMAGE_TYPES[image?.mediaType];
  if (!type || typeof image.data !== "string") return { error: "The receipt must be a JPG, PNG or WebP image." };
  const bytes = Buffer.from(image.data, "base64");
  if (bytes.length === 0 || bytes.length > MAX_RECEIPT_BYTES) return { error: "The receipt image must be under 5 MB." };
  if (!type.magic.every((byte, i) => bytes[i] === byte)) return { error: "That file is not a valid image." };
  return { bytes, ext: type.ext, hash: createHash("sha256").update(bytes).digest("hex") };
}

// The same customer is recognised by email or WhatsApp number.
function sameCustomer(a, b) {
  return a.email === b.email || a.whatsapp === b.whatsapp;
}

function itemsKey(order) {
  return JSON.stringify(order.items.map((i) => [i.productId, i.optionId, i.quantity]).sort());
}

export function createOrderStore(dataDir) {
  const ordersFile = path.join(dataDir, "orders.json");
  const receiptsDir = path.join(dataDir, "receipts");
  const excelFile = path.join(dataDir, "orders.xlsx");

  function readOrders() {
    if (!fs.existsSync(ordersFile)) return [];
    return JSON.parse(fs.readFileSync(ordersFile, "utf8"));
  }

  // Write to a temporary file first so a crash never leaves orders.json half-written.
  function writeOrders(orders) {
    const temp = `${ordersFile}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(orders, null, 2)}\n`);
    fs.renameSync(temp, ordersFile);
  }

  function nextCustomerId(orders) {
    const highest = orders.reduce((max, o) => Math.max(max, Number(o.customerId?.slice(2)) || 0), 0);
    return `C-${String(highest + 1).padStart(4, "0")}`;
  }

  // orders.json is the master record; the spreadsheet is rebuilt from it after every order.
  // Rebuilds run one at a time, each from the latest orders.json.
  let queue = Promise.resolve();
  function updateSpreadsheet() {
    queue = queue.then(rebuildSpreadsheet);
    return queue;
  }

  async function rebuildSpreadsheet() {
    try {
      await writeOrdersWorkbook(readOrders(), excelFile, dataDir);
      return true;
    } catch (err) {
      const locked = err.code === "EBUSY" || err.code === "EPERM";
      console.error(
        locked
          ? "orders.xlsx is open in Excel, so it was not updated. Close it; it updates with the next order (or run: npm run export-orders)."
          : `Could not update orders.xlsx: ${err.name}`,
      );
      return false;
    }
  }

  return {
    // Checks a new order against saved ones. A receipt that was already used is refused outright.
    checkNewOrder(order, receipt) {
      const orders = readOrders();
      const usedReceipt = orders.find((o) => o.receiptHash === receipt.hash);
      if (usedReceipt) {
        return { error: "This receipt was already used for another order. Please upload the receipt for this payment." };
      }
      const previous = orders.filter((o) => sameCustomer(o.customer, order.customer));
      const now = Date.now();
      const sameRecent = previous.find(
        (o) => itemsKey(o) === itemsKey(order) && o.total === order.total && now - Date.parse(o.submittedAt) < DUPLICATE_WINDOW_MS,
      );
      return {
        customerId: previous.at(-1)?.customerId ?? nextCustomerId(orders),
        customerOrderNumber: previous.length + 1,
        possibleDuplicateOf: sameRecent?.orderId ?? null,
      };
    },
    saveReceipt(orderId, { bytes, ext }) {
      fs.mkdirSync(receiptsDir, { recursive: true });
      const fileName = `${orderId}.${ext}`;
      fs.writeFileSync(path.join(receiptsDir, fileName), bytes);
      return `receipts/${fileName}`;
    },
    saveOrder(order) {
      const orders = readOrders();
      orders.push(order);
      writeOrders(orders);
      updateSpreadsheet(); // runs in the background; orders.json is already safe
    },
    readOrders,
    findOrder(orderId) {
      return readOrders().find((o) => o.orderId === orderId) ?? null;
    },
    // Full path of an order's receipt image, only if it is inside data/receipts.
    receiptPath(order) {
      if (!order?.receiptFile) return null;
      const file = path.resolve(dataDir, order.receiptFile);
      return file.startsWith(receiptsDir + path.sep) && fs.existsSync(file) ? file : null;
    },
    // Records email progress on saved orders, e.g. { ownerEmail: {...} } or { customerEmail: {...} }.
    updateOrders(orderIds, changes) {
      const ids = new Set(orderIds);
      const orders = readOrders().map((o) => (ids.has(o.orderId) ? { ...o, ...changes(o) } : o));
      writeOrders(orders);
    },
    excelFile,
    updateSpreadsheet,
  };
}
