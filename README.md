# Conscious

A personal assistant for your daily life, not your work, that feels more like a friend than a coworker. It remembers you and the people in your life, nudges you before your sister's birthday, asks how the interview went, and handles reminders, plans, errands and things to look up. Long jobs run in the background while it keeps talking to you.

You text it on WhatsApp or iMessage, or chat with it in its own phone app.

Conscious is open source and built in Europe. You run it yourself, on your own machine or server, with the model you choose: Mistral, Claude, GPT, or a local one through Ollama. Your memory, accounts and plugins stay on your install.

## How the agent works

```
  WhatsApp / iMessage (Photon)   phone app   terminal
                 │                   │           │
                 └─────────┬─────────┴───────────┘
                           ▼
                     Orchestrator ── memory, reminders, capabilities
                      │        │
          background  │        │  tools
                      ▼        ▼
       sub-agents (up to 5 lanes)    skills · MCP · Composio · plugins
                      │                      │
                      ▼                      ▼
              user's computer (E2B)       Vault (secrets)
```

- **Orchestrator.** One agent per user, the one you chat with. It runs on [`pi-agent-core`](https://github.com/earendil-works/pi), answers one message at a time, and loads only the tools that user can use. The same loop runs every sub-agent.
- **One way to talk.** Every agent, the one you chat with, a job's or a check's, reaches you only through one tool, `chat_send_message`, each message the moment it is ready. What it writes outside the tool stays private: you get its messages, never its thinking.
- **Sub-agents made for each job.** For a long job ("find me a ticket to Lisbon") the orchestrator writes a harness for it: a method, the tools it needs, a time budget (10, 30 or 60 minutes) and up to five parts that run side by side, merged by a last agent. It answers you at once and you keep chatting. The job can text you a first find, takes a change of plan while it runs ("only morning flights"), and sends the result as a normal message. Jobs survive a restart.
- **Agents that rest.** When a job ends, its agent is kept as a folder: its method, a notebook of what it learned, and a log of its jobs. The next job of the same kind ("a flight to Tokyo") wakes it with its notes. Nothing runs while it sleeps.
- **Memory.** Facts about you and the people in your life, with birthdays, kept apart from the chat and read into every prompt. You can see and delete any line.
- **Reminders and checks.** One-off or recurring, in your timezone. A scheduled check is a reminder with a job: an agent runs it and messages you only if it finds something. What Conscious sends on its own waits out the night and stops at a few a day.
- **A computer of its own.** Each user gets an [E2B](https://e2b.dev) sandbox for files, a shell, memory and its agents, and optionally a second one with a real Chrome. It pauses when idle and holds no secrets. E2B is open source, so you can run it in Europe or on your own hardware.
- **Skills.** Instructions for jobs that come up often (weather, price watches, PDFs, inbox triage), in the [AgentSkills](https://agentskills.io) format. Bundled ones are copied into each computer; the agent also writes its own.
- **Connectors.** Google, Spotify, any IMAP mailbox, [Shop](https://shop.dev) for shopping across millions of online stores, hosted MCP servers (Todoist, Strava, Kiwi.com flights, trivago) and, optionally, Composio for more everyday apps. Work apps are left out on purpose. For anything else, the agent writes a plugin that runs in a sandbox and reaches only the hosts it declares.
- **Vault.** Secrets never pass through the chat or the model. Conscious sends a private link, you paste a key or sign in there, and it is stored encrypted on your install and added to requests by the host.
- **Safety in code.** Every tool is `read`, `draft` or `commit`. Commits (send, book, pay, delete) are blocked until you say yes.

More: [`docs/architecture.md`](docs/architecture.md).

## Run it

Needs Node >= 22.19.

```bash
pnpm install
cp .env.example .env    # pick a model and set its API key
pnpm chat               # terminal; `pnpm photon` for WhatsApp and iMessage, `pnpm app` for the phone app
```

Models, Photon, the phone app, the computer, the browser, sign-ins and hosting: [`docs/setup.md`](docs/setup.md).

## Contribute

Issues and pull requests are welcome: see [`CONTRIBUTING.md`](CONTRIBUTING.md). To add a plugin for everyone who runs Conscious, open a pull request with its folder in `plugins/` (see [`plugins/README.md`](plugins/README.md)). Report security issues privately, as [`SECURITY.md`](SECURITY.md) says.

## License

[MIT](LICENSE). Most bundled skills and the MCP manifests are adapted from [Hermes Agent](https://github.com/NousResearch/hermes-agent) and [OpenClaw](https://github.com/openclaw/openclaw), under their own licenses: see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
