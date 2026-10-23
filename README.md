# Conscious

A personal assistant for your life, not your job: reminders, plans, errands, things to look up. It keeps talking while longer jobs run in the background, and tells you when they are done. You text it on iMessage or WhatsApp through [Photon](https://photon.codes), chat with it in its own phone app, or in the terminal.

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

Reminders and finished background tasks print on their own, above the prompt. Commands: `/reminders`, `/tasks`, `/reset` (forget the conversation), `/exit`.

Reminders, scheduled checks and the conversation are saved in `.conscious/`, so a restart keeps them. A one-off reminder that came due while Conscious was off is sent, marked late, when it starts again (up to 12 hours late).

A **scheduled check** is a reminder with a job: at the time, an agent does the work with all of Conscious's tools and messages you only if it finds something. "Every morning at 8, tell me if it will rain", "check the Lisbon flight daily and tell me if it drops under 120 EUR".

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

On WhatsApp, Conscious has a number of its own: a WhatsApp Business line in your Photon project. You text it from your usual WhatsApp, so your own number goes in `CONSCIOUS_ALLOWED_USERS`, not in Photon. A number that becomes a business line can no longer be used in the WhatsApp app. Set `PHOTON_PLATFORMS=whatsapp` if you only enabled WhatsApp.

Messages reach Conscious over an outgoing connection to Photon, so it runs on a laptop with no public address. A sender who is not on the list is logged, so a typo in the list is easy to find. Conscious remembers which chat each user writes from, so reminders still arrive after a restart.

WhatsApp lets a business line write freely only within 24 hours of your last message. Past that, Meta accepts only an approved message template. So reminders and checks arrive on any day, create one template in WhatsApp Manager (Message templates, category Utility) with one variable, for example:

```
Message from Conscious: {{1}} Reply to keep chatting.
```

Meta refuses a body that starts or ends with the variable. Once it is approved, set `CONSCIOUS_WHATSAPP_TEMPLATE` to its name (and `CONSCIOUS_WHATSAPP_TEMPLATE_LANGUAGE` if it is not `en`). Conscious then sends anything past the window inside it, on one line.

### Voice notes, photos and files

Send a voice note and Conscious answers what you said. It needs a transcription service: Mistral's Voxtral with `MISTRAL_API_KEY` (picked first, hosted in the EU), OpenAI with `OPENAI_API_KEY`, or your own Whisper server (whisper.cpp, Speaches) with `CONSCIOUS_TRANSCRIBE_URL`. Without one, it asks you to write instead. `CONSCIOUS_TRANSCRIBE` and `CONSCIOUS_TRANSCRIBE_MODEL` choose explicitly.

Photos go to the model when it can see them. Every file you send is saved on its computer in `files/inbox/`, where the PDF, Word and Excel skills open it, and it can send files back: a plan as a PDF, a converted spreadsheet. Without a computer, it reads small text files (CSV, plain text) and photos, and says it cannot open the rest.

## Use the phone app

`mobile/` is Conscious's own app for iPhone and Android: one chat, answers written out as they come, what it is doing while it works ("Searching the web…"), its reactions, photos both ways, and reminders that arrive while you are away. No messaging account or Meta approval is involved: the app talks straight to your Conscious.

```bash
pnpm app
```

```
Phone app on http://192.168.1.20:8788
  New access code for me: k7qd-m2xa-9wfe-c4tn
```

Then run the app (see [`mobile/README.md`](mobile/README.md)) and enter that address and code. `pnpm app` talks as `me`, the same user as `pnpm chat`.

To have the app next to WhatsApp and iMessage, set `CONSCIOUS_APP_USERS` to your own number and run `pnpm photon`: the app and your messaging chat are then one conversation. Reminders go to whichever you wrote from last. Each user listed gets an access code the first time; codes are kept in `.conscious/app-codes.json`, and deleting a line there and restarting gives that user a new one.

The app server runs on `CONSCIOUS_APP_PORT` (8788). On your home network the phone reaches it directly. Away from home, use a private network such as [Tailscale](https://tailscale.com), or an https tunnel; the code is the only lock, so do not put the port on the open internet without https.

## Give it a computer

Conscious can have a computer of its own: one [E2B](https://e2b.dev) sandbox per user. Everything it knows about you lives there: its memory (`memory/MEMORY.md`, read into every conversation), the files it keeps for you (`files/`), and the conversation itself (`.conscious/conversation.json`). It also gets a shell and file tools that run there, never on your machine.

```bash
CONSCIOUS_SANDBOX=e2b
E2B_API_KEY=e2b_...
E2B_DOMAIN=            # the E2B EU cluster, or your own E2B; empty = E2B's US cloud
```

The sandbox pauses after 10 minutes without a message and resumes on the next one, so nothing runs while you are away and nothing is lost. After a restart, Conscious finds each user's sandbox again by a hash of their id; E2B never sees your phone number.

To keep data in Europe, ask E2B support for its EU cluster, or run E2B yourself: its runtime is open source ([e2b-dev/infra](https://github.com/e2b-dev/infra)) and needs a Linux host with KVM. Set `E2B_DOMAIN` to either.

Behind an outbound proxy, Conscious sends E2B traffic through `HTTPS_PROXY`.

No secrets go in: the sandbox starts with an empty environment, and account tokens stay on the host. Internet is off unless you set `CONSCIOUS_SANDBOX_INTERNET=true`; most skills need it, so turn it on unless you have a reason not to. The setting applies to existing computers too, the next time they wake.

To check a setup before you text it, run `pnpm computer:check`. It starts a throwaway computer with your `.env`, checks that internet matches the setting, lists the programs skills rely on and the skills that show up, then deletes it.

## Skills

Skills are instructions for jobs that come up often, in the [AgentSkills](https://agentskills.io) format. They live on the user's computer, in `skills/`: the repo's [`skills/`](skills/) folder is copied in when a computer starts, next to the skills the agent wrote for that user. The system prompt lists the ones that can run there, and the agent reads a skill's `SKILL.md` before it uses it.

23 ship today:

| Area | Skills |
| --- | --- |
| Search | `duckduckgo-search`, `reddit-reading`, `youtube-content`, `blocked-page-recovery`, `rss-feeds` |
| Watching | `product-price-monitor`, `watchers`, `stocks` |
| Daily life | `weather`, `maps`, `fitness-nutrition` |
| Planning | `weekly-review-planning`, `decision-questionnaire`, `one-three-one-rule`, `social-media-content-calendar`, `llm-wiki` |
| Mail | `email-inbox-triage` (with Gmail or any IMAP mailbox) |
| Documents | `pdf`, `docx`, `xlsx`, `powerpoint`, `document-to-action-items` |
| Agent | `skill-creator` |

Without a computer, the skills that need no scripts and no files still work, read straight from the repo and followed with Conscious's own tools (web search, page reading, reminders): `weather`, `product-price-monitor`, `weekly-review-planning`, `decision-questionnaire`, `one-three-one-rule`, `social-media-content-calendar`, `document-to-action-items`, `email-inbox-triage`. The rest need a computer. A skill can opt out with `"computer": true` in its `conscious.json`.

Skills that fetch from the web show up on a computer only with `CONSCIOUS_SANDBOX_INTERNET=true`. Watching skills can run on a schedule as checks (see Chat with it). To copy another one at a pinned commit:

```bash
pnpm skills:import https://github.com/<owner>/<repo> skills/<name> --commit <sha> --internet
```

The agent also saves its own skills after work worth repeating (`skills_save_skill`), and keeps every earlier version so a change can be undone.

## Google: Calendar, Gmail, Drive, Contacts and Tasks

Ask "what's on this week?" and Conscious sends a Vault link with a **Sign in with Google** button. After that it can check and add calendar events; search, read and draft email; find and read files in Drive (Docs and Slides as text, Sheets as CSV); look people up in Contacts (numbers, birthdays, addresses); and list, add and tick off Google Tasks. It never sends email, deletes, or invites anyone: drafts wait in Gmail for you.

Someone who signed in before Drive, Contacts and Tasks were added is asked to sign in once more the first time Conscious needs them.

Conscious is self-hosted, so each install brings its own Google sign-in client. Once:

1. In [Google Cloud](https://console.cloud.google.com/), create a project and enable the **Google Calendar API**, **Gmail API**, **Google Drive API**, **People API** and **Google Tasks API**.
2. Under Google Auth Platform, set up the consent screen as **External**, and add your own Google address as a test user.
3. Create an OAuth client of type **Web application**, with this redirect URI: your `CONSCIOUS_PUBLIC_URL` followed by `/vault/oauth/google` (for example `https://conscious.example.com/vault/oauth/google`, or `http://localhost:8787/vault/oauth/google` in the terminal).
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`.

While the app is in Testing, Google ends the sign-in after 7 days, and Conscious asks you to sign in again. Publishing it removes that limit; for Gmail, Google asks for a review only if people other than you will use it.



## Any other mailbox

For mail outside Gmail (iCloud, GMX, WEB.DE, Libero, Posteo, Yahoo, Fastmail, a work or own domain), ask "anything from the landlord?" and Conscious sends a Vault link that asks for your address and an app password. It signs in to the mail server over IMAPS to check them before saving. After that it searches and reads mail, without marking anything read, and saves replies in your Drafts folder for you to send. It never sends, moves or deletes. Common providers' servers are known; for others the page has a box for the IMAP server. Outlook.com and Hotmail no longer accept passwords over IMAP, so they do not work this way.

## Spotify

Ask "what am I listening to?" or "put on something for cooking" and Conscious sends a Vault link with a **Sign in with Spotify** button. After that it sees what plays and on which device, searches, reads your history and top artists, lists your playlists and makes private ones. Playing, pausing, skipping and queueing need Spotify Premium and an open Spotify app.

Like Google, each install brings its own Spotify app. Once:

1. At [developer.spotify.com](https://developer.spotify.com/dashboard), create an app and tick **Web API**.
2. Add the redirect URI: your `CONSCIOUS_PUBLIC_URL` followed by `/vault/oauth/spotify`. Spotify refuses `localhost`, so in the terminal it is `http://127.0.0.1:8787/vault/oauth/spotify`; Conscious sends that form on its own.
3. Under User Management, add the Spotify accounts that will use it.
4. Set `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` in `.env`.

Spotify lets an app in development mode serve only a few listed users, and its owner needs Premium. That fits one household; more people need Spotify's review.

## Notion, Todoist, Strava and Dropbox

Conscious connects to vendor-hosted MCP servers listed in [`mcp/`](mcp/), from the host, and offers their tools like any capability. Kiwi.com flights and trivago hotels need no account and are on from the start.

Notion, Todoist, Strava and Dropbox need your account. Ask "what's on my Todoist today?" and Conscious sends a Vault link with a **Sign in with Todoist** button. You sign in on Todoist's own page, and from then on Conscious calls Todoist as you. There is nothing to set up first: Conscious registers itself with each service the first time someone signs in. The redirect goes to your `CONSCIOUS_PUBLIC_URL`, so it works on the same machine with `http://localhost:8787`, and from a phone through an https address.

Set `CONSCIOUS_MCP_SERVERS` to choose (for example `kiwi,notion,todoist`, or `none`). Reading is free; adding and changing pages or tasks is allowed; deleting, and any tool a manifest does not mark, waits for your yes.

## Plugins

Ask Conscious about an app it has no capability for and it installs a plugin that ships with Conscious, or writes one itself. A plugin it writes stays on your install. Plugins run in a sandbox and reach only the hosts they declare. See [Plugins](docs/architecture.md#plugins).

Ask "anything new on GitHub?". Conscious installs the GitHub plugin and sends you a **Vault** link: a private page where you paste a GitHub token. It checks the token with GitHub, saves it encrypted, and tells you in the chat when you are connected. Secrets never pass through the chat or the model.

For a service with no built-in connection, Conscious reads the service's API docs and defines the connection in the plugin it writes. The Vault page then shows exactly which hosts your key will go to, and says that Conscious wrote this connection itself. Your key only ever goes to those hosts. Sign-in by redirect works for Google (above); open banking and other providers come later.

The Vault page runs on `CONSCIOUS_VAULT_PORT` (8787). In the terminal, `http://localhost:8787` works. For a phone, set `CONSCIOUS_PUBLIC_URL` to an https tunnel to that port.

Connected accounts, plugins (including ones the agent wrote) and installs are saved in `.conscious/` on the host and survive a restart.

## Run it online

Conscious is one Node process that keeps running, so any host that keeps a process up and gives it a disk works. Nothing has to reach it from outside except your phone: Photon is an outgoing connection, and E2B is already in the cloud.

A host such as Railway, Render or Fly.io gives a service one address. Set `CONSCIOUS_APP_PORT` and `CONSCIOUS_VAULT_PORT` to the same port, and that one https address serves both: the app under `/app/`, the Vault under `/vault/`. It goes in `CONSCIOUS_PUBLIC_URL` and in the phone app.

- Build with `pnpm build`, start with `node dist/photon.js` (`node dist/app.js` for the app alone). On Railway, set the start command in the service settings or as `RAILPACK_START_CMD`.
- Variables: your `.env`, plus `CONSCIOUS_APP_PORT=8080`, `CONSCIOUS_VAULT_PORT=8080`, `CONSCIOUS_DATA_DIR=/data` and a `CONSCIOUS_VAULT_KEY` of its own (`openssl rand -base64 32`).
- A volume at `/data`, so the Vault, access codes and reminders survive a deploy.
- One copy only. Two would both answer, and both send every reminder; stop the one on your laptop.

The phone app's access code is in the first deploy's logs. Each user's computer is found again by the same `E2B_API_KEY`, so memory and conversations carry over.

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
├─ app.ts                the phone app on its own
├─ channels/photon.ts    Spectrum messages → orchestrator, replies and notifications back
├─ channels/app.ts       the phone app's WebSocket: streamed replies, reactions, files
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
│  ├─ reactions/         an emoji on the user's message, before an answer or instead of one
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
mobile/                  the phone app (Expo, React Native)
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
