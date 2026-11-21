// Adds (or updates) the DEFAULT holiday notice that every user sees,
// pre-applied until the user removes it.
//
//   node scripts/seedDefaultHoliday.js                          -> data/beu_holidays_2026.json
//   node scripts/seedDefaultHoliday.js data/other_notice.json   -> any notice file
//   node scripts/seedDefaultHoliday.js data/x.json --replace    -> notice with the same title
//                                                                  already exists: replace its dates
//
// The JSON file looks like:
//   { "title": "...", "description": "...", "holidays": [ { "date": "2026-01-26", "name": "Republic Day" } ] }
//
// --replace: for every user who has this notice applied, the old effect is
// removed first, then the new dates are applied (so nobody is left with stale
// holiday marks).

require("dotenv").config();

const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");
const { DateTime } = require("luxon");

const HolidayNotice = require("../models/holidayNotice");
const HolidayState = require("../models/holidayState");
const userInfo = require("../models/loginfo");

const {
  applyNotice,
  removeNotice,
  clearDefaultCache
} = require("../utils/holidayService");

const IST_ZONE = "Asia/Kolkata";

async function main() {

  const args = process.argv.slice(2);
  const replace = args.includes("--replace");
  const fileArg = args.find((a) => !a.startsWith("--")) || "data/beu_holidays_2026.json";
  const filePath = path.resolve(__dirname, "..", fileArg);

  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));

  if (!data.title || !Array.isArray(data.holidays) || data.holidays.length === 0) {
    throw new Error("The JSON file needs a title and a non-empty holidays list.");
  }

  const holidays = [];
  const seen = new Set();

  for (const h of data.holidays) {

    const dt = DateTime.fromISO(String(h.date), { zone: IST_ZONE }).startOf("day");

    if (!dt.isValid) {
      throw new Error(`Invalid date in file: ${h.date}`);
    }

    const key = dt.toFormat("yyyy-MM-dd");

    if (seen.has(key)) {
      throw new Error(`Date appears twice in file: ${key}`);
    }

    seen.add(key);
    holidays.push({ date: dt.toJSDate(), name: h.name || "Holiday" });
  }

  holidays.sort((a, b) => a.date - b.date);

  await mongoose.connect(process.env.MONGO_URI);

  const existing = await HolidayNotice.findOne({ isDefault: true, title: data.title });

  // ---------- New notice ----------
  if (!existing) {

    const notice = await HolidayNotice.create({
      title: data.title,
      description: data.description,
      isDefault: true,
      user: null,
      holidays
    });

    console.log(`Created default notice "${notice.title}" with ${holidays.length} dates.`);
    console.log("Every user gets it applied the next time they open Dashboard / Attendance / Subjects / Holidays.");
    return;
  }

  // ---------- Already there ----------
  if (!replace) {
    console.log(`A default notice called "${data.title}" already exists. Nothing changed.`);
    console.log("Run again with --replace to replace its dates.");
    return;
  }

  // ---------- Replace dates ----------
  const states = await HolidayState
    .find({ notice: existing._id, applied: true })
    .select("user")
    .lean();

  console.log(`Removing the old effect for ${states.length} user(s)...`);

  for (const s of states) {
    await removeNotice(s.user, existing.toObject());
  }

  existing.description = data.description;
  existing.holidays = holidays;
  await existing.save();

  console.log("Applying the new dates...");

  for (const s of states) {
    await applyNotice(s.user, existing.toObject());
  }

  console.log(`Replaced. "${existing.title}" now has ${holidays.length} dates.`);
}

main()
  .catch((err) => {
    console.error("Seed failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    clearDefaultCache();
    await mongoose.disconnect();
  });
