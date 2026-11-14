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


## Agent task queue (v1)

The chat dashboard includes a Tasks page at `/tasks.html`. Signed-in users can submit AI reasoning, drafting, analysis, calculation, and summarization tasks; the server worker processes queued tasks and stores their status and result in Supabase. This first version does not control browsers or devices, edit repositories, or perform external actions. Review task output before using it. The worker runs inside the web-service process and is not guaranteed to run continuously on Render Free while the service is asleep.


## Autonomous task tools

The task worker can now use provider tool-calling to carry out supported work instead of only drafting instructions.

Optional Render environment variables:
- `TAVILY_API_KEY`: enables public web search.
- `GITHUB_TOKEN`: enables GitHub repository reading, file listing, isolated task branches, file changes on those branches, and draft pull requests.

Keep these credentials server-side in Render Environment. Never put them in browser code or chat messages. Use a GitHub token with the narrowest repository permissions needed (Contents: read/write; Pull requests: read/write). The agent writes only to branches named `agent/task-...`; it cannot write to the default branch, merge pull requests, deploy, delete repositories, or modify secrets/workflows/deployment configuration. Draft PRs require human review.

Tool availability is shown by the authenticated `/api/status` endpoint. Browser automation, direct Android/PC control, arbitrary shell execution, and approval workflows are not included in this increment. Render Free may sleep while idle, so scheduled work is not guaranteed to run continuously.


## Android visible UI assistance (in progress)

The Worker-owned Android app has a guarded YouTube-only visible UI flow. It asks the AI provider for a typed plan, shows that plan for approval, then uses Android Accessibility only while the approved task is active. The initial tap allowlist is limited to YouTube's Search control; it will not tap a video result or auto-play. Typing is limited to a focused visible YouTube search field.

Before testing, run `supabase/migrations/20261114000000_android_agent.sql` in addition to `schema.sql`. The server requires the existing authenticated Worker session and Supabase service-role configuration. See `android-agent/API.md` for endpoint details.

The companion APK workflow now also runs on feature branches. Device registration, browser automation, PC bridge, and new voice-command work remain out of scope. A physical-device end-to-end test is still required before this feature should be considered complete.
