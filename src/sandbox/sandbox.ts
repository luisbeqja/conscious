import { posix } from "node:path";

export interface CommandResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

export interface FileEntry {
    name: string;
    type: "file" | "dir";
    size: number;
}

/**
 * The user's own computer: where everything Conscious knows about them lives (memory, files,
 * the conversation) and where its shell and file tools run. Secrets never enter it: account
 * tokens stay on the host.
 */
export interface Sandbox {
    /** Names this computer. One made to replace it, after it was deleted, has a new id. */
    readonly id: string;
    /** Absolute home directory. Relative paths resolve against it. */
    readonly home: string;
    run(command: string, options?: { cwd?: string; timeoutMs?: number }): Promise<CommandResult>;
    /** Undefined when the file does not exist. */
    readFile(path: string): Promise<string | undefined>;
    /** Undefined when the file does not exist. For files that are not text: photos, PDFs. */
    readBytes(path: string): Promise<Uint8Array | undefined>;
    /** Creates missing parent directories. */
    writeFile(path: string, content: string | Uint8Array): Promise<void>;
    listFiles(path: string): Promise<FileEntry[]>;
}

/** One sandbox per user, kept between messages. A backend decides where it runs. */
export interface SandboxProvider {
    forUser(userId: string): Promise<Sandbox>;
    /** Let go of every sandbox; their state stays for next time. */
    shutdown(): Promise<void>;
}

export const resolvePath = (home: string, path: string): string => posix.resolve(home, path || ".");
