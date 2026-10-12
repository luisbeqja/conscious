# Architecture

## The idea

1. **One orchestrator per user, many capability packs.** The orchestrator is the agent you chat with. Each area of life (reminders, calendar, email, travel, music) is a pack: tools plus a short `SKILL.md` on how to use them.
2. **Long work goes to background agents.** The orchestrator hands a sub-agent a written brief and answers you at once. The sub-agent runs its own loop with its own tools and messages you when it is done. The next time you write, the orchestrator is told what finished. Depth is one: a sub-agent cannot start another.
3. **Reminders are cron jobs.** One-off or recurring, read in your timezone, sent to you as a normal message.
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

## A message, end to end

1. The terminal (later WhatsApp) hands the orchestrator your text. It waits behind any message still being answered for you.
2. The orchestrator loads the conversation, builds the turn (the time in your timezone, background tasks that finished or are still running, your text), and runs the loop with the packs available to you.
3. The answer streams back as it is written, tool calls shown as they start, and the conversation is saved.
4. Reminders and finished background tasks reach you through `notify`, the one way Conscious speaks first.

## Next, in order

1. **WhatsApp.** A webhook in, the Cloud API out, an allow-list of numbers. The orchestrator already knows nothing about the terminal.
2. **Durable storage.** Conversations, reminders and background tasks live in memory today; a restart forgets them. A store (Postgres or Mongo) that re-arms reminders on boot.
3. **Approvals on WhatsApp.** A `commit` becomes an interactive message with Yes / No buttons; only the tap runs it.
4. **Google Calendar connector** with OAuth. Then Gmail, Linear, GitHub, Spotify.
5. **Memory.** What Conscious knows about you (people, preferences, routines), separate from the transcript.
6. **Voice notes and photos** in, read with transcription and vision.
7. **The sandbox:** a hosted browser for booking, forms and price checks.
8. **Tracing** with Langfuse, one trace per message, sub-agents as child agents.
