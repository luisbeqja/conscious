# Conscious

A personal assistant for your life, not your job: reminders, plans, errands, things to look up. It keeps talking while longer jobs run in the background, and tells you when they are done. You text it on iMessage or WhatsApp through [Photon](https://photon.codes), or chat with it in the terminal.

Conscious is open source and built in Europe. You run it yourself, on your own machine or server, with the model you choose: a hosted one such as Mistral, Claude or GPT, or a local one through Ollama. Your accounts and plugins stay on your install. With a computer (below), memory and conversations live in an E2B sandbox that you can also run yourself.

The agent loop is [`pi-agent-core`](https://github.com/earendil-works/pi). Design: [`docs/architecture.md`](docs/architecture.md).

## Chat with it

Needs Node >= 22.19.

```bash
pnpm install
cp .env.example .env        # pick a model and set its API key
pnpm chat
```

```
you remind me to call mum tomorrow at 9
conscious [reminders_create_reminder] Done: tomorrow at 9:00 I'll nudge you to call mum 📞
```

Reminders and finished background tasks print on their own, above the prompt. Commands: `/reminders`, `/tasks`, `/reset` (forget the conversation), `/exit`. Without a computer (below) everything lives in memory, so quitting forgets it all.

## Choose your model

Set `CONSCIOUS_MODEL_PROVIDER` and `CONSCIOUS_MODEL` in `.env`. Every provider in [pi-ai](https://github.com/earendil-works/pi) works, with its usual API key variable:

| You want | Provider | Model, for example | Key |
|---|---|---|---|
| Mistral (Paris) | `mistral` | `mistral-large-latest` | `MISTRAL_API_KEY` |
| Claude | `anthropic` | `claude-sonnet-5` | `ANTHROPIC_API_KEY` |
| GPT | `openai` | the model id | `OPENAI_API_KEY` |
| Many models, one key | `openrouter` | the model id | `OPENROUTER_API_KEY` |
| A model on your own machine | `local` | e.g. `qwen3:8b` | none; set `CONSCIOUS_MODEL_BASE_URL` |

`local` is any server that speaks the OpenAI chat API: Ollama (`http://localhost:11434/v1`), LM Studio, vLLM. Conscious leans on tool calls, so pick a model that handles them well. A wrong provider or model id stops Conscious at start, with the ids it knows.

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

## Skills

Skills are instructions for jobs that come up often, in the [AgentSkills](https://agentskills.io) format. They live on the user's computer, in `skills/`: the repo's [`skills/`](skills/) folder is copied in when a computer starts, next to the skills the agent wrote for that user. The system prompt lists the ones that can run there, and the agent reads a skill's `SKILL.md` before it uses it.

22 ship today:

| Area | Skills |
| --- | --- |
| Search | `duckduckgo-search`, `reddit-reading`, `youtube-content`, `blocked-page-recovery`, `rss-feeds` |
| Watching | `product-price-monitor`, `watchers`, `stocks` |
| Daily life | `weather`, `maps`, `fitness-nutrition` |
| Planning | `weekly-review-planning`, `decision-questionnaire`, `one-three-one-rule`, `social-media-content-calendar`, `llm-wiki` |
| Documents | `pdf`, `docx`, `xlsx`, `powerpoint`, `document-to-action-items` |
| Agent | `skill-creator` |

Skills that fetch from the web show up only with `CONSCIOUS_SANDBOX_INTERNET=true`. Watching skills check when the user asks; checks on a schedule come later. To copy another one at a pinned commit:

```bash
pnpm skills:import https://github.com/<owner>/<repo> skills/<name> --commit <sha> --internet
```

The agent also saves its own skills after work worth repeating (`skills_save_skill`), and keeps every earlier version so a change can be undone.

## MCP servers

Conscious connects to vendor-hosted MCP servers listed in [`mcp/`](mcp/), from the host, and offers their tools like any capability. By default that is Kiwi.com flights and trivago hotels, which need no account; set `CONSCIOUS_MCP_SERVERS` to choose (`alltrails`, or `none`). A tool that is not marked read-only waits for your yes. Servers that need a sign-in come with OAuth on the Vault page.

## Plugins

Ask Conscious about an app it has no capability for and it installs a plugin that ships with Conscious, or writes one itself. A plugin it writes stays on your install. Plugins run in a sandbox and reach only the hosts they declare. See [Plugins](docs/architecture.md#plugins).

Ask "anything new on GitHub?". Conscious installs the GitHub plugin and sends you a **Vault** link: a private page where you paste a GitHub token. It checks the token with GitHub, saves it encrypted, and tells you in the chat when you are connected. Secrets never pass through the chat or the model.

For a service with no built-in connection, Conscious reads the service's API docs and defines the connection in the plugin it writes. The Vault page then shows exactly which hosts your key will go to, and says that Conscious wrote this connection itself. Your key only ever goes to those hosts. Sign-in by redirect (OAuth, open banking) is not supported yet.

The Vault page runs on `CONSCIOUS_VAULT_PORT` (8787). In the terminal, `http://localhost:8787` works. For a phone, set `CONSCIOUS_PUBLIC_URL` to an https tunnel to that port.

Connected accounts, plugins (including ones the agent wrote) and installs are saved in `.conscious/` on the host and survive a restart.

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
│  └─ models.ts          the model you chose: any pi-ai provider, or a local server
├─ agents/               background sub-agents: spawn, list, cancel, report back
├─ scheduler/            reminders: one-off and cron, in your timezone
├─ sandbox/              each user's computer: the Sandbox seam, the E2B backend, memory
├─ capabilities/         one folder per pack: capability.ts + SKILL.md
│  ├─ reminders/
│  ├─ background/
│  ├─ computer/          shell and files in the user's sandbox
│  ├─ skills/            the agent saves its own skills, with undo
│  ├─ plugins/           search, install and write plugins
│  └─ vault/             connect and disconnect accounts through Vault links
├─ skills/               the skill library: copy into the computer, list what can run, import
├─ plugins/              plugins: manifest, connectors, sandbox, broker, review, local store
├─ vault/                the user's secrets: sealed store and the Vault page
├─ mcp/                  MCP catalog and client: each server becomes a capability
├─ conversations/        one conversation per user, in memory or in their sandbox
└─ prompts/              system and background prompts as markdown
skills/                  bundled skills, copied into every computer
mcp/                     MCP server manifests, one folder per server
test/                    vitest
plugins/                 the bundled plugins, one folder per plugin
```

## Add a capability

1. Create `src/capabilities/<id>/` with `capability.ts` and `SKILL.md`.
2. Name tools `<id>_<verb>_<noun>` and set `effect` honestly: `read`, `draft` or `commit`.
3. If only some users can have it (a connected account), return `available` for them.
4. Register it in `src/capabilities/index.ts` and add a test.

## Contribute

Conscious is built in the open. To add a plugin for everyone who runs Conscious, open a pull request with its folder in `plugins/` (see [`plugins/README.md`](plugins/README.md)). A plugin your agent wrote is a good start: it already has tests.

## License

[MIT](LICENSE).
