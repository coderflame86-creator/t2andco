// Order emails through Gmail: an instant "order received" email to the customer, and a grouped
// summary of new orders to the owner. Plain text only, so customer-typed details can't inject anything.
// Emails are off (and only logged) until SMTP_USER and SMTP_PASS are set in .env.
import nodemailer from "nodemailer";

const TIME_ZONE = "Asia/Karachi";

function money(amount, currency) {
  return `${currency} ${amount.toLocaleString("en-US")}`;
}

function when(iso) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

function itemLines(order) {
  return order.items.map((i) => `  - ${i.quantity} x ${i.name}${i.size ? ` (${i.size})` : ""}: ${money(i.lineTotal, order.currency)}`);
}

// Strips line breaks from anything that goes into an email header.
function headerSafe(text) {
  return String(text).replace(/[\r\n]+/g, " ").trim();
}

function gmailTransport(env) {
  if (!env.SMTP_USER || !env.SMTP_PASS) return null;
  return nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } });
}

// transport can be passed in for testing; normally it is Gmail.
export function createMailer(env, transport = gmailTransport(env)) {
  const configured = Boolean(transport);
  const from = env.EMAIL_FROM || env.SMTP_USER;
  const owner = env.OWNER_EMAIL || env.SMTP_USER;

  async function send(message) {
    if (!transport) throw Object.assign(new Error("Email is not set up (SMTP_PASS missing in .env)."), { code: "NOT_CONFIGURED" });
    await transport.sendMail({ from, ...message });
  }

  return {
    configured,

    sendOrderReceived(order) {
      const c = order.customer;
      const text = [
        `Dear ${c.name},`,
        "",
        "Thank you for shopping with T2&Co! We have received your order and payment receipt.",
        "",
        `Order number: ${order.orderId}`,
        `Placed on: ${when(order.submittedAt)}`,
        "",
        "Your items:",
        ...itemLines(order),
        `Total: ${money(order.total, order.currency)}`,
        "",
        "Delivery to:",
        `  ${c.address}, ${c.city}`,
        "",
        "Our team will check your payment and message you on WhatsApp. Your order will be delivered in about 5–7 working days.",
        "Any delivery charge will be confirmed by our team.",
        "",
        "Please keep your order number in case you need to contact us.",
        "",
        "With love,",
        "T2&Co",
        "Bringing the best of Japan to everyone ready to begin.",
      ].join("\n");
      return send({ to: c.email, subject: headerSafe(`Your T2&Co order ${order.orderId} has been received`), text });
    },

    // One email for all orders since the last summary, with the up-to-date spreadsheet attached.
    sendOwnerSummary(orders, excelFile) {
      const total = orders.reduce((sum, o) => sum + o.total, 0);
      const blocks = orders.map((o) => {
        const c = o.customer;
        return [
          `${o.orderId}  (${when(o.submittedAt)}, via ${o.source === "website" ? "website" : "chat"})`,
          `  ${c.name} · ${c.whatsapp} · ${c.email}`,
          `  ${c.address}, ${c.city}`,
          ...itemLines(o).map((line) => `  ${line}`),
          `  Total: ${money(o.total, o.currency)}`,
          o.possibleDuplicateOf ? `  ⚠ Possible duplicate of ${o.possibleDuplicateOf}. Check before sending.` : null,
          o.customerOrderNumber > 1 ? `  Returning customer (order no. ${o.customerOrderNumber}).` : null,
        ].filter(Boolean).join("\n");
      });
      const text = [
        `${orders.length} new order${orders.length > 1 ? "s" : ""} · ${money(total, orders[0].currency)}`,
        "",
        "Payment receipts are in the attached spreadsheet (and in data/receipts on the computer running the site).",
        "Please check each payment in your bank before sending.",
        "",
        blocks.join("\n\n"),
      ].join("\n");
      return send({
        to: owner,
        subject: `T2&Co: ${orders.length} new order${orders.length > 1 ? "s" : ""} (${money(total, orders[0].currency)})`,
        text,
        attachments: [{ filename: "T2Co-orders.xlsx", path: excelFile }],
      });
    },
  };
}
