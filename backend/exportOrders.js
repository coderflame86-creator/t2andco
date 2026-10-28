// Rebuilds data/orders.xlsx from data/orders.json. Run with: npm run export-orders
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOrderStore } from "./orderStore.js";

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const ok = await createOrderStore(DATA_DIR).updateSpreadsheet();
console.log(ok ? `Updated ${path.join(DATA_DIR, "orders.xlsx")}` : "orders.xlsx was not updated.");
process.exit(ok ? 0 : 1);
