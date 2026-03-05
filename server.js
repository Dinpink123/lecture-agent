require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");
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

const sessions = new Map();
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
    res.send("<html><body><script>window.opener && window.opener.postMessage({ type: 'google_auth_success' }, '*'); window.close();</script><p>התחברת בהצלחה! סגור חלון זה.</p></body></html>");
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

app.post("/api/summarize", async (req, res) => {
  const { transcript, currentOutline, isFinal } = req.body;
  if (!transcript || !transcript.trim()) return res.status(400).json({ error: "transcript required" });

  try {
    const SUMMARY_PROMPT = "אתה עוזר אקדמי שמסכם הרצאות בעברית. החזר JSON בלבד ללא markdown:\n{\"lecture_title\":\"\",\"date\":\"\",\"topics\":[{\"title\":\"\",\"subtopics\":[{\"title\":\"\",\"bullets\":[],\"examples\":[]}]}],\"definitions\":[{\"term\":\"\",\"meaning\":\"\"}],\"cases_or_laws\":[{\"name\":\"\",\"context\":\"\"}],\"exam_questions\":[]}";

    const userMsg = (currentOutline ? "outline קיים:\n" + JSON.stringify(currentOutline) + "\n\n" : "") +
      "transcript:\n" + transcript +
      (isFinal ? "\n\n[סוף ההרצאה]" : "");

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

app.post("/api/create-doc", async (req, res) => {
  const { sessionId, outline, transcript } = req.body;
  if (!userTokens.has(sessionId)) return res.status(401).json({ error: "לא מחובר ל-Google" });

  try {
    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials(userTokens.get(sessionId));
    const docs = google.docs({ version: "v1", auth: oauth2Client });
    const title = (outline && outline.lecture_title) || "סיכום שיעור - " + new Date().toLocaleDateString("he-IL");
    const createRes = await docs.documents.create({ requestBody: { title } });
    const docId = createRes.data.documentId;
    const docUrl = "https://docs.google.com/document/d/" + docId + "/edit";
    res.json({ docUrl, docId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

server.listen(PORT, () => {
  console.log("Server on port " + PORT);
  console.log("OpenAI: " + (process.env.OPENAI_API_KEY ? "OK" : "MISSING"));
  console.log("Google: " + (process.env.GOOGLE_CLIENT_ID ? "OK" : "MISSING"));
});
