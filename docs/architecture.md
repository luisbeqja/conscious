# Architecture

Conscious is open source and self-hosted. Whoever runs it picks the model and keeps the data: the Vault, plugins and installs live in the install's own data folder, and memory and conversations live in each user's computer (an E2B sandbox, hosted or self-run). There is no Conscious server that sees any of it.

## The idea

1. **One orchestrator per user, many capability packs.** The orchestrator is the agent you chat with. Each area of life (reminders, calendar, email, travel, music) is a pack: tools plus a short `SKILL.md` on how to use them.
2. **Long work goes to background agents.** The orchestrator hands a sub-agent a written brief and answers you at once. The sub-agent runs its own loop with its own tools and messages you when it is done. The next time you write, the orchestrator is told what finished. Depth is one: a sub-agent cannot start another.
3. **Reminders are cron jobs.** One-off or recurring, read in your timezone, sent to you as a normal message. A scheduled check is a reminder with a job: when it fires, an agent does the job and messages you only if it found something. Both are saved in `.conscious/reminders.json` and re-armed at start.
4. **Connectors bring in your life.** A connector is a link to one of your accounts. A pack that needs one is invisible until you connect it. Tokens never reach the model.
5. **A computer for what no API covers.** A disposable sandbox with a browser. Not built yet.
6. **Safety is code, not prompt.** Every tool is `read`, `draft` or `commit`. A `commit` (send, book, pay, delete) never runs without your explicit yes. Until approvals exist, commits are blocked outright.

## Building blocks

| Piece | What it is |
|---|---|
| The loop | `pi-agent-core`, behind `engine/run-agent.ts`. One loop, used by the orchestrator and every sub-agent. |
| Capability packs | Tools named `<id>_<verb>_<noun>` plus a `SKILL.md` on how to use them. |
| Effects | Every tool is `read`, `draft` or `commit`. A commit will become a yes/no the user answers. |
| Background agents | Sub-agents with a written brief. They outlive the turn and report to the user directly. |
| Budgets | Turns and tool calls are capped per message. |
| Conversations | One conversation per user, no threads. |
| Connectors | The user's own accounts, linked one by one. |
| Skills | `SKILL.md` instructions on the user's computer: copied from the repo, or written by the agent. |
| MCP servers | Vendor-hosted tool servers from a reviewed catalog, called from the host. |
| Plugins | Apps without a capability: bundled with Conscious or written by the agent on your install, run in a sandbox. |
| Vault | Your secrets, saved through a private page and sealed. Only the broker reads them. |

## A message, end to end

1. The terminal, or Photon (iMessage and WhatsApp), hands the orchestrator your text. It waits behind any message still being answered for you.
2. The orchestrator loads the conversation, builds the turn (the time in your timezone, background tasks that finished or are still running, your text), and runs the loop with the packs available to you.
3. The answer streams back as it is written, tool calls shown as they start, and the conversation is saved.
4. Reminders and finished background tasks reach you through `notify`, the one way Conscious speaks first.

## Channels

Conscious reaches people through [Photon Spectrum](https://photon.codes/spectrum): one SDK and one message stream for iMessage and WhatsApp. `src/channels/photon.ts` is the only code that knows about it.

- **A user is their sender id** (phone number or Apple ID), so the same person on iMessage and WhatsApp is one conversation. Only ids on `CONSCIOUS_ALLOWED_USERS` are answered.
- **Replies and notifications go to the chat the user last wrote from.** Nobody is messaged before they write first, which also keeps the numbers looking like normal chats to Apple's and Meta's spam checks.
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
- Today: Kiwi.com flights and trivago hotels (on by default), AllTrails (off: its schemas cost about 24K tokens a message). Servers that need a sign-in (Todoist, Notion, Strava) wait for OAuth 2.1 on the Vault page.

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
- **Sign-in by redirect.** Google uses the install's own OAuth client: the Vault page sends the user to Google with the link's code as `state`, and the callback keeps the refresh token. The `google` capability runs on the host, refreshes access tokens itself, and a plugin can never use that connector. Open banking and OAuth MCP servers come next on the same page.

## Next, in order

1. **Durable storage.** With a computer, the conversation and memory survive restarts in the user's sandbox; without one, the conversation is saved in `.conscious/conversations/`. The Vault, plugins, installs, reminders and the chat each user writes from are saved in `.conscious/` on the host. Background tasks still live in memory; a restart forgets them.
2. **Approvals in the chat.** A `commit` becomes a Yes / No question (an iMessage poll or mini-app, a typed yes on WhatsApp); only the answer runs it.
3. **More sign-in on the Vault page.** OAuth 2.1 with dynamic registration for MCP servers (Todoist, Notion, Strava, Dropbox), and Spotify with the install's own client, like Google.
4. **An egress proxy for the computer**, so skills can reach only the hosts the user approved, with the Vault adding tokens on the way out instead of the computer holding them.
5. **Memory, better.** Today it is `memory/MEMORY.md` in the sandbox, written by the agent and read into every prompt. Next: search over older notes when the index outgrows the prompt.
6. **Voice notes and photos** in, read with transcription and vision.
7. **A browser in the sandbox** for booking, forms and price checks, with internet scoped so reads and commits stay apart.
8. **Tracing** with Langfuse, one trace per message, sub-agents as child agents.
9. **A stronger plugin sandbox:** run plugin calls in a container or microVM with no network, for installs with many users.
