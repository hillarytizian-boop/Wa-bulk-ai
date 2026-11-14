// Transactional email.
//
// Resend over plain HTTPS: no SDK, no build weight, and a missing key simply turns email off
// instead of breaking the request that tried to send. Every caller must treat a send as
// best-effort - nothing a customer does should fail because an email bounced.
//
// Configure with RESEND_API_KEY (and optionally MAIL_FROM, default onboarding@resend.dev until a
// domain is verified). Without it, messages are logged in development and dropped in production.
const config = require('./config');

const apiKey = () => process.env.RESEND_API_KEY || '';
const from = () => process.env.MAIL_FROM || `${config.siteName} <onboarding@resend.dev>`;
const adminTo = () => process.env.ADMIN_EMAIL || config.admin.email || '';

function enabled() {
  return Boolean(apiKey());
}

/** Escape the few characters that matter when we interpolate into HTML. */
const esc = (v) =>
  String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Minimal, monochrome, inline-styled template so it looks right in Gmail and Apple Mail. */
function layout({ heading, lines = [], button, footer }) {
  const paras = lines.map((l) => `<p style="margin:0 0 14px;line-height:1.55">${l}</p>`).join('');
  const cta = button
    ? `<p style="margin:22px 0"><a href="${esc(button.href)}" style="background:#000;color:#fff;text-decoration:none;padding:13px 22px;border-radius:10px;font-weight:700;display:inline-block">${esc(button.label)}</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f4">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:28px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border:1px solid #e4e4e4;border-radius:14px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#000;font-size:15px">
        <tr><td style="padding:22px 24px 6px">
          <div style="font-weight:800;font-size:15px;letter-spacing:.02em">smmpanel</div>
          <h1 style="font-size:19px;margin:10px 0 16px;letter-spacing:-.01em">${esc(heading)}</h1>
          ${paras}${cta}
        </td></tr>
        <tr><td style="padding:6px 24px 22px;color:#666;font-size:12px;line-height:1.5;border-top:1px solid #eee">
          ${footer || `You are receiving this because you have a ${esc(config.siteName)} account.`}
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

/**
 * Send one message. Never throws: returns {ok, skipped?, error?}.
 * @param {{to:string, subject:string, heading:string, lines?:string[], button?:{label:string,href:string}, footer?:string, text?:string}} msg
 */
async function send(msg) {
  const to = String(msg.to || '').trim();
  if (!to) return { ok: false, skipped: 'no_recipient' };
  const payload = {
    from: from(),
    to: [to],
    subject: msg.subject,
    html: msg.html || layout(msg),
  };
  if (!enabled()) {
    if (process.env.NODE_ENV !== 'test') {
      console.log(`[mail] (disabled, no RESEND_API_KEY) would send "${msg.subject}" to ${to}`);
    }
    return { ok: false, skipped: 'not_configured' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey()}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn('[mail] send failed:', res.status, body.slice(0, 200));
      return { ok: false, error: `http_${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.warn('[mail] send threw:', err.message);
    return { ok: false, error: err.message };
  }
}

const baseUrl = () => (process.env.PUBLIC_URL || config.publicUrl || '').replace(/\/$/, '');

// ---------------------------------------------------------------- message templates
const resetPassword = (to, token) =>
  send({
    to,
    subject: `Reset your ${config.siteName} password`,
    heading: 'Reset your password',
    lines: [
      'Tap the button below to choose a new password. The link works once and expires in 30 minutes.',
      'If you did not ask for this, ignore the email - your password stays as it is.',
    ],
    button: { label: 'Choose a new password', href: `${baseUrl()}/#/reset?token=${encodeURIComponent(token)}` },
    footer: 'Sent because a password reset was requested for this address.',
  });

const welcome = (to) =>
  send({
    to,
    subject: `Welcome to ${config.siteName}`,
    heading: 'Your account is ready',
    lines: [
      'Add funds with M-Pesa and your first order can start within minutes.',
      'Any problem with an order, reply to this address or use the WhatsApp line in the app.',
    ],
    button: { label: 'Open the panel', href: `${baseUrl()}/` },
  });

const paymentReceived = (to, { amountKes, balanceKes }) =>
  send({
    to,
    subject: `Payment received - KSh ${amountKes}`,
    heading: `We received KSh ${amountKes}`,
    lines: [
      `Your balance is now KSh ${balanceKes}.`,
      'You can spend it on any service in the panel - prices already include the service fee.',
    ],
    button: { label: 'Place an order', href: `${baseUrl()}/#/order` },
  });

const orderUpdate = (to, { id, name, status, note }) =>
  send({
    to,
    subject: `Order #${id} is ${status}`,
    heading: `Order #${id}: ${status}`,
    lines: [
      `${esc(name)}`,
      note ? `${esc(note)}` : '',
      'You can see the live status any time under Orders.',
    ].filter(Boolean),
    button: { label: 'View order', href: `${baseUrl()}/#/orders` },
  });

const adminAlert = (subject, lines) => {
  const to = adminTo();
  if (!to) return Promise.resolve({ ok: false, skipped: 'no_admin_recipient' });
  return send({ to, subject, heading: subject, lines, footer: 'Operational alert for the panel owner.' });
};

module.exports = { enabled, send, layout, resetPassword, welcome, paymentReceived, orderUpdate, adminAlert, baseUrl };
