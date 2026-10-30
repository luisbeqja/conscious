# Architecture

Conscious is a personal assistant for daily life, not work, and it should feel like a friend: it remembers you and the people in your life, follows up, and knows when to stay quiet. It is open source and self-hosted. Whoever runs it picks the model and keeps the data: the Vault, plugins and installs live in the install's own data folder, and memory and conversations live there too, or in each user's computer (an E2B sandbox, hosted or self-run) when there is one. There is no Conscious server that sees any of it.

## The idea

1. **One orchestrator per user, many capability packs.** The orchestrator is the agent you chat with. Each area of life (reminders, calendar, email, travel, music) is a pack: tools plus a short `SKILL.md` on how to use them.
2. **Long work goes to background agents.** The orchestrator designs a sub-agent for the job (a method, the packs it needs, how long it may take, and parts that run side by side) and answers you at once. You keep chatting: the orchestrator sees each task's progress and can pass it a change of plan. The sub-agent may text you a first find, then messages you its result. Tasks are saved in `.conscious/background.json`; a restart starts an interrupted one over, once. Depth is one: a sub-agent cannot start another.
3. **Agents rest between jobs.** Each kind of job (flights, gift ideas) has an agent that is kept when its job ends: its method, a notebook of what it learned, and a log of its jobs. The next job of that kind wakes it with all three. It is files, not a process.
4. **Reminders are cron jobs.** One-off or recurring, read in your timezone, sent to you as a normal message. A scheduled check is a reminder with a job: when it fires, an agent does the job and messages you only if it found something. Both are saved in `.conscious/reminders.json` and re-armed at start.
5. **Connectors bring in your life.** A connector is a link to one of your accounts. A pack that needs one is invisible until you connect it. Tokens never reach the model.
6. **A computer for what no API covers.** Each user has a sandbox for files and a shell, and a second one with a real Chrome for sites with no API, kept signed in to the sites the user signed in to themselves.
7. **Memory is not the transcript.** What Conscious knows about you and the people in your life is kept apart from the conversation, read into every prompt, and yours to see and delete.
8. **Speaking first is rationed in code.** What Conscious sends on its own waits out the night and stops at a daily limit. A friend who texts too much is worse than one who never does.
9. **Safety is code, not prompt.** Every tool is `read`, `draft` or `commit`. A `commit` (send, book, pay, delete) never runs without your explicit yes. Until approvals exist, commits are blocked outright.

## Building blocks

| Piece | What it is |
|---|---|
| The loop | `pi-agent-core`, behind `engine/run-agent.ts`. One loop, used by the orchestrator and every sub-agent. |
| Capability packs | Tools named `<id>_<verb>_<noun>` plus a `SKILL.md` on how to use them. |
| Effects | Every tool is `read`, `draft` or `commit`. A commit will become a yes/no the user answers. |
| Messages | `chat_send_message` is the only way any agent reaches the user, whatever the channel. What an agent writes outside it stays private. |
| Reactions | A small model of their own, beside every answer, decides whether a message gets an emoji and which, from a list every channel accepts. The agent that answers has no reaction tool. |
| Background agents | Sub-agents with a written brief and a harness designed for the job (instructions, packs, effort, parallel parts). They outlive the turn, can text an update, take a change of plan, and report to the user directly. |
| Browser | A Chrome per user on an E2B desktop, driven over CDP with Playwright. The user signs in through a live view; commits are refused. |
| Agents | One per kind of background job, kept between jobs as a folder: method, notebook, log. Woken by name. |
| Budgets | Turns and tool calls are capped per message. |
| Conversations | One conversation per user, no threads. |
| Connectors | The user's own accounts, linked one by one. |
| Skills | `SKILL.md` instructions on the user's computer: copied from the repo, or written by the agent. |
| MCP servers | Vendor-hosted tool servers from a reviewed catalog, called from the host. |
| Memory | Facts about the user and the people in their life, with birthdays. On the host's disk, or on the user's computer. |
| Pacing | Quiet hours, a daily limit and a pause for the messages Conscious sends on its own. |
| Composio | Optional: more everyday apps through Composio's hosted tool router, which holds each user's sign-ins. Work apps are refused. |
| Shop | Shopping through Shop MCP: search, checkouts the user pays on the store's page, and their Shop account for addresses and orders. |
| Plugins | Apps without a capability: bundled with Conscious or written by the agent on your install, run in a sandbox. |
| Vault | Your secrets, saved through a private page and sealed. Only the broker reads them. |
| Knowledge | Documents saved ahead of time and indexed, searched by words and by meaning: today the official pages of Italian public offices. |

