# Architecture

Conscious is a personal assistant for daily life, not work, and it should feel like a friend: it remembers you and the people in your life, follows up, and knows when to stay quiet. It is open source and self-hosted. Whoever runs it picks the model and keeps the data: the Vault, plugins and installs live in the install's own data folder, and memory and conversations live there too, or in each user's computer (an E2B sandbox, hosted or self-run) when there is one. There is no Conscious server that sees any of it.

## The idea

1. **One orchestrator per user, many capability packs.** The orchestrator is the agent you chat with. Each area of life (reminders, calendar, email, travel, music) is a pack: tools plus a short `SKILL.md` on how to use them.
2. **Long work goes to background agents.** The orchestrator designs a sub-agent for the job (a method, the packs it needs, how long it may take, and parts that run side by side) and answers you at once. You keep chatting: the orchestrator sees each task's progress and can pass it a change of plan. The sub-agent may text you a first find, then messages you its result. Tasks are saved in `.conscious/background.json`; a restart starts an interrupted one over, once. Depth is one: a sub-agent cannot start another.
3. **Reminders are cron jobs.** One-off or recurring, read in your timezone, sent to you as a normal message. A scheduled check is a reminder with a job: when it fires, an agent does the job and messages you only if it found something. Both are saved in `.conscious/reminders.json` and re-armed at start.
4. **Connectors bring in your life.** A connector is a link to one of your accounts. A pack that needs one is invisible until you connect it. Tokens never reach the model.
5. **A computer for what no API covers.** A disposable sandbox with a browser. Not built yet.
6. **Memory is not the transcript.** What Conscious knows about you and the people in your life is kept apart from the conversation, read into every prompt, and yours to see and delete.
7. **Speaking first is rationed in code.** What Conscious sends on its own waits out the night and stops at a daily limit. A friend who texts too much is worse than one who never does.
8. **Safety is code, not prompt.** Every tool is `read`, `draft` or `commit`. A `commit` (send, book, pay, delete) never runs without your explicit yes. Until approvals exist, commits are blocked outright.

## Building blocks

| Piece | What it is |
|---|---|
| The loop | `pi-agent-core`, behind `engine/run-agent.ts`. One loop, used by the orchestrator and every sub-agent. |
| Capability packs | Tools named `<id>_<verb>_<noun>` plus a `SKILL.md` on how to use them. |
| Effects | Every tool is `read`, `draft` or `commit`. A commit will become a yes/no the user answers. |
| Background agents | Sub-agents with a written brief and a harness designed for the job (instructions, packs, effort, parallel parts). They outlive the turn, can text an update, take a change of plan, and report to the user directly. |
| Budgets | Turns and tool calls are capped per message. |
| Conversations | One conversation per user, no threads. |
| Connectors | The user's own accounts, linked one by one. |
| Skills | `SKILL.md` instructions on the user's computer: copied from the repo, or written by the agent. |
| MCP servers | Vendor-hosted tool servers from a reviewed catalog, called from the host. |
| Memory | Facts about the user and the people in their life, with birthdays. On the host's disk, or on the user's computer. |
| Pacing | Quiet hours, a daily limit and a pause for the messages Conscious sends on its own. |
| Composio | Optional: more everyday apps through Composio's hosted tool router, which holds each user's sign-ins. Work apps are refused. |
| Plugins | Apps without a capability: bundled with Conscious or written by the agent on your install, run in a sandbox. |
| Vault | Your secrets, saved through a private page and sealed. Only the broker reads them. |

## A message, end to end

1. The terminal, the phone app, or Photon (iMessage and WhatsApp), hands the orchestrator your text. It waits behind any message still being answered for you.
2. The orchestrator loads the conversation, builds the turn (the time in your timezone, background tasks that finished or are still running, your text), and runs the loop with the packs available to you.
3. The answer streams back as it is written, tool calls shown as they start, and the conversation is saved.
4. Reminders and finished background tasks reach you through `notify`, the one way Conscious speaks first.

## Memory and speaking first

