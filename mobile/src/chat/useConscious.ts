import * as Crypto from "expo-crypto";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { AppState } from "react-native";
import type { AppEntry, AppTask, ClientMessage, ServerMessage } from "../protocol";
import { type Connection, socketUrl } from "../storage";

export type Status = "connecting" | "online" | "offline" | "unauthorized";

export interface Attachment {
    uri: string;
    name: string;
    mimeType: string;
    base64: string;
    width?: number;
    height?: number;
}

/** A message the phone has not heard back about yet. */
export interface Pending {
    clientId: string;
    text: string;
    attachments: Attachment[];
    at: string;
    state: "queued" | "sending" | "failed";
}

/** The answer being written right now. */
export interface Draft {
    text: string;
    tool?: string;
}

interface State {
    status: Status;
    entries: AppEntry[];
    pending: Pending[];
    typing: boolean;
    draft: Draft;
    /** Jobs running in the background while the chat goes on. */
    tasks: AppTask[];
    error?: string;
    /** History arrived at least once, so an empty list means an empty chat. */
    loaded: boolean;
}

type Action =
    | { type: "status"; status: Status }
    | { type: "server"; message: ServerMessage }
    | { type: "queue"; pending: Pending }
    | { type: "sending"; clientIds: string[] }
    | { type: "dropped" }
    | { type: "retry"; clientId: string }
    | { type: "clearError" }
    | { type: "fail"; error: string };

const EMPTY_DRAFT: Draft = { text: "" };

const reduce = (state: State, action: Action): State => {
    switch (action.type) {
        case "status":
            return { ...state, status: action.status };
        case "queue":
            return { ...state, pending: [...state.pending, action.pending] };
        case "sending":
            return {
                ...state,
                pending: state.pending.map((item) =>
                    action.clientIds.includes(item.clientId) ? { ...item, state: "sending" } : item,
                ),
            };
        // A message on a socket that dropped may or may not have arrived; the user decides to resend.
        case "dropped":
            return {
                ...state,
                typing: false,
                draft: EMPTY_DRAFT,
                pending: state.pending.map((item) => (item.state === "sending" ? { ...item, state: "failed" } : item)),
            };
        case "retry":
            return {
                ...state,
                pending: state.pending.map((item) =>
                    item.clientId === action.clientId ? { ...item, state: "queued" } : item,
                ),
            };
        case "clearError":
            return { ...state, error: undefined };
        case "fail":
            return { ...state, error: action.error };
        case "server":
            return receive(state, action.message);
    }
};

const receive = (state: State, message: ServerMessage): State => {
    switch (message.type) {
        // The server sends the running tasks right after, if there are any.
        case "ready":
            return { ...state, entries: message.history, tasks: [], loaded: true };
        case "tasks":
            return { ...state, tasks: message.tasks };
        case "ack":
            return {
                ...state,
                entries: [...state.entries, message.entry],
                pending: state.pending.filter((item) => item.clientId !== message.clientId),
            };
        case "entry":
            return {
                ...state,
                entries: [...state.entries, message.entry],
                draft: message.entry.role === "assistant" ? EMPTY_DRAFT : state.draft,
            };
        case "typing":
            return { ...state, typing: message.active, draft: message.active ? state.draft : EMPTY_DRAFT };
        // Text written before a tool call is the agent thinking aloud; the next stretch replaces it.
        case "delta":
            return { ...state, draft: { text: state.draft.text + message.text } };
        case "tool":
            return { ...state, draft: { text: "", tool: message.name } };
        case "reaction":
            return {
                ...state,
                entries: state.entries.map((entry) =>
                    entry.id === message.entryId ? { ...entry, reaction: message.emoji } : entry,
                ),
            };
        case "error":
            return { ...state, error: message.message };
    }
};

const INITIAL: State = {
    status: "connecting",
    entries: [],
    pending: [],
    typing: false,
    draft: EMPTY_DRAFT,
    tasks: [],
    loaded: false,
};

const RETRY_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];
// Wiping a computer's memory takes a few seconds; past this the server did not take the reset.
const RESET_TIMEOUT_MS = 20_000;