## A message, end to end

1. The terminal, the phone app, Telegram, or Photon (iMessage and WhatsApp), hands the orchestrator your text. It waits behind any message still being answered for you.
2. The orchestrator loads the conversation, builds the turn (the time in your timezone, background tasks that finished or are still running, your text), and runs the loop with the packs available to you.
3. The agent answers with `chat_send_message`, once or a few times: each message goes out the moment it is sent, on the channel you wrote from, and the app shows it as it is written. Tool calls show as they start.
4. The conversation is saved as what was said and done: your message, the tools used, the messages sent.
5. Reminders, scheduled checks and background tasks reach you through `notify`, the way Conscious speaks first.

## Talking to the user

Every agent, the one you chat with, a background job's or a scheduled check's, speaks through one tool, `chat_send_message`. The text it writes outside the tool is never shown, so it can think aloud, keep notes and stay silent without a word of it reaching you.

- **Where it goes.** The channel decides: the chat you wrote from while answering you (as bubbles on iMessage, WhatsApp and Telegram), and wherever you last wrote for a job or a check. Messages of one turn go out in the order they were written, and one run sends at most five.
- **Its own text is private.** A background job finishes with notes that only the orchestrator reads, to answer what you ask next; a part of a split job finishes with findings for the agent that merges them. A check that found nothing sends nothing.
- **Forgetting the tool.** An agent about to end without sending anything is reminded once, with what it wrote quoted as not delivered. After that, silence is its choice. A job that still sends nothing is reported as not finished; an answer that broke before saying anything gets a short apology.
- **The transcript teaches by example.** Replies from before the tool were plain text, and a model copies its own past turns, so they are shown as sent messages. For the same reason an answer is saved without the text nobody saw.

## Memory and speaking first

- **Memory** (`src/memory/`, `capabilities/memory/`) holds two lists: facts about the user, and people (name, relation, birthday, notes). It is a JSON file per user: `.conscious/memory/<hash>.json` on the host, or `memory/memory.json` on the user's computer. Every prompt carries it with an id per line, so the agent can forget one. Older free-form notes in `memory/MEMORY.md` are shown too, until the agent moves them over.
- **The first meeting.** While memory is empty, the system prompt adds `prompts/first-meeting.md`: say hi, ask their name, offer to look them up online. The look-up is a background task with a brief written from the memory skill: public pages only, no addresses, money or health, and it asks when two people share a name. Nothing it finds is saved until the user confirms it.
- **Birthdays and follow-ups** are scheduled checks marked `unprompted`: a birthday arms one a week before and one on the day, and `reminders_follow_up` arms one after an event the user mentioned. Each runs the agent with memory, so the words fit what Conscious knows by then.
- **Pacing** (`scheduler/pacing.ts`) runs before any reminder fires. A plain reminder the user set always goes. An unprompted one inside quiet hours is moved to their end, and past the daily limit it is dropped. While the user paused messages (`quiet_pause_messages`), unprompted ones and scheduled checks are dropped. The pause and the day's count are kept in `.conscious/pacing.json`.
- **Bubbles.** On iMessage, WhatsApp and Telegram, a message of two to four short paragraphs goes out as that many bubbles, with a short pause between them.

## Agents

