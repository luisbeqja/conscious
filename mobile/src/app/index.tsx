import { useEffect, useState } from "react";
import { View } from "react-native";
import { ChatScreen } from "../chat/ChatScreen";
import { ConnectScreen } from "../connect/ConnectScreen";
import { type Connection, forgetConnection, loadConnection, saveConnection } from "../storage";
import { usePalette } from "../theme";

export default function Home() {
    const palette = usePalette();
    // undefined while reading the saved connection, null when there is none.
    const [connection, setConnection] = useState<Connection | null>();

    useEffect(() => {
        loadConnection().then((saved) => setConnection(saved ?? null));
    }, []);

    if (connection === undefined) return <View style={{ flex: 1, backgroundColor: palette.background }} />;
    if (!connection) {
        return (
            <ConnectScreen
                onConnected={(next) => {
                    void saveConnection(next);
                    setConnection(next);
                }}
            />
        );
    }
    return (
        <ChatScreen
            key={`${connection.server}|${connection.code}`}
            connection={connection}
            onDisconnect={() => {
                void forgetConnection();
                setConnection(null);
            }}
        />
    );
}
