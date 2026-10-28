// Order notifications.
// - Customer: "order received" email right after the order is submitted. Failed sends are retried a few times.
// - Owner: one summary email for all new orders, at most once every OWNER_SUMMARY_HOURS, never when there's nothing new.
//   The first order after a quiet spell goes out at the next check (within CHECK_EVERY_MS).
// Progress is saved on each order in orders.json, so nothing is lost or sent twice if the server restarts.

const CHECK_EVERY_MS = 10 * 60 * 1000;
const MAX_CUSTOMER_ATTEMPTS = 5;

export function createNotifier({ mailer, orderStore, summaryHours }) {
  const summaryGapMs = summaryHours * 60 * 60 * 1000;
  let running = false;

  async function emailCustomer(order) {
    const attempts = (order.customerEmail?.attempts ?? 0) + 1;
    try {
      await mailer.sendOrderReceived(order);
      orderStore.updateOrders([order.orderId], () => ({ customerEmail: { status: "sent", attempts, at: new Date().toISOString() } }));
    } catch (err) {
      console.error(`Customer email for ${order.orderId} not sent: ${err.code ?? err.name}`);
      orderStore.updateOrders([order.orderId], () => ({ customerEmail: { status: "failed", attempts } }));
    }
  }

  async function sendOwnerSummaryIfDue() {
    const orders = orderStore.readOrders();
    const pending = orders.filter((o) => !o.ownerNotifiedAt);
    if (pending.length === 0) return;
    const lastSummary = Math.max(0, ...orders.map((o) => Date.parse(o.ownerNotifiedAt) || 0));
    if (Date.now() - lastSummary < summaryGapMs) return;

    await orderStore.updateSpreadsheet(); // attach the latest spreadsheet
    try {
      await mailer.sendOwnerSummary(pending, orderStore.excelFile);
      const now = new Date().toISOString();
      orderStore.updateOrders(pending.map((o) => o.orderId), () => ({ ownerNotifiedAt: now }));
      console.log(`Owner summary sent: ${pending.length} order(s).`);
    } catch (err) {
      console.error(`Owner summary not sent: ${err.code ?? err.name}`);
    }
  }

  async function check() {
    if (running || !mailer.configured) return;
    running = true;
    try {
      const retry = orderStore
        .readOrders()
        .filter((o) => o.customerEmail?.status === "failed" && o.customerEmail.attempts < MAX_CUSTOMER_ATTEMPTS);
      for (const order of retry) await emailCustomer(order);
      await sendOwnerSummaryIfDue();
    } finally {
      running = false;
    }
  }

  return {
    // Called right after an order is saved. Runs in the background so the customer isn't kept waiting.
    orderSubmitted(order) {
      if (!mailer.configured) {
        orderStore.updateOrders([order.orderId], () => ({ customerEmail: { status: "off", attempts: 0 } }));
        return;
      }
      emailCustomer(order).then(check);
    },
    start() {
      if (!mailer.configured) {
        console.log("Emails are off: add SMTP_PASS (a Gmail App Password) to .env to turn them on.");
        return;
      }
      console.log(`Emails on: customers get an order email; owner summary at most every ${summaryHours} hour(s).`);
      check();
      setInterval(check, CHECK_EVERY_MS).unref();
    },
  };
}
