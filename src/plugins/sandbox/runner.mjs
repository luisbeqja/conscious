// Runs one plugin tool call in a child process started with Node's permission model:
// no files, no child processes, no workers, an empty environment. The permission model does
// not cover sockets, so they are closed here before the plugin loads, and its only way out
// is `ctx.http`, which the host's broker checks and signs. This is the local sandbox; a hosted
// one (no network at all) replaces it in production.
import dgram from "node:dgram";
import dns from "node:dns";
import net from "node:net";

const closed = () => {
    throw new Error("Plugins have no direct network access. Use ctx.http.");
};
net.Socket.prototype.connect = closed;
dgram.Socket.prototype.send = closed;
dgram.Socket.prototype.bind = closed;
dns.lookup = closed;
dns.resolve = closed;
dns.promises.lookup = closed;
dns.promises.resolve = closed;
for (const name of ["fetch", "WebSocket", "EventSource"]) {
    Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
}
Object.freeze(net.Socket.prototype);
Object.freeze(dgram.Socket.prototype);
Object.freeze(dns.promises);
Object.freeze(dns);

const send = process.send.bind(process);
const pending = new Map();
let nextId = 0;

const http = (request) =>
    new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        send({ type: "http", id, request });
    });

const fail = (error) => {
    const message = error instanceof Error ? error.message : String(error);
    send({ type: "result", ok: false, error: message.slice(0, 2_000) }, () => process.exit(0));
};

process.on("message", async (message) => {
    if (message.type === "http") {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error));
        else waiter?.resolve(message.response);
        return;
    }
    if (message.type !== "call") return;
    try {
        const module = await import(`data:text/javascript;base64,${Buffer.from(message.code).toString("base64")}`);
        const tools = module.tools ?? {};
        if (message.tool === null) {
            const exported = Object.keys(tools).filter((name) => typeof tools[name] === "function");
            send({ type: "result", ok: true, data: exported }, () => process.exit(0));
            return;
        }
        const tool = tools[message.tool];
        if (typeof tool !== "function") throw new Error(`The plugin does not export a tool "${message.tool}"`);
        const data = await tool(message.params, Object.freeze({ http }));
        send({ type: "result", ok: true, data: data ?? null }, () => process.exit(0));
    } catch (error) {
        fail(error);
    }
});
