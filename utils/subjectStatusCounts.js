// Replaces the "4 countDocuments calls per subject" N+1 pattern that was
// duplicated on the Dashboard and Subjects routes. Instead of 4×N queries
// (one per subject, per status), this does ONE aggregation over dailyMark
// for the whole user, grouped by {subject, status}, then buckets the
// results into a per-subject map in memory.
//
// Returns: Map<subjectId(string), { present: n, absent: n, holiday: n, cancel: n }>

const mongoose = require("mongoose");
const dailyMark = require("../models/attendReview");

async function getSubjectStatusCounts(userId) {

  // IMPORTANT: Mongoose auto-casts query filter values to the schema type
  // for .find()/.countDocuments()/etc, but it does NOT do this for
  // .aggregate() pipelines — $match is passed straight to the MongoDB
  // driver. If req.session.userId ever comes back as a plain string
  // (common after being round-tripped through the session store), an
  // un-cast string would silently match zero documents against the
  // ObjectId-typed `user` field, making every subject show 0% attendance
  // without throwing any error. Casting explicitly here makes this safe
  // regardless of what type userId arrives as.
  const userObjectId =
    userId instanceof mongoose.Types.ObjectId
      ? userId
      : new mongoose.Types.ObjectId(userId);

  const rows = await dailyMark.aggregate([
    { $match: { user: userObjectId } },
    {
      $group: {
        _id: { subject: "$subject", status: "$status" },
        count: { $sum: 1 }
      }
    }
  ]);

  const counts = new Map();

  for (const row of rows) {
    const subjectId = row._id.subject.toString();
    const status = row._id.status;

    if (!counts.has(subjectId)) {
      counts.set(subjectId, { present: 0, absent: 0, holiday: 0, cancel: 0 });
    }

    counts.get(subjectId)[status] = row.count;
  }

  return counts;
}

// Small helper so call sites don't need to worry about a subject
// having zero attendance records yet (Map.get would return undefined).
function getCountsFor(countsMap, subjectId) {
  return countsMap.get(subjectId.toString()) || {
    present: 0,
    absent: 0,
    holiday: 0,
    cancel: 0
  };
}

module.exports = { getSubjectStatusCounts, getCountsFor };
