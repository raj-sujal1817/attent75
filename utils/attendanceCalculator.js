const { DateTime } = require("luxon");

// Attendance Calculator
//
// Counts how many classes a subject has in the semester.
//
// A subject can have MORE THAN ONE class on the same day
// (for example Monday 10:00 and Monday 14:00). Every class counts,
// because attendance (present / absent / holiday / cancel) is also saved
// once per class, not once per day.
// Two entries with the same day AND the same start time are one class
// (they could not be saved twice anyway).

const IST = "Asia/Kolkata";

// { Monday: 2, Tuesday: 1 ... }  -> how many classes the subject has on each weekday
function classesPerWeekday(schedule) {

  const seen = new Set();
  const perDay = {};

  for (const item of schedule || []) {

    if (!item || !item.day) continue;

    const key = `${item.day}|${item.start || ""}`;

    if (seen.has(key)) continue;

    seen.add(key);

    perDay[item.day] = (perDay[item.day] || 0) + 1;
  }

  return perDay;
}

// Number of classes between two days (both included)
function countClasses(schedule, from, to) {

  const perDay = classesPerWeekday(schedule);

  let total = 0;

  let currentDate = from;

  while (currentDate <= to) {

    total += perDay[currentDate.toFormat("cccc")] || 0;

    currentDate = currentDate.plus({ days: 1 });
  }

  return total;
}

function calculateTotalClasses(subject, semester) {

  let totalClasses = 0;

  // Semester start date
  const semesterStart = DateTime
    .fromJSDate(semester.startDate)
    .setZone(IST)
    .startOf("day");

  // Semester end date
  const semesterEnd = DateTime
    .fromJSDate(semester.endDate)
    .setZone(IST)
    .startOf("day");


  // ---------------------------------------
  // 1. Calculate classes from old schedules
  // ---------------------------------------

  for (const history of subject.scheduleHistory || []) {

    let scheduleStart = DateTime
      .fromJSDate(history.effectiveFrom)
      .setZone(IST)
      .startOf("day");

    let scheduleEnd = DateTime
      .fromJSDate(history.effectiveTo)
      .setZone(IST)
      .startOf("day");


    // Make sure schedule period stays
    // inside current semester period
    if (scheduleStart < semesterStart) {
      scheduleStart = semesterStart;
    }

    if (scheduleEnd > semesterEnd) {
      scheduleEnd = semesterEnd;
    }


    // If this schedule period is outside
    // the semester, skip it
    if (scheduleStart > scheduleEnd) {
      continue;
    }

    totalClasses += countClasses(history.schedule, scheduleStart, scheduleEnd);
  }


  // ---------------------------------------
  // 2. Calculate classes from current schedule
  // ---------------------------------------

  let currentScheduleStart = DateTime
    .fromJSDate(subject.currentScheduleFrom)
    .setZone(IST)
    .startOf("day");


  // Current schedule cannot start
  // before semester start
  if (currentScheduleStart < semesterStart) {
    currentScheduleStart = semesterStart;
  }


  // Current schedule cannot go
  // beyond semester end
  const currentScheduleEnd = semesterEnd;


  // Only calculate if valid date range
  if (currentScheduleStart <= currentScheduleEnd) {

    totalClasses += countClasses(subject.currentSchedule, currentScheduleStart, currentScheduleEnd);
  }


  return totalClasses;
}

module.exports = calculateTotalClasses;
