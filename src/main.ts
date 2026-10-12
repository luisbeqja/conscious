import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app, scheduler } = createApp(config);
const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
    console.log(`Conscious listening on :${port}${config.whatsapp ? "" : " (no WhatsApp number: replies print here)"}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        scheduler.stopAll();
        server.close(() => process.exit(0));
    });
}
