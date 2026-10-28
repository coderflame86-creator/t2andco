// Builds data/orders.xlsx from the saved orders:
// "Orders by date" groups orders under a heading for each day (newest first), with the receipt image in each row.
// "Customers" lists every customer once, with all their orders.
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";

const TIME_ZONE = "Asia/Karachi";
const MAROON = "FF7A1C2E";
const AQUA = "FFCAF0F8";
const WARNING = "FFFDE2E1";
const RECEIPT_COLUMN = 12; // 0-based index of "Receipt" in ORDER_COLUMNS
const RECEIPT_BOX = { width: 150, height: 130 };

const ORDER_COLUMNS = [
  { header: "Order no.", width: 22 },
  { header: "Time", width: 9 },
  { header: "Ordered via", width: 12 },
  { header: "Customer ID", width: 12 },
  { header: "Name", width: 20 },
  { header: "Email", width: 28 },
  { header: "WhatsApp", width: 16 },
  { header: "Address", width: 32 },
  { header: "City", width: 12 },
  { header: "Items", width: 42 },
  { header: "Skin types", width: 22 },
  { header: "Total (PKR)", width: 12 },
  { header: "Receipt", width: 23 },
  { header: "Notes", width: 30 },
];

function dayKey(iso) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date(iso)); // YYYY-MM-DD
}

function dayHeading(iso) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, dateStyle: "full" }).format(new Date(iso));
}

function timeOf(iso) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, timeStyle: "short" }).format(new Date(iso));
}

function itemsText(order) {
  return order.items.map((i) => `${i.quantity} x ${i.name}${i.size ? ` (${i.size})` : ""}`).join("\n");
}

function skinTypesText(order) {
  return order.items.filter((i) => i.skinType).map((i) => `${i.name}: ${i.skinType}`).join("\n");
}

function notesText(order) {
  const notes = [];
  if (order.possibleDuplicateOf) notes.push(`Possible duplicate of ${order.possibleDuplicateOf}: same items and total within 24 hours. Check before sending.`);
  if (order.customerOrderNumber > 1) notes.push(`Returning customer (order no. ${order.customerOrderNumber}).`);
  return notes.join("\n");
}

// Reads width and height from a PNG or JPEG file, so receipts keep their shape in the sheet.
function imageSize(bytes) {
  if (bytes[0] === 0x89) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  let i = 2;
  while (i < bytes.length) {
    const marker = bytes[i + 1];
    const length = bytes.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    i += 2 + length;
  }
  return null;
}

function fitInBox(size) {
  const scale = Math.min(RECEIPT_BOX.width / size.width, RECEIPT_BOX.height / size.height, 1);
  return { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
}

function addReceipt(workbook, sheet, row, order, dataDir) {
  const cell = row.getCell(RECEIPT_COLUMN + 1);
  if (!order.receiptFile) return;
  const filePath = path.join(dataDir, order.receiptFile);
  cell.value = { text: "Open receipt", hyperlink: filePath };
  const extension = { ".png": "png", ".jpg": "jpeg" }[path.extname(filePath)];
  if (!extension || !fs.existsSync(filePath)) return; // WebP can't be shown inside Excel; the link still works
  const bytes = fs.readFileSync(filePath);
  const size = imageSize(bytes);
  if (!size) return;
  const imageId = workbook.addImage({ buffer: bytes, extension });
  sheet.addImage(imageId, { tl: { col: RECEIPT_COLUMN + 0.05, row: row.number - 1 + 0.15 }, ext: fitInBox(size) });
  cell.alignment = { vertical: "bottom" };
}

function addOrdersSheet(workbook, orders, dataDir) {
  const sheet = workbook.addWorksheet("Orders by date", { views: [{ state: "frozen", ySplit: 0 }] });
  sheet.columns = ORDER_COLUMNS.map(({ width }) => ({ width }));

  const byDay = new Map();
  for (const order of [...orders].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))) {
    const key = dayKey(order.submittedAt);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(order);
  }

  for (const dayOrders of byDay.values()) {
    const dayTotal = dayOrders.reduce((sum, o) => sum + o.total, 0);
    const heading = sheet.addRow([
      `${dayHeading(dayOrders[0].submittedAt)}  ·  ${dayOrders.length} order${dayOrders.length > 1 ? "s" : ""}  ·  PKR ${dayTotal.toLocaleString("en-US")}`,
    ]);
    sheet.mergeCells(heading.number, 1, heading.number, ORDER_COLUMNS.length);
    heading.font = { bold: true, size: 13, color: { argb: "FFFFFFFF" } };
    heading.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: MAROON } };
    heading.height = 24;

    const header = sheet.addRow(ORDER_COLUMNS.map((c) => c.header));
    header.font = { bold: true };
    header.eachCell((cell) => (cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: AQUA } }));

    for (const order of [...dayOrders].reverse()) {
      const c = order.customer;
      const row = sheet.addRow([
        order.orderId,
        timeOf(order.submittedAt),
        order.source === "website" ? "Website" : "Chat",
        order.customerId,
        c.name,
        c.email,
        c.whatsapp,
        c.address,
        c.city,
        itemsText(order),
        skinTypesText(order),
        order.total,
        "",
        notesText(order),
      ]);
      row.height = 110;
      row.alignment = { vertical: "top", wrapText: true };
      row.getCell(12).numFmt = "#,##0";
      addReceipt(workbook, sheet, row, order, dataDir);
      if (order.possibleDuplicateOf) {
        row.eachCell({ includeEmpty: true }, (cell) => (cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: WARNING } }));
      }
    }
    sheet.addRow([]);
  }
  if (orders.length === 0) sheet.addRow(["No orders yet."]);
}

function addCustomersSheet(workbook, orders) {
  const sheet = workbook.addWorksheet("Customers");
  sheet.columns = [
    { header: "Customer ID", width: 12 },
    { header: "Name", width: 20 },
    { header: "Email", width: 28 },
    { header: "WhatsApp", width: 16 },
    { header: "City", width: 12 },
    { header: "Orders", width: 8 },
    { header: "Order numbers", width: 26 },
    { header: "First order", width: 14 },
    { header: "Last order", width: 14 },
    { header: "Total spent (PKR)", width: 16 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).eachCell((cell) => (cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: AQUA } }));

  const customers = new Map();
  for (const order of [...orders].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))) {
    const entry = customers.get(order.customerId) ?? { orders: [] };
    entry.orders.push(order);
    customers.set(order.customerId, entry);
  }
  for (const [id, { orders: list }] of customers) {
    const latest = list.at(-1).customer;
    const row = sheet.addRow([
      id,
      latest.name,
      latest.email,
      latest.whatsapp,
      latest.city,
      list.length,
      list.map((o) => o.orderId).join("\n"),
      dayKey(list[0].submittedAt),
      dayKey(list.at(-1).submittedAt),
      list.reduce((sum, o) => sum + o.total, 0),
    ]);
    row.alignment = { vertical: "top", wrapText: true };
    row.getCell(10).numFmt = "#,##0";
  }
}

export async function writeOrdersWorkbook(orders, excelFile, dataDir) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "T2&Co";
  addOrdersSheet(workbook, orders, dataDir);
  addCustomersSheet(workbook, orders);
  // Build in a temporary file, then swap it in, so a half-written spreadsheet never replaces the old one.
  const temp = `${excelFile}.tmp`;
  await workbook.xlsx.writeFile(temp);
  fs.renameSync(temp, excelFile);
}
