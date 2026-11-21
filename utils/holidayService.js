const { DateTime } = require("luxon");

const HolidayNotice = require("../models/holidayNotice");
const HolidayState  = require("../models/holidayState");
const DailyMark     = require("../models/attendReview");
const UserSubject   = require("../models/subjectsModel");
const Semester      = require("../models/semesterSet");

const { getActiveSchedule } = require("./activeSchedule");

const IST_ZONE = "Asia/Kolkata";

// ------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------

function istDay(date) {
  return DateTime
    .fromJSDate(new Date(date))
    .setZone(IST_ZONE)
    .startOf("day");
}

function dateKey(date) {
  return istDay(date).toFormat("yyyy-MM-dd");
}

function recordKey(record) {
  return `${record.subject}_${dateKey(record.date)}_${record.startTime}`;
}

async function loadContext(userId) {

  const [sem, subjects] = await Promise.all([

    Semester.findOne({ user: userId }).lean(),

    UserSubject
      .find({ user: userId })
      .select("name currentSchedule currentScheduleFrom scheduleHistory")
      .lean()

  ]);

  return { sem, subjects };
}


// ------------------------------------------------------------------
// Core: make the user's attendance records match ONE notice.
//
//  shouldApply = true   -> every class on every holiday date (inside the
//                          semester) becomes Holiday
//  shouldApply = false  -> every record this notice created / locked is
//                          put back the way it was
//
// It is a "sync", so it is safe to run again and again:
//   - already-correct records are left alone
//   - missing records are added (new subject, changed schedule ...)
//   - records that no longer belong (class removed, semester moved) are restored
// ------------------------------------------------------------------

async function syncNotice(userId, notice, shouldApply, ctx) {

  ctx = ctx || await loadContext(userId);

  const noticeId = notice._id;

  // ---------- 1. Which (subject, date, start time) must be Holiday? ----------

  const expected = new Map();

  if (shouldApply && ctx.sem && ctx.subjects.length > 0) {

    const semStart = istDay(ctx.sem.startDate);
    const semEnd   = istDay(ctx.sem.endDate);

    for (const holiday of (notice.holidays || [])) {

      const day = istDay(holiday.date);

      if (day < semStart || day > semEnd) {
        continue;
      }

      const dayName = day.toFormat("cccc");
      const dayKey  = day.toFormat("yyyy-MM-dd");

      for (const subject of ctx.subjects) {

        const schedule = getActiveSchedule(subject, day);

        for (const cls of schedule) {

          if (cls.day !== dayName) {
            continue;
          }

          const key = `${subject._id}_${dayKey}_${cls.start}`;

          if (!expected.has(key)) {
            expected.set(key, {
              subject,
              cls,
              day,
              name: holiday.name || "Holiday"
            });
          }
        }
      }
    }
  }


  // ---------- 2. What already exists? ----------

  // Records this notice has already turned into Holiday
  const tagged = await DailyMark
    .find({ user: userId, holidayNotices: noticeId })
    .lean();

  const taggedByKey = new Map();
  tagged.forEach((record) => taggedByKey.set(recordKey(record), record));

  // Records sitting on the dates we need, not yet tagged by this notice
  const untaggedByKey = new Map();

  if (expected.size > 0) {

    const times = [...expected.values()].map((e) => e.day.toMillis());
    const from  = new Date(Math.min(...times));
    const to    = DateTime
      .fromMillis(Math.max(...times))
      .setZone(IST_ZONE)
      .endOf("day")
      .toJSDate();

    const records = await DailyMark
      .find({
        user: userId,
        date: { $gte: from, $lte: to },
        holidayNotices: { $ne: noticeId }
      })
      .select("subject date startTime status holidayNotices")
      .lean();

    records.forEach((record) => untaggedByKey.set(recordKey(record), record));
  }


  const ops = [];
  let added = 0;
  let restored = 0;


  // ---------- 3. Create / convert what is missing ----------

  for (const [key, item] of expected) {

    if (taggedByKey.has(key)) {
      continue;                         // already done
    }

    const record = untaggedByKey.get(key);

    if (record && record.holidayNotices && record.holidayNotices.length > 0) {

      // Another applied notice already made this class a Holiday.
      // Just remember this notice as well.
      ops.push({
        updateOne: {
          filter: { _id: record._id },
          update: { $addToSet: { holidayNotices: noticeId } }
        }
      });

    } else if (record) {

      // Present / Absent / Cancel / manual Holiday exists.
      // Keep it in prevStatus, so removing the notice brings it back.
      ops.push({
        updateOne: {
          filter: { _id: record._id, "holidayNotices.0": { $exists: false } },
          update: {
            $set: {
              prevStatus: record.status,
              status: "holiday",
              holidayName: item.name,
              holidayNotices: [noticeId]
            }
          }
        }
      });

    } else {

      ops.push({
        insertOne: {
          document: {
            user: userId,
            subject: item.subject._id,
            subjectName: item.subject.name,
            date: item.day.toJSDate(),
            startTime: item.cls.start,
            endTime: item.cls.end,
            status: "holiday",
            prevStatus: "none",
            holidayName: item.name,
            holidayNotices: [noticeId]
          }
        }
      });
    }

    added++;
  }


  // ---------- 4. Restore what no longer belongs ----------

  const stale = tagged.filter((record) => !expected.has(recordKey(record)));

  // If some other notice still covers the day, we need its holiday name.
  const otherNoticeIds = new Set();

  stale.forEach((record) => {
    (record.holidayNotices || []).forEach((id) => {
      if (String(id) !== String(noticeId)) {
        otherNoticeIds.add(String(id));
      }
    });
  });

  const nameLookup = new Map();

  if (otherNoticeIds.size > 0) {

    const others = await HolidayNotice
      .find({ _id: { $in: [...otherNoticeIds] } })
      .select("holidays")
      .lean();

    others.forEach((other) => {
      const byDate = new Map();
      (other.holidays || []).forEach((h) => {
        const k = dateKey(h.date);
        if (!byDate.has(k)) byDate.set(k, h.name);
      });
      nameLookup.set(String(other._id), byDate);
    });
  }

  for (const record of stale) {

    const remaining = (record.holidayNotices || [])
      .filter((id) => String(id) !== String(noticeId));

    if (remaining.length > 0) {

      // Still a holiday because of another notice
      const byDate = nameLookup.get(String(remaining[0]));
      const name = (byDate && byDate.get(dateKey(record.date))) || record.holidayName || "Holiday";

      ops.push({
        updateOne: {
          filter: { _id: record._id },
          update: {
            $pull: { holidayNotices: noticeId },
            $set: { holidayName: name }
          }
        }
      });

    } else if (!record.prevStatus || record.prevStatus === "none") {

      // There was no record before the notice
      ops.push({ deleteOne: { filter: { _id: record._id } } });

    } else {

      // Bring back Present / Absent / Cancel / manual Holiday
      ops.push({
        updateOne: {
          filter: { _id: record._id },
          update: {
            $set: { status: record.prevStatus },
            $unset: { prevStatus: "", holidayName: "", holidayNotices: "" }
          }
        }
      });
    }

    restored++;
  }


  // ---------- 5. Write everything in one go ----------

  if (ops.length > 0) {
    try {
      await DailyMark.bulkWrite(ops, { ordered: false });
    } catch (err) {
      // Two requests (double click) can try to create the same record.
      // The unique index stops the second one; that is fine.
      const writeErrors = (err && err.writeErrors) || [];
      const onlyDuplicates =
        writeErrors.length > 0 &&
        writeErrors.every((e) => (e.err ? e.err.code : e.code) === 11000);

      if (!onlyDuplicates && !(err && err.code === 11000)) {
        throw err;
      }
    }
  }

  return { added, restored };
}


