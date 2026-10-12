import { Hono } from "hono";
import { BackgroundAgents } from "./agents/background-agents.js";
import { createRegistry } from "./capabilities/index.js";
import { type Channel, ConsoleChannel } from "./channels/channel.js";
import { WhatsAppChannel } from "./channels/whatsapp/client.js";
import { whatsappWebhook } from "./channels/whatsapp/webhook.js";
import type { Config } from "./config.js";
import { InMemoryConversationStore } from "./conversations/store.js";
import { createModelRuntime } from "./engine/models.js";
import { Orchestrator } from "./engine/orchestrator.js";
import { Scheduler } from "./scheduler/scheduler.js";

/** Composition root: which implementation sits behind each seam. */
export const createApp = (config: Config) => {
    const channel: Channel = config.whatsapp ? new WhatsAppChannel(config.whatsapp) : new ConsoleChannel();
    const scheduler = new Scheduler((reminder) => channel.send(reminder.userId, reminder.text));
    // The runner is called only after startup, once `orchestrator` exists.
    const background: BackgroundAgents = new BackgroundAgents(
        (task, signal): Promise<string> => orchestrator.runBackgroundTask(task, signal),
        (userId, text) => channel.send(userId, text),
        config.budgets.maxBackgroundAgents,
    );
    const orchestrator = new Orchestrator({
        registry: createRegistry({}),
        store: new InMemoryConversationStore(),
        channel,
        runtime: createModelRuntime(config.model.provider, config.model.id),
        budgets: config.budgets,
        timezone: config.timezone,
        scheduler,
        background,
    });

    const app = new Hono();
    app.get("/health", (c) => c.json({ ok: true }));
    if (config.whatsapp) {
        app.route(
            "/webhooks/whatsapp",
            whatsappWebhook(config.whatsapp, (message) => {
                if (!config.allowedNumbers.has(message.userId)) return;
                void orchestrator.receive(message);
            }),
        );
    }
    // Talk to Conscious without WhatsApp: replies print to the console. Never on in production.
    if (process.env.NODE_ENV !== "production") {
        app.post("/dev/messages", async (c) => {
            const { userId = "dev", text } = await c.req.json<{ userId?: string; text: string }>();
            await orchestrator.receive({ userId, messageId: crypto.randomUUID(), text, receivedAt: new Date() });
            return c.json({ ok: true });
        });
    }
    return { app, scheduler };
};
