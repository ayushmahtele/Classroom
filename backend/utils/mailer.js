/**
 * mailer.js — sends the "forgot password" 6-digit code by email.
 *
 * Two ways to send (set ONE of them in backend/.env):
 *
 *  1) BREVO_API_KEY  (recommended on Render — uses HTTPS, so it works even
 *     where outgoing SMTP ports are blocked). Free tier, no domain needed:
 *     just verify your sender address (e.g. your Gmail) in Brevo.
 *
 *  2) GAS_MAIL_URL + GAS_MAIL_SECRET  (free, no other service needed): a small
 *     Google Apps Script web app that sends the email from YOUR Gmail over
 *     HTTPS, so it works on Render's free plan. Script + steps:
 *     backend/apps-script/mailer.gs  (limit: about 100 emails a day).
 *
 *  3) SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS  (e.g. Gmail with an
 *     App Password: smtp.gmail.com, port 465). Often blocked on free hosts.
 *
 * MAIL_FROM is the address the email comes from, e.g.
 *   MAIL_FROM="Classroom <yourname@gmail.com>"
 *
 * For local testing without any email service, set MAIL_DEV_LOG=true and the
 * code is printed in the server console instead of being emailed.
 */
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (_) { /* only needed for SMTP */ }

function parseFrom() {
  const raw = process.env.MAIL_FROM || process.env.SMTP_USER || '';
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || 'Classroom', email: m[2].trim() };
  return { name: 'Classroom', email: raw.trim() };
}

function mailMode() {
  if (process.env.BREVO_API_KEY) return 'brevo';
  if (process.env.GAS_MAIL_URL && process.env.GAS_MAIL_SECRET) return 'gas';
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) return 'smtp';
  if (String(process.env.MAIL_DEV_LOG).toLowerCase() === 'true') return 'console';
  return null;
}

const isMailConfigured = () => !!mailMode();

let transporter = null;
function smtpTransport() {
  if (!nodemailer) throw new Error('nodemailer is not installed (run: npm install nodemailer)');
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT || 465);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      // fail fast (instead of hanging ~2 minutes) if the host blocks SMTP
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000
    });
  }
  return transporter;
}

async function sendMail({ to, subject, text, html }) {
  const mode = mailMode();
  if (!mode) throw new Error('Email service is not configured on the server');

  if (mode === 'console') {
    console.log('------------------ [MAIL_DEV_LOG] ------------------');
    console.log('To     :', to);
    console.log('Subject:', subject);
    console.log(text);
    console.log('----------------------------------------------------');
    return;
  }

  const from = parseFrom();
  if (mode === 'brevo') {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
      headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: from, to: [{ email: to }], subject, textContent: text, htmlContent: html })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Brevo send failed (${res.status}) ${body}`);
    }
    return;
  }

  if (mode === 'gas') {
    const res = await fetch(process.env.GAS_MAIL_URL, {
      method: 'POST',
      redirect: 'follow', // Apps Script answers through a redirect
      signal: AbortSignal.timeout(25000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: process.env.GAS_MAIL_SECRET, to, subject, text, html, name: from.name })
    });
    const raw = await res.text();
    let out = null;
    try { out = JSON.parse(raw); } catch (_) { /* not JSON */ }
    if (!res.ok || !out || !out.ok) {
      throw new Error(`Apps Script send failed (${res.status}) ${out ? out.error : raw.slice(0, 200)}`);
    }
    return;
  }

  await smtpTransport().sendMail({ from: `"${from.name}" <${from.email}>`, to, subject, text, html });
}

/** The password-reset code email. */
function resetCodeEmail({ name, code, role, minutes }) {
  const subject = `Your Classroom password reset code: ${code}`;
  const text =
`Hi ${name || ''},

Use this code to reset the password of your Classroom ${role} account:

    ${code}

The code expires in ${minutes} minutes and can only be used once.
If you didn't ask to reset your password, you can ignore this email — your password stays the same.`;
  const html = `
<div style="font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:460px;margin:0 auto;padding:24px;color:#1c2230">
  <h2 style="margin:0 0 6px;font-size:20px">Reset your Classroom password</h2>
  <p style="margin:0 0 18px;color:#6b7385;font-size:14px">Hi ${escapeHtml(name || '')}, use this code to reset the password of your ${escapeHtml(role)} account.</p>
  <div style="font-size:32px;font-weight:700;letter-spacing:10px;text-align:center;background:#f4f6fb;border:1px solid #e3e7f0;border-radius:12px;padding:16px 0">${code}</div>
  <p style="margin:18px 0 0;color:#6b7385;font-size:13px">The code expires in ${minutes} minutes and can only be used once. If you didn't ask for this, ignore this email — your password stays the same.</p>
</div>`;
  return { subject, text, html };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** ayushmahtele@gmail.com -> ay*********e@g****.com */
function maskEmail(email) {
  const [local = '', domain = ''] = String(email || '').split('@');
  const stars = (n) => '*'.repeat(Math.max(n, 1));
  let l;
  if (local.length <= 2) l = local[0] + stars(local.length - 1);
  else if (local.length <= 4) l = local[0] + stars(local.length - 2) + local.slice(-1);
  else l = local.slice(0, 2) + stars(local.length - 3) + local.slice(-1);

  const dot = domain.lastIndexOf('.');
  const name = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  const d = name ? name[0] + stars(name.length - 1) : '';
  return `${l}@${d}${tld}`;
}

module.exports = { sendMail, isMailConfigured, resetCodeEmail, maskEmail };
