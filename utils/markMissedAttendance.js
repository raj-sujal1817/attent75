
const { DateTime } = require("luxon");

const UserSubject = require("../models/subjectsModel");
const DailyMark = require("../models/attendReview");

const IST_ZONE = "Asia/Kolkata";


async function markMissedAttendance(userId, semester) {

  try {

    console.log("🔄 Attendance sync started");


    // ==========================================
    // 1. Validate semester
    // ==========================================

    if (
      !semester ||
      !semester.startDate ||
      !semester.endDate
    ) {

      console.log(
        "⚠️ Semester information not available."
      );

      return;
    }


    // ==========================================
    // 2. Current IST date
    // ==========================================

    const actualToday =
      DateTime
        .now()
        .setZone(IST_ZONE)
        .startOf("day");


    // ==========================================
    // 3. Semester end date
    // ==========================================

    const semesterEnd =
      DateTime
        .fromJSDate(
          new Date(semester.endDate),
          {
            zone: IST_ZONE
          }
        )
        .startOf("day");


    // ==========================================
    // 4. Effective today
    //
    // Don't sync today's classes.
    // Sync only up to yesterday.
    //
    // But never go beyond semester end.
    // ==========================================

    const yesterday =
      actualToday.minus({
        days: 1
      });


    const today =
      yesterday < semesterEnd
        ? yesterday
        : semesterEnd;


    // ==========================================
    // 5. Semester start date
    // ==========================================

    const semesterStart =
      DateTime
        .fromJSDate(
          new Date(semester.startDate),
          {
            zone: IST_ZONE
          }
        )
        .startOf("day");


    // ==========================================
    // 6. Determine sync start date
    //
    // First sync:
    // Semester Start → Today
    //
    // Next sync:
    // Last Sync + 1 → Today
    //
    // If semester start date is changed,
    // lastAttendanceSyncDate should be reset
    // to null in semester update POST route.
    // ==========================================

    let syncStart;


    if (
      semester.lastAttendanceSyncDate
    ) {

      syncStart =
        DateTime
          .fromJSDate(
            new Date(
              semester.lastAttendanceSyncDate
            ),
            {
              zone: IST_ZONE
            }
          )
          .startOf("day")
          .plus({
            days: 1
          });

    } else {

      syncStart =
        semesterStart;

    }


    // ==========================================
    // 7. Nothing new to sync
    // ==========================================

    if (
      syncStart > today
    ) {

      console.log(
        "ℹ️ No new dates available for sync."
      );

      return;
    }


    console.log(
      `📅 Sync range: ${syncStart.toFormat("dd-MM-yyyy")} → ${today.toFormat("dd-MM-yyyy")}`
    );


    // ==========================================
    // 8. Get user's subjects
    //
    // Get:
    //
    // - currentSchedule
    // - currentScheduleFrom
    // - scheduleHistory
    //
    // These are required to determine
    // which schedule was active on each date.
    // ==========================================

    const subjects =
      await UserSubject
        .find({
          user: userId
        })
        .select(
          "name currentSchedule currentScheduleFrom scheduleHistory"
        )
        .lean();


    // ==========================================
    // 9. No subjects
    //
    // IMPORTANT:
    // Do NOT update lastAttendanceSyncDate.
    //
    // Because a subject may be added later.
    // ==========================================

    if (
      !subjects.length
    ) {

      console.log(
        "ℹ️ No subjects found. Sync date not updated."
      );

      return;
    }


    console.log(
      `📚 Subjects found: ${subjects.length}`
    );


    // ==========================================
    // 10. Get existing DailyMark records
    //
    // Only current sync range.
    // ==========================================

    const existingRecords =
      await DailyMark.find({

        user:
          userId,

        date: {
          $gte:
            syncStart.toJSDate(),

          $lte:
            today
              .endOf("day")
              .toJSDate()
        }

      })
      .select(
        "subject date startTime"
      )
      .lean();


    // ==========================================
    // 11. Create fast lookup Set
    //
    // Format:
    //
    // subjectId_date_startTime
    // ==========================================

    const existingSet =
      new Set(

        existingRecords.map(
          record => {

            const dateKey =
              DateTime
                .fromJSDate(
                  record.date,
                  {
                    zone: IST_ZONE
                  }
                )
                .toFormat(
                  "yyyy-MM-dd"
                );


            return (
              `${record.subject}_${dateKey}_${record.startTime}`
            );

          }
        )

      );


    // ==========================================
    // 12. Missing attendance records
    // ==========================================

    const missedRecords = [];


    // ==========================================
    // 13. Loop through every date
    // ==========================================

    for (
      let date = syncStart;

      date <= today;

      date = date.plus({
        days: 1
      })
    ) {


      // ==========================================
      // Day name
      // ==========================================

      const dayName =
        date.toFormat(
          "cccc"
        );


      const dateKey =
        date.toFormat(
          "yyyy-MM-dd"
        );


      // ==========================================
      // 14. Loop through user's subjects
      // ==========================================

      for (
        const subject of subjects
      ) {


        const currentSchedule =
          subject.currentSchedule || [];


        const scheduleHistory =
          subject.scheduleHistory || [];


        // ==========================================
        // 15. Determine active schedule
        // for THIS exact date
        // ==========================================

        let activeSchedule = [];


        // ==========================================
        // CASE 1:
        //
        // Subject was NEVER edited.
        //
        // scheduleHistory is empty.
        //
        // Therefore currentSchedule is used.
        //
        // Example:
        //
        // Semester Start = 16 July
        // scheduleHistory = []
        //
        // 16 July onwards:
        // currentSchedule
        // ==========================================

        if (
          scheduleHistory.length === 0
        ) {

          activeSchedule =
            currentSchedule;

        }


        // ==========================================
        // CASE 2:
        //
        // Subject has schedule history.
        // ==========================================

        else {

          // ----------------------------------------
          // Current schedule start date
          // ----------------------------------------

          const currentScheduleFrom =
            subject.currentScheduleFrom
              ? DateTime
                  .fromJSDate(
                    new Date(
                      subject.currentScheduleFrom
                    ),
                    {
                      zone: IST_ZONE
                    }
                  )
                  .startOf("day")
              : null;


          // ----------------------------------------
          // Current schedule is active
          // from currentScheduleFrom onwards.
          // ----------------------------------------

          if (
            currentScheduleFrom &&
            date >= currentScheduleFrom
          ) {

            activeSchedule =
              currentSchedule;

          }


          // ----------------------------------------
          // Date is BEFORE currentScheduleFrom.
          //
          // Therefore search old schedules.
          // ----------------------------------------

          else {

            // --------------------------------------
            // Sort history from newest to oldest.
            //
            // This is important if multiple edits
            // happened and date ranges overlap.
            // Latest matching history is preferred.
            // --------------------------------------

            const sortedHistory =
              [...scheduleHistory]
                .sort(
                  (a, b) =>
                    new Date(
                      b.effectiveFrom
                    ) -
                    new Date(
                      a.effectiveFrom
                    )
                );


            // --------------------------------------
            // Find exact historical schedule
            // for this date.
            // --------------------------------------

            const historyVersion =
              sortedHistory.find(
                version => {

                  if (
                    !version.effectiveFrom ||
                    !version.effectiveTo
                  ) {

                    return false;

                  }


                  const effectiveFrom =
                    DateTime
                      .fromJSDate(
                        new Date(
                          version.effectiveFrom
                        ),
                        {
                          zone: IST_ZONE
                        }
                      )
                      .startOf("day");


                  const effectiveTo =
                    DateTime
                      .fromJSDate(
                        new Date(
                          version.effectiveTo
                        ),
                        {
                          zone: IST_ZONE
                        }
                      )
                      .startOf("day");


                  return (
                    date >= effectiveFrom &&
                    date <= effectiveTo
                  );

                }
              );


            // --------------------------------------
            // Exact history found.
            //
            // Use the schedule that was active
            // on this exact date.
            // --------------------------------------

            if (
              historyVersion
            ) {

              activeSchedule =
                historyVersion.schedule || [];

            }


            // --------------------------------------
            // No exact history found.
            //
            // This can happen when semester start
            // date is moved BACKWARD.
            //
            // Example:
            //
            // Old semester start = 21 July
            // New semester start = 16 July
            //
            // History starts from 21 July.
            //
            // For 16-20 July, use the oldest
            // known historical schedule.
            // --------------------------------------

            else {

              const oldestHistory =
                [...scheduleHistory]
                  .sort(
                    (a, b) =>
                      new Date(
                        a.effectiveFrom
                      ) -
                      new Date(
                        b.effectiveFrom
                      )
                  )[0];


              if (
                oldestHistory
              ) {

                activeSchedule =
                  oldestHistory.schedule || [];

              }

            }

          }

        }


        // ==========================================
        // No schedule found for this date
        //
        // Do not create absent record.
        //
        // This protects subjects that were added
        // later or have no valid schedule data.
        // ==========================================

        if (
          !activeSchedule.length
        ) {

          continue;

        }


        // ==========================================
        // 16. Find classes scheduled
        // on this particular day
        // ==========================================

        const classesToday =
          activeSchedule.filter(
            cls =>
              cls.day === dayName
          );


        // No class on this day
        if (
          !classesToday.length
        ) {

          continue;
        }


        // ==========================================
        // 17. Process each class
        // ==========================================

        for (
          const cls of classesToday
        ) {


          // ==========================================
          // Unique lookup key
          // ==========================================

          const key =
            `${subject._id}_${dateKey}_${cls.start}`;


          // ==========================================
          // Already marked?
          //
          // present
          // absent
          // holiday
          // cancel
          //
          // Any existing DailyMark means:
          // Don't create another record.
          // ==========================================

          if (
            existingSet.has(key)
          ) {

            continue;

          }


          // ==========================================
          // Create automatic absent record
          // ==========================================

          missedRecords.push({

            user:
              userId,

            subject:
              subject._id,

            subjectName:
              subject.name,

            date:
              date.toJSDate(),

            startTime:
              cls.start,

            endTime:
              cls.end,

            status:
              "absent"

          });


          // ==========================================
          // Prevent duplicate within same sync
          // ==========================================

          existingSet.add(
            key
          );

        }

      }

    }


    // ==========================================
    // 18. Insert all missing records
    // ==========================================

    if (
      missedRecords.length > 0
    ) {

      try {

        await DailyMark.insertMany(
          missedRecords,
          {
            ordered: false
          }
        );


        console.log(
          `✅ ${missedRecords.length} absent records added.`
        );


      } catch (
        insertError
      ) {

        console.error(
          "❌ Attendance insert error:",
          insertError
        );

        return;
      }

    } else {

      console.log(
        "ℹ️ No missing attendance records found."
      );

    }


    // ==========================================
    // 19. Update last sync date
    // ==========================================

    semester.lastAttendanceSyncDate =
      today.toJSDate();


    await semester.save();


    // ==========================================
    // 20. Sync completed
    // ==========================================

    console.log(
      `✅ Attendance sync completed for user ${userId}.`
    );


  } catch (
    error
  ) {

    console.error(
      "❌ Automatic attendance sync error:",
      error
    );

  }

}


module.exports = markMissedAttendance;

