# Conscious

A personal assistant for your life, not your job: reminders, plans, errands, things to look up. It keeps talking while longer jobs run in the background, and tells you when they are done. You text it on iMessage or WhatsApp through [Photon](https://photon.codes), or chat with it in the terminal.

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

Reminders and finished background tasks print on their own, above the prompt. Commands: `/reminders`, `/tasks`, `/reset` (forget the conversation), `/exit`. Without a computer (below) everything lives in memory, so quitting forgets it all.

## Text it on iMessage and WhatsApp

Create a project at [app.photon.codes](https://app.photon.codes) and enable iMessage and WhatsApp in it. Then set `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET` and `CONSCIOUS_ALLOWED_USERS` (your own number) in `.env`, and:

```bash
pnpm photon
```

Text the project's number. Conscious answers only the senders on the list, and only after they have written first.

## Give it a computer

Conscious can have a computer of its own: one [E2B](https://e2b.dev) sandbox per user. Everything it knows about you lives there: its memory (`memory/MEMORY.md`, read into every conversation), the files it keeps for you (`files/`), and the conversation itself (`.conscious/conversation.json`). It also gets a shell and file tools that run there, never on your machine.

```bash
CONSCIOUS_SANDBOX=e2b
E2B_API_KEY=e2b_...
E2B_DOMAIN=            # the E2B EU cluster, or your own E2B; empty = E2B's US cloud
```

The sandbox pauses after 10 minutes without a message and resumes on the next one, so nothing runs while you are away and nothing is lost. After a restart, Conscious finds each user's sandbox again by a hash of their id; E2B never sees your phone number.

To keep data in Europe, ask E2B support for its EU cluster, or run E2B yourself: its runtime is open source ([e2b-dev/infra](https://github.com/e2b-dev/infra)) and needs a Linux host with KVM. Set `E2B_DOMAIN` to either.

No secrets go in: the sandbox starts with an empty environment, and account tokens stay on the host. Internet is off unless you set `CONSCIOUS_SANDBOX_INTERNET=true`.

## Check it

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
├─ photon.ts             iMessage and WhatsApp through Photon Spectrum
├─ channels/photon.ts    Spectrum messages → orchestrator, replies and notifications back
├─ create-conscious.ts   composition root: which implementation sits behind each seam
├─ config.ts             environment → typed config
├─ engine/
│  ├─ orchestrator.ts    the agent you talk to: one message at a time per user
│  ├─ run-agent.ts       one pi-agent-core loop + policy (budgets, commits held)
│  ├─ tool-adapter.ts    capability tool → pi tool
│  └─ models.ts          provider + model from pi-ai
├─ agents/               background sub-agents: spawn, list, cancel, report back
├─ scheduler/            reminders: one-off and cron, in your timezone
├─ sandbox/              each user's computer: the Sandbox seam, the E2B backend, memory
├─ capabilities/         one folder per pack: capability.ts + SKILL.md
│  ├─ reminders/
│  ├─ background/
│  └─ computer/          shell and files in the user's sandbox
├─ conversations/        one conversation per user, in memory or in their sandbox
└─ prompts/              system and background prompts as markdown
test/                    vitest
```

## Add a capability

1. Create `src/capabilities/<id>/` with `capability.ts` and `SKILL.md`.
2. Name tools `<id>_<verb>_<noun>` and set `effect` honestly: `read`, `draft` or `commit`.
3. If only some users can have it (a connected account), return `available` for them.
4. Register it in `src/capabilities/index.ts` and add a test.
