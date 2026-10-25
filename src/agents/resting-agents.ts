import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import type { SandboxProvider } from "../sandbox/sandbox.js";

/** An agent is named for the kind of job it does: flights, gift-ideas, apartment-search. */
export const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Where agents live on the user's computer. */
export const AGENTS_DIR = "agents";

/** Past this the agent is asked to shorten its notebook, and the prompt shows only this much. */
export const MAX_NOTES_CHARS = 4_000;

/**
 * An agent kept after its job: the method the orchestrator designed for it, a notebook of what
 * it learned, and a line per job. It runs only while it has a job; in between it is these files.
 */
export interface RestingAgent {
    name: string;
    /** One line: the kind of job it does. */
    description: string;
    /** The capability ids it works with. All of them when empty. */
    capabilities: string[];
    /** How it does the job, written by the orchestrator when it made the agent. */
    method: string;
    /** YYYY-MM-DD, in the user's timezone. */
    created: string;
    jobs: number;
    /** YYYY-MM-DD of its last job. */
    last?: string;
}

export type NewAgent = Omit<RestingAgent, "jobs" | "last">;

/** One finished job, as the agent's log keeps it. */
export interface AgentRun {
    /** YYYY-MM-DD */
    date: string;
    taskId: string;
    title: string;
    brief: string;
    /** "done", or why it did not finish. */
    status: string;
    /** What the user was sent, in order. */
    sent: readonly string[];
    /** What the agent wrote at the end, for itself and the chat: what it found and did not send. */
    notes?: string;
}

/** An agent's files, under its own folder name, on the user's computer or the host's disk. */
interface AgentFiles {
    read(path: string): Promise<string | undefined>;
    write(path: string, content: string): Promise<void>;
    /** The agent folders there are. */
    folders(): Promise<string[]>;
    /** Removes one agent's folder, or every agent's when no name is given. */
    remove(name?: string): Promise<void>;
}

const onComputer = (sandboxes: SandboxProvider, userId: string): AgentFiles => {
    const sandbox = () => sandboxes.forUser(userId);
    return {
        read: async (path) => (await sandbox()).readFile(`${AGENTS_DIR}/${path}`),
        write: async (path, content) => (await sandbox()).writeFile(`${AGENTS_DIR}/${path}`, content),
        folders: async () =>
            (await (await sandbox()).listFiles(AGENTS_DIR).catch(() => []))
                .filter((entry) => entry.type === "dir" && AGENT_NAME.test(entry.name))
                .map((entry) => entry.name),
        // Names are checked against AGENT_NAME, so they are safe in a command.
        remove: async (name) => {
            await (await sandbox()).run(`rm -rf ${name ? `${AGENTS_DIR}/${name}` : AGENTS_DIR}`);
        },
    };
};

/** Without a computer: a folder per user on the host, named by a hash so no phone numbers show. */
const onHost = (dir: string, userId: string): AgentFiles => {
    const root = join(dir, createHash("sha256").update(userId).digest("hex").slice(0, 32));
    return {
        read: async (path) => {
            const file = join(root, path);
            return existsSync(file) ? readFile(file, "utf8") : undefined;
        },
        write: async (path, content) => {
            const file = join(root, path);
            mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
            await writeFile(`${file}.tmp`, content, { mode: 0o600 });
            await rename(`${file}.tmp`, file);
        },
        folders: async () =>
            existsSync(root)
                ? readdirSync(root).filter((name) => AGENT_NAME.test(name) && statSync(join(root, name)).isDirectory())
                : [],
        remove: async (name) => rmSync(name ? join(root, name) : root, { recursive: true, force: true }),
    };
};

const checkName = (name: string): string => {
    if (!AGENT_NAME.test(name)) {
        throw new Error("An agent's name is lowercase letters, digits and dashes, like flights or gift-ideas");
    }
    return name;
};

const agentFile = ({ method, ...meta }: RestingAgent): string => `---\n${stringify(meta)}---\n\n${method.trim()}\n`;

const parseAgentFile = (text: string, name: string): RestingAgent | undefined => {
    const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
    if (!match) return undefined;
    let meta: Partial<RestingAgent>;
    try {
        meta = (parse(match[1] ?? "") ?? {}) as Partial<RestingAgent>;
    } catch {
        return undefined;
    }
    return {
        name,
        description: typeof meta.description === "string" ? meta.description : "",
        capabilities: Array.isArray(meta.capabilities) ? meta.capabilities.filter((id) => typeof id === "string") : [],
        method: (match[2] ?? "").trim(),
        created: String(meta.created ?? ""),
        jobs: Number(meta.jobs) || 0,
        last: meta.last ? String(meta.last) : undefined,
    };
};

const oneLine = (text: string, max: number): string => {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
};

/**
 * The user's agents, one folder each: `AGENT.md` (what it does and its method), `NOTES.md` (its
 * notebook), `runs.md` (a line per job) and `runs/` (each job's brief and answer).
 */
export class AgentStore {
    private constructor(
        private readonly filesFor: (userId: string) => AgentFiles,
        /** Whether the agents can open their own files, which only a computer allows. */
        readonly onComputer: boolean,
    ) {}

