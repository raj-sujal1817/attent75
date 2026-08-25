require('dotenv').config();

const { testGemini, extractRoutine } = require("./utils/gemini");

const multer = require("multer");

const upload = multer({
  dest: "uploads/routines/",

  limits: {
    fileSize: 10 * 1024 * 1024 //10MB
  }

});

const express = require("express");
const mongoose = require("mongoose");

const { DateTime } = require("luxon");

const dns = require("dns");

dns.setServers(["1.1.1.1", "8.8.8.8"]);

const { 
  nowIST,
  nowISTDate,
  startOfTodayIST,
  endOfTodayIST,
  formattedToday,
  startOfDayIST,
  endOfDayIST } = require("./utils/date");


const bcrypt = require("bcrypt");
const session = require("express-session");
const MongoStore = require("connect-mongo").default;

const path = require("path");
const ejsMate = require("ejs-mate");
const methodOverride = require("method-override");
const app = express();

const markMissedAttendance = require("./utils/markMissedAttendance");

const userInfo = require("./models/loginfo");  // userInfo is a collection of u75 db..
const userSubject = require("./models/subjectsModel")  // userSubject is a collection of u75 db..
const semester = require("./models/semesterSet")  // semester is a collection of u75 db..
const attendanceCalculator = require("./utils/attendanceCalculator");
const calculateTotalClasses = require("./utils/attendanceCalculator");
const dailyMark = require("./models/attendReview");
const getWorkingDays = require("./utils/workingDaysCalci");
const needToGet75 = require("./utils/needClassesCalci");
const { getSubjectStatusCounts, getCountsFor } = require("./utils/subjectStatusCounts");
const { start } = require("repl");
const fs = require("fs");

// MogoDB Connection 

  const dbUrl =  process.env.MONGO_URI;



mongoose.connect(dbUrl)
.then(() => console.log("CONNECTED"))
.catch(err => console.log(err));


// gemini api ....

app.get("/test-gemini", async (req, res) => {
  try {
    const result = await testGemini();

    res.send(`
      <h1>Gemini Connected ✅</h1>
      <p>${result}</p>
    `);

  } catch (err) {
    console.error("Gemini Error:", err);

    res.status(500).send("Gemini connection failed.");
  }
});

// console.log(require("connect-mongo"));

//Session 

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,

    store: MongoStore.create({
      mongoUrl: dbUrl
    }),

    cookie: {
      maxAge: 30*24*60*60*1000
    },

    rolling: true
  })

);

app.engine("ejs", ejsMate);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(methodOverride("_method"));
app.use(express.urlencoded({ extended: true}));
app.use(express.static(path.join(__dirname, "/public")));


// starting ...//




// Globally execute for all .ejs file...//

app.use((req, res, next) => {
  res.locals.formateTime = function(time){
    let [hours, minutes] = time.split(":");
    hours = Number(hours);
    
    let ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12 || 12;
    let ABC;

    return `${hours}:${minutes} ${ampm}`;
  };

  next();

});




//home route 


app.get("/", (req, res) => {
  if(req.session.userId) {
    return res.redirect("/dashboard");
  }
  res.redirect("/login");
});

// Sigup page

app.get("/signup", (req, res) => {
  res.render("users/signup.ejs");
});

// Signup Logic
app.post("/signup", async (req, res) => {
  try {
    const {username, email, password} = req.body;
    const existingUser = await userInfo.findOne({email});
    if(existingUser){
      return res.render("users/signup.ejs", {
        error: "An account with this email already exists.",
        formData: { username, email }
      });
    }
    const hashedPassword = await bcrypt.hash(password,10);
    const newUser = new userInfo({
      username,
      email,
      password: hashedPassword
    });
    await newUser.save();
    res.redirect("/login");
  }catch(err){
    console.log(err);
    res.render("users/signup.ejs", {
      error: "Something went wrong. Please try again.",
      formData: { username: req.body.username, email: req.body.email }
    });
  };
});


// Login Page

app.get("/login", (req, res) => {
  res.render("users/login.ejs");
});


//login logic 
app.post("/login", async (req, res) =>{
  try {
    const {email, password} = req.body;
    const user = await userInfo.findOne({email});
    if(!user){
      return res.render("users/login.ejs", {
        error: "No account found with this email.",
        formData: { email }
      });
    }
    const isMatch = await bcrypt.compare(password, user.password);
    if(!isMatch){
      return res.render("users/login.ejs", {
        error: "Incorrect password. Please try again.",
        formData: { email }
      });
    }
    req.session.userId = user._id;
    res.redirect("/");
  }catch(err){
    console.log(err);
    res.render("users/login.ejs", {
      error: "Something went wrong. Please try again.",
      formData: { email: req.body.email }
    });
  }
});


//middilware function 

