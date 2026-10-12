/**
 * The computer Conscious works on: a disposable machine with a browser, for jobs no API covers
 * (book a table, fill a form, check a price). Not built yet. This is the seam a capability will
 * call, so the provider (a container, a hosted browser) can change without touching the tools.
 */
export interface Sandbox {
    open(userId: string): Promise<SandboxSession>;
}

export interface SandboxSession {
    navigate(url: string): Promise<void>;
    /** The page as text, for the model to read. */
    read(): Promise<string>;
    screenshot(): Promise<{ data: string; mimeType: "image/png" }>;
    close(): Promise<void>;
}