/** One live connection to Conscious: the chat, what is being written, and a way to send. */
export const useConscious = (connection: Connection) => {
    const [state, dispatch] = useReducer(reduce, INITIAL);
    const socket = useRef<WebSocket | null>(null);
    const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const pendingRef = useRef(state.pending);
    pendingRef.current = state.pending;

    const flush = useCallback(() => {
        const open = socket.current;
        if (!open || open.readyState !== WebSocket.OPEN) return;
        const queued = pendingRef.current.filter((item) => item.state === "queued");
        for (const item of queued) {
            const message: ClientMessage = {
                type: "send",
                clientId: item.clientId,
                text: item.text,
                files: item.attachments.map((file) => ({ name: file.name, mimeType: file.mimeType, data: file.base64 })),
            };
            open.send(JSON.stringify(message));
        }
        if (queued.length) dispatch({ type: "sending", clientIds: queued.map((item) => item.clientId) });
    }, []);

    useEffect(() => {
        let attempt = 0;
        let retry: ReturnType<typeof setTimeout> | undefined;
        let stopped = false;

        const connect = () => {
            clearTimeout(retry);
            if (stopped || socket.current) return;
            dispatch({ type: "status", status: "connecting" });
            const ws = new WebSocket(socketUrl(connection.server));
            socket.current = ws;
            ws.onopen = () => ws.send(JSON.stringify({ type: "auth", code: connection.code } satisfies ClientMessage));
            ws.onmessage = (event) => {
                const message = JSON.parse(String(event.data)) as ServerMessage;
                if (message.type === "ready" || message.type === "error") clearTimeout(resetTimer.current);
                if (message.type === "ready") {
                    attempt = 0;
                    dispatch({ type: "status", status: "online" });
                }
                dispatch({ type: "server", message });
            };
            ws.onclose = (event) => {
                if (socket.current === ws) socket.current = null;
                dispatch({ type: "dropped" });
                if (event.code === 4003) {
                    dispatch({ type: "status", status: "unauthorized" });
                    return;
                }
                dispatch({ type: "status", status: "offline" });
                if (stopped) return;
                retry = setTimeout(connect, RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]);
                attempt += 1;
            };
        };

        connect();
        // A phone coming back to the app should not wait out the backoff.
        const subscription = AppState.addEventListener("change", (next) => {
            if (next === "active") {
                attempt = 0;
                connect();
            }
        });
        return () => {
            stopped = true;
            clearTimeout(retry);
            clearTimeout(resetTimer.current);
            subscription.remove();
            socket.current?.close();
            socket.current = null;
        };
    }, [connection.server, connection.code, flush]);

    // New messages wait in the outbox until the socket is ready, then go out in order.
    useEffect(() => {
        if (state.status === "online" && state.pending.some((item) => item.state === "queued")) flush();
    }, [state.status, state.pending, flush]);

    const send = useCallback((text: string, attachments: Attachment[] = []) => {
        const trimmed = text.trim();
        if (!trimmed && !attachments.length) return;
        dispatch({
            type: "queue",
            pending: {
                clientId: Crypto.randomUUID(),
                text: trimmed,
                attachments,
                at: new Date().toISOString(),
                state: "queued",
            },
        });
    }, []);

    const retry = useCallback((clientId: string) => dispatch({ type: "retry", clientId }), []);
    const clearError = useCallback(() => dispatch({ type: "clearError" }), []);
    // The server answers with an empty history, which empties the chat on every open phone.
    // A server from before Start fresh ignores the request, so silence becomes an error.
    const startFresh = useCallback(() => {
        const open = socket.current;
        if (!open || open.readyState !== WebSocket.OPEN) {
            dispatch({ type: "fail", error: "You're offline. Start fresh once you're back online." });
            return;
        }
        open.send(JSON.stringify({ type: "reset" } satisfies ClientMessage));
        clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(
            () =>
                dispatch({
                    type: "fail",
                    error: "Your Conscious didn't start fresh. Its server may need the latest version.",
                }),
            RESET_TIMEOUT_MS,
        );
    }, []);

    return { ...state, send, retry, clearError, startFresh };
};