app.use(async (req, res, next) => {
  if(req.session.userId){
    let user = await userInfo.findById(req.session.userId);
    res.locals.user = user;
  }
  next();
});

// Logout

app.get("/logout", (req, res) => {
  req.session.destroy(()=>{
    res.redirect("/login");
  });

});


// semester Setup 

app.get("/semester/setup", async (req, res) => {
  const sem = await semester.findOne({user: req.session.userId});
  console.log("CODING IS THE MONEY............");
  console.log(sem);
  res.render("semester/setup.ejs", {semester: sem});
});


app.post("/semester/setup", async (req, res) => {


  try {

      const {
      semesterName,
      startDate,
      endDate,
    } = req.body;

    const semInfo = await semester.findOneAndUpdate(

      {
        user: req.session.userId
      },

      {
        semesterName,
        startDate,
        endDate,
        user: req.session.userId
      },

      {
        upsert: true,
        new: true
      }
    );



    if (semInfo) {
      console.log(semInfo);
      console.log(
      "🔥 markMissedAttendance CALLED"
    );

                                             
      semInfo.lastAttendanceSyncDate = null;                               
      await semInfo.save();

    }

    const subjects = await userSubject.find({ user: req.session.userId});

    // Each subject's recalculation + save is independent of the others,
    // so they're run in parallel instead of one at a time.
    await Promise.all(subjects.map(sub => {
      sub.totalClasses = calculateTotalClasses(sub, semInfo);
      return sub.save();
    }));

    res.redirect("/dashboard");

  }catch(err){
    console.log(err);
    res.send("Something went wrong.");
  }



});




app.get("/time-check", (req, res) => {
  res.json({
    now: new Date(),
    iso: new Date().toISOString(),
    local: new Date().toString(),
    timezoneOffset: new Date().getTimezoneOffset()
  });
});





// dashboard

app.get("/dashboard", async (req, res) => {

  try{

    
    const userId = req.session.userId;

    

    const [subjects, semInfo, statusCounts] = await Promise.all([
      // Only select fields this route actually uses — scheduleHistory isn't
      // needed here and can grow large over a semester.
      userSubject.find({user:userId}).select("name currentSchedule totalClasses"),
      semester.findOne({user:userId}),
      // Single aggregation replacing the old 4-countDocuments-per-subject loop.
      getSubjectStatusCounts(userId)
    ]);

    // console.log(subjects);

    // // ⚠️ TEMPORARY: Sirf ek baar reset karne ke liye
    //   semInfo.lastAttendanceSyncDate = null;
    //   await semInfo.save();


    // // Automatic missed attendance sync
    // if (semInfo) {

    //   await markMissedAttendance(
    //     userId,
    //     semInfo
    //   );

    //   console.log("🔥 markMissedAttendance CALLED");

    // }



    let dailySchedule = [];
    let dashboardShow = [];

    // Computed once instead of on every subject×class iteration.
    const todayDay = nowIST().toFormat("cccc");

    for (let subject of subjects) {

    


      // srif Aaj ki classes ko show krana hai dashboard pr ....

      for(let cls of subject.currentSchedule){

        // Srif Aaj Waali classes

        if(cls.day === todayDay){

          let room = "apna class";

            dailySchedule.push({
              
            subjectId: subject._id,
            name: subject.name,
            startTime: cls.start,
            // endTime: cls.end,
            apnaClass: room,
            

          });
        } 
      }








      // ye neeche waala concept dono for loop k use ka hai
      // jo each subject k total persent,absent,cancel,holiday ko count kr 
      // each subject ka percentage bta rha....









    // No query here anymore — counts come from the single aggregation
    // fetched once above (getSubjectStatusCounts), instead of 4 separate
    // countDocuments queries per subject.
    const {
      present: presentCount,
      absent: absentCount,
      holiday: holidayCount,
      cancel: cancelCount
    } = getCountsFor(statusCounts, subject._id);












      const finalClasses =  subject.totalClasses - holidayCount - cancelCount;

      const finalPercent = finalClasses > 0 ? (presentCount * 100) / finalClasses : 0;



      //push

        dashboardShow.push({

        // subjectId: subject._id,

        subjectName: subject.name,

        // totalClasses: subject.totalClasses,

        // finalClasses : finalClasses,

        presentCount,

        // absentCount,

        // holidayCount,

        // cancelCount,

        finalPercent: finalPercent.toFixed(1)

      });

      // console.log(dashboardShow);


    }




    // Left days in Semester..2

   

    if(!semInfo) {
      return res.redirect("/semester/setup");
    }



    let leftDays = 0;
    let passDays = 0;


    const exactDate = startOfTodayIST();
    // console.log("exactDate : ", exactDate);



      const endDate = startOfDayIST(semInfo.endDate);
      const startDate = startOfDayIST(semInfo.startDate);

      // console.log("SEM START DATE : ", startDate);


    if(semInfo){
      
      const diff = endDate - exactDate;


      leftDays = Math.ceil( diff / (1000*60*60*24));

    }

    











    // BIOMETRIC LOGIC.....


    // finding total workingDays....1

    // const sem = await semester.findOne({
    //   user: userId
    // });

    


    // const startingDate = semInfo.startDate
    // // console.log("Starting date of the semester : ",startingDate);
    // const endingDate = semInfo.endDate;

    // const ttotal = Math.ceil(endDate - startDate)/(1000 * 60 * 60 * 24);
    // console.log("ttotal :", ttotal);

    // const ttoday = Math.ceil((exactDate) - (startDate))/(1000 * 60 * 60 * 24);
    // console.log("ttoday :", ttoday);


    const workingDays = getWorkingDays(startDate, endDate);
    // console.log("Working Days : ", workingDays);

    // console.log("workingDays:" ,workingDays);

    





    // Total present days & total holiday days — these are independent
    // queries, so they're run in parallel instead of one-after-another.

    const [presentDates, holidayDates] = await Promise.all([
      dailyMark.distinct("date", { user: userId, status: "present" }),
      dailyMark.distinct("date", { user: userId, status: "holiday" })
    ]);

    const userPresentDays = presentDates.length;
    // console.log("presentdays : ", userPresentDays);

      const userHolidays = holidayDates.length;
      // console.log("userHolidays : ", userHolidays);

      const actulWorkingDays = workingDays - userHolidays ;

      // console.log("actualWorkingDays : ", actulWorkingDays);

      const biometricPercent = (userPresentDays * 100) / actulWorkingDays ;

      // console.log("bimoetric % : ", biometricPercent );


      const needDays = needToGet75(userPresentDays, actulWorkingDays);  
    

      // console.log("needDaysToget75 : ", needDays);
      // console.log("leftDays : ", leftDays);


      const bioDashInfo = {
        biometric: biometricPercent.toFixed(1),
        needClasses: needDays,
        remainingDays: leftDays,
        semStartDate : startDate
      }

      // console.log("bioDashInfo : ", bioDashInfo);



    //   console.log(dashboardShow);
    // console.log(dailySchedule);

    dailySchedule.sort((a,b) => {
      return a.startTime.localeCompare(b.startTime);
    });

    res.render("dashboard/dash_index.ejs", {subjects: dashboardShow , todayClasses: dailySchedule,  stats: bioDashInfo, todayDate: formattedToday()});


  }catch(err){
  console.log(err);
  res.send("Something went wrong.");
}


});











