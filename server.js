require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const OpenAI = require("openai");
const { google } = require("googleapis");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = process.env.PORT || 8080;
const userTokens = new Map();

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

app.get("/auth/google", (req, res) => {
  const { sessionId } = req.query;
  const oauth2Client = getOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/drive.file",
    ],
    state: sessionId || "no-session",
    prompt: "consent",
  });
  res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  const { code, state: sessionId } = req.query;
  try {
    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    userTokens.set(sessionId, tokens);
    res.send(`<html><body><script>
      window.opener && window.opener.postMessage({ type: 'google_auth_success' }, '*');
      window.close();
    </script><p>התחברת בהצלחה! סגור חלון זה.</p></body></html>`);
  } catch (err) {
    res.send("<html><body><p>שגיאה: " + err.message + "</p></body></html>");
  }
});

app.get("/auth/status", (req, res) => {
  const { sessionId } = req.query;
  res.json({ authenticated: userTokens.has(sessionId) });
});

app.get("/api/get-key", (req, res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "No API key" });
  res.json({ key: process.env.OPENAI_API_KEY });
});

// ─── Summarize ────────────────────────────────────────────────────────────────
app.post("/api/summarize", async (req, res) => {
  const { transcript, currentOutline, isFinal, courseName: manualCourse, lessonNum: manualLesson } = req.body;
  if (!transcript || !transcript.trim()) return res.status(400).json({ error: "transcript required" });

  try {
    const isFinalSummary = isFinal;
    const SUMMARY_PROMPT = `אתה עוזר אקדמי מומחה שמסכם הרצאות אקדמיות בעברית.
${manualCourse ? `שם הקורס: "${manualCourse}"` : "זהה את שם הקורס מהדיבור."}
${manualLesson ? `מספר השיעור: ${manualLesson}` : "זהה מספר שיעור מהדיבור אם אפשר."}

${isFinalSummary ? `זהו הסיכום הסופי של כל ההרצאה. עליך:
1. לתקן טעויות כתיב ודקדוק בתמלול
2. לסדר ולנקות את התוכן (להסיר גמגומים, חזרות מיותרות)
3. לארגן את החומר בצורה לוגית ומקצועית
4. להעשיר עם מידע רלוונטי מהידע הכללי שלך על כל נושא שהוזכר
5. לכתוב סיכום מקיף ומפורט` : `סכם את החלק הנוכחי בקצרה.`}

החזר JSON בלבד ללא markdown:
{
  "course_name": "שם הקורס",
  "lesson_number": 1,
  "lesson_date": "תאריך אם הוזכר",
  "lecture_title": "כותרת השיעור",
  "quick_summary": "סיכום מקיף של 5-8 שורות המתאר את כל עיקרי השיעור בצורה ברורה",
  "topics": [{"title": "נושא ראשי", "subtopics": [{"title": "תת-נושא", "bullets": ["נקודה מפורטת 1", "נקודה מפורטת 2"], "examples": ["דוגמה"], "enrichment": "הרחבה ומידע נוסף מהידע הכללי"}]}],
  "definitions": [{"term": "מושג", "meaning": "הגדרה מלאה ומדויקת", "enrichment": "הקשר ומידע נוסף"}],
  "cases_or_laws": [{"name": "שם פסק דין / חוק", "context": "הקשר ומשמעות", "enrichment": "מידע נוסף חשוב"}],
  "exam_questions": [{"question": "שאלה אפשרית לבחינה", "hint": "רמז לתשובה"}]
}`;

    const userMsg = (currentOutline ? "outline קיים:\n" + JSON.stringify(currentOutline) + "\n\n" : "") +
      "transcript:\n" + transcript +
      (isFinal ? "\n\n[סוף ההרצאה - צור סיכום מלא ומפורט]" : "");

    const response = await openai.chat.completions.create({
      model: process.env.SUMMARY_MODEL || "gpt-4o",
      messages: [{ role: "system", content: SUMMARY_PROMPT }, { role: "user", content: userMsg }],
      temperature: 0.3,
      response_format: { type: "json_object" },
    });

    const outline = JSON.parse(response.choices[0].message.content);
    res.json({ outline });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Google Drive helpers ─────────────────────────────────────────────────────
async function getOrCreateFolder(drive, folderName, parentId) {
  const q = parentId
    ? `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
    : `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const list = await drive.files.list({ q, fields: "files(id)" });
  if (list.data.files.length > 0) return list.data.files[0].id;
  const folder = await drive.files.create({
    requestBody: { name: folderName, mimeType: "application/vnd.google-apps.folder", ...(parentId ? { parents: [parentId] } : {}) },
    fields: "id",
  });
  return folder.data.id;
}

// מצא קובץ קיים של הקורס
async function findCourseDoc(drive, courseName, folderId) {
  const q = `name='${courseName}' and mimeType='application/vnd.google-apps.document' and '${folderId}' in parents and trashed=false`;
  const list = await drive.files.list({ q, fields: "files(id, name)" });
  if (list.data.files.length > 0) return list.data.files[0].id;
  return null;
}

// ספור שיעורים קיימים במסמך
async function countExistingLessons(docs, docId) {
  try {
    const doc = await docs.documents.get({ documentId: docId });
    const text = doc.data.body.content
      .filter(e => e.paragraph)
      .map(e => e.paragraph.elements.map(el => el.textRun ? el.textRun.content : "").join(""))
      .join("");
    const matches = text.match(/═══ שיעור \d+/g);
    return matches ? matches.length : 0;
  } catch (e) { return 0; }
}

// מצא את האינדקס הנכון להכנסת שיעור לפי מספר (סדר כרונולוגי)
async function findInsertIndex(docs, docId, lessonNum) {
  try {
    const doc = await docs.documents.get({ documentId: docId });
    const content = doc.data.body.content;
    let lastIndex = 1;
    
    for (const element of content) {
      if (!element.paragraph) continue;
      const text = element.paragraph.elements
        .map(el => el.textRun ? el.textRun.content : "").join("");
      
      // מצא כותרות שיעור עם מספר גדול יותר
      const match = text.match(/═══ שיעור (\d+)/);
      if (match) {
        const existingNum = parseInt(match[1]);
        if (existingNum > lessonNum) {
          // הכנס לפני שיעור זה
          return element.startIndex || lastIndex;
        }
      }
      if (element.endIndex) lastIndex = element.endIndex;
    }
    return lastIndex; // הכנס בסוף
  } catch (e) { return 1; }
}

// בנה requests לתוכן שיעור
function buildLessonRequests(outline, lessonNum, lessonDate, insertAt) {
  const requests = [];
  let idx = insertAt;

  const ins = (text, style) => {
    requests.push({ insertText: { location: { index: idx }, text } });
    if (style) {
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: idx, endIndex: idx + text.length },
          paragraphStyle: { namedStyleType: style },
          fields: "namedStyleType",
        },
      });
    }
    idx += text.length;
  };

  const bold = (text) => {
    requests.push({ insertText: { location: { index: idx }, text } });
    requests.push({ updateTextStyle: { range: { startIndex: idx, endIndex: idx + text.length }, textStyle: { bold: true }, fields: "bold" } });
    idx += text.length;
  };

  const italic = (text) => {
    requests.push({ insertText: { location: { index: idx }, text } });
    requests.push({ updateTextStyle: { range: { startIndex: idx, endIndex: idx + text.length }, textStyle: { italic: true }, fields: "italic" } });
    idx += text.length;
  };

  // מפריד שיעור
  ins(`\n\n═══════════════════════════════════════\n`, null);
  ins(`שיעור ${lessonNum}`, "HEADING_1");
  ins(` | ${lessonDate}\n`, null);
  if (outline.lecture_title) ins(`${outline.lecture_title}\n`, "HEADING_2");

  if (outline.quick_summary) {
    ins("\n📋 סיכום מהיר\n", "HEADING_2");
    ins(outline.quick_summary + "\n\n", null);
  }

  if (outline.topics && outline.topics.length > 0) {
    ins("\n📚 נושאים\n", "HEADING_2");
    outline.topics.forEach(topic => {
      ins(`\n${topic.title}\n`, "HEADING_3");
      if (topic.subtopics) {
        topic.subtopics.forEach(sub => {
          ins(`  • ${sub.title}\n`, null);
          if (sub.bullets) sub.bullets.forEach(b => ins(`      – ${b}\n`, null));
          if (sub.examples && sub.examples.length > 0) ins(`      📌 דוגמה: ${sub.examples.join(", ")}\n`, null);
          if (sub.enrichment) { ins(`      💡 הרחבה: `, null); italic(sub.enrichment + "\n"); }
        });
      }
    });
  }

  if (outline.definitions && outline.definitions.length > 0) {
    ins("\n\n📖 מושגים והגדרות\n", "HEADING_2");
    outline.definitions.forEach(d => {
      bold(`${d.term}: `);
      ins(`${d.meaning}\n`, null);
      if (d.enrichment) { ins(`   💡 `, null); italic(d.enrichment + "\n"); }
    });
  }

  if (outline.cases_or_laws && outline.cases_or_laws.length > 0) {
    ins("\n\n⚖️ פסקי דין וחוקים\n", "HEADING_2");
    outline.cases_or_laws.forEach(c => {
      bold(`${c.name}\n`);
      ins(`${c.context}\n`, null);
      if (c.enrichment) { ins(`💡 `, null); italic(c.enrichment + "\n"); }
      ins("\n", null);
    });
  }

  if (outline.exam_questions && outline.exam_questions.length > 0) {
    ins("\n\n❓ שאלות לבחינה\n", "HEADING_2");
    outline.exam_questions.forEach((q, i) => {
      ins(`${i + 1}. ${q.question}\n`, null);
      if (q.hint) ins(`   💡 רמז: ${q.hint}\n`, null);
    });
  }

  ins("\n", null);
  return requests;
}

