const { DateTime } = require("luxon");

// Attendance Calculator

function calculateTotalClasses(subject, semester) {

  let totalClasses = 0;

  // Semester start date
  const semesterStart = DateTime
    .fromJSDate(semester.startDate)
    .setZone("Asia/Kolkata")
    .startOf("day");

  // Semester end date
  const semesterEnd = DateTime
    .fromJSDate(semester.endDate)
    .setZone("Asia/Kolkata")
    .startOf("day");


  // ---------------------------------------
  // 1. Calculate classes from old schedules
  // ---------------------------------------

  for (const history of subject.scheduleHistory) {

    let scheduleStart = DateTime
      .fromJSDate(history.effectiveFrom)
      .setZone("Asia/Kolkata")
      .startOf("day");

    let scheduleEnd = DateTime
      .fromJSDate(history.effectiveTo)
      .setZone("Asia/Kolkata")
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


    const subjectDays = history.schedule.map(
      item => item.day
    );


    let currentDate = scheduleStart;


    while (currentDate <= scheduleEnd) {

      const currentDay = currentDate.toFormat("cccc");

      if (subjectDays.includes(currentDay)) {
        totalClasses++;
      }

      currentDate = currentDate.plus({
        days: 1
      });

    }

  }


  // ---------------------------------------
  // 2. Calculate classes from current schedule
  // ---------------------------------------

  let currentScheduleStart = DateTime
    .fromJSDate(subject.currentScheduleFrom)
    .setZone("Asia/Kolkata")
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

    const subjectDays = subject.currentSchedule.map(
      item => item.day
    );


    let currentDate = currentScheduleStart;


    while (currentDate <= currentScheduleEnd) {

      const currentDay = currentDate.toFormat("cccc");

      if (subjectDays.includes(currentDay)) {
        totalClasses++;
      }

      currentDate = currentDate.plus({
        days: 1
      });

    }

  }


  return totalClasses;
}

module.exports = calculateTotalClasses;