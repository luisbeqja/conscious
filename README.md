# Conscious

A personal assistant for your life, not your job: reminders, plans, errands, things to look up. It keeps talking while longer jobs run in the background, and tells you when they are done. It will live in WhatsApp; today you chat with it in the terminal.

The agent loop is [`pi-agent-core`](https://github.com/earendil-works/pi). Design: [`docs/architecture.md`](docs/architecture.md).

## Chat with it

Needs Node >= 22.19.

```bash
pnpm install
cp .env.example .env        # set ANTHROPIC_API_KEY
pnpm chat
```

```
you remind me to call mum tomorrow at 9
conscious [reminders_create_reminder] Done: tomorrow at 9:00 I'll nudge you to call mum 📞
```

Reminders and finished background tasks print on their own, above the prompt. Commands: `/reminders`, `/tasks`, `/reset` (forget the conversation), `/exit`. Everything lives in memory, so quitting forgets it all.

```bash
pnpm test        # vitest; the engine test runs the real loop against a scripted model
pnpm typecheck
pnpm lint
pnpm build
```

## Layout

```
src/
├─ main.ts               the terminal chat
├─ create-conscious.ts   composition root: which implementation sits behind each seam
├─ config.ts             environment → typed config
├─ engine/
│  ├─ orchestrator.ts    the agent you talk to: one message at a time per user
│  ├─ run-agent.ts       one pi-agent-core loop + policy (budgets, commits held)
│  ├─ tool-adapter.ts    capability tool → pi tool
│  └─ models.ts          provider + model from pi-ai
├─ agents/               background sub-agents: spawn, list, cancel, report back
├─ scheduler/            reminders: one-off and cron, in your timezone
├─ capabilities/         one folder per pack: capability.ts + SKILL.md
│  ├─ reminders/
│  └─ background/
├─ conversations/        one conversation per user
└─ prompts/              system and background prompts as markdown
test/                    vitest
```

## Add a capability

1. Create `src/capabilities/<id>/` with `capability.ts` and `SKILL.md`.
2. Name tools `<id>_<verb>_<noun>` and set `effect` honestly: `read`, `draft` or `commit`.
3. If only some users can have it (a connected account), return `available` for them.
4. Register it in `src/capabilities/index.ts` and add a test.