A background job usually comes back in another form: another flight, another present. So the sub-agent that did it is not thrown away. It becomes an agent of the user's, named for the kind of job, and it rests as a folder until the next job of that kind.

- **What an agent is.** `agents/<name>/` on the user's computer, or `.conscious/agents/<hash>/<name>/` on the host without one (`src/agents/resting-agents.ts`). `AGENT.md` holds a one-line description, the capabilities it works with, its method and a count of jobs. `NOTES.md` is its notebook. `runs.md` has a line per job, and `runs/` the brief and the answer of each. No transcript is kept: what is worth keeping goes into the notebook.
- **Made on its first job.** `background_start_task` takes `agent`, a name for the kind of job (`flights`, never `lisbon-flights`), and, for a new one, `agentDescription`. The `instructions` and `capabilities` the orchestrator designs become the agent's method and tools.
- **Woken on the next.** The orchestrator's prompt lists the user's agents, most recently used first. A job given to one of them runs with its method, its notebook and its last jobs in the system prompt, and with its tools unless the orchestrator names others. Instructions written for that job are added on top. A fresh conversation every time: the agent remembers through what it wrote down, not by replaying its old transcript, so stale prices never come back and a small local model still fits.
- **It writes its notebook.** Only the sub-agent that writes the answer gets `notebook_save_notes`, and its guidance asks it to rewrite the notebook once, just before answering: what worked, what did not, the user's preferences for this kind of job. Parts of a split job read the notebook but do not write it. After the job, the orchestrator adds the line to `runs.md`, done or not.
- **The user's reaction reaches it.** "Booked the second one" arrives in the chat after the job ended, so the orchestrator passes it with `agents_add_note`; it is a dated line in the notebook that the agent sees on its next job.
- **One job at a time.** A second job for a busy agent is refused, so two runs never rewrite one notebook.
- **Yours to see and delete.** `agents_read_notes` shows what an agent knows, `agents_forget_agent` deletes one, and Start fresh deletes them all. Sub-agents never get these tools.

## The browser

`CONSCIOUS_BROWSER=e2b` gives each user a Chrome on an E2B desktop computer of its own (`src/browser/`), next to their files computer. It is found again by a hash of the user's id, pauses when idle, and resumes with its tabs and cookies.

- **Driven from the host.** Conscious runs Playwright and connects to Chrome over CDP (`connectOverCDP`). The computer is created with private URLs (`allowPublicTraffic: false`): each request needs the traffic token only the host holds. Chrome refuses control from any host but localhost, so the computer's network masks the `Host` header as `localhost:<port>`.
- **Pages as trees.** The agent reads a page as Playwright's AI snapshot (`ariaSnapshot({ mode: "ai" })`), elements with refs like `[ref=e12]`, in parts of 10,000 characters, and clicks or types by ref (`getByRef`). Every step returns the page again.
- **Pictures.** A screenshot is a JPEG the model sees (tools can now return images, dropped for models that cannot read them) and a file in `files/browser/` on the user's computer. `browser_find_images` lists a page's pictures, the one it shares first; `browser_save_file` fetches with the browser's cookies.
- **Sign-in through a live view.** `browser_ask_user_to_sign_in` opens the site's sign-in page and starts the desktop's VNC stream with a fresh password. The link is a code on the Vault's server (`/browser/<code>/…`) that relays noVNC's page and socket to the computer, adding the token. It lasts 15 minutes, and a new one for the user closes the old. With the app and the Vault on one port, the app's server routes sockets by path: `/app/socket` to the app, the rest to the live views.
- **Commits in a browser.** Before a click, the tool reads the element: a button whose label pays, buys, books, orders, sends, posts, deletes, transfers or signs up, in six languages, or a submit in a form with card fields, is refused; plain links are not. Typing into password and card fields is refused; Enter and Space are not keys the agent can press. A heuristic, written down as such, until approvals exist.

## Your Mac

`CONSCIOUS_MAC=true` lets the owners link their own Mac, so Conscious can give jobs to Claude Code there (`src/mac/`).