// Subjects

app.get("/subjects", async (req, res) => {

  try {


    const userId = req.session.userId;

    // subjects + all status counts fetched in parallel; counts come from a
    // single aggregation instead of 4 countDocuments queries per subject.
    const [subjects, statusCounts] = await Promise.all([
      userSubject.find({user: userId}).select("name classesPerWeek currentSchedule totalClasses"),
      getSubjectStatusCounts(userId)
    ]);



    let subjectsList = [];



    for (let subject of subjects) {

      // ye neeche waala concept dono for loop k use ka hai
      // jo each subject k total persent,absent,cancel,holiday ko count kr 
      // each subject ka percentage bta rha....

      const {
        present: presentCount,
        absent: absentCount,
        holiday: holidayCount,
        cancel: cancelCount
      } = getCountsFor(statusCounts, subject._id);

      const finalClasses =  subject.totalClasses - holidayCount - cancelCount;

      const finalPercent = finalClasses > 0 ? (presentCount * 100) / finalClasses : 0;



      //push

        subjectsList.push({

        ...subject.toObject(),

        finalClasses : finalClasses,

        attendClasses: presentCount,

        missedClasses: absentCount,

        finalPercent: finalPercent.toFixed(1)

      });

    }

    
    res.render("subjects/sub_index.ejs", {subjectsList: subjectsList});


  }catch(err){
    console.log(err);
    res.send("Something went wrong.");
  }

  
});




