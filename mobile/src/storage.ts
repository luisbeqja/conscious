import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

export interface Connection {
    /** The Conscious host, e.g. http://192.168.1.20:8788 */
    server: string;
    code: string;
}

const KEY = "conscious.connection";

// SecureStore has no web build; the browser preview keeps the connection in localStorage.
const store = {
    get: (key: string) =>
        Platform.OS === "web" ? Promise.resolve(globalThis.localStorage?.getItem(key) ?? null) : SecureStore.getItemAsync(key),
    set: (key: string, value: string) =>
        Platform.OS === "web" ? Promise.resolve(globalThis.localStorage?.setItem(key, value)) : SecureStore.setItemAsync(key, value),
    remove: (key: string) =>
        Platform.OS === "web" ? Promise.resolve(globalThis.localStorage?.removeItem(key)) : SecureStore.deleteItemAsync(key),
};

export const loadConnection = async (): Promise<Connection | undefined> => {
    const saved = await store.get(KEY).catch(() => null);
    return saved ? (JSON.parse(saved) as Connection) : undefined;
};

export const saveConnection = (connection: Connection) => store.set(KEY, JSON.stringify(connection));

export const forgetConnection = () => store.remove(KEY);

/** Accepts what people type: a bare address, a trailing slash, ws:// or https://. */
export const normalizeServer = (input: string): string => {
    let server = input.trim().replace(/\/+$/, "");
    if (!server) return server;
    if (!/^[a-z]+:\/\//i.test(server)) server = `http://${server}`;
    return server.replace(/^ws(s?):\/\//i, "http$1://");
};

export const socketUrl = (server: string) => `${server.replace(/^http/i, "ws")}/app/socket`;

export const fileUrl = (server: string, fileId: string) => `${server}/app/files/${fileId}`;
