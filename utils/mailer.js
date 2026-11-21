// Sends e-mails through SMTP (Gmail by default).
//
// .env needs:
//   SMTP_USER=yourname@gmail.com
//   SMTP_PASS=the 16 letter Google "App password"   (NOT your normal Gmail password)
// Optional:
//   SMTP_HOST=smtp.gmail.com   SMTP_PORT=465   MAIL_FROM="Attent75 <yourname@gmail.com>"

const nodemailer = require("nodemailer");

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error("SMTP_USER / SMTP_PASS are missing in .env");
  }

  const port = Number(process.env.SMTP_PORT) || 465;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000
  });

  return transporter;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const COPY = {
  verify: {
    subject: "Your Attent75 verification code",
    title: "Verify your email",
    line: "Use this code to finish creating your Attent75 account."
  },
  reset: {
    subject: "Your Attent75 password reset code",
    title: "Reset your password",
    line: "Use this code to set a new password for your Attent75 account."
  }
};

async function sendOtpEmail(to, username, code, purpose) {
  const c = COPY[purpose] || COPY.verify;

  const from = process.env.MAIL_FROM || `Attent75 <${process.env.SMTP_USER}>`;

  const text =
    `Hi ${username},\n\n${c.line}\n\nYour code: ${code}\n\n` +
    "It works for 10 minutes. If you did not ask for it, you can ignore this email.\n\n- Attent75";

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;background:#f1f5f9;padding:24px;">
    <div style="max-width:420px;margin:auto;background:#ffffff;border-radius:14px;overflow:hidden;">
      <div style="background:linear-gradient(135deg,#1a3a5c,#2563eb);padding:20px 24px;color:#ffffff;">
        <div style="font-size:22px;font-weight:700;">Attent<span style="color:#93c5fd;">75</span></div>
      </div>
      <div style="padding:24px;color:#1e293b;">
        <h2 style="margin:0 0 8px;font-size:20px;color:#1a3a5c;">${esc(c.title)}</h2>
        <p style="margin:0 0 16px;font-size:14px;color:#475569;">Hi ${esc(username)}, ${esc(c.line)}</p>
        <div style="text-align:center;font-size:34px;letter-spacing:10px;font-weight:700;color:#2563eb;background:#eff6ff;border:1.5px solid #bfdbfe;border-radius:12px;padding:14px 0;">${esc(code)}</div>
        <p style="margin:16px 0 0;font-size:12px;color:#64748b;">This code works for 10 minutes. If you did not ask for it, you can ignore this email.</p>
      </div>
    </div>
  </div>`;

  await getTransporter().sendMail({ from, to, subject: c.subject, text, html });
}

module.exports = { sendOtpEmail };