app.post("/subjects", async (req, res) => {

  try {

    // Find user's semester
    const Semester = await semester.findOne({
      user: req.session.userId
    });

    const userId = req.session.userId;

    if (!Semester) {
      return res.send("SEMESTER DETAILS NOT FOUND.");
    }


//====================================================
    // AI ROUTINE IMPORT
    //====================================================

    if (req.body.importMode === "ai") {

      const routine =
        req.session.importedRoutine;

      if (
        !routine ||
        !Array.isArray(routine.subjects)
      ) {
        return res.send("IMPORTED ROUTINE NOT FOUND.");
      }


      let selectedSubjects =
        req.body.selectedSubjects || [];


      // If only one checkbox selected,
      // Express gives a string.
      if (!Array.isArray(selectedSubjects)) {
        selectedSubjects = [selectedSubjects];
      }


      if (selectedSubjects.length === 0) {
        return res.send(
          "PLEASE SELECT AT LEAST ONE SUBJECT."
        );
      }


      // New subjects added
      Semester.lastAttendanceSyncDate = null;


      // Create every checked subject
      for (const index of selectedSubjects) {

        const data =
          routine.subjects[Number(index)];


        if (!data || !data.schedule?.length) {
          continue;
        }


        const subject = new userSubject({

          name: data.name,

          // Backend calculates this
          classesPerWeek:
            data.schedule.length,

          currentScheduleFrom:
            Semester.startDate,

          currentSchedule:
            data.schedule,

          scheduleHistory: [],

          user: userId
        });


        // Existing Attent75 calculation
        subject.totalClasses =
          calculateTotalClasses(
            subject,
            Semester
          );


        // Save to MongoDB
        await subject.save();

      }


      await Semester.save();


      // Routine is no longer needed
      delete req.session.importedRoutine;


      // Go to normal subjects page
      return res.redirect("/subjects");
    }



    // NORMAL FLOW.....//





    // Create new subject
    const subject = new userSubject({
      name: req.body.subjectName,

      classesPerWeek: req.body.classesPerWeek,

      // Current active schedule starts from semester start date
      currentScheduleFrom: Semester.startDate,

      // User's current schedule
      currentSchedule: req.body.schedule,

      // No previous schedule when subject is first created
      scheduleHistory: [],

      user: req.session.userId
    });

    // New subject ke past classes ko sync karne ke liye

    if (Semester) {
      Semester.lastAttendanceSyncDate = null;
      await Semester.save();
    }

    // Calculate total classes
    const totalClasses = calculateTotalClasses(
      subject,
      Semester
    );

    subject.totalClasses = totalClasses;

    // Save subject
    await subject.save();

    res.redirect("/subjects");

  } catch (err) {

    console.log(err);

    res.send("ERROR WHILE SAVING SUBJECT.");

  }

});

// Adding new subjects...


app.get("/subjects/new", (req, res) => {
  res.render("subjects/sub_new.ejs");
});


// new route for upload routine files...

app.get("/subjects/import-routine", (req, res) => {
  res.render("subjects/import_routine.ejs");
});

app.post(
  "/subjects/import-routine",

  // Wraps multer's upload so a too-large file gives a clean message
  // instead of a raw/default Express error page.
  function (req, res, next) {
    upload.single("routineFile")(req, res, function (err) {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(400).send(
            "File is too large (max 10MB). Please compress it to under 2MB and try again."
          );
        }
        return res.status(400).send("Failed to upload file. Please try again.");
      }
      next();
    });
  },

  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).send("Please upload a routine file.");
      }

      console.log("Routine received:");
      console.log("Original name:", req.file.originalname);
      console.log("MIME type:", req.file.mimetype);
      console.log("Saved path:", req.file.path);

      const routineData = await extractRoutine(req.file.path, req.file.mimetype);

      console.log("Gemini response:");
      console.log(routineData);

      const parsedRoutine = JSON.parse(routineData);

      console.log("Parsed routine:");
      console.log(parsedRoutine);

      req.session.importedRoutine = parsedRoutine;

      res.render("subjects/routine_select.ejs", {
        routineData: parsedRoutine
      });

    } catch (err) {
      console.error("Routine extraction error:", err);
      res.status(500).send("Failed to analyze routine.");
    } finally {
      if (req.file?.path) {
        try {
          await fs.promises.unlink(req.file.path);
          console.log("Temporary routine file deleted.");
        } catch (deleteErr) {
          console.error("Failed to delete temporary routine file:", deleteErr);
        }
      }
    }
  }
);



//===========================================================
// Edit Subject - By Subject ID
//===========================================================

