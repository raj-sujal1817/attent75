const { DateTime } = require("luxon");

const IST_ZONE = "Asia/Kolkata";

// Returns the class list (day/start/end) that was active for a subject on a
// given date. `date` must be a Luxon DateTime at IST start of day.
//
// This is the same rule markMissedAttendance uses, kept here so the holiday
// feature creates records for exactly the classes that would otherwise be
// marked missed.
//
//  - Subject never edited (no scheduleHistory)      -> currentSchedule
//  - date >= currentScheduleFrom                    -> currentSchedule
//  - date inside a history period                   -> that history schedule
//  - date before every period (semester start moved back)
//                                                   -> oldest history schedule
function getActiveSchedule(subject, date) {

  const currentSchedule = subject.currentSchedule || [];
  const scheduleHistory = subject.scheduleHistory || [];

  if (scheduleHistory.length === 0) {
    return currentSchedule;
  }

  const currentScheduleFrom = subject.currentScheduleFrom
    ? DateTime
        .fromJSDate(new Date(subject.currentScheduleFrom), { zone: IST_ZONE })
        .startOf("day")
    : null;

  if (currentScheduleFrom && date >= currentScheduleFrom) {
    return currentSchedule;
  }

  const sortedHistory = [...scheduleHistory].sort(
    (a, b) => new Date(b.effectiveFrom) - new Date(a.effectiveFrom)
  );

  const historyVersion = sortedHistory.find((version) => {

    if (!version.effectiveFrom || !version.effectiveTo) {
      return false;
    }

    const effectiveFrom = DateTime
      .fromJSDate(new Date(version.effectiveFrom), { zone: IST_ZONE })
      .startOf("day");

    const effectiveTo = DateTime
      .fromJSDate(new Date(version.effectiveTo), { zone: IST_ZONE })
      .startOf("day");

    return date >= effectiveFrom && date <= effectiveTo;
  });

  if (historyVersion) {
    return historyVersion.schedule || [];
  }

  const oldestHistory = [...scheduleHistory].sort(
    (a, b) => new Date(a.effectiveFrom) - new Date(b.effectiveFrom)
  )[0];

  return oldestHistory ? (oldestHistory.schedule || []) : [];
}

module.exports = { getActiveSchedule };
