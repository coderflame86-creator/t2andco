// Order notifications, sent right after each order is submitted:
// - Customer: "order received" email.
// - Owner: "new order" email with the payment receipt attached.
// Failed sends are retried a few times. Progress is saved on each order in orders.json,
// so nothing is lost or sent twice if the server restarts.

const CHECK_EVERY_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export function createNotifier({ mailer, orderStore }) {
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

  async function emailOwner(order) {
    const attempts = (order.ownerEmail?.attempts ?? 0) + 1;
    try {
      await mailer.sendNewOrderToOwner(order, orderStore.receiptPath(order));
      orderStore.updateOrders([order.orderId], () => ({ ownerEmail: { status: "sent", attempts, at: new Date().toISOString() } }));
    } catch (err) {
      console.error(`Owner email for ${order.orderId} not sent: ${err.code ?? err.name}`);
      orderStore.updateOrders([order.orderId], () => ({ ownerEmail: { status: "failed", attempts } }));
    }
  }

  function failed(email) {
    return email?.status === "failed" && email.attempts < MAX_ATTEMPTS;
  }

  async function retryFailed() {
    if (running || !mailer.configured) return;
    running = true;
    try {
      for (const order of orderStore.readOrders()) {
        if (failed(order.customerEmail)) await emailCustomer(order);
        if (failed(order.ownerEmail)) await emailOwner(order);
      }
    } finally {
      running = false;
    }
  }

  return {
    // Called right after an order is saved. Runs in the background so the customer isn't kept waiting.
    orderSubmitted(order) {
      if (!mailer.configured) {
        const off = { status: "off", attempts: 0 };
        orderStore.updateOrders([order.orderId], () => ({ customerEmail: off, ownerEmail: off }));
        return;
      }
      emailCustomer(order).then(() => emailOwner(order));
    },
    start() {
      if (!mailer.configured) {
        console.log("Emails are off: add SMTP_PASS (a Gmail App Password) to .env to turn them on.");
        return;
      }
      console.log("Emails on: the customer and the owner each get an email for every new order.");
      retryFailed();
      setInterval(retryFailed, CHECK_EVERY_MS).unref();
    },
  };
}
