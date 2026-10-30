# Running Conscious

How to install, configure and run Conscious, and what each part does once it is on. For how it is built, see [architecture.md](architecture.md).

## Chat with it

Needs Node >= 22.19.

```bash
pnpm install
cp .env.example .env        # pick a model and set its API key
pnpm chat
```

```
you remind me to call mum tomorrow at 9
conscious [reminders_create_reminder] done, tomorrow 9:00 📞
```

Reminders and finished background tasks print on their own, above the prompt. Commands: `/reminders`, `/tasks`, `/reset` (start fresh: forget the conversation, memory, reminders and agents), `/exit`.

Reminders, scheduled checks and the conversation are saved in `.conscious/`, so a restart keeps them. A one-off reminder that came due while Conscious was off is sent, marked late, when it starts again (up to 12 hours late).

A **scheduled check** is a reminder with a job: at the time, an agent does the work with all of Conscious's tools and messages you only if it finds something. "Every morning at 8, tell me if it will rain", "check the Lisbon flight daily and tell me if it drops under 120 EUR".

## Long jobs in the background

Ask for something that takes a while ("find me a ticket to Lisbon") and Conscious hands it to a sub-agent and answers you at once. You keep chatting about anything else while it works.

- **A sub-agent made for the job.** Conscious writes its method (compare the total price with bags, prefer direct flights), picks the tools it needs, gives it 10, 30 or 60 minutes, and can split the job into up to five parts that run at the same time (each airport, each date). A last agent compares the parts and writes the answer.
- **It keeps you posted.** It can text you a first good find before it is done, and the result comes as a normal message. Ask "how is it going?" and Conscious knows how far it got. The phone app shows each running job under the header.
- **Change of plan.** "Only morning flights" while it runs is passed on to the job, no need to start over.
- **Restarts.** Jobs are saved in `.conscious/background.json`; one a restart or a deploy cut off starts over once.
- **Agents that stay.** Each kind of job has an agent: the first flight search makes a `flights` agent, and when the job is done it is kept, asleep, with a notebook of what it learned (which sources worked, that you fly from Milan, that you prefer direct). Tell Conscious what you picked ("booked the second one") and it goes into that notebook too. A month later, "a flight to Tokyo" wakes the same agent, which starts from its notes instead of from nothing. An agent is only files: its method (`AGENT.md`), its notebook (`NOTES.md`) and a line per job (`runs.md`, with each job's brief and answer in `runs/`), on the computer in `agents/<name>/`, or in `.conscious/agents/` without one. Nothing runs while it sleeps. Ask "what does the flights agent know?" to see a notebook, and "forget how you book flights" to delete one.

## A friend, not a coworker

- **It remembers you.** What you tell it about yourself and the people in your life (who they are, their birthday, what is going on with them) is kept with the memory tools and read into every conversation, with or without a computer. Ask "what do you know about me?" to see it, and "forget that" to delete a line. Without a computer it is saved in `.conscious/memory/`, on a computer in `memory/memory.json`.
- **It gets to know you.** The first time you write, it introduces itself, asks your name, and offers to look you up online. With your yes, a background agent reads what is public about you (your name and city, the profiles you point it to) and shows you what it found. Only what you confirm is kept.
- **It remembers the people you care about.** A birthday in memory becomes a nudge a week before, with a present idea, and another on the morning of the day.
- **It follows up.** Mention an interview, a doctor's visit or a first date, and it asks how it went afterwards, once.
- **It knows when to be quiet.** What it sends on its own waits out the night (`CONSCIOUS_QUIET_HOURS`, 22-8 by default) and stops at a few a day (`CONSCIOUS_MAX_UNPROMPTED`, 3). Tell it "leave me alone this week" and it holds those and scheduled checks until then. Reminders you set yourself always come.
- **It texts like a person.** Short messages, often two or three bubbles instead of one block, reactions when a reaction is enough, and no assistant phrases. It talks to you only through one tool, `chat_send_message`, so you get its messages, never its thinking.
- **It helps with work too.** No work apps or work skills are installed, but it never turns down a work question: it helps with what it has, like Claude Code on your Mac.

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

## Text it on Telegram

Telegram needs no business account and no review: the bot is yours in a minute.

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, and pick a name and a username. It answers with a token.
2. Set `TELEGRAM_BOT_TOKEN` in `.env` and run `pnpm telegram`.
3. Message your bot. It does not answer yet: the log shows `ignored a message from 123456789 (@you)`. Put that id in `CONSCIOUS_TELEGRAM_USERS` and restart.

Conscious asks Telegram for its messages (long polling), so like Photon it runs on a laptop with no public address. Only the ids on the list are answered, and only in their private chat with the bot, never in a group. Voice notes, photos and files work as above, `*bold*` shows as bold, and there is no 24-hour window: reminders arrive whenever they are due. Run one copy per bot; two would take turns getting its messages.

With `pnpm photon`, a `TELEGRAM_BOT_TOKEN` adds the bot next to WhatsApp and iMessage. List yourself as `123456789=+393331234567`, your Telegram id and then your number as in `CONSCIOUS_ALLOWED_USERS`, and Telegram, WhatsApp and the app are one conversation; reminders go to whichever you wrote from last. An id alone is a user of its own, `telegram:123456789`. With `pnpm telegram`, `123456789=me` makes you the same user as `pnpm chat`.

### Invite friends

Whoever is listed in the settings (`CONSCIOUS_ALLOWED_USERS`, `CONSCIOUS_TELEGRAM_USERS`, `CONSCIOUS_APP_USERS`) owns the install and can invite people from Telegram or WhatsApp:

- `/invite +39 333 123 4567` answers with a link to the bot. It works once, for 7 days. The number can text Conscious on WhatsApp at once.
- Your friend taps the link, presses Start, then taps *Share my phone number*. Telegram vouches for the number, so a forwarded link is no use to anyone else. You get a message when they join.
- `/invites` lists who you invited; `/uninvite +39 333 123 4567` takes their access back. What they saved stays, in case you invite them again.

Each friend is a user of their own, with their own memory and computer, on your keys and accounts: the model, E2B, transcription and Composio are billed to you. Invites are kept in `.conscious/invites.json`.

## Use the phone app

`mobile/` is Conscious's own app for iPhone and Android: one chat, answers written out as they come, what it is doing while it works ("Searching the web…"), its reactions, photos both ways, and reminders that arrive while you are away. No messaging account or Meta approval is involved: the app talks straight to your Conscious.

```bash
pnpm app
```

```
Phone app on http://192.168.1.20:8788
  New access code for me: k7qd-m2xa-9wfe-c4tn
```

Then run the app (see [`mobile/README.md`](../mobile/README.md)) and enter that address and code. `pnpm app` talks as `me`, the same user as `pnpm chat`.

*Start fresh* in the app's ⋯ menu does what `/reset` does: it clears the chat, forgets the memory and the agents, and drops the reminders, so the next message is a first meeting again. Files on the computer stay.

To have the app next to WhatsApp and iMessage, set `CONSCIOUS_APP_USERS` to your own number and run `pnpm photon`: the app and your messaging chat are then one conversation. Reminders go to whichever you wrote from last. Each user listed gets an access code the first time; codes are kept in `.conscious/app-codes.json`, and deleting a line there and restarting gives that user a new one.

The app server runs on `CONSCIOUS_APP_PORT` (8788). On your home network the phone reaches it directly. Away from home, use a private network such as [Tailscale](https://tailscale.com), or an https tunnel; the code is the only lock, so do not put the port on the open internet without https.

## Give it a computer

Conscious can have a computer of its own: one [E2B](https://e2b.dev) sandbox per user. Everything it knows about you lives there: its memory (`memory/memory.json`, read into every conversation), its agents and their notebooks (`agents/`), the files it keeps for you (`files/`), and the conversation itself (`.conscious/conversation.json`). It also gets a shell and file tools that run there, never on your machine.

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

## Give it a browser

With `CONSCIOUS_BROWSER=e2b` (and a computer), Conscious gets a real Chrome of its own, on a second E2B computer per user: an E2B desktop. It opens pages, clicks and types, scrolls, takes screenshots it can look at, finds the pictures on a page, and saves pictures and files (behind a login too) to `files/browser/` on the user's computer, from where it can send them in the chat.

- **You sign in, never Conscious.** When a job needs a site you use (an airline, a shop, GitHub), Conscious sends a private link that shows its browser on that site's sign-in page. You sign in on your phone, 2FA included, and the browser stays signed in for next time. It never sees or types a password, and refuses to type into password and card fields.
- **It stops before the last click.** A click that pays, buys, books, orders, sends, posts, deletes, transfers or signs up (in English, Italian, Spanish, Portuguese, French and German), or that submits a form with card details, is refused like any other commit until approvals in the chat exist. Conscious gets everything ready and tells you what is left to click.
- **Private by construction.** The browser computer's addresses open only with a token Conscious holds, so nobody else can drive or watch it. The sign-in link goes through Conscious's own server (the Vault's), lasts 15 minutes, and a new one closes the old.
- **Cost.** The desktop computer is bigger than the one for files (E2B gives it 8 CPUs and 8 GB, about $0.53 an hour while it runs). It pauses after `CONSCIOUS_BROWSER_IDLE_MINUTES` (5) and E2B bills nothing while it is paused; its tabs and sign-ins survive.

## Claude Code on your Mac

Conscious can hand work on your own Mac to [Claude Code](https://code.claude.com): "ask Claude Code why the build fails in conscious", "have it add a line to notes.txt". It becomes a background job: Claude Code works on your real files, in the folders you allowed, and Conscious tells you what it did when it is done. The next job in that folder goes on with the same conversation, so Claude Code remembers the work.

1. Set `CONSCIOUS_MAC=true` and restart Conscious. For a WhatsApp QR as well as Telegram's, set `CONSCIOUS_WHATSAPP_NUMBER` to Conscious's own number.
2. On the Mac, in a copy of this repository, with Node 22 and Claude Code installed and signed in, run `pnpm mac`. It starts conscious-mac in the background, from every login on, and opens its page at http://localhost:7337.
3. Type your Conscious's address on the page and scan the QR with your phone. It opens your chat with Conscious with the code ready: tap Start (Telegram) or Send (WhatsApp), and the page links by itself. Sending `/mac <code>` from any chat works too. Only owners can link a Mac.
4. On the page, add the folders Claude Code may work in, and pick what it may do and the model.

The page shows whether the Mac is online and what Claude Code did lately; "Unlink this Mac" and "Stop conscious-mac" are there too. `/mac off` in the chat unlinks it from the other side. Everything the page does also works in the terminal: `pnpm mac help` lists it, including `pnpm mac pair <address> <code>` with a code from `/mac`, for a Mac without a browser.

- **The Mac calls Conscious, never the other way.** It holds a socket open to `/mac/socket` on your Conscious's address, so it needs no open port, works behind any router, and comes back by itself after sleep or a network change. A QR's code works for 10 minutes and links only the Mac that showed it. The token the Mac gets stays in `~/.config/conscious/mac.json`, readable by you alone; Conscious keeps only a digest of it.
- **The page is for you alone.** It listens on this Mac only, and opens for a browser that `pnpm mac` handed a key from a file only you can read. Other websites open in the same browser cannot read it or change a setting.
- **Your Claude account stays on the Mac.** conscious-mac runs your own `claude`, unchanged, signed in the way you signed it in. Conscious never sees a Claude login, and what Claude Code uses is on your own plan or key.
- **The Mac decides what Claude Code may do.** It works only in the folders you allowed, in `acceptEdits` mode: it edits files there and runs what your Claude Code settings already allow. Anything it would ask permission for is refused, since nobody is at the Mac to say yes, and Conscious tells you what it wanted to do. Conscious can only pick a folder, write the message, go on with a conversation and ask for a read-only job (plan mode); no other flag reaches Claude Code.
- **Full control, if you want it.** "My whole home folder" (`pnpm mac allow ~`) lets Claude Code work anywhere in your home folder, and "Full control" (`pnpm mac mode bypassPermissions`) lets it run any command without asking. Together, any message that reaches Conscious can do anything on your Mac that you can, and Conscious also reads web pages and emails, which may carry instructions of their own. `pnpm mac forbid ~` and `pnpm mac mode acceptEdits` take it back.
- **Awake while it works.** The Mac stays awake while Claude Code runs a job, then may sleep again. A Mac that is asleep, closed or off the internet is offline, and Conscious says so.

## Skills

Skills are instructions for jobs that come up often, in the [AgentSkills](https://agentskills.io) format. They live on the user's computer, in `skills/`: the repo's [`skills/`](../skills/) folder is copied in when a computer starts, next to the skills the agent wrote for that user. The system prompt lists the ones that can run there, and the agent reads a skill's `SKILL.md` before it uses it.

18 ship today, all for everyday life:

| Area | Skills |
| --- | --- |
| Search | `duckduckgo-search`, `reddit-reading`, `youtube-content`, `blocked-page-recovery`, `rss-feeds` |
| Watching | `product-price-monitor`, `watchers`, `stocks` |
| Daily life | `weather`, `maps`, `fitness-nutrition`, `sunday-reset` |
| Mail | `email-inbox-triage` (with Gmail or any IMAP mailbox) |
| Paperwork | `pdf`, `docx`, `xlsx`, `document-to-action-items` |
| Agent | `skill-creator` |

Without a computer, the skills that need no scripts and no files still work, read straight from the repo and followed with Conscious's own tools (web search, page reading, reminders): `weather`, `product-price-monitor`, `sunday-reset`, `document-to-action-items`, `email-inbox-triage`. The rest need a computer. A skill can opt out with `"computer": true` in its `conscious.json`.

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

## Shopping with Shop

Ask "find me a ceramic coffee dripper under 40 euro" and Conscious searches [Shop](https://shop.dev), Shopify's catalog of products from millions of online stores, with live prices and stock. It shows two or three good options with their store, price and link, checks a size or colour before it recommends one, and searches by a photo you send when it has a computer. When you want one, it prepares the checkout at that store and sends you its page: you check the total and pay there. Conscious never pays or places an order itself.

Search and checkout need no account and no setup. Sign in to your Shop account (ask "connect my Shop account", or Conscious offers it when it helps) and it also fills in your saved delivery address, and answers "where is my order?" for orders from any store Shop tracks, with the tracking link. The sign-in is a Vault link with a **Sign in with Shop** button: the page shows a code, you approve Conscious on Shop's own page, and Conscious tells you in the chat when it is connected. The sign-in stays in the Vault on your install.

Searches and checkouts go from your install to Shopify (`mcp.shop.com`), the way flight searches go to Kiwi.com. `CONSCIOUS_SHOP=false` turns shopping off.

## Todoist, Strava, Notion and Dropbox

Conscious connects to vendor-hosted MCP servers listed in [`mcp/`](../mcp/), from the host, and offers their tools like any capability. Kiwi.com flights and trivago hotels need no account and are on from the start.

Todoist and Strava need your account. Ask "what's on my Todoist today?" and Conscious sends a Vault link with a **Sign in with Todoist** button. You sign in on Todoist's own page, and from then on Conscious calls Todoist as you. There is nothing to set up first: Conscious registers itself with each service the first time someone signs in. The redirect goes to your `CONSCIOUS_PUBLIC_URL`, so it works on the same machine with `http://localhost:8787`, and from a phone through an https address.

Notion and Dropbox work the same way, but are off unless you name them, since most people use them for work. Set `CONSCIOUS_MCP_SERVERS` to choose (for example `kiwi,todoist,notion`, or `none`). Reading is free; adding and changing pages or tasks is allowed; deleting, and any tool a manifest does not mark, waits for your yes.

## More everyday apps through Composio

For everyday apps Conscious has no tools of its own for (Google Photos, Fitbit, Oura, Splitwise, YouTube, Pinterest and more), it can use [Composio](https://composio.dev). Set `COMPOSIO_API_KEY` in `.env` (from the Composio dashboard) and restart. Ask "how did I sleep this week?" and Conscious finds the right tool. On an install without its own Google or Spotify client, those connect through Composio too, and Conscious never mentions the setup it skipped. If the app is not connected yet, it sends a link to Composio's sign-in page. There is no app to register.

Conscious is for your life, not your job, so work apps (Linear, Slack, Jira, HubSpot…) are not offered. The list of allowed apps is `LIFE_APPS` in `src/capabilities/composio/capability.ts`; `COMPOSIO_APPS` replaces it with your own comma-separated list, and `COMPOSIO_APPS=all` lifts it.

Composio is a hosted service: it holds each user's app sign-ins and runs the tools, so that data passes through Composio. Conscious sends it an opaque id per user, never a phone number or name. Reading is free, saving drafts is allowed, and anything that creates, changes, sends or deletes waits for your yes. Without a key, nothing goes to Composio.

After signing in, the user lands on a Conscious page, not Composio's. To make the sign-in itself show Conscious:

1. In the Composio dashboard, under Project Settings → Auth Screen, set the logo and app name. That changes the Connect Link page for every app.
2. For apps with a consent screen (Google, Fitbit, Spotify…), register your own OAuth app with the redirect URI `https://backend.composio.dev/api/v3.1/toolkits/auth/callback`. Then create an auth config with its client ID and secret in the Composio dashboard. Google then says "Conscious wants access", not Composio.
3. List those auth configs in `.env`: `COMPOSIO_AUTH_CONFIGS=googlecalendar=ac_…,gmail=ac_…`. Only new connections use them. Users connected before have to connect again.

## Italian official pages

Ask "how do I renew my ID card?" or "can I get the bonus asilo nido?" and Conscious searches about 2,250 official pages of Italian public offices: ministries, INPS, Agenzia delle Entrate, regions, comuni and EU portals, as listed on [italiaaperta.it/fonti](https://www.italiaaperta.it/fonti), plus the service pages of big comuni the list misses (Milano and Torino, in [`scripts/italy-extra-sources.json`](../scripts/italy-extra-sources.json)). A search returns pages, not answers. Conscious reads the best one or two whole, searches again when they fall short, and checks the live page when an amount or a deadline may have changed since the copy was saved. The answer ends with the source address.

The pages and their index stay on your install. Once, and again whenever you want fresher copies:

```bash
pnpm italy:download    # about 2 minutes, into .conscious/italy/download; needs uv and curl
pnpm italy:index       # writes .conscious/italy/index.sqlite
```

The index matches words and, with an embeddings model, meanings too, so an English question finds an Italian page. Embeddings come from Mistral with `MISTRAL_API_KEY`, else OpenAI with `OPENAI_API_KEY`, else a local OpenAI-style server at `CONSCIOUS_EMBEDDINGS_URL` (Ollama with `bge-m3`). A search embeds with the model that built the index; with another one, or none, it matches words only. A rebuild embeds only the passages that changed.

Online, the host needs the index in its data folder and the same embeddings key. On Railway, with the volume at `/data`: `railway volume files upload .conscious/italy/index.sqlite /italy/index.sqlite --overwrite`, then restart the service; the index is opened at start.

## Plugins

Ask Conscious about an app it has no capability for and it writes a plugin for it, or installs one that ships with Conscious. A plugin it writes stays on your install. Plugins run in a sandbox and reach only the hosts they declare. See [Plugins](architecture.md#plugins).

When the plugin needs your account, Conscious sends you a **Vault** link: a private page where you paste the key. It checks the key with the service, saves it encrypted, and tells you in the chat when you are connected. Secrets never pass through the chat or the model.

For a service with no built-in connection, Conscious reads the service's API docs and defines the connection in the plugin it writes. The Vault page then shows exactly which hosts your key will go to, and says that Conscious wrote this connection itself. Your key only ever goes to those hosts. Sign-in by redirect works for Google (above); open banking and other providers come later.

The Vault page runs on `CONSCIOUS_VAULT_PORT` (8787). In the terminal, `http://localhost:8787` works. For a phone, set `CONSCIOUS_PUBLIC_URL` to an https tunnel to that port.

Connected accounts, plugins (including ones the agent wrote) and installs are saved in `.conscious/` on the host and survive a restart.

## Run it online

Conscious is one Node process that keeps running, so any host that keeps a process up and gives it a disk works. Nothing has to reach it from outside except your phone: Photon and Telegram are outgoing connections, and E2B is already in the cloud.

A host such as Railway, Render or Fly.io gives a service one address. Set `CONSCIOUS_APP_PORT` and `CONSCIOUS_VAULT_PORT` to the same port, and that one https address serves both: the app under `/app/`, the Vault under `/vault/`. It goes in `CONSCIOUS_PUBLIC_URL` and in the phone app.

- Build with `pnpm build`, start with `node dist/photon.js` (`node dist/app.js` for the app alone, `node dist/telegram.js` for Telegram alone). On Railway, set the start command in the service settings or as `RAILPACK_START_CMD`.
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
├─ telegram.ts           a Telegram bot on its own
├─ channels/photon.ts    Spectrum messages → orchestrator, replies (as short bubbles) and notifications back
├─ channels/app.ts       the phone app's WebSocket: streamed replies, reactions, files
├─ channels/telegram.ts  the Telegram Bot API, long polled: replies as bubbles, reactions, files, notifications
├─ invites/              /invite links for friends, and who was invited
├─ mac/                  /mac and the socket the users' Macs hold open; mac/local/ is conscious-mac, run on the Mac
├─ create-conscious.ts   composition root: which implementation sits behind each seam
├─ config.ts             environment → typed config
├─ engine/
│  ├─ orchestrator.ts    the agent you talk to: one message at a time per user
│  ├─ reactions.ts       the emoji on a message: a small model of its own decides, beside the answer
│  ├─ run-agent.ts       one pi-agent-core loop + policy (budgets, commits held)
│  ├─ tool-adapter.ts    capability tool → pi tool
│  └─ models.ts          the model you chose: any pi-ai provider, or a local server
├─ agents/               background sub-agents: spawn, list, cancel, report back
├─ memory/               what Conscious remembers about you and the people in your life
├─ scheduler/            reminders: one-off and cron, in your timezone; pacing of what it sends unprompted
├─ sandbox/              each user's computer: the Sandbox seam, the E2B backend, older notes
├─ capabilities/         one folder per pack: capability.ts + SKILL.md
│  ├─ memory/            remember, people and birthdays, forget
│  ├─ reminders/         reminders, follow-ups and scheduled checks
│  ├─ quiet/             give the user space: pause what Conscious would send on its own
│  ├─ chat/              chat_send_message: the only way any agent's words reach the user
│  ├─ background/
│  ├─ computer/          shell and files in the user's sandbox
│  ├─ skills/            the agent saves its own skills, with undo
│  ├─ italy/             official Italian pages: search, read, with their source address
│  ├─ mac/               Claude Code on the user's Mac, from a background task
│  ├─ plugins/           search, install and write plugins
│  └─ vault/             connect and disconnect accounts through Vault links
├─ skills/               the skill library: copy into the computer, list what can run, import
├─ plugins/              plugins: manifest, connectors, sandbox, broker, review, local store
├─ vault/                the user's secrets: sealed store and the Vault page
├─ mcp/                  MCP catalog and client: each server becomes a capability
├─ composio/             Composio's tool router: one session per user
├─ conversations/        one conversation per user, in memory or in their sandbox
├─ knowledge/            search indexes: passages, keywords and vectors in one SQLite file
└─ prompts/              system, background and first-meeting prompts as markdown
skills/                  bundled skills, copied into every computer
mcp/                     MCP server manifests, one folder per server
test/                    vitest
plugins/                 bundled plugins, one folder per plugin (none yet)
mobile/                  the phone app (Expo, React Native)
site/                    the landing page: static, served as its own Railway service
```

## Add a capability

1. Create `src/capabilities/<id>/` with `capability.ts` and `SKILL.md`.
2. Name tools `<id>_<verb>_<noun>` and set `effect` honestly: `read`, `draft` or `commit`.
3. If only some users can have it (a connected account), return `available` for them.
4. Register it in `src/capabilities/index.ts` and add a test.