app.get("/subjects/:id/edit", async (req, res) => {

  try {

    const { id } = req.params;
    const userId = req.session.userId;

    // Find subject
    const editSub = await userSubject.findOne({
      _id: id,
      user: userId
    });

    // Subject not found
    if (!editSub) {
      return res.status(404).send("SUBJECT NOT FOUND.");
    }


    //===========================================================
    // Get Attendance Statistics
    //===========================================================

    const [
      presentCount,
      absentCount,
      holidayCount,
      cancelCount
    ] = await Promise.all([

      dailyMark.countDocuments({
        user: userId,
        subject: editSub._id,
        status: "present"
      }),

      dailyMark.countDocuments({
        user: userId,
        subject: editSub._id,
        status: "absent"
      }),

      dailyMark.countDocuments({
        user: userId,
        subject: editSub._id,
        status: "holiday"
      }),

      dailyMark.countDocuments({
        user: userId,
        subject: editSub._id,
        status: "cancel"
      })

    ]);

    


    //===========================================================
    // Calculate Final Classes & Attendance Percentage
    //===========================================================

    const finalClasses =
      editSub.totalClasses - holidayCount - cancelCount;

    

    const finalPercent =
      finalClasses > 0
        ? (presentCount * 100) / finalClasses
        : 0;


    //===========================================================
    // Prepare Statistics
    //===========================================================

    const subjectsList = [

      {
        ...editSub.toObject(),

        finalClasses: finalClasses,

        attendClasses: presentCount,

        missedClasses: absentCount,

        finalPercent: finalPercent.toFixed(1)
      }

    ];


    

    //===========================================================
    // Render Edit Page
    //===========================================================

    res.render("subjects/edit.ejs", {

      subject: editSub,

      stats: subjectsList,


    });


  } catch (err) {

    console.log("ERROR WHILE OPENING EDIT SUBJECT:", err);

    res.status(500).send("Something went wrong.");

  }

});



//===========================================================
// Update (Edit) Subject
//===========================================================

app.post("/subjects/:id", async (req, res) => {

  try {

    const subjectId = req.params.id;
    const userId = req.session.userId;


    // -------------------------------------------------------
    // 1. Find existing subject
    // -------------------------------------------------------

    const subject = await userSubject.findOne({
      _id: subjectId,
      user: userId
    });

    if (!subject) {
      return res.send("SUBJECT NOT FOUND.");
    }


    // -------------------------------------------------------
    // 2. Find user's semester
    // -------------------------------------------------------

    const semInfo = await semester.findOne({
      user: userId
    });

    if (!semInfo) {
      return res.send("SEMESTER DETAILS NOT FOUND.");
    }


    // -------------------------------------------------------
    // 3. Store old subject name
    // -------------------------------------------------------

    const oldSubjectName = subject.name;


    // -------------------------------------------------------
    // 4. Get updated data from edit form
    // -------------------------------------------------------

    const newName = req.body.subjectName;

    const newClassesPerWeek = Number(
      req.body.classesPerWeek
    );

    const newSchedule = Array.isArray(req.body.schedule)
      ? req.body.schedule
      : [req.body.schedule];


    // -------------------------------------------------------
    // 5. Get today's date in IST
    // -------------------------------------------------------

    const changeDate = DateTime
      .now()
      .setZone("Asia/Kolkata")
      .startOf("day");


    // -------------------------------------------------------
    // 6. Check whether schedule has changed
    // -------------------------------------------------------

    const oldSchedule = JSON.stringify(
      subject.currentSchedule
    );

    const updatedSchedule = JSON.stringify(
      newSchedule
    );

    const scheduleChanged =
      oldSchedule !== updatedSchedule;


    // -------------------------------------------------------
    // 7. Handle schedule change
    // -------------------------------------------------------

    if (scheduleChanged) {

      // -----------------------------------------------------
      // Check if current schedule was already changed today
      // -----------------------------------------------------

      const currentScheduleFrom = DateTime
        .fromJSDate(subject.currentScheduleFrom)
        .setZone("Asia/Kolkata")
        .startOf("day");


      const sameDayScheduleEdit =
        currentScheduleFrom.toMillis() ===
        changeDate.toMillis();


      // -----------------------------------------------------
      // CASE 1:
      // Schedule was already changed today
      //
      // Just replace current schedule.
      // Do NOT create another history record.
      // -----------------------------------------------------

      if (sameDayScheduleEdit) {

        subject.currentSchedule =
          newSchedule;

      }


      // -----------------------------------------------------
      // CASE 2:
      // Schedule was not changed today
      //
      // Move old schedule to history.
      // Then set new schedule as current.
      // -----------------------------------------------------

      else {

        const oldScheduleEnd = changeDate
          .minus({ days: 1 })
          .toJSDate();


        // Save old current schedule in history

        subject.scheduleHistory.push({

          effectiveFrom:
            subject.currentScheduleFrom,

          effectiveTo:
            oldScheduleEnd,

          schedule:
            subject.currentSchedule

        });


        // Set new schedule as current

        subject.currentSchedule =
          newSchedule;


        // New schedule starts today

        subject.currentScheduleFrom =
          changeDate.toJSDate();

      }

    }


    // -------------------------------------------------------
    // 8. Update subject basic information
    // -------------------------------------------------------

    subject.name =
      newName;

    subject.classesPerWeek =
      newClassesPerWeek;


    // -------------------------------------------------------
    // 9. Recalculate total classes
    // -------------------------------------------------------

    subject.totalClasses =
      attendanceCalculator(
        subject,
        semInfo
      );


    // -------------------------------------------------------
    // 10. Save updated subject
    // -------------------------------------------------------

    await subject.save();


    // -------------------------------------------------------
    // 11. Update subject name in existing attendance records
    // -------------------------------------------------------

    if (oldSubjectName !== newName) {

      await dailyMark.updateMany(
        {
          subject: subjectId,
          user: userId
        },

        {
          subjectName: newName
        }
      );

    }


    // -------------------------------------------------------
    // 12. Redirect
    // -------------------------------------------------------

    res.redirect("/subjects");


  } catch (err) {

    console.log(err);

    res.send("Something went wrong.");

  }

});



