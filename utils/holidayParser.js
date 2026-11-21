const { DateTime } = require("luxon");

const IST_ZONE = "Asia/Kolkata";

const MAX_HOLIDAYS = 400;
const MAX_NAME_LENGTH = 80;
const MAX_TITLE_LENGTH = 80;
// (exported at the bottom: MAX_HOLIDAYS, MAX_NAME_LENGTH, MAX_TITLE_LENGTH)

// Gemini sometimes wraps JSON in ```json fences even when told not to.
function stripCodeFences(text) {
  return String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function cleanName(name) {
  const cleaned = String(name === undefined || name === null ? "" : name)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH);

  return cleaned || "Holiday";
}

// "2026-11-08" -> Luxon date (IST) or null if it is not a real calendar date
function parseYmd(value) {

  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return null;
  }

  const dt = DateTime.fromISO(value.trim(), { zone: IST_ZONE }).startOf("day");

  if (!dt.isValid || dt.year < 2000 || dt.year > 2100) {
    return null;
  }

  return dt;
}

function weekdayMatches(claimed, actualLongName) {

  if (!claimed) {
    return true;                        // nothing to compare
  }

  const a = String(claimed).trim().slice(0, 3).toLowerCase();
  const b = actualLongName.slice(0, 3).toLowerCase();

  return a === b;
}

// Turns Gemini's answer into clean rows for the review page.
//
// Returns { title, holidays: [{ date: "yyyy-MM-dd", name, warning? }], dropped }
//   - bad / impossible dates are dropped (counted in `dropped`)
//   - the same date twice keeps the first one
//   - rows are sorted by date
//   - `warning` is added when the date looks suspicious, so the user checks it
function parseHolidayResponse(rawText) {

  let data;

  try {
    data = JSON.parse(stripCodeFences(rawText));
  } catch (err) {
    throw new Error("Gemini did not return valid JSON.");
  }

  // Be forgiving: allow a bare array as well
  const list = Array.isArray(data) ? data : (data && data.holidays);

  if (!Array.isArray(list)) {
    throw new Error("Gemini response has no holidays list.");
  }

  const title = cleanName(data && !Array.isArray(data) ? data.title : "")
    .slice(0, MAX_TITLE_LENGTH);

  const seen = new Set();
  const rows = [];
  let dropped = 0;

  for (const item of list.slice(0, MAX_HOLIDAYS)) {

    const dt = parseYmd(item && item.date);

    if (!dt) {
      dropped++;
      continue;
    }

    const key = dt.toFormat("yyyy-MM-dd");

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    const row = {
      date: key,
      name: cleanName(item.name)
    };

    // The notice prints the weekday next to every date. If it disagrees with
    // the calendar, the date (not the weekday) is usually what AI misread.
    const actualWeekday = dt.toFormat("cccc");

    if (!weekdayMatches(item.weekday, actualWeekday)) {
      row.warning =
        `The notice says ${String(item.weekday).trim()}, but ${key} is a ${actualWeekday}. ` +
        `Please check this date.`;
    }

    rows.push(row);
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // A date in a different year than the rest is almost always a misread
  const yearCount = {};
  rows.forEach((r) => {
    const y = r.date.slice(0, 4);
    yearCount[y] = (yearCount[y] || 0) + 1;
  });

  const mainYear = Object.keys(yearCount)
    .sort((a, b) => yearCount[b] - yearCount[a])[0];

  rows.forEach((r) => {
    if (r.date.slice(0, 4) !== mainYear && !r.warning) {
      r.warning = `Most dates are in ${mainYear}, but this one is in ${r.date.slice(0, 4)}. Please check it.`;
    }
  });

  return {
    title: title === "Holiday" ? "" : title,
    holidays: rows,
    dropped
  };
}

// The text sent to Gemini together with the file
const HOLIDAY_PROMPT = `
Analyze this university holiday notice (holiday list).

Extract every holiday date from the table.

Return ONLY raw JSON.

Do NOT use markdown.
Do NOT use \`\`\`json.
Do NOT use code fences.

{
  "title": "Short English title, e.g. BEU Holiday Notice 2026",
  "holidays": [
    {
      "date": "2026-01-26",
      "name": "Republic Day",
      "weekday": "Monday"
    }
  ]
}

Rules:
- "date" must be in YYYY-MM-DD format.
- The table often shows only day and month (for example "26 जनवरी").
  Take the YEAR from the heading of the notice (for example "वर्ष 2026" / "year 2026").
- If one row covers a date range (for example "02 March to 04 March"),
  output ONE entry for EVERY calendar day in that range, all with the same name.
  Example: 02 March to 04 March = 2026-03-02, 2026-03-03, 2026-03-04.
- This also applies to long vacations (for example a whole month of summer vacation
  or a week of winter vacation): list every single day.
- Include every row of the table, even if the "total days" column is empty
  or the date falls on a Sunday.
- "name" must be the holiday name in short English.
  If the Hindi name is a well known festival or day, use its common English name
  (for example "गणतंत्र दिवस" = "Republic Day", "दीपावली" = "Deepawali").
  If a row has several names separated by "/", keep all of them, joined with " / ".
- "weekday" is the English weekday written in the "day" column of that row
  (Monday ... Sunday). For a date range, give the real weekday of each date.
- Do NOT include the notice number, issue date, signatures, remarks or copy-to lists as holidays.
- Do not output the same date twice.
`;

module.exports = {
  parseHolidayResponse,
  parseYmd,
  cleanName,
  stripCodeFences,
  MAX_NAME_LENGTH,
  MAX_TITLE_LENGTH,
  HOLIDAY_PROMPT,
  MAX_HOLIDAYS
};
