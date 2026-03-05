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
const fs = require("fs");
const pubDir = path.join(__dirname, "public");
const pubNested = path.join(__dirname, "public", "index.html");
if (fs.existsSync(pubNested) && fs.statSync(pubNested).isDirectory()) {
  app.use(express.static(pubNested));
} else {
  app.use(express.static(pubDir));
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = process.env.PORT || 8080;

// ─── Session store (simple in-memory) ───────────────────────────────────────
const sessions = new Map();       // sessionId → session data
const userTokens = new Map();     // sessionId → Google OAuth tokens

// ─── Google OAuth setup ──────────────────────────────────────────────────────
function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// שלב 1: הפנה ל-Google Login
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

// שלב 2: קבל token אחרי login
app.get("/auth/google/callback", async (req, res) => {
  const { code, state: sessionId } = req.query;
  try {
    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    userTokens.set(sessionId, tokens);

    // סגור חלון ועדכן את ה-app
    res.send(`
      <html><body>
        <script>
          window.opener?.postMessage({ type: "google_auth_success" }, "*");
          window.close();
        </script>
        <p>✅ התחברת בהצלחה! אפשר לסגור חלון זה.</p>
      </body></html>
    `);
  } catch (err) {
    res.send(`<html><body><p>❌ שגיאה: ${err.message}</p></body></html>`);
  }
});

// בדיקת סטטוס auth
app.get("/auth/status", (req, res) => {
  const { sessionId } = req.query;
  res.json({ authenticated: userTokens.has(sessionId) });
});

// ─── Google Docs: יצירת מסמך עם הסיכום ─────────────────────────────────────
app.post("/api/create-doc", async (req, res) => {
  const { sessionId, outline, transcript } = req.body;

  if (!userTokens.has(sessionId)) {
    return res.status(401).json({ error: "לא מחובר ל-Google" });
  }

  try {
    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials(userTokens.get(sessionId));
    const docs = google.docs({ version: "v1", auth: oauth2Client });

    const title = outline?.lecture_title || `סיכום שיעור – ${new Date().toLocaleDateString("he-IL")}`;

    // צור מסמך ריק
    const createRes = await docs.documents.create({ requestBody: { title } });
    const docId = createRes.data.documentId;

    // בנה את תוכן המסמך
    const requests = buildDocRequests(outline, transcript);

    if (requests.length > 0) {
      await docs.documents.batchUpdate({
        documentId: docId,
        requestBody: { requests },
      });
    }

    const docUrl = `https://docs.google.com/document/d/${docId}/edit`;
    res.json({ docUrl, docId });
  } catch (err) {
    console.error("Docs error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

function buildDocRequests(outline, transcript) {
  const requests = [];
  let insertIndex = 1;

  const insertText = (text, index) => {
    requests.push({ insertText: { location: { index }, text } });
    return text.length;
  };

  const styleRange = (startIndex, endIndex, namedStyleType, bold = false, fontSize = null) => {
    const req = {
      updateParagraphStyle: {
        range: { startIndex, endIndex },
        paragraphStyle: { namedStyleType },
        fields: "namedStyleType",
      },
    };
    requests.push(req);
    if (bold || fontSize) {
      requests.push({
        updateTextStyle: {
          range: { startIndex, endIndex },
          textStyle: {
            ...(bold ? { bold: true } : {}),
            ...(fontSize ? { fontSize: { magnitude: fontSize, unit: "PT" } } : {}),
          },
          fields: [bold ? "bold" : "", fontSize ? "fontSize" : ""].filter(Boolean).join(","),
        },
      });
    }
  };

  // כותרת ראשית
  const titleText = (outline?.lecture_title || "סיכום שיעור") + "\n";
  const titleLen = insertText(titleText, insertIndex);
  styleRange(insertIndex, insertIndex + titleLen - 1, "HEADING_1");
  insertIndex += titleLen;

  // תאריך
  if (outline?.date) {
    const dateText = `תאריך: ${outline.date}\n\n`;
    insertText(dateText, insertIndex);
    insertIndex += dateText.length;
  }

  // נושאים
  if (outline?.topics?.length > 0) {
    const hdr = "נושאים מרכזיים\n";
    const hdrLen = insertText(hdr, insertIndex);
    styleRange(insertIndex, insertIndex + hdrLen - 1, "HEADING_2");
    insertIndex += hdrLen;

    outline.topics.forEach((topic, i) => {
      const topicText = `${i + 1}. ${topic.title}\n`;
      const tLen = insertText(topicText, insertIndex);
      styleRange(insertIndex, insertIndex + tLen - 1, "HEADING_3");
      insertIndex += tLen;

      topic.subtopics?.forEach((sub) => {
        const subText = `${sub.title}\n`;
        const sLen = insertText(subText, insertIndex);
        styleRange(insertIndex, insertIndex + sLen - 1, "HEADING_4");
        insertIndex += sLen;

        sub.bullets?.forEach((b) => {
          const bText = `• ${b}\n`;
          insertText(bText, insertIndex);
          insertIndex += bText.length;
        });

        if (sub.examples?.length > 0) {
          const exHdr = "דוגמאות:\n";
          insertText(exHdr, insertIndex);
          insertIndex += exHdr.length;
          sub.examples.forEach((e) => {
            const eText = `   💡 ${e}\n`;
            insertText(eText, insertIndex);
            insertIndex += eText.length;
          });
        }
      });
      insertText("\n", insertIndex);
      insertIndex += 1;
    });
  }

  // הגדרות
  if (outline?.definitions?.length > 0) {
    const hdr = "מושגים והגדרות\n";
    const hdrLen = insertText(hdr, insertIndex);
    styleRange(insertIndex, insertIndex + hdrLen - 1, "HEADING_2");
    insertIndex += hdrLen;

    outline.definitions.forEach((def) => {
      const t = `${def.term}: ${def.meaning}\n`;
      insertText(t, insertIndex);
      insertIndex += t.length;
    });
    insertText("\n", insertIndex);
    insertIndex += 1;
  }

  // פסקי דין / חוקים
  if (outline?.cases_or_laws?.length > 0) {
    const hdr = "פסקי דין, חוקים וסעיפים\n";
    const hdrLen = insertText(hdr, insertIndex);
    styleRange(insertIndex, insertIndex + hdrLen - 1, "HEADING_2");
    insertIndex += hdrLen;

    outline.cases_or_laws.forEach((item) => {
      const nameText = `${item.name}\n`;
      const nLen = insertText(nameText, insertIndex);
      styleRange(insertIndex, insertIndex + nLen - 1, "HEADING_3");
      insertIndex += nLen;

      const ctxText = `${item.context}\n\n`;
      insertText(ctxText, insertIndex);
      insertIndex += ctxText.length;
    });
  }

  // שאלות לבחינה
  if (outline?.exam_questions?.length > 0) {
    const hdr = "שאלות פוטנציאליות לבחינה\n";
    const hdrLen = insertText(hdr, insertIndex);
    styleRange(insertIndex, insertIndex + hdrLen - 1, "HEADING_2");
    insertIndex += hdrLen;

    outline.exam_questions.forEach((q, i) => {
      const qText = `${i + 1}. ${q}\n`;
      insertText(qText, insertIndex);
      insertIndex += qText.length;
    });
    insertText("\n", insertIndex);
    insertIndex += 1;
  }

  // תמלול גולמי (מקופל)
  if (transcript) {
    const hdr = "תמלול מלא\n";
    const hdrLen = insertText(hdr, insertIndex);
    styleRange(insertIndex, insertIndex + hdrLen - 1, "HEADING_2");
    insertIndex += hdrLen;

    const tText = transcript + "\n";
    insertText(tText, insertIndex);
    insertIndex += tText.length;
  }

  return requests;
}

// ─── Summarize endpoint ──────────────────────────────────────────────────────
const SUMMARY_PROMPT = `אתה עוזר אקדמי שמסכם הרצאות בעברית. קבל transcript וצור/עדכן outline מסודר.

חוקים קפדניים:
1. אל תמציא מידע שלא נאמר
2. אם לא ברור – סמן [לא ברור]
3. זהה פסקי דין, חוקים, סעיפים → cases_or_laws
4. זהה הגדרות ומושגים → definitions
5. הצע שאלות בחינה פוטנציאליות

החזר JSON בלבד (ללא markdown):
{
  "lecture_title": "שם השיעור אם ידוע",
  "date": "YYYY-MM-DD",
  "topics": [{"title":"...","subtopics":[{"title":"...","bullets":["..."],"examples":["..."]}]}],
  "definitions": [{"term":"...","meaning":"..."}],
  "cases_or_laws": [{"name":"...","context":"..."}],
  "exam_questions": ["..."]
}`;

app.post("/api/summarize", async (req, res) => {
  const { transcript, currentOutline, isFinal } = req.body;
  if (!transcript?.trim()) return res.status(400).json({ error: "transcript required" });

  try {
    const userMsg = [
      currentOutline ? `outline קיים:\n${JSON.stringify(currentOutline, null, 2)}\n\n` : "",
      `transcript חדש:\n${transcript}`,
      isFinal ? "\n\n[זהו סוף ההרצאה – צור סיכום מלא ומסודר]" : "",
    ].join("");

    const response = await openai.chat.completions.create({
      model: process.env.SUMMARY_MODEL || "gpt-4o",
      messages: [
        { role: "system", content: SUMMARY_PROMPT },
        { role: "user", content: userMsg },
      ],
      temperature: 0.3,
      response_format: { type: "json_object" },
    });

    const outline = JSON.parse(response.choices[0].message.content);
    res.json({ outline });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Safe API key pass-through (key never stored on client) ──────────────────
app.get("/api/get-key", (req, res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "No API key" });
  res.json({ key: process.env.OPENAI_API_KEY });
});

// ─── Health check ────────────────────────────────────────────────────────────
app.get("/health", (req, res) =>
  res.json({ status: "ok", timestamp: new Date().toISOString() })
);

// ─── Serve frontend for all other routes ─────────────────────────────────────
app.get("*", (req, res) =>
  const htmlPath = fs.existsSync(path.join(__dirname,"public","index.html","index.html")) ? path.join(__dirname,"public","index.html","index.html") : path.join(__dirname,"public","index.html"); res.sendFile(htmlPath)
);

server.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  console.log(`🔑 OpenAI: ${process.env.OPENAI_API_KEY ? "✓" : "✗ MISSING"}`);
  console.log(`🔑 Google: ${process.env.GOOGLE_CLIENT_ID ? "✓" : "✗ MISSING"}`);
});