//==========================================================//
  // delete subject .....//
//==========================================================//



app.post("/subjects/:id/delete", async (req, res) => {

  try {
    // const {id} = req.body;

    await userSubject.findOneAndDelete(

      {
        _id: req.params.id,
        user: req.session.userId
      }

    );

    await dailyMark.deleteMany({
      subject : req.params.id,
      user: req.session.userId
    });



    res.redirect("/subjects");

  }catch(err){
    console.log(err);
    res.send("ERROR WHILE DELETING SUBJECT..");
  }
  
});





// Mark Attendance page..... //


// ============================================================
// Shared helper: build today's scheduled classes + their current
// attendance status. Used by both the GET render and the POST
// AJAX response, so the "what does today look like" logic lives
// in exactly one place.
// ============================================================

async function getTodayClassesWithStatus(userId) {

  const subjects = await userSubject.find({user: userId}).select("name currentSchedule");

  const startOfDay = startOfTodayIST();
  const endOfDay = endOfTodayIST();

  const todayMark = await dailyMark.find({
    user: userId,
    date: {
      $gte: startOfDay,
      $lte: endOfDay
    }
  });

  const todayDay = nowIST().toFormat("cccc");

  let todayClasses = [];

  for (let subject of subjects) {
    for (let cls of subject.currentSchedule) {
      if (cls.day === todayDay) {

        const mark = todayMark.find(m =>
          m.subject.toString() === subject._id.toString() && m.startTime === cls.start
        );

        todayClasses.push({
          subjectId: subject._id,
          name: subject.name,
          startTime: cls.start,
          endTime: cls.end,
          status: mark ? mark.status : null
        });
      }
    }
  }

  todayClasses.sort((a,b) => a.startTime.localeCompare(b.startTime));

  return todayClasses;
}

// Sends the result of an attendance-marking action.
// - AJAX callers (fetch, marked via X-Requested-With) get back the fresh
//   today's-classes+status list as JSON, so the page can update in place.
// - Non-JS/classic form submits still get the old redirect, so the page
//   keeps working even with JavaScript disabled.
async function respondAfterAttendanceChange(req, res) {
  if (req.xhr) {
    const classes = await getTodayClassesWithStatus(req.session.userId);
    return res.json({ success: true, classes });
  }
  return res.redirect("/attendance/mark");
}

// Same idea for error responses — AJAX callers get JSON they can parse
// and show inline; classic form submits keep the old plain-text response.
function sendMarkError(req, res, status, message) {
  if (req.xhr) {
    return res.status(status).json({ success: false, message });
  }
  return res.status(status).send(message);
}


app.get("/attendance/mark", async (req, res) => {

  const todayClasses = await getTodayClassesWithStatus(req.session.userId);

  res.render("attendance/mark.ejs", {classes: todayClasses});
});


// ============================================================
// POST: Mark Attendance
// ============================================================