- **Memory** (`src/memory/`, `capabilities/memory/`) holds two lists: facts about the user, and people (name, relation, birthday, notes). It is a JSON file per user: `.conscious/memory/<hash>.json` on the host, or `memory/memory.json` on the user's computer. Every prompt carries it with an id per line, so the agent can forget one. Older free-form notes in `memory/MEMORY.md` are shown too, until the agent moves them over.
- **The first meeting.** While memory is empty, the system prompt adds `prompts/first-meeting.md`: say hi, ask their name, offer to look them up online. The look-up is a background task with a brief written from the memory skill: public pages only, no addresses, money or health, and it asks when two people share a name. Nothing it finds is saved until the user confirms it.
- **Birthdays and follow-ups** are scheduled checks marked `unprompted`: a birthday arms one a week before and one on the day, and `reminders_follow_up` arms one after an event the user mentioned. Each runs the agent with memory, so the words fit what Conscious knows by then.
- **Pacing** (`scheduler/pacing.ts`) runs before any reminder fires. A plain reminder the user set always goes. An unprompted one inside quiet hours is moved to their end, and past the daily limit it is dropped. While the user paused messages (`quiet_pause_messages`), unprompted ones and scheduled checks are dropped. The pause and the day's count are kept in `.conscious/pacing.json`.
- **Bubbles.** On iMessage and WhatsApp, a reply of two to four short paragraphs goes out as that many messages, with a short pause between them.

## Channels

Conscious reaches people through [Photon Spectrum](https://photon.codes/spectrum): one SDK and one message stream for iMessage and WhatsApp. `src/channels/photon.ts` is the only code that knows about it.

- **A user is their sender id** (phone number or Apple ID), so the same person on iMessage and WhatsApp is one conversation. Only ids on `CONSCIOUS_ALLOWED_USERS` are answered.
- **Replies and notifications go to the chat the user last wrote from.** Nobody is messaged before they write first, which also keeps the numbers looking like normal chats to Apple's and Meta's spam checks.
- **The phone app** (`mobile/`, Expo) is a channel of its own, `src/channels/app.ts`: a WebSocket to the host, signed in with an access code per user. It streams the answer as it is written and shows tool use and reactions live. It keeps its own transcript of the bubbles and files in `.conscious/app/`, so a phone that was closed sees what it missed. With Photon running too, the app user with the same id is the same conversation, and Conscious speaks first wherever the user last wrote.
- **Spectrum Cloud owns the numbers and lines.** WhatsApp goes through the WhatsApp Business API, so Meta's rule against general-purpose assistants applies; it is allowed in the EU while the Commission's interim order stands.

## Skills

A skill is a folder with a `SKILL.md` in the [AgentSkills](https://agentskills.io) format: a name, a one-line description, requirements, and instructions. Other agents write theirs the same way, so their skills can be copied as they are.

- **Where they live.** On the user's computer, in `skills/`. The repo's `skills/` folder is copied in the first time the process sees a user, and again when it changes; a `.bundled` file holds the hash of what was copied. A skill without that file is the user's own and is never overwritten, even when the repo has one with the same name.
- **What the agent sees.** Each turn, the system prompt lists the skills that can run on that computer, by name, path and description. The agent reads the whole `SKILL.md` before using one. A skill is hidden when a program it needs is missing, it needs a secret (the computer holds none), it is for another operating system, or it needs the internet and the computer has none. Requirements are read from `metadata.conscious`, and from the same keys under another agent's name.
- **Copied skills.** `pnpm skills:import` copies one folder at a full commit SHA and only under MIT or Apache-2.0. With `--internet` it writes `conscious.json` so the skill shows only on a computer with internet. A bump to a newer commit is a reviewed diff.
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
6. **A browser in the sandbox** for booking, forms and price checks, with internet scoped so reads and commits stay apart.
7. **Tracing** with Langfuse, one trace per message, sub-agents as child agents.
8. **A stronger plugin sandbox:** run plugin calls in a container or microVM with no network, for installs with many users.
