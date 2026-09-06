
## FitPose AI Coach — OpenAI setup

The AI Coach is a server-side OpenAI integration. The browser never receives the OpenAI API key.

### 1. Backend environment

Create/edit `backend/.env`:

```dotenv
FIRESTORE_PROJECT_ID=your-gcp-project-id
GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\service-account.json
SESSION_SECRET=your-long-random-secret
OPENAI_API_KEY=your-openai-api-key
OPENAI_MODEL=gpt-5.6-luna
```

The OpenAI key must be in `backend/.env`, **not** the frontend `.env`.

### 2. Install dependencies

From the FitPose project directory:

```powershell
python -m pip install -r backend/requirements.txt
npm install
```

### 3. Start both servers

Terminal 1:

```powershell
python backend/app.py
```

Terminal 2:

```powershell
npm run dev
```

Open the Vite URL shown by the terminal.

### 4. Verify the AI backend

Open:

`http://localhost:5000/health`

The JSON should show:

```json
"aiCoach": {
  "available": true,
  "configured": true,
  "model": "gpt-5.6-luna"
}
```

If `configured` is false, the backend did not receive `OPENAI_API_KEY`.

### What the AI Coach can do

FitPose AI uses the full conversation history, the real FitPose exercise catalog, and available FitPose progress context. It can answer naturally about:

- physiotherapy-informed movement and mobility
- posture and exercise form
- exercise technique
- workout/routine planning
- recovery guidance
- FitPose progress and streaks when that data exists

For pain/injury conversations it follows a conservative safety flow and asks for symptom duration before creating a recovery plan when appropriate. It only schedules exercises that actually exist in the FitPose exercise catalog.

### Security

Never commit `backend/.env`, an OpenAI API key, or a Google service-account JSON key to Git. Rotate any API key that has been exposed in source, chat, screenshots, logs, or a repository.