app.post("/attendance/mark", async (req, res) => {

  try {

    // ========================================================
    // 1. Get current user's semester + all subjects
    //
    // These two lookups don't depend on each other, so they're
    // fetched in parallel instead of one after another. This is
    // the highest-frequency write route in the app (fired on
    // every attendance tap), so shaving a round trip here matters.
    // ========================================================

    const [semInfo, subjects] = await Promise.all([
      semester.findOne({ user: req.session.userId }),
      userSubject.find({ user: req.session.userId }).select("name currentSchedule")
    ]);


    // ========================================================
    // 2. Validate semester information
    // ========================================================

    if (
      !semInfo ||
      !semInfo.endDate
    ) {

      return sendMarkError(req, res, 400,
        "Semester information not available."
      );

    }


    // ========================================================
    // 3. Check semester end date
    // ========================================================

    const currentDate =
      startOfDayIST(
        nowISTDate()
      );

    const semEnd =
      startOfDayIST(
        semInfo.endDate
      );


    // Attendance marking not allowed
    // after semester end date

    if (
      currentDate > semEnd
    ) {

      return sendMarkError(req, res, 403,
        "Semester has ended."
      );

    }


    // ========================================================
    // 4. Get request data
    // ========================================================

    const {
      subjectId,
      subjectName,
      startTime,
      endTime,
      status
    } = req.body;


    // ========================================================
    // 5. Today's date
    // ========================================================

    const today =
      startOfTodayIST();


    // ========================================================
    // 6. Get today's day name
    //
    // Example:
    // Monday
    // Tuesday
    // Wednesday
    // ========================================================

    const todayDay =
      nowIST().toFormat("cccc");


    // ========================================================
    // 7. Build today's scheduled classes
    //
    // (subjects were already fetched above, in parallel with semInfo)
    //
    // This contains ONLY today's actual classes
    // according to currentSchedule.
    // ========================================================

    const todayClasses = [];


    for (
      const subject of subjects
    ) {

      const currentSchedule =
        subject.currentSchedule || [];


      for (
        const cls of currentSchedule
      ) {

        if (
          cls.day === todayDay
        ) {

          todayClasses.push({

            subjectId:
              subject._id,

            subjectName:
              subject.name,

            startTime:
              cls.start,

            endTime:
              cls.end

          });

        }

      }

    }


    // ========================================================
    // 9. If no class is scheduled today
    // ========================================================

    if (
      todayClasses.length === 0
    ) {

      return await respondAfterAttendanceChange(req, res);

    }


    // ========================================================
    // 10. Check whether today is already FULL HOLIDAY
    //
    // IMPORTANT:
    //
    // Holiday is GLOBAL.
    //
    // If every scheduled class today has a holiday record,
    // then the whole day is considered Holiday.
    // ========================================================

    const holidayRecords =
      await dailyMark.find({

        user:
          req.session.userId,

        date:
          today,

        status:
          "holiday"

      })
      .select(
        "subject startTime"
      )
      .lean();


    // ========================================================
    // 11. Create unique keys for today's classes
    // ========================================================

    const todayClassKeys =
      new Set(

        todayClasses.map(
          cls =>
            `${cls.subjectId}_${cls.startTime}`
        )

      );


    // ========================================================
    // 12. Create unique keys for Holiday records
    // ========================================================

    const holidayKeys =
      new Set(

        holidayRecords.map(
          record =>
            `${record.subject}_${record.startTime}`
        )

      );


    // ========================================================
    // 13. Check if ALL today's scheduled classes
    // are currently Holiday
    // ========================================================

    const isFullHoliday =
      todayClassKeys.size > 0 &&
      todayClassKeys.size === holidayKeys.size &&
      [...todayClassKeys].every(
        key =>
          holidayKeys.has(key)
      );


    // ========================================================
    // ========================================================
    // 14. GLOBAL HOLIDAY TOGGLE
    // ========================================================
    // ========================================================

    if (
      status === "holiday"
    ) {


      // ======================================================
      // CASE A:
      //
      // Today is already FULL HOLIDAY.
      //
      // Clicking Holiday again means:
      //
      // → Remove Holiday
      // → Unmark ALL today's classes
      //
      // This ensures partial Holiday can never remain.
      // ======================================================

      if (
        isFullHoliday
      ) {

        await dailyMark.deleteMany({

          user:
            req.session.userId,

          date:
            today

        });


        return await respondAfterAttendanceChange(req, res);

      }


      // ======================================================
      // CASE B:
      //
      // Today is NOT full Holiday.
      //
      // Clicking Holiday means:
      //
      // → ALL today's classes become Holiday.
      //
      // Any existing Present / Absent / Cancel record
      // will be changed to Holiday.
      // ======================================================

      for (
        const cls of todayClasses
      ) {

        await dailyMark.findOneAndUpdate(

          {

            user:
              req.session.userId,

            subject:
              cls.subjectId,

            date:
              today,

            startTime:
              cls.startTime

          },

          {

            user:
              req.session.userId,

            subject:
              cls.subjectId,

            subjectName:
              cls.subjectName,

            date:
              today,

            startTime:
              cls.startTime,

            endTime:
              cls.endTime,

            status:
              "holiday"

          },

          {

            upsert:
              true,

            new:
              true

          }

        );

      }


      return await respondAfterAttendanceChange(req, res);

    }


    // ========================================================
    // ========================================================
    // 15. BLOCK INDIVIDUAL ATTENDANCE DURING FULL HOLIDAY
    // ========================================================
    // ========================================================
    //
    // If whole day is Holiday,
    // user cannot mark only one subject as:
    //
    // Present
    // Absent
    // Cancel
    //
    // Holiday must remain GLOBAL.
    // ========================================================

    if (
      isFullHoliday
    ) {

      return await respondAfterAttendanceChange(req, res);

    }


    // ========================================================
    // 16. Validate normal attendance status
    // ========================================================

    const allowedStatuses = [
      "present",
      "absent",
      "cancel"
    ];


    if (
      !allowedStatuses.includes(status)
    ) {

      return sendMarkError(req, res, 400,
        "Invalid attendance status."
      );

    }


    // ========================================================
    // 17. Validate subjectId
    // ========================================================

    if (
      !subjectId ||
      !startTime
    ) {

      return sendMarkError(req, res, 400,
        "Invalid attendance data."
      );

    }


    // ========================================================
    // 18. Make sure requested subject/class
    // actually belongs to today's schedule
    // ========================================================

    const requestedClass =
      todayClasses.find(

        cls =>

          cls.subjectId.toString() ===
            subjectId.toString() &&

          cls.startTime ===
            startTime

      );


    if (
      !requestedClass
    ) {

      return sendMarkError(req, res, 400,
        "Invalid class selection."
      );

    }


    // ========================================================
    // 19. Find existing attendance record
    // ========================================================

    const existingRecord =
      await dailyMark.findOne({

        user:
          req.session.userId,

        subject:
          subjectId,

        date:
          today,

        startTime:
          startTime

      });


    // ========================================================
    // 20. Existing record found
    // ========================================================

    if (
      existingRecord
    ) {


      // ======================================================
      // Same status clicked again
      //
      // Example:
      //
      // Present → Present
      //
      // Result:
      // Unmark / Delete record
      // ======================================================

      if (
        existingRecord.status === status
      ) {

        await dailyMark.deleteOne({

          _id:
            existingRecord._id

        });


        return await respondAfterAttendanceChange(req, res);

      }


      // ======================================================
      // Different status selected
      //
      // Example:
      //
      // Present → Absent
      // Absent  → Present
      // Cancel  → Present
      //
      // Existing record will be updated.
      // ======================================================

      existingRecord.status =
        status;

      existingRecord.subjectName =
        subjectName ||
        requestedClass.subjectName;

      existingRecord.endTime =
        endTime ||
        requestedClass.endTime;


      await existingRecord.save();


    }

    // ========================================================
    // 21. No existing record
    //
    // Create new attendance record
    // ========================================================

    else {

      await dailyMark.create({

        user:
          req.session.userId,

        subject:
          subjectId,

        subjectName:
          subjectName ||
          requestedClass.subjectName,

        date:
          today,

        startTime:
          startTime,

        endTime:
          endTime ||
          requestedClass.endTime,

        status:
          status

      });

    }


    // ========================================================
    // 22. Redirect back to Mark Attendance page
    // ========================================================

    return await respondAfterAttendanceChange(req, res);


  } catch (
    err
  ) {

    console.error(
      "❌ Attendance marking error:",
      err
    );

    return sendMarkError(req, res, 500,
      "Error Found"
    );

  }

});