- **Linked with a QR.** conscious-mac serves a page on `localhost:7337`. It asks `POST /mac/offers` for a code and a secret, and shows the code as a QR that opens the chat with Conscious: `t.me/<bot>?start=mac-<code>`, or a WhatsApp message with `CONSCIOUS_WHATSAPP_NUMBER`. The channel answers `/start mac-<code>` and `/mac <code>` itself, never the agent, and only for owners. Meanwhile the page asks `POST /mac/offers/collect` with its secret, and gets the token once the code was sent. The token lives only on the Mac; Conscious keeps its digest in `macs.json`. Without a browser, `/mac` gives a code that `pnpm mac pair` trades at `POST /mac/pair`.
- **The page opens for its owner only.** It listens on 127.0.0.1, refuses any other `Host` (DNS rebinding), and needs a cookie that `pnpm mac` sets from a key file only the user can read. A change also needs the page's own `Origin`, so another site in the same browser can neither read nor change the settings.
- **The Mac connects out.** conscious-mac (`src/mac/local/`, kept running by launchd) holds a socket to `/mac/socket` on the Vault's server, which pings it every 30 seconds. Each job has an id: a Mac that drops off gets its jobs again when it is back, and answers each once.
- **One turn of Claude Code per job.** The Mac runs its own `claude -p` in a folder it checks against its own list, with `--permission-prompts none`, so whatever would ask for approval is refused and listed in the answer; `--resume` goes on with a conversation, and a read-only job runs in plan mode. The server sends a folder, a message, a session and read-only, and nothing else reaches the command line.
- **Always a background job.** `mac_ask_claude_code` waits minutes, so it is `backgroundOnly`: the chat is never offered it and starts a background task with the `mac` capability instead, given to the `claude-code` agent. That agent sends the user what matters. `mac_check_status` shows Claude Code's last steps and the latest conversations, which the next job goes on with.

## Channels

