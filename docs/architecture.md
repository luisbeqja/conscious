# Architecture

## The idea

1. **One orchestrator per user, many capability packs.** The orchestrator is the agent you chat with. Each area of life (reminders, calendar, email, travel, music) is a pack: tools plus a short `SKILL.md` on how to use them.
2. **Long work goes to background agents.** The orchestrator hands a sub-agent a written brief and answers you at once. The sub-agent runs its own loop with its own tools and messages you when it is done. The next time you write, the orchestrator is told what finished. Depth is one: a sub-agent cannot start another.
3. **Reminders are cron jobs.** One-off or recurring, read in your timezone, sent to you as a normal WhatsApp message.
4. **Connectors bring in your life.** A connector is a link to one of your accounts. A pack that needs one is invisible until you connect it. Tokens never reach the model.
5. **A computer for what no API covers.** A disposable sandbox with a browser, behind the `Sandbox` seam. Not built yet.
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

1. Meta posts to `/webhooks/whatsapp`. The signature is checked; numbers not on the allow-list are ignored.
2. The orchestrator queues it behind any message still being answered for that user, and skips one it has already handled (Meta redelivers).
3. It loads the conversation, builds the turn (the time in your timezone, background tasks that finished or are still running, your text), and runs the loop with the packs available to you.
4. The answer goes back on WhatsApp, split under the 4096-character limit, and the conversation is saved.

## Next, in order

1. **Durable storage.** Conversations, reminders and background tasks live in memory today; a restart forgets them. A store (Postgres or Mongo) that re-arms reminders on boot.
2. **Approvals on WhatsApp.** A `commit` becomes an interactive message with Yes / No buttons; only the tap runs it.
3. **Google Calendar connector** with OAuth (the pack is already written against the `CalendarConnector` interface). Then Gmail, Linear, GitHub, Spotify.
4. **Memory.** What Conscious knows about you (people, preferences, routines), separate from the transcript.
5. **Voice notes and photos** in, read with transcription and vision.
6. **The sandbox:** a hosted browser for booking, forms and price checks.
7. **Tracing** with Langfuse, one trace per message, sub-agents as child agents.
