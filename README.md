# Conscious

A personal assistant that lives in your WhatsApp. It helps with your life, not your job: reminders, plans, errands, your calendar, things to look up. It keeps talking while longer jobs run in the background, and it messages you when they are done.

The agent loop is [`pi-agent-core`](https://github.com/earendil-works/pi). Design: [`docs/architecture.md`](docs/architecture.md).

## Run it

Needs Node >= 22.19.

```bash
pnpm install
cp .env.example .env        # set ANTHROPIC_API_KEY
pnpm dev                    # http://localhost:8100
```

Without a WhatsApp number, talk to it over HTTP. Replies print in the terminal:

```bash
curl -XPOST localhost:8100/dev/messages -H 'content-type: application/json' \
  -d '{"text":"Remind me to call mum tomorrow at 9"}'
```

To use WhatsApp, fill in the `WHATSAPP_*` values from a Meta WhatsApp Cloud API app, add your number to `CONSCIOUS_ALLOWED_NUMBERS`, and point the app's webhook at `https://<host>/webhooks/whatsapp`.

```bash
pnpm test        # vitest
pnpm typecheck
pnpm lint
pnpm build
```

## Layout

```
src/
├─ main.ts               starts the server
├─ app.ts                composition root: which implementation sits behind each seam
├─ config.ts             environment → typed config
├─ channels/             where the user is talked to · whatsapp/ (webhook in, Cloud API out)
├─ engine/
│  ├─ orchestrator.ts    the agent the user talks to: one message at a time per user
│  ├─ run-agent.ts       one pi-agent-core loop + policy (budgets, commits held)
│  ├─ tool-adapter.ts    capability tool → pi tool
│  └─ models.ts          provider + model from pi-ai
├─ agents/               background sub-agents: spawn, list, cancel, report back
├─ scheduler/            reminders: one-off and cron, in the user's timezone
├─ capabilities/         one folder per pack: capability.ts + SKILL.md
│  ├─ reminders/
│  ├─ background/
│  └─ calendar/          offered only once the user connects a calendar
├─ connectors/           links to the user's own accounts (calendar first)
├─ sandbox/              the computer + browser seam (not built)
├─ conversations/        one conversation per user
└─ prompts/              system and background prompts as markdown
test/                    vitest
```

## Add a capability

1. Create `src/capabilities/<id>/` with `capability.ts` and `SKILL.md`.
2. Name tools `<id>_<verb>_<noun>` and set `effect` honestly: `read`, `draft` or `commit`.
3. If it needs one of the user's accounts, take a connector and return `available` from it.
4. Register it in `src/capabilities/index.ts` and add a test.
