// Turns a Gemini API error into a message a student can understand,
// including WHEN they can try again.
//
// - Daily free limit finished  -> "resets around 12:30 PM IST (in about 3 hours)"
//   (Gemini's daily quota resets at midnight Pacific time)
// - Per minute limit           -> "try again in about 40 seconds" (taken from the error if it has it)
// - Google servers are busy    -> "try again in a few minutes"
// - anything else              -> { kind: "other" } and the caller keeps its own message

const { DateTime } = require("luxon");

function errorText(err) {
  const parts = [];

  if (err && err.message) parts.push(String(err.message));

  try {
    if (err && err.error) parts.push(JSON.stringify(err.error));
    if (err && err.response && err.response.data) parts.push(JSON.stringify(err.response.data));
  } catch (e) {
    // ignore, the message is enough
  }

  return parts.join(" ");
}

function statusOf(err, text) {
  const code = Number(err && (err.status || err.code || (err.error && err.error.code)));
  if (code) return code;

  const m = /"code"\s*:\s*(\d{3})/.exec(text);
  return m ? Number(m[1]) : 0;
}

// "retryDelay":"37s"  or  "Please retry in 37.2s"  ->  seconds
function retrySeconds(text) {
  const a = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(text);
  const b = /retry in (\d+(?:\.\d+)?)\s*s/i.exec(text);
  const v = a ? a[1] : b ? b[1] : null;
  return v ? Math.ceil(Number(v)) : null;
}

function humanDuration(seconds) {
  if (seconds < 60) return `${Math.max(1, seconds)} second${seconds === 1 ? "" : "s"}`;

  const mins = Math.ceil(seconds / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;

  const hours = Math.floor(mins / 60);
  const rest = mins % 60;

  if (rest === 0) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${hours} hour${hours === 1 ? "" : "s"} ${rest} minute${rest === 1 ? "" : "s"}`;
}

// Next midnight in Pacific time (handles summer / winter time itself), as an IST DateTime
function nextDailyResetIST(now) {
  const pacificMidnight = DateTime
    .fromMillis(now, { zone: "America/Los_Angeles" })
    .plus({ days: 1 })
    .startOf("day");

  return pacificMidnight.setZone("Asia/Kolkata");
}

function describeGeminiError(err, now = Date.now()) {

  const text = errorText(err);
  const status = statusOf(err, text);

  const isQuota =
    status === 429 ||
    /RESOURCE_EXHAUSTED/i.test(text) ||
    /quota/i.test(text) && /exceed|exhaust|limit/i.test(text);

  if (isQuota) {

    const seconds = retrySeconds(text);

    // Daily limit: the error names a "PerDay" quota (or there is no short retry time)
    const isDaily = /PerDay|per day|daily/i.test(text) || (seconds === null || seconds > 3600);

    if (isDaily && !(seconds !== null && seconds <= 120 && !/PerDay|per day|daily/i.test(text))) {

      const reset = nextDailyResetIST(now);
      const wait = Math.max(60, Math.ceil((reset.toMillis() - now) / 1000));

      return {
        kind: "daily",
        status: 429,
        retryAfterSeconds: wait,
        message:
          "Today's free AI limit is over, so this file cannot be read right now. " +
          `It resets around ${reset.toFormat("h:mm a")} IST (in about ${humanDuration(wait)}). ` +
          "Please upload it again after that."
      };
    }

    const wait = seconds || 60;

    return {
      kind: "rate",
      status: 429,
      retryAfterSeconds: wait,
      message: `Too many requests right now. Please try again in about ${humanDuration(wait)}.`
    };
  }

  if (status === 503 || status === 500 || /UNAVAILABLE|overloaded|high demand/i.test(text)) {
    return {
      kind: "busy",
      status: 503,
      retryAfterSeconds: 120,
      message: "The AI service is busy right now. Please try again in a few minutes."
    };
  }

  return { kind: "other", status: 500, message: null };
}

module.exports = { describeGeminiError, nextDailyResetIST, humanDuration };
