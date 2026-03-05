# 🎓 סוכן שיעורים – מדריך הקמה מלא (ממש שלב אחר שלב)

## מה בנינו?

- **קישור** שתשלח בוואטסאפ
- פותחים אותו בסафארי → מקליטים מהמיקרופון
- השרת מתמלל בעברית ומסכם עם GPT-4o
- בלחיצה אחת → הסיכום נשמר ב-Google Docs שלך

---

## שלב 1: פתח חשבון ב-Railway (שרת חינמי)

1. לך ל [railway.app](https://railway.app)
2. לחץ **"Start a New Project"**
3. **"Login with GitHub"** (תצטרך חשבון GitHub – זה חינמי)
   - אם אין חשבון GitHub: [github.com/signup](https://github.com/signup)
4. אחרי כניסה – Railway ייתן לך **$5 קרדיט חינמי** (מספיק לחודשים)

---

## שלב 2: העלה את הקוד ל-GitHub

1. לך ל [github.com](https://github.com) → **"New repository"**
2. שם: `lecture-agent` → לחץ **"Create repository"**
3. פתח Terminal במחשב שלך:

```bash
cd lecture-web          # הכנס לתיקיית הפרויקט

git init
git add .
git commit -m "first commit"
git remote add origin https://github.com/YOUR_USERNAME/lecture-agent.git
git push -u origin main
```
(החלף `YOUR_USERNAME` בשם המשתמש ב-GitHub שלך)

---

## שלב 3: פרוס ב-Railway

1. ב-Railway לחץ **"New Project"** → **"Deploy from GitHub repo"**
2. בחר `lecture-agent`
3. Railway יתחיל לבנות (2-3 דקות) ✅
4. לחץ על הפרויקט → **"Settings"** → **"Generate Domain"**
   - תקבל כתובת כמו: `lecture-agent-production.up.railway.app`
   - **שמור את הכתובת הזו!**

---

## שלב 4: הוסף OpenAI API Key

1. ב-Railway לחץ על הפרויקט → **"Variables"**
2. לחץ **"New Variable"** ומלא:

| שם משתנה | ערך |
|----------|-----|
| `OPENAI_API_KEY` | `sk-proj-xxxx...` (ה-key שלך) |
| `SUMMARY_MODEL` | `gpt-4o` |
| `SUMMARY_INTERVAL_SECONDS` | `180` |
| `SESSION_SECRET` | כתוב כל מחרוזת אקראית, למשל `abc123xyz789` |

**איך מקבלים OpenAI API Key:**
1. לך ל [platform.openai.com](https://platform.openai.com)
2. הירשם / כנס
3. **API Keys** → **"Create new secret key"**
4. העתק את ה-key (מתחיל ב-`sk-`)
5. **חשוב:** טען כסף – לפחות $5 (Settings → Billing)

---

## שלב 5: הגדר Google Cloud (לשמירה ב-Docs)

### 5א. צור פרויקט ב-Google Cloud

1. לך ל [console.cloud.google.com](https://console.cloud.google.com)
2. כנס עם חשבון ה-Gmail שלך
3. למעלה → **"Select a project"** → **"New Project"**
4. שם: `lecture-agent` → **"Create"**

### 5ב. הפעל את Google Docs API

1. בתפריט שמאל → **"APIs & Services"** → **"Library"**
2. חפש **"Google Docs API"** → לחץ עליו → **"Enable"**
3. חפש **"Google Drive API"** → לחץ עליו → **"Enable"**

### 5ג. צור OAuth credentials

1. **"APIs & Services"** → **"Credentials"**
2. **"+ Create Credentials"** → **"OAuth client ID"**
3. אם שואל על "Configure consent screen":
   - **"External"** → **"Create"**
   - App name: `סוכן שיעורים`
   - User support email: האימייל שלך
   - Developer contact: האימייל שלך
   - **"Save and Continue"** × 3 → **"Back to Dashboard"**
4. חזור ל-**"Create OAuth client ID"**:
   - Application type: **"Web application"**
   - Name: `lecture-agent`
   - **"Authorized redirect URIs"** → **"+ Add URI"**:
     ```
     https://YOUR-APP.up.railway.app/auth/google/callback
     ```
     (החלף בכתובת ה-Railway שלך מסוף שלב 3)
5. לחץ **"Create"**
6. **תקבל**: Client ID ו-Client Secret → **שמור אותם!**

### 5ד. הוסף ל-Railway

חזור ל-Railway → Variables → הוסף:

| שם משתנה | ערך |
|----------|-----|
| `GOOGLE_CLIENT_ID` | ה-Client ID שקיבלת |
| `GOOGLE_CLIENT_SECRET` | ה-Client Secret שקיבלת |
| `GOOGLE_REDIRECT_URI` | `https://YOUR-APP.up.railway.app/auth/google/callback` |

Railway יעשה **redeploy אוטומטי** ✅

---

## שלב 6: שלח את הקישור בוואטסאפ

הקישור שלך הוא:
```
https://YOUR-APP.up.railway.app
```

שלח אותו לעצמך בוואטסאפ → לחץ → נפתח בסafארי → מוכן! 🎉

---

## איך משתמשים

1. **פתח הקישור** בסafארי
2. **"התחבר ל-Google Docs"** → כנס עם Gmail
3. **"התחל הקלטה"** → אשר גישה למיקרופון
4. **השאר את המסך דלוק** (חשוב!)
5. בסוף → **"עצור הקלטה"**
6. **"שמור ב-Google Docs"** → נפתח מסמך מסודר ✅

---

## פתרון בעיות

### "לא ניתן לגשת למיקרופון"
- Safari: הגדרות → Safari → מיקרופון → אפשר

### "שגיאת OpenAI"
- בדוק שיש credit בחשבון OpenAI
- בדוק שה-API key נכון ב-Railway Variables

### הסיכום לא מדויק
- עשה את ה-summarize interval גדול יותר: `SUMMARY_INTERVAL_SECONDS=300`
- דבר ברור ולא מהיר מדי

### הקישור לא עובד
- בדוק ב-Railway שה-deployment הצליח (ירוק)
- בדוק שה-domain נוצר (Settings → Domains)

---

## עלויות חודשיות (הערכה)

| שירות | עלות |
|-------|------|
| Railway | $0-5/חודש |
| OpenAI (20 שיעורים × 90 דקות) | ~$100-120 |
| Google Cloud | חינם |

---

*נבנה ע"י Claude – v2.0 (Web Edition)*
