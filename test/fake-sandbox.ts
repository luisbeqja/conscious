import { posix } from "node:path";
import type { CommandResult, FileEntry, Sandbox, SandboxProvider } from "../src/sandbox/sandbox.js";
import { resolvePath } from "../src/sandbox/sandbox.js";

/** A sandbox made of a Map: files only, and commands answered by a script. */
export class FakeSandbox implements Sandbox {
    readonly home = "/home/user";
    readonly files = new Map<string, string>();
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

    async writeFile(path: string, content: string): Promise<void> {
        this.files.set(resolvePath(this.home, path), content);
    }

    async listFiles(path: string): Promise<FileEntry[]> {
        const dir = resolvePath(this.home, path);
        return [...this.files]
            .filter(([file]) => posix.dirname(file) === dir)
            .map(([file, content]) => ({ name: posix.basename(file), type: "file", size: content.length }));
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
