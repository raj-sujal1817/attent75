// OTP helpers: make a 6 digit code, store only its hash, check it later.
//
// The hash is an HMAC (keyed with SESSION_SECRET) of  email + purpose + code,
// so a code for one email / purpose can never be used for another.
// A 6 digit code is short, so the real protection is: 10 minute expiry +
// at most 5 wrong tries + a gap between sends (see the routes in app.js).

const crypto = require("crypto");

const OTP_TTL_MS = 10 * 60 * 1000;     // code works for 10 minutes
const OTP_MAX_ATTEMPTS = 5;            // wrong tries before the code is thrown away
const RESEND_GAP_MS = 60 * 1000;       // minimum gap between two sends
const MAX_SENDS_PER_HOUR = 5;          // codes per user per hour
const SEND_WINDOW_MS = 60 * 60 * 1000;

function secret() {
  return process.env.SESSION_SECRET || "attent75-dev-secret";
}

function makeCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

function hashCode(email, purpose, code) {
  return crypto
    .createHmac("sha256", secret())
    .update(`${String(email).toLowerCase()}|${purpose}|${String(code)}`)
    .digest("hex");
}

function sameHash(a, b) {
  const x = Buffer.from(String(a || ""), "hex");
  const y = Buffer.from(String(b || ""), "hex");
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

// How many seconds the user must still wait before asking for another code.
function resendWaitSeconds(user, now = Date.now()) {
  if (!user || !user.otpLastSentAt) return 0;
  const left = user.otpLastSentAt.getTime() + RESEND_GAP_MS - now;
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

// Is the user allowed to be sent another code right now?
// returns { ok: true } or { ok: false, reason: "wait"|"limit", wait: seconds }
function canSend(user, now = Date.now()) {
  const wait = resendWaitSeconds(user, now);
  if (wait > 0) return { ok: false, reason: "wait", wait };

  const windowOpen = user.otpWindowStart && now - user.otpWindowStart.getTime() < SEND_WINDOW_MS;

  if (windowOpen && (user.otpSendCount || 0) >= MAX_SENDS_PER_HOUR) {
    return { ok: false, reason: "limit", wait: 0 };
  }

  return { ok: true };
}

// Puts a fresh code on the user document (caller saves it) and returns the plain code to e-mail.
function issueCode(user, purpose, now = Date.now()) {
  const code = makeCode();

  const windowOpen = user.otpWindowStart && now - user.otpWindowStart.getTime() < SEND_WINDOW_MS;

  user.otpHash = hashCode(user.email, purpose, code);
  user.otpPurpose = purpose;
  user.otpExpiresAt = new Date(now + OTP_TTL_MS);
  user.otpAttempts = 0;
  user.otpLastSentAt = new Date(now);
  user.otpWindowStart = windowOpen ? user.otpWindowStart : new Date(now);
  user.otpSendCount = windowOpen ? (user.otpSendCount || 0) + 1 : 1;

  return code;
}

function clearCode(user) {
  user.otpHash = undefined;
  user.otpPurpose = undefined;
  user.otpExpiresAt = undefined;
  user.otpAttempts = 0;
}

// Checks a code the user typed. Changes user.otpAttempts / clears the code, caller saves.
// returns "ok" | "none" | "expired" | "locked" | "wrong"
function checkCode(user, purpose, typed, now = Date.now()) {
  if (!user.otpHash || user.otpPurpose !== purpose) return "none";

  if (!user.otpExpiresAt || user.otpExpiresAt.getTime() < now) {
    clearCode(user);
    return "expired";
  }

  if ((user.otpAttempts || 0) >= OTP_MAX_ATTEMPTS) {
    clearCode(user);
    return "locked";
  }

  const clean = String(typed || "").replace(/\D/g, "");

  if (sameHash(user.otpHash, hashCode(user.email, purpose, clean))) {
    clearCode(user);
    return "ok";
  }

  user.otpAttempts = (user.otpAttempts || 0) + 1;

  if (user.otpAttempts >= OTP_MAX_ATTEMPTS) {
    clearCode(user);
    return "locked";
  }

  return "wrong";
}

function maskEmail(email) {
  const [name = "", domain = ""] = String(email).split("@");
  const shown = name.slice(0, Math.min(2, name.length));
  return `${shown}${"*".repeat(Math.max(1, name.length - shown.length))}@${domain}`;
}

module.exports = {
  OTP_TTL_MS, OTP_MAX_ATTEMPTS, RESEND_GAP_MS, MAX_SENDS_PER_HOUR,
  makeCode, hashCode, resendWaitSeconds, canSend, issueCode, clearCode, checkCode, maskEmail
};
