// Order emails through Gmail: an instant "order received" email to the customer, and a "new order"
// email to the owner with the receipt attached. Plain text only, so customer-typed details can't inject anything.
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

    // Sent to the owner right after each order, with the payment receipt attached.
    sendNewOrderToOwner(order, receiptFile) {
      const c = order.customer;
      const dashboard = env.SITE_URL ? `${env.SITE_URL.replace(/\/+$/, "")}/owner/` : null;
      const text = [
        `New order ${order.orderId}`,
        `Placed on ${when(order.submittedAt)}, via ${order.source === "website" ? "the website" : "the chat"}.`,
        "",
        "Customer:",
        `  ${c.name}`,
        `  Email: ${c.email}`,
        `  WhatsApp: ${c.whatsapp}`,
        `  Address: ${c.address}, ${c.city}`,
        `  Email offers: ${order.emailOffers ? "yes" : "no"}`,
        order.customerOrderNumber > 1 ? `  Returning customer (order no. ${order.customerOrderNumber}).` : null,
        "",
        "Items:",
        ...itemLines(order),
        `Total: ${money(order.total, order.currency)}`,
        order.possibleDuplicateOf ? `\n⚠ Possible duplicate of ${order.possibleDuplicateOf}. Check before sending.` : null,
        "",
        receiptFile ? "The payment receipt is attached." : "No receipt image was found for this order.",
        "Check the payment in your bank, then mark the order complete in the owner dashboard.",
        dashboard,
      ].filter((line) => line !== null).join("\n");
      return send({
        to: owner,
        subject: headerSafe(`New T2&Co order ${order.orderId}: ${money(order.total, order.currency)}`),
        text,
        attachments: receiptFile ? [{ filename: `${order.orderId}-receipt${receiptFile.slice(receiptFile.lastIndexOf("."))}`, path: receiptFile }] : [],
      });
    },
  };
}
