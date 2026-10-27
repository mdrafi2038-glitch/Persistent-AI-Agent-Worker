# Persistent AI Agent Worker

A mobile-friendly, password-protected chat dashboard for Claude or an OpenAI-compatible AI gateway. Conversation history is stored in Supabase when configured.

## Important limitations

- Render Free **web services** sleep after 15 minutes without inbound traffic and can take about a minute to wake. This is a web chat app, not a guaranteed always-on worker.
- Supabase Free projects can pause after a week of low database activity.
- Without Supabase environment variables, chat history is only held in memory and will be lost on restart.
- This repository does not include API keys or passwords. Never commit secrets to GitHub.

## 1. Supabase

1. Create or select your Supabase project.
2. Open **SQL Editor**, run the contents of `schema.sql`.
3. In Project Settings → API, copy the Project URL and the service-role key.
4. Keep the service-role key only in Render environment variables. Never put it in browser code or GitHub.

## 2. AI provider

For Anthropic direct API:
- `AI_PROVIDER=anthropic`
- `ANTHROPIC_API_KEY` = your Anthropic API key
- `ANTHROPIC_MODEL` = a model enabled for your account

For an OpenAI-compatible gateway such as OmniRoute/OpenRouter:
- `AI_PROVIDER=openai-compatible`
- `AI_BASE_URL` = provider's OpenAI-compatible API base URL (without `/chat/completions`)
- `AI_API_KEY` = provider API key
- `AI_MODEL` = exact model ID supported by that gateway

Do not assume an OmniRoute dashboard URL is the API base URL; use the API endpoint shown in that provider's docs/settings.

## 3. Render deployment

1. Open Render and choose **New → Blueprint**.
2. Connect this GitHub repository: `mdrafi2038-glitch/Persistent-AI-Agent-Worker`.
3. Review the `render.yaml` service before creating it.
4. Set `APP_PASSWORD` to a strong unique password.
5. Add the AI and Supabase environment variables described above. If using a gateway, set `AI_PROVIDER=openai-compatible` and remove/ignore Anthropic key settings.
6. Deploy. Open the service URL and sign in.

## 4. Verify

- `/health` should return JSON with `ok: true`.
- The dashboard should show Supabase history enabled.
- Send a short test message and check the `chat_messages` table in Supabase.

## Environment variables

See `.env.example`. Required for secure production use: `APP_PASSWORD`, `SESSION_SECRET` (at least 32 characters), a valid AI provider configuration, and Supabase URL + service-role key for durable history.