    /** On each user's computer, next to their memory and skills. */
    static onComputer(sandboxes: SandboxProvider): AgentStore {
        return new AgentStore((userId) => onComputer(sandboxes, userId), true);
    }

    /** On the host's disk, for installs without a computer. */
    static onHost(dir: string): AgentStore {
        return new AgentStore((userId) => onHost(dir, userId), false);
    }

    /** Every agent, the one used most recently first. */
    async list(userId: string): Promise<RestingAgent[]> {
        const files = this.filesFor(userId);
        const found = await Promise.all(
            (await files.folders()).map(async (name) => {
                const text = await files.read(`${name}/AGENT.md`);
                return text === undefined ? undefined : parseAgentFile(text, name);
            }),
        );
        return found
            .filter((agent): agent is RestingAgent => agent !== undefined)
            .sort((a, b) => (b.last ?? b.created).localeCompare(a.last ?? a.created) || a.name.localeCompare(b.name));
    }

    async load(userId: string, name: string): Promise<RestingAgent | undefined> {
        if (!AGENT_NAME.test(name)) return undefined;
        const text = await this.filesFor(userId).read(`${name}/AGENT.md`);
        return text === undefined ? undefined : parseAgentFile(text, name);
    }

    async create(userId: string, agent: NewAgent): Promise<RestingAgent> {
        const created: RestingAgent = {
            ...agent,
            name: checkName(agent.name),
            description: oneLine(agent.description, 160),
            jobs: 0,
        };
        await this.filesFor(userId).write(`${created.name}/AGENT.md`, agentFile(created));
        return created;
    }

    /** The agent's notebook, empty when it has none yet. */
    async notes(userId: string, name: string): Promise<string> {
        return (await this.filesFor(userId).read(`${checkName(name)}/NOTES.md`))?.trim() ?? "";
    }

    /** The agent rewrites its notebook at the end of a job. */
    async saveNotes(userId: string, name: string, notes: string): Promise<void> {
        const text = notes.trim();
        if (text.length > MAX_NOTES_CHARS) {
            throw new Error(
                `Your notebook is ${text.length} characters; keep it under ${MAX_NOTES_CHARS}: merge lines and drop what no longer matters.`,
            );
        }
        await this.filesFor(userId).write(`${checkName(name)}/NOTES.md`, `${text}\n`);
    }

    /** Something the user said about the agent's work after the job, kept for its next one. */
    async addNote(userId: string, name: string, note: string, date: string): Promise<void> {
        const notes = await this.notes(userId, name);
        const line = `- ${date}, from the chat: ${oneLine(note, 400)}`;
        await this.filesFor(userId).write(`${name}/NOTES.md`, `${notes ? `${notes}\n` : ""}${line}\n`);
    }

    /** The last lines of the agent's log, oldest first. */
    async runs(userId: string, name: string, limit = 8): Promise<string[]> {
        const log = (await this.filesFor(userId).read(`${checkName(name)}/runs.md`)) ?? "";
        return log
            .split("\n")
            .filter((line) => line.startsWith("- "))
            .slice(-limit);
    }

    /** Writes down a finished job: a line in `runs.md`, its brief and answer in `runs/`, and the count. */
    async logRun(userId: string, name: string, run: AgentRun): Promise<void> {
        const files = this.filesFor(userId);
        const agent = await this.load(userId, checkName(name));
        if (!agent) return;
        const file = `runs/${run.date}-${run.taskId}.md`;
        await files.write(
            `${name}/${file}`,
            [
                `# ${run.title}`,
                "",
                `${run.date} · ${run.status}`,
                "",
                "## Brief",
                "",
                run.brief.trim(),
                "",
                "## Sent to the user",
                "",
                run.sent.join("\n\n").trim() || "(nothing)",
                "",
                "## Notes",
                "",
                run.notes?.trim() || "(none)",
                "",
            ].join("\n"),
        );
        const log = (await files.read(`${name}/runs.md`)) ?? "";
        await files.write(
            `${name}/runs.md`,
            `${log}- ${run.date} · ${oneLine(run.title, 120)} · ${oneLine(run.status, 120)} · ${file}\n`,
        );
        await files.write(`${name}/AGENT.md`, agentFile({ ...agent, jobs: agent.jobs + 1, last: run.date }));
    }

    async forget(userId: string, name: string): Promise<boolean> {
        if (!(await this.load(userId, name))) return false;
        await this.filesFor(userId).remove(name);
        return true;
    }

    async forgetAll(userId: string): Promise<void> {
        await this.filesFor(userId).remove();
    }
}

/** The list the orchestrator sees each message, so it can wake the agent a job belongs to. */
export const renderAgentList = (agents: readonly RestingAgent[], max = 30): string => {
    if (!agents.length) return "None yet.";
    const lines = agents.slice(0, max).map((agent) => {
        const jobs = `${agent.jobs} job${agent.jobs === 1 ? "" : "s"}${agent.last ? `, last ${agent.last}` : ""}`;
        return `- \`${agent.name}\`: ${agent.description} (${jobs})`;
    });
    if (agents.length > max) lines.push(`…and ${agents.length - max} more, used less recently.`);
    return lines.join("\n");
};

/** Today's date where the user is, as YYYY-MM-DD. */
export const dayIn = (timezone: string, now: Date = new Date()): string =>
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
        now,
    );
