// A copy of the types in the server's src/channels/app.ts and app-log.ts. Keep them in step.

export interface AppFile {
    id: string;
    name: string;
    mimeType: string;
    size: number;
}

export interface AppEntry {
    id: string;
    role: "user" | "assistant";
    text: string;
    at: string;
    files?: AppFile[];
    reaction?: string;
}

export type ClientMessage =
    | { type: "auth"; code: string }
    | {
          type: "send";
          clientId: string;
          text: string;
          files?: { name: string; mimeType: string; data: string }[];
      }
    | { type: "reset" };

export type ServerMessage =
    | { type: "ready"; history: AppEntry[] }
    | { type: "ack"; clientId: string; entry: AppEntry }
    | { type: "entry"; entry: AppEntry }
    | { type: "typing"; active: boolean }
    | { type: "delta"; text: string }
    | { type: "tool"; name: string }
    | { type: "reaction"; entryId: string; emoji: string }
    | { type: "error"; message: string };
