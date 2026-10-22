import { useRef, useState } from "react";
import {
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View,
} from "react-native";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Dot } from "../dot/Dot";
import type { ClientMessage, ServerMessage } from "../protocol";
import { type Connection, normalizeServer, socketUrl } from "../storage";
import { fonts, type Palette, type, usePalette } from "../theme";

/** Opens the socket and signs in once, so a typo is caught here and not in the chat. */
const tryConnection = (connection: Connection): Promise<void> =>
    new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error?: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            ws.close();
            error ? reject(new Error(error)) : resolve();
        };
        const ws = new WebSocket(socketUrl(connection.server));
        const timer = setTimeout(
            () => finish("Couldn't reach Conscious there. Is it running, and is your phone on the same network?"),
            8_000,
        );
        ws.onopen = () => ws.send(JSON.stringify({ type: "auth", code: connection.code } satisfies ClientMessage));
        ws.onmessage = (event) => {
            if ((JSON.parse(String(event.data)) as ServerMessage).type === "ready") finish();
        };
        ws.onclose = (event) =>
            finish(
                event.code === 4003
                    ? "That access code doesn't match. Check it in the terminal where Conscious runs."
                    : "Couldn't reach Conscious there. Is it running, and is your phone on the same network?",
            );
        ws.onerror = () => {};
    });

const Field = ({
    label,
    palette,
    ...input
}: { label: string; palette: Palette } & React.ComponentProps<typeof TextInput>) => {
    const [focused, setFocused] = useState(false);
    return (
        <View style={styles.fieldWrap}>
            <Text style={[type.small, styles.label, { color: palette.muted }]}>{label}</Text>
            <TextInput
                {...input}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                placeholderTextColor={palette.faint}
                selectionColor={palette.accent}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                style={[
                    type.body,
                    styles.input,
                    {
                        color: palette.text,
                        backgroundColor: palette.surface,
                        borderColor: focused ? palette.accent : palette.hairline,
                    },
                    input.style,
                ]}
            />
        </View>
    );
};

export const ConnectScreen = ({ onConnected }: { onConnected: (connection: Connection) => void }) => {
    const palette = usePalette();
    const insets = useSafeAreaInsets();
    const [server, setServer] = useState("");
    const [code, setCode] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const codeInput = useRef<React.ComponentRef<typeof TextInput>>(null);
    const ready = server.trim().length > 0 && code.trim().length > 0 && !busy;

    const connect = async () => {
        if (!ready) return;
        const connection = { server: normalizeServer(server), code: code.trim().toLowerCase() };
        setBusy(true);
        setError(undefined);
        try {
            await tryConnection(connection);
            onConnected(connection);
        } catch (failure) {
            setError((failure as Error).message);
            setBusy(false);
        }
    };

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : undefined}
            style={[styles.screen, { backgroundColor: palette.background }]}
        >
            <ScrollView
                contentContainerStyle={[styles.content, { paddingTop: insets.top + 56, paddingBottom: insets.bottom + 24 }]}
                keyboardShouldPersistTaps="handled"
            >
                <Animated.View entering={FadeIn.duration(500)}>
                    <Dot size={72} mood={busy ? "thinking" : error ? "error" : "idle"} />
                </Animated.View>
                <Animated.View entering={FadeInDown.delay(80).duration(450)} style={styles.intro}>
                    <Text style={[type.display, { color: palette.text }]}>Conscious</Text>
                    <Text style={[type.body, { color: palette.muted }]}>
                        Connect to the Conscious you run. On that computer, start it with{" "}
                        <Text style={[styles.code, { color: palette.text }]}>pnpm app</Text> and enter what it prints.
                    </Text>
                </Animated.View>
                <Animated.View entering={FadeInDown.delay(160).duration(450)} style={styles.form}>
                    <Field
                        label="Address"
                        palette={palette}
                        value={server}
                        onChangeText={setServer}
                        placeholder="http://192.168.1.20:8788"
                        keyboardType="url"
                        textContentType="URL"
                        returnKeyType="next"
                        onSubmitEditing={() => codeInput.current?.focus()}
                        submitBehavior="submit"
                    />
                    <Field
                        ref={codeInput}
                        label="Access code"
                        palette={palette}
                        value={code}
                        onChangeText={setCode}
                        placeholder="xxxx-xxxx-xxxx-xxxx"
                        textContentType="oneTimeCode"
                        returnKeyType="go"
                        onSubmitEditing={connect}
                        style={styles.codeInput}
                    />
                    {error ? (
                        <Animated.Text entering={FadeIn} style={[type.small, { color: palette.danger }]}>
                            {error}
                        </Animated.Text>
                    ) : null}
                    <Pressable
                        onPress={connect}
                        disabled={!ready}
                        accessibilityRole="button"
                        style={({ pressed }) => [
                            styles.button,
                            {
                                backgroundColor: pressed ? palette.accentPressed : palette.accent,
                                opacity: ready || busy ? 1 : 0.45,
                            },
                        ]}
                    >
                        {busy ? (
                            <ActivityIndicator color={palette.onAccent} />
                        ) : (
                            <Text style={[type.title, { color: palette.onAccent }]}>Connect</Text>
                        )}
                    </Pressable>
                    <Text style={[type.caption, styles.note, { color: palette.faint }]}>
                        Your messages go only to that computer. Away from home, reach it over a private network
                        such as Tailscale, or an https address.
                    </Text>
                </Animated.View>
            </ScrollView>
        </KeyboardAvoidingView>
    );
};

const styles = StyleSheet.create({
    screen: { flex: 1 },
    content: { paddingHorizontal: 24, gap: 24, maxWidth: 520, width: "100%", alignSelf: "center" },
    intro: { gap: 10 },
    code: { fontFamily: fonts.mono, fontSize: 15 },
    form: { gap: 16 },
    fieldWrap: { gap: 6 },
    label: { fontWeight: "600", marginLeft: 2 },
    input: {
        borderWidth: 1,
        borderRadius: 14,
        paddingHorizontal: 14,
        paddingVertical: 13,
        ...Platform.select({ web: { outlineStyle: "none" } as object, default: {} }),
    },
    codeInput: { fontFamily: fonts.mono, letterSpacing: 1 },
    button: { height: 52, borderRadius: 14, alignItems: "center", justifyContent: "center", marginTop: 4 },
    note: { textAlign: "center", marginTop: 4, paddingHorizontal: 8 },
});
