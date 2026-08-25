const { DateTime } = require("luxon");

// Total working days calculator

function getWorkingDays(startDate, endDate) {

  let start = DateTime
    .fromJSDate(startDate)
    .setZone("Asia/Kolkata")
    .startOf("day");

  let end = DateTime
    .fromJSDate(endDate)
    .setZone("Asia/Kolkata")
    .startOf("day");

  const today = DateTime
    .now()
    .setZone("Asia/Kolkata")
    .startOf("day");

    const effectiveEndDate =
    today > end
        ? end
        : today;

  let workingDays = 0;

  while (start <= effectiveEndDate) {

    if (start.weekday !== 7) {   // Sunday = 7 in Luxon
      workingDays++;
    }

    start = start.plus({ days: 1 });
  }

  return workingDays;
}

module.exports = getWorkingDays;