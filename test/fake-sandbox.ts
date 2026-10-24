import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { CommandResult, FileEntry, Sandbox, SandboxProvider } from "../src/sandbox/sandbox.js";
import { resolvePath } from "../src/sandbox/sandbox.js";

/** A sandbox made of a Map: files only, and commands answered by a script. */
export class FakeSandbox implements Sandbox {
    readonly id = randomUUID();
    readonly home = "/home/user";
    readonly files = new Map<string, string>();
    readonly bytes = new Map<string, Uint8Array>();
    readonly commands: string[] = [];

    constructor(
        private readonly answer: (command: string) => CommandResult = () => ({ exitCode: 0, stdout: "", stderr: "" }),
    ) {}

    async run(command: string): Promise<CommandResult> {
        this.commands.push(command);
        return this.answer(command);
    }

    async readFile(path: string): Promise<string | undefined> {
        return this.files.get(resolvePath(this.home, path));
    }

    async readBytes(path: string): Promise<Uint8Array | undefined> {
        const absolute = resolvePath(this.home, path);
        const text = this.files.get(absolute);
        return this.bytes.get(absolute) ?? (text === undefined ? undefined : new TextEncoder().encode(text));
    }

    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
        const absolute = resolvePath(this.home, path);
        if (typeof content === "string") this.files.set(absolute, content);
        else this.bytes.set(absolute, content);
    }

    async listFiles(path: string): Promise<FileEntry[]> {
        const dir = resolvePath(this.home, path);
        const files: FileEntry[] = [...this.files]
            .filter(([file]) => posix.dirname(file) === dir)
            .map(([file, content]) => ({ name: posix.basename(file), type: "file", size: content.length }));
        const dirs = new Set(
            [...this.files.keys()]
                .filter((file) => file.startsWith(`${dir}/`) && posix.dirname(file) !== dir)
                .map((file) => file.slice(dir.length + 1).split("/")[0] ?? ""),
        );
        return [...files, ...[...dirs].map((name): FileEntry => ({ name, type: "dir", size: 0 }))];
    }
}

export class FakeSandboxes implements SandboxProvider {
    readonly sandboxes = new Map<string, FakeSandbox>();

    async forUser(userId: string): Promise<FakeSandbox> {
        const sandbox = this.sandboxes.get(userId) ?? new FakeSandbox();
        this.sandboxes.set(userId, sandbox);
        return sandbox;
    }

    async shutdown(): Promise<void> {}
}