function applyNotice(userId, notice, ctx) {
  return syncNotice(userId, notice, true, ctx);
}

function removeNotice(userId, notice, ctx) {
  return syncNotice(userId, notice, false, ctx);
}


// ------------------------------------------------------------------
// Re-check every applied notice of a user.
// Call it after a subject / schedule / semester change, so new classes
// also become Holiday and removed classes stop being Holiday.
// ------------------------------------------------------------------

async function reapplyAppliedNotices(userId) {

  const states = await HolidayState
    .find({ user: userId, applied: true })
    .select("notice")
    .lean();

  if (states.length === 0) {
    return;
  }

  const notices = await HolidayNotice
    .find({ _id: { $in: states.map((s) => s.notice) } })
    .lean();

  const ctx = await loadContext(userId);

  for (const notice of notices) {
    await applyNotice(userId, notice, ctx);
  }
}


// ------------------------------------------------------------------
// Default notices (the ones you add from the backend)
// Pre-applied for every user until that user removes them.
// ------------------------------------------------------------------

let defaultCache = { at: 0, list: [] };

async function getDefaultNotices() {

  if (Date.now() - defaultCache.at < 60 * 1000) {
    return defaultCache.list;
  }

  const list = await HolidayNotice.find({ isDefault: true }).lean();

  defaultCache = { at: Date.now(), list };

  return list;
}

function clearDefaultCache() {
  defaultCache = { at: 0, list: [] };
}

async function ensureDefaultNotices(userId) {

  const defaults = await getDefaultNotices();

  if (defaults.length === 0) {
    return;
  }

  const states = await HolidayState
    .find({ user: userId, notice: { $in: defaults.map((d) => d._id) } })
    .select("notice")
    .lean();

  const have = new Set(states.map((s) => String(s.notice)));

  for (const notice of defaults) {

    if (have.has(String(notice._id))) {
      continue;
    }

    try {
      await HolidayState.create({ user: userId, notice: notice._id, applied: true });
    } catch (err) {
      if (err && err.code === 11000) {
        continue;                       // another request just created it
      }
      throw err;
    }

    await applyNotice(userId, notice);
  }
}


// ------------------------------------------------------------------
// What the Holidays page shows
// ------------------------------------------------------------------

async function getNoticesForUser(userId) {

  const [defaults, own, states] = await Promise.all([

    HolidayNotice.find({ isDefault: true }).sort({ createdAt: 1 }).lean(),

    HolidayNotice.find({ user: userId }).sort({ createdAt: -1 }).lean(),

    HolidayState.find({ user: userId }).lean()

  ]);

  const appliedMap = new Map(states.map((s) => [String(s.notice), s.applied]));

  return [...defaults, ...own].map((notice) => ({
    ...notice,
    // a default notice without a state yet is treated as applied
    isApplied: appliedMap.has(String(notice._id))
      ? appliedMap.get(String(notice._id))
      : !!notice.isDefault
  }));
}

// A notice a user is allowed to touch: a default one, or their own
async function findAccessibleNotice(noticeId, userId) {

  const notice = await HolidayNotice.findById(noticeId).lean();

  if (!notice) {
    return null;
  }

  if (notice.isDefault || String(notice.user) === String(userId)) {
    return notice;
  }

  return null;
}


module.exports = {
  applyNotice,
  removeNotice,
  reapplyAppliedNotices,
  ensureDefaultNotices,
  clearDefaultCache,
  getNoticesForUser,
  findAccessibleNotice,
  dateKey
};