Conscious reaches people through [Photon Spectrum](https://photon.codes/spectrum): one SDK and one message stream for iMessage and WhatsApp. `src/channels/photon.ts` is the only code that knows about it.

- **A user is their sender id** (phone number or Apple ID), so the same person on iMessage and WhatsApp is one conversation. Only ids on `CONSCIOUS_ALLOWED_USERS` are answered.
- **Replies and notifications go to the chat the user last wrote from.** Nobody is messaged before they write first, which also keeps the numbers looking like normal chats to Apple's and Meta's spam checks.
- **The phone app** (`mobile/`, Expo) is a channel of its own, `src/channels/app.ts`: a WebSocket to the host, signed in with an access code per user. It streams the answer as it is written and shows tool use and reactions live. It keeps its own transcript of the bubbles and files in `.conscious/app/`, so a phone that was closed sees what it missed. With Photon running too, the app user with the same id is the same conversation, and Conscious speaks first wherever the user last wrote.
- **Telegram** is a channel of its own as well, `src/channels/telegram.ts`: the Bot API, long polled, with no SDK and no webhook, so it needs no public address either. A Telegram user is their numeric id (a username can change hands), answered only when it is on `CONSCIOUS_TELEGRAM_USERS` and only in their private chat with the bot: in a group, everyone would read the answers. The list can make an id the same user as a phone number, so Telegram, WhatsApp and the app are one conversation, and the chat book records Telegram like any other chat, so Conscious speaks first wherever the user last wrote.
- **Invites.** The users in the settings own the install. `/invite <number>`, `/invites` and `/uninvite <number>` are answered by the channel, never by the agent, so no text the agent reads can let someone in. An invited number is allowed on WhatsApp at once. On Telegram, its link (`t.me/<bot>?start=inv-…`, once, 7 days) asks for the phone number through Telegram's own share button, and only the account whose number matches is let in, as the same user as that number. Guests live in `invites.json` in the data folder.
- **Spectrum Cloud owns the numbers and lines.** WhatsApp goes through the WhatsApp Business API, so Meta's rule against general-purpose assistants applies; it is allowed in the EU while the Commission's interim order stands.

## Skills

A skill is a folder with a `SKILL.md` in the [AgentSkills](https://agentskills.io) format: a name, a one-line description, requirements, and instructions. Other agents write theirs the same way, so their skills can be copied as they are.

- **Where they live.** On the user's computer, in `skills/`. The repo's `skills/` folder is copied in the first time the process sees a user, and again when it changes; a `.bundled` file holds the hash of what was copied. A skill without that file is the user's own and is never overwritten, even when the repo has one with the same name.
- **What the agent sees.** Each turn, the system prompt lists the skills that can run on that computer, by name, path and description. The agent reads the whole `SKILL.md` before using one. A skill is hidden when a program it needs is missing, it needs a secret (the computer holds none), it is for another operating system, or it needs the internet and the computer has none. Requirements are read from `metadata.conscious`, and from the same keys under another agent's name.
- **Copied skills.** `pnpm skills:import` copies one folder at a full commit SHA and only under MIT or Apache-2.0. It records the source in `conscious.json`, keeps the project's license in `licenses/`, and the skill gets a row in `THIRD_PARTY_NOTICES.md`. With `--internet`, the skill shows only on a computer with internet. A bump to a newer commit is a reviewed diff.
- **Learned skills.** `skills_save_skill` writes a skill after work worth repeating, or fixes one that misled the agent. Every change keeps the previous version in `.history/`, and `skills_restore_version` puts one back. Saving over a bundled skill makes it the user's own.
- **A skill grants nothing.** It is instructions only. Its commands run on the computer, with the computer's limits; commits still wait for a yes.

## MCP servers

`mcp/<name>/manifest.yaml` lists a vendor-hosted MCP server: its URL, auth and tools, plus `enabled_by_default`, `default_effect` and `effects`. Being in the folder means it was reviewed in a pull request.

- At startup Conscious connects to the chosen servers (`CONSCIOUS_MCP_SERVERS`, or the catalog's defaults) and turns each into a capability with tools named `<server>_<tool>`. A server that does not answer is left out and logged.
- Calls run on the host, never on the user's computer, so a future token for the server never enters the sandbox.
- A tool's effect is the manifest's, then `read` if the server marks it read-only, then the manifest's `default_effect`, and `commit` when nothing says otherwise.
- Servers with `auth: none` connect once at start. Servers with `auth: oauth` connect per user, only after that user signs in on the Vault page: Conscious finds the server's authorization server (RFC 9728), registers itself as a client once per run (dynamic registration), sends the user there with PKCE, and keeps the tokens in the Vault under `mcp-<name>`, an id no plugin can use. Every request carries that user's token; a refused one is refreshed once, and a sign-in that can no longer be refreshed is dropped so the agent offers a new link.
- Today: Kiwi.com flights and trivago hotels (no account), Notion, Todoist, Strava and Dropbox (sign-in), AllTrails (off: its schemas cost about 24K tokens a message).

## Composio

With `COMPOSIO_API_KEY` set, the `composio` capability reaches apps Conscious has no tools for. Conscious opens one Composio session per user, under an opaque id (a hash of the user id), and keeps Composio's own connection-management tools out of it. The agent gets six tools: list apps, make a sign-in link (Composio's page), find tools for a task, and three run tools by effect. Each run tool looks up the target tool's tags first: `readOnlyHint` is a read, a `DRAFT` tool that is not destructive is a draft, anything else is a commit and waits for the user's yes. The API key stays on the host. Sign-in links send the user back to `/vault/connected` on the Vault server, a Conscious page, and `COMPOSIO_AUTH_CONFIGS` makes chosen apps sign in with the owner's own OAuth apps.

## Shop

Shopping goes through Shop MCP (shop.dev), Shopify's catalog and checkout for agents. Its server speaks MCP 2026-07-28, which has no session and no `initialize`, so the SDK's client cannot reach it: `src/shop/client.ts` sends each call as one POST that names its protocol version. It is not in the `mcp/` catalog either. Shop's 17 tools have schemas of about 17K tokens, and a search for five products returns about 28,000 characters, so the `shop` capability has eight tools of its own (about 2K tokens) and turns each answer into what the agent needs: one offer per product, prices from minor units, no store descriptions in a list.

- **Search, products, lookup** run signed out. A photo is read from the user's computer and sent as its bytes.
- **Checkouts** are drafts: one per store, no order placed, and the agent sends `continueUrl`, the store's page where the user pays. Shop replaces a checkout whole on update, so an update reads it fresh, changes only the lines, address, delivery option or codes asked for, and sends every other field back as it was. `complete_checkout` and the spend-request tools are not offered: paying waits for approvals in the chat.
- **The account** (saved addresses, orders from any store) signs in with the OAuth device flow and Shop's public client, so nobody registers an app. The Vault page shows the code and links to Shop's page, and Conscious asks Shop until the user approves. The tokens live in the Vault under `shop`, which no plugin can ask for, and are refreshed before they expire. A token Shop refuses is renewed once, else dropped; a search then goes on signed out, and the account tools offer a new link.

## Knowledge: official Italian pages

Italy is where most users live, and its bureaucracy is where a friend who knows the rules helps most. Conscious keeps a copy of the official pages listed on italiaaperta.it/fonti (ministries, INPS, Agenzia delle Entrate, regions, comuni, EU portals) and searches it like a library: the search finds pages, and the agent reads them.

- **Saving the pages.** `scripts/download-italia-fonti.py` downloads every listed page and keeps its main text as Markdown, with the source address, the office, the page's own date and the day it was saved. Bot walls and maintenance pages are detected and tried again on the next run. Comuni the list misses come from `scripts/italy-extra-sources.json`: each one's service pages, found by following the links of its services page.
- **The index** (`src/knowledge/`) is one SQLite file: the documents, their passages (cut at headings, about 1,200 characters, each with the headings above it and where it starts), a BM25 keyword index with light Italian stemming, and one vector per passage from any OpenAI-style embeddings API (Mistral, OpenAI, Ollama). `pnpm italy:index` builds it into the data folder; a rebuild embeds only passages whose text changed.
- **A search** ranks passages by keywords and by vector, fuses the two rankings by reciprocal rank, and returns pages with their best passages. Vectors are compared only when the install embeds with the model that built the index; otherwise, or when the embeddings call fails, it falls back to keywords. Vectors always return the closest pages, so each page also says how much of the query it contains, rare words weighing more; when none contains most of it, the agent is told these pages probably do not cover it and to search the web.
- **Two tools.** `italy_search_pages` returns pages with their source, dates and matching passages, each with an offset; `italy_read_page` returns a whole page in parts. The agent decides whether it knows enough, searches again, or checks the live page with `web_read_page` when an amount or a deadline may have moved since the copy.
- The index is read-only and shared by every user of the install. Calls run on the host, so it works with or without a computer.

## Plugins

Plugins let the agent reach apps it has no capability for. When you ask about one, it looks at the plugins on your install and installs a match. If nothing fits, it writes a plugin itself. A plugin it writes stays on your install, for you only.

**A plugin** is a manifest (id, version, the hosts it calls, the account it acts as, its tools with an effect each), one ES module with no imports, a short `SKILL.md`, and a test per tool with recorded responses. Installed plugin tools join the agent's tools like any capability's, and their `effect` is enforced the same way: a `commit` waits for your yes.

**Safety comes from what a plugin can reach.**

- **The sandbox.** Each call runs in a short-lived Node process under the permission model: no files, no child processes, no environment, a small heap, a deadline. Sockets are closed before the plugin loads. In production this becomes a hosted sandbox with no network at all.
- **The broker.** `ctx.http` is the plugin's only way out. The host checks every request: https, a declared host, GET only for a `read` tool. It adds your token itself, only for the connector's own hosts, so plugin code never holds it. A plugin that acts as your account may only call that account's hosts, so it cannot carry what it reads elsewhere.
- **Review before anyone else runs it.** The manifest is valid, the code passes a tripwire scan, it exports exactly the tools it declares, and every tool's test passes in the sandbox against recorded responses.
- **Quarantine.** A plugin that tries an undeclared host at runtime is disabled at once, even if it caught the refusal.
- **Pinned versions.** An install pins the content hash. A new version reaches you only when you install it again.

**Where plugins come from.** `bundled` plugins ship in the repository's `plugins/` folder; each was reviewed as a pull request, and every user of an install can use them. `agent` plugins are the ones the agent wrote on this install; only the user it wrote them for can install them. There is no shared catalog: to give a plugin to everyone who runs Conscious, open a pull request that adds its folder.

## The Vault

Secrets never pass through the chat. When a plugin needs an account you have not connected, the agent sends a **Vault link**: a private page, single-use, valid 15 minutes. You paste the token there; Conscious checks it with the service, seals it (AES-256-GCM) and tells you in the chat that you are connected. Sealed secrets are saved in `.conscious/vault.json`. The key is `CONSCIOUS_VAULT_KEY`, or one created on first start in `.conscious/vault.key` (owner-only); in production the key belongs in a secret manager, not beside the data.

- The model sees which accounts are connected, never a secret. The broker adds the token to a plugin's request at the moment of the call, only for that connector's hosts.
- The code in the link is the only thing that grants access. Five rejected tokens retire it.
- The page has a strict content security policy, no caching, no referrer, and cannot be framed.
- Each connector says where to get its token, which hosts it goes to, which header carries it, and how to check it.
- **The agent can define a connector itself.** Built-in connectors live in `src/plugins/connectors.ts` (GitHub today). For any other service with an API key or personal token, the agent reads the service's docs and defines the connector inside its plugin's `auth`: name, hosts, how-to link and steps, a verify URL on one of the hosts, and the header. Review checks it: public hosts only, https, the verify URL on the connector's hosts, no reserved header, and a built-in id cannot be redefined.
- **The hosts you see are what you approve.** The Vault page lists the hosts the token will go to, and warns you when Conscious wrote the connection itself. The Vault stores those hosts with the sealed token. At every call the plugin's hosts must all be approved hosts; if not, the agent is told to get a fresh link. So a second plugin that reuses a connector id with an extra host cannot carry your token there.
- **Sign-in by redirect.** The Vault page sends the user to the provider with the link's code as `state`, and the callback at `/vault/oauth/<connector>` keeps what the provider gives back. Google uses the install's own OAuth client; MCP servers register Conscious themselves. The capabilities that use them run on the host and refresh tokens themselves, and a plugin can never use these connectors.

## Next, in order

1. **Durable storage.** With a computer, the conversation and memory survive restarts in the user's sandbox; without one, the conversation is saved in `.conscious/conversations/`. The Vault, plugins, installs, reminders and the chat each user writes from are saved in `.conscious/` on the host. Background tasks are saved in `.conscious/background.json`, and one a restart interrupted starts over once.
2. **Approvals in the chat.** A `commit` becomes a Yes / No question (an iMessage poll or mini-app, a typed yes on WhatsApp); only the answer runs it.
3. **More sign-in on the Vault page.** Open banking (EU PSD2 aggregators).
4. **An egress proxy for the computer**, so skills can reach only the hosts the user approved, with the Vault adding tokens on the way out instead of the computer holding them.
5. **Memory, better.** Today it is `memory/MEMORY.md` in the sandbox, written by the agent and read into every prompt. Next: search over older notes when the index outgrows the prompt.
6. **Tracing** with Langfuse, one trace per message, sub-agents as child agents.
7. **A stronger plugin sandbox:** run plugin calls in a container or microVM with no network, for installs with many users.
