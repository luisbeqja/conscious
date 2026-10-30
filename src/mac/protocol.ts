/**
 * What Conscious and a user's Mac say to each other on `/mac/socket`, one JSON object per message.
 * The Mac connects out, so it needs no open port, and its first message is `hello`.
 */

/** Raised when a message changes shape, so an old Mac is told to update instead of misreading. */
export const PROTOCOL_VERSION = 1;

export const MAC_SOCKET_PATH = "/mac/socket";
export const MAC_PAIR_PATH = "/mac/pair";

/** Why a socket was closed, so the Mac knows whether to come back. */
export const CLOSE = {
    noHello: 4001,
    /** The token is unknown: the Mac was unlinked, or another Mac was linked in its place. */
    unlinked: 4003,
    /** A newer connection from the same Mac took over. */
    replaced: 4005,
    outdated: 4006,
} as const;

/** A job for Claude Code on the Mac. */
export interface MacRequest {
    /** An allowed folder, by its name or a path inside it. The Mac checks it against its own list. */
    folder: string;
    /** What Claude Code is asked, as a person would write it. */
    message: string;
    /** The Claude Code session to continue, from an earlier answer. */
    session?: string;
    /** Plan mode: Claude Code reads and answers, and changes nothing. */
    readOnly?: boolean;
}

/** Claude Code's answer to one request. */
export interface MacAnswer {
    /** Passed back as `session`, it continues the same conversation. */
    session: string;
    /** Where it ran, as a path on the Mac. */
    folder: string;
    text: string;
    /** Claude Code ended with an error instead of an answer. */
    error: boolean;
    /** What it was not allowed to do, like "Bash: git push": nobody is at the Mac to approve it. */
    denied: string[];
    turns: number;
    costUsd?: number;
}

/** A folder the user lets Claude Code work in. */
export interface MacFolder {
    name: string;
    path: string;
}

export type FromMac =
    | { type: "hello"; token: string; name: string; version: number; folders: MacFolder[] }
    | { type: "folders"; folders: MacFolder[] }
    | { type: "step"; id: string; step: string }
    | { type: "answer"; id: string; answer: MacAnswer }
    | { type: "failed"; id: string; reason: string };

export type ToMac =
    | { type: "welcome"; user: string }
    | { type: "ask"; id: string; request: MacRequest }
    | { type: "cancel"; id: string };