// Attendance History ....//


app.get("/attendance/history", async (req, res) => {


  const userId = req.session.userId;

  const semInfo = await semester.findOne({
    user: userId
  });

  if (semInfo) {

    // New subject add hone ke baad
    // past classes ko dobara sync karne ke liye

    // semInfo.lastAttendanceSyncDate = null;

    // await semInfo.save();


    // Automatic missed attendance sync
    await markMissedAttendance(
      userId,
      semInfo
    );

    console.log(
      "🔥 markMissedAttendance CALLED"
    );

  }

  const history = await dailyMark.find({
     user: req.session.userId
    })
    .sort({date: -1 })
    .limit(30);

  //   const absentRecords = await dailyMark.find({
  //   user: req.session.userId,
  //   status: "absent"
  // })
  // .sort({ date: -1 })
  // .limit(10);

  // console.log("Latest History:", history);

  // console.log("Latest Absent:", absentRecords);
  

  res.render("attendance/history.ejs", {attendanceHistory: history});

  // console.log("AttendanceHistory : ", history);
});



// attendance history edit page...//

app.get("/attendance/history/:id/edit", async (req, res) => {

  const {id} = req.params;
  // console.log(id);

  const record = await dailyMark.findOne({
    _id: id,
    user: req.session.userId
  });

  // console.log(record);
  // console.log(record._id);

  if(!record){
    return res.send("Record Not Found");
  }

  res.render("attendance/edit_history.ejs", {record});

});

//post request for attendance history edit page...//

app.post("/attendance/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const record = await dailyMark.findOne({
      _id: id,
      user: req.session.userId
    });

    if (!record) {
      return res.status(404).send("Attendance record not found");
    }

    record.status = status;

    await record.save();

    res.redirect(`/attendance/history/${id}/edit?updated=true`);

  } catch (err) {
    console.error("Past attendance update error:", err);
    res.status(500).send("Server Error");
  }
});



app.get("/pyq", (req, res) => {
  res.render("pyq/pyq_index.ejs");
});

const PORT = process.env.PORT || 9010;

app.listen(PORT, () => {
  console.log(`app is listen on port ${PORT}`);
});     

     

