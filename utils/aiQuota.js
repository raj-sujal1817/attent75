// Per-user daily limit for AI reads (routine import + holiday notice import).
//
// Why: the free Gemini key is shared by every user, so one person uploading again and
// again would finish the quota for everybody. Each user gets a few reads per IST day
// (default 3, change with AI_DAILY_LIMIT_PER_USER in .env).
//
// - A read is counted BEFORE Gemini is called (so two quick clicks cannot sneak past the limit).
// - If Gemini fails because of ITS limit / busy servers, the read is given back.
// - The user's day is the IST calendar day, so it resets at 12:00 AM IST.

const { DateTime } = require("luxon");
const AiUsage = require("../models/aiUsage");
const { humanDuration } = require("./geminiErrors");

const IST = "Asia/Kolkata";

function dailyLimit() {
  const n = Number(process.env.AI_DAILY_LIMIT_PER_USER);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
}

function dayKey(now) {
  return DateTime.fromMillis(now, { zone: IST }).toFormat("yyyy-MM-dd");
}

function nextReset(now) {
  return DateTime.fromMillis(now, { zone: IST }).plus({ days: 1 }).startOf("day");
}

function describe(used, now) {
  const limit = dailyLimit();
  const reset = nextReset(now);
  const seconds = Math.max(60, Math.ceil((reset.toMillis() - now) / 1000));

  return {
    limit,
    used,
    left: Math.max(0, limit - used),
    resetText: reset.toFormat("h:mm a") + " IST",     // "12:00 AM IST"
    resetIn: humanDuration(seconds)                     // "5 hours 10 minutes"
  };
}

async function getQuota(userId, now = Date.now()) {
  const doc = await AiUsage.findOne({ user: userId, day: dayKey(now) }).lean();
  return describe(doc && doc.used ? doc.used : 0, now);
}

// Takes one read. returns { ok:true, day, quota } or { ok:false, quota }
async function reserve(userId, now = Date.now()) {
  const day = dayKey(now);
  const limit = dailyLimit();

  try {
    const doc = await AiUsage.findOneAndUpdate(
      { user: userId, day, used: { $lt: limit } },
      {
        $inc: { used: 1 },
        $setOnInsert: { expiresAt: new Date(now + 3 * 24 * 60 * 60 * 1000) }
      },
      { upsert: true, new: true, setDefaultsOnInsert: false }
    );

    return { ok: true, day, quota: describe(doc.used, now) };

  } catch (err) {

    // Document for today exists and used >= limit: the upsert tried to insert a second
    // one and the unique index refused it. That means "limit reached".
    if (err && err.code === 11000) {
      return { ok: false, quota: await getQuota(userId, now) };
    }

    throw err;
  }
}

// Gives a read back (Gemini was down / over ITS limit, not the user's fault)
async function refund(userId, day) {
  try {
    await AiUsage.updateOne(
      { user: userId, day, used: { $gt: 0 } },
      { $inc: { used: -1 } }
    );
  } catch (err) {
    console.error("AI read refund failed:", err);
  }
}

function limitMessage(quota, manualHint) {
  return (
    `You have used all ${quota.limit} AI reads for today. ` +
    `Your limit resets at ${quota.resetText} (in about ${quota.resetIn}). ` +
    (manualHint || "")
  ).trim();
}

module.exports = { getQuota, reserve, refund, limitMessage, dailyLimit, dayKey };
