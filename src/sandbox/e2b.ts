import { createHash } from "node:crypto";
import { ALL_TRAFFIC, CommandExitError, Sandbox as E2BSandbox, type EntryInfo, FileType } from "e2b";
import { type CommandResult, type FileEntry, resolvePath, type Sandbox, type SandboxProvider } from "./sandbox.js";

export interface E2BOptions {
    apiKey: string;
    /** The E2B EU cluster, or a self-hosted E2B. Unset means E2B's default cloud. */
    domain?: string;
    /** An outbound HTTPS proxy, for hosts that cannot reach E2B directly. */
    proxy?: string;
    template: string;
    /** Idle time before the sandbox pauses. Pausing keeps its files and memory. */
    idleMs: number;
    internet: boolean;
}

/** The part of E2B's SDK Conscious uses, so tests can stand in for it. */
export interface E2BClient {
    find(metadata: Record<string, string>): Promise<string | undefined>;
    create(metadata: Record<string, string>): Promise<E2BInstance>;
    connect(sandboxId: string): Promise<E2BInstance>;
}

export type E2BInstance = Pick<E2BSandbox, "sandboxId" | "commands" | "files" | "setTimeout">;

const HOME = "/home/user";
// Reconnect a little before the idle timeout, in case E2B paused it while we were not looking.
const RECONNECT_MARGIN_MS = 60_000;

export const createE2BClient = (options: E2BOptions): E2BClient => {
    const connection = { apiKey: options.apiKey, domain: options.domain, proxy: options.proxy };
    return {
        find: async (metadata) => {
            const [found] = await E2BSandbox.list({ ...connection, query: { metadata }, limit: 1 }).nextItems();
            return found?.sandboxId;
        },
        create: (metadata) =>
            E2BSandbox.create(options.template, {
                ...connection,
                metadata,
                timeoutMs: options.idleMs,
                lifecycle: { onTimeout: "pause" },
                allowInternetAccess: options.internet,
                // Nothing from the host's environment goes in: no API keys, no tokens.
                envs: {},
            }),
        connect: async (sandboxId) => {
            const sandbox = await E2BSandbox.connect(sandboxId, { ...connection, timeoutMs: options.idleMs });
            // Internet is set when a computer is created; setting it again here lets a change of
            // CONSCIOUS_SANDBOX_INTERNET reach computers that already exist.
            await sandbox
                .updateNetwork(options.internet ? {} : { denyOut: [ALL_TRAFFIC] })
                .catch((error: unknown) => console.warn(`[e2b] could not set internet access on ${sandboxId}`, error));
            return sandbox;
        },
    };
};

/** Users are phone numbers or emails; E2B only ever sees a hash of them. */
export const userKey = (userId: string): string => createHash("sha256").update(userId).digest("hex").slice(0, 32);

/**
 * One E2B sandbox per user, found again by metadata after a restart. It pauses itself when idle
 * and resumes on the next message, so files and memory survive without anything running.
 */
export class E2BSandboxes implements SandboxProvider {
    private readonly open = new Map<string, { instance: Promise<E2BInstance>; usedAt: number }>();

    constructor(
        private readonly client: E2BClient,
        private readonly idleMs: number,
        private readonly now: () => number = Date.now,
    ) {}

    async forUser(userId: string): Promise<Sandbox> {
        const cached = this.open.get(userId);
        const fresh = cached && this.now() - cached.usedAt < this.idleMs - RECONNECT_MARGIN_MS;
        const instance = fresh ? cached.instance : this.attach(userId, cached?.instance);
        this.open.set(userId, { instance, usedAt: this.now() });
        try {
            const sandbox = await instance;
            if (fresh) await sandbox.setTimeout(this.idleMs);
            return new E2BUserSandbox(sandbox);
        } catch (error) {
            this.open.delete(userId);
            throw error;
        }
    }

    async shutdown(): Promise<void> {
        // E2B pauses each sandbox on its own timeout; dropping the handles is all there is to do.
        this.open.clear();
    }

    private async attach(userId: string, previous?: Promise<E2BInstance>): Promise<E2BInstance> {
        const known = await previous?.catch(() => undefined);
        const metadata = { conscious: userKey(userId) };
        const sandboxId = known?.sandboxId ?? (await this.client.find(metadata));
        // Connecting resumes a paused sandbox.
        return sandboxId ? this.client.connect(sandboxId) : this.client.create(metadata);
    }
}

const toEntry = (entry: EntryInfo): FileEntry => ({
    name: entry.name,
    type: entry.type === FileType.DIR ? "dir" : "file",
    size: entry.size,
});

class E2BUserSandbox implements Sandbox {
    readonly home = HOME;

    constructor(private readonly instance: E2BInstance) {}

    async run(command: string, options: { cwd?: string; timeoutMs?: number } = {}): Promise<CommandResult> {
        try {
            const result = await this.instance.commands.run(command, {
                cwd: resolvePath(this.home, options.cwd ?? "."),
                timeoutMs: options.timeoutMs,
            });
            return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
        } catch (error) {
            // A non-zero exit is an answer, not a failure.
            if (error instanceof CommandExitError) {
                return { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr };
            }
            throw error;
        }
    }

    async readFile(path: string): Promise<string | undefined> {
        const absolute = resolvePath(this.home, path);
        if (!(await this.instance.files.exists(absolute))) return undefined;
        return this.instance.files.read(absolute);
    }

    async readBytes(path: string): Promise<Uint8Array | undefined> {
        const absolute = resolvePath(this.home, path);
        if (!(await this.instance.files.exists(absolute))) return undefined;
        return this.instance.files.read(absolute, { format: "bytes" });
    }

    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
        const data =
            typeof content === "string"
                ? content
                : (content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer);
        await this.instance.files.write(resolvePath(this.home, path), data);
    }

    async listFiles(path: string): Promise<FileEntry[]> {
        return (await this.instance.files.list(resolvePath(this.home, path))).map(toEntry);
    }
}
