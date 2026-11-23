// Owner dashboard API under /owner/api. Everything except login needs an owner session (see ownerAuth.js).
// Customer data only ever goes to a logged-in owner, and is never cached by the browser.
import express from "express";

const ORDER_ID = /^T2-\d{8}-[0-9A-F]{6}$/;

// Only same-site pages may change anything (a second guard next to the SameSite=Strict cookie).
function sameOrigin(req, res, next) {
  const origin = req.headers.origin;
  if (req.method !== "GET" && origin && origin !== `${req.protocol}://${req.headers.host}`) {
    return res.status(403).json({ error: "Not allowed." });
  }
  next();
}

function ownerView(order) {
  const { receiptHash, ...visible } = order;
  return { ...visible, hasReceipt: Boolean(order.receiptFile) };
}

export function createOwnerRoutes({ auth, orderStore }) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
    next();
  });
  router.use(sameOrigin);

  router.post("/login", (req, res) => {
    const result = auth.login(req, res, req.body);
    if (result && typeof result === "object" && result.error) return res.status(401).json({ error: result.error });
    if (typeof result === "string") return res.status(401).json({ error: result });
    res.json({ ok: true, token: result?.token });
  });

  router.post("/logout", (req, res) => {
    auth.logout(req, res);
    res.json({ ok: true });
  });

  router.get("/session", (req, res) => {
    res.json({ loggedIn: auth.isLoggedIn(req), configured: auth.configured });
  });

  router.use(auth.requireOwner);

  router.get("/orders", (req, res) => {
    res.json({ orders: orderStore.readOrders().map(ownerView) });
  });

  router.get("/orders/:orderId/receipt", (req, res) => {
    const order = ORDER_ID.test(req.params.orderId) ? orderStore.findOrder(req.params.orderId) : null;
    const file = orderStore.receiptPath(order);
    if (!file) return res.status(404).json({ error: "Receipt not found." });
    res.sendFile(file);
  });

  // Marks an order complete once the owner has matched the receipt with the bank (or undoes it).
  router.post("/orders/:orderId/complete", (req, res) => {
    const { orderId } = req.params;
    if (!ORDER_ID.test(orderId) || !orderStore.findOrder(orderId)) return res.status(404).json({ error: "Order not found." });
    if (typeof req.body?.complete !== "boolean") return res.status(400).json({ error: '"complete" must be true or false.' });
    const completedAt = req.body.complete ? new Date().toISOString() : null;
    orderStore.updateOrders([orderId], () => ({ completedAt }));
    orderStore.updateSpreadsheet();
    res.json({ order: ownerView(orderStore.findOrder(orderId)) });
  });

  return router;
}
