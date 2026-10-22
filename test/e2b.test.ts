import { CommandExitError } from "e2b";
import { describe, expect, it, vi } from "vitest";
import { type E2BClient, type E2BInstance, E2BSandboxes } from "../src/sandbox/e2b.js";

const instance = (sandboxId: string): E2BInstance =>
    ({
        sandboxId,
        setTimeout: vi.fn(async () => {}),
        commands: { run: vi.fn(async () => ({ exitCode: 0, stdout: "hi\n", stderr: "" })) },
        files: {
            exists: vi.fn(async () => false),
            read: vi.fn(async () => ""),
            write: vi.fn(async () => ({})),
            list: vi.fn(async () => [{ name: "memory", type: "dir", size: 0 }]),
        },
    }) as unknown as E2BInstance;

const client = (existing?: string) => {
    const fake = {
        find: vi.fn(async (): Promise<string | undefined> => existing),
        create: vi.fn(async () => instance("new")),
        connect: vi.fn(async (id: string) => instance(id)),
    } satisfies E2BClient;
    return fake;
};

describe("E2BSandboxes", () => {
    it("creates one sandbox per user, tagged with a hash of the user and never the user id", async () => {
        const fake = client();
        const sandboxes = new E2BSandboxes(fake, 600_000);
        await sandboxes.forUser("+393331234567");
        await sandboxes.forUser("+393331234567");

        expect(fake.create).toHaveBeenCalledTimes(1);
        const [metadata] = fake.create.mock.calls[0] as unknown as [Record<string, string>];
        expect(metadata.conscious).toMatch(/^[0-9a-f]{32}$/);
        expect(JSON.stringify(metadata)).not.toContain("393331234567");
    });

    it("finds the user's sandbox again after a restart and resumes it", async () => {
        const fake = client("paused-1");
        await new E2BSandboxes(fake, 600_000).forUser("me");
        expect(fake.create).not.toHaveBeenCalled();
        expect(fake.connect).toHaveBeenCalledWith("paused-1");
    });

    it("reconnects once the sandbox may have paused itself", async () => {
        let now = 0;
        const fake = client();
        const sandboxes = new E2BSandboxes(fake, 600_000, () => now);
        await sandboxes.forUser("me");
        now = 60_000;
        await sandboxes.forUser("me");
        expect(fake.connect).not.toHaveBeenCalled();
        now = 600_000;
        await sandboxes.forUser("me");
        expect(fake.connect).toHaveBeenCalledWith("new");
        expect(fake.find).toHaveBeenCalledTimes(1);
    });

    it("returns a failing command's exit code instead of throwing", async () => {
        const fake = client();
        const sandboxes = new E2BSandboxes(fake, 600_000);
        const sandbox = await sandboxes.forUser("me");
        const created = await fake.create.mock.results[0]?.value;
        vi.mocked(created.commands.run).mockRejectedValueOnce(
            new CommandExitError({ exitCode: 2, stdout: "", stderr: "no such file" }),
        );
        expect(await sandbox.run("cat nope")).toEqual({ exitCode: 2, stdout: "", stderr: "no such file" });
        expect(created.commands.run).toHaveBeenCalledWith("cat nope", { cwd: "/home/user", timeoutMs: undefined });
    });

    it("resolves paths against home and reads a missing file as undefined", async () => {
        const fake = client();
        const sandbox = await new E2BSandboxes(fake, 600_000).forUser("me");
        const created = await fake.create.mock.results[0]?.value;
        expect(await sandbox.readFile("memory/MEMORY.md")).toBeUndefined();
        expect(created.files.exists).toHaveBeenCalledWith("/home/user/memory/MEMORY.md");
        expect(await sandbox.listFiles(".")).toEqual([{ name: "memory", type: "dir", size: 0 }]);
    });
});