// ─── Create / Update Doc ──────────────────────────────────────────────────────
app.post("/api/create-doc", async (req, res) => {
  const { sessionId, outline, lessonNum: manualLessonNum, lessonDate: manualDate } = req.body;
  if (!userTokens.has(sessionId)) return res.status(401).json({ error: "לא מחובר ל-Google" });

  try {
    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials(userTokens.get(sessionId));
    const docs = google.docs({ version: "v1", auth: oauth2Client });
    const drive = google.drive({ version: "v3", auth: oauth2Client });

    const courseName = (outline && outline.course_name) || "כללי";
    const lessonDate = manualDate || (outline && outline.lesson_date) || new Date().toLocaleDateString("he-IL");

    // תיקיית שורש + קורס
    const rootId = await getOrCreateFolder(drive, "📚 סוכן שיעורים", null);
    const courseId = await getOrCreateFolder(drive, courseName, rootId);

    // חפש קובץ קיים לקורס זה
    let docId = await findCourseDoc(drive, courseName, courseId);
    let isNewDoc = false;

    if (!docId) {
      // צור קובץ חדש
      const createRes = await docs.documents.create({ requestBody: { title: courseName } });
      docId = createRes.data.documentId;
      await drive.files.update({ fileId: docId, addParents: courseId, removeParents: "root", fields: "id" });
      isNewDoc = true;
    }

    // מספר שיעור
    let lessonNum = parseInt(manualLessonNum) || (outline && outline.lesson_number);
    if (!lessonNum) {
      const count = await countExistingLessons(docs, docId);
      lessonNum = count + 1;
    }

    // מצא מיקום נכון להכנסה (סדר כרונולוגי)
    const insertAt = isNewDoc ? 1 : await findInsertIndex(docs, docId, lessonNum);

    // הוסף תוכן
    const requests = buildLessonRequests(outline, lessonNum, lessonDate, insertAt);
    if (requests.length > 0) {
      await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests } });
    }

    const docUrl = "https://docs.google.com/document/d/" + docId + "/edit";
    res.json({ docUrl, docId, courseName, lessonNum, isNewDoc });
  } catch (err) {
    console.error("create-doc error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

server.listen(PORT, () => {
  console.log("🚀 Server on port " + PORT);
  console.log("🔑 OpenAI: " + (process.env.OPENAI_API_KEY ? "✓" : "MISSING"));
  console.log("🔑 Google: " + (process.env.GOOGLE_CLIENT_ID ? "✓" : "MISSING"));
});
