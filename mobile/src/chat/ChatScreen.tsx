import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
    ActionSheetIOS,
    Alert,
    FlatList,
    type NativeScrollEvent,
    type NativeSyntheticEvent,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    View,
} from "react-native";
import Animated, {
    FadeIn,
    FadeInDown,
    FadeOut,
    FadeOutUp,
    useAnimatedKeyboard,
    useAnimatedStyle,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Dot } from "../dot/Dot";
import type { DotMood } from "../dot/motion";
import { useDotMood } from "../dot/useDotMood";
import { ChevronDown, More } from "../icons";
import type { AppEntry } from "../protocol";
import type { Connection } from "../storage";
import { type Palette, type, usePalette } from "../theme";
import { toolLabel } from "../tools";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";
import { EntryMessage, PendingMessage } from "./Message";
import { Tasks } from "./Tasks";
import { Thinking } from "./Thinking";
import { type Pending, type Status, useConscious } from "./useConscious";

type Item =
    | { kind: "entry"; key: string; entry: AppEntry; tail: boolean; animate: boolean }
    | { kind: "pending"; key: string; pending: Pending; tail: boolean }
    | { kind: "time"; key: string; label: string }
    | { kind: "answer"; key: string };

const NEW_SECTION_MS = 60 * 60_000;

const timeLabel = (date: Date, now = new Date()): string => {
    const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
    const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
    if (days === 0) return `Today ${time}`;
    if (days === 1) return `Yesterday ${time}`;
    const day = date.toLocaleDateString(undefined, {
        weekday: days < 7 ? "long" : "short",
        day: days < 7 ? undefined : "numeric",
        month: days < 7 ? undefined : "short",
        year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
    });
    return `${day} ${time}`;
};

/** Messages in order, with a time line where a new stretch of the conversation starts. */
const buildItems = (
    entries: AppEntry[],
    pending: Pending[],
    answering: boolean,
    animateAfter: number,
): Item[] => {
    const rows: { at: string; role: "user" | "assistant"; item: Omit<Item, "tail"> & { tail?: boolean } }[] = [
        ...entries.map((entry, index) => ({
            at: entry.at,
            role: entry.role,
            item: { kind: "entry" as const, key: entry.id, entry, animate: index >= animateAfter },
        })),
        ...pending.map((item) => ({
            at: item.at,
            role: "user" as const,
            item: { kind: "pending" as const, key: item.clientId, pending: item },
        })),
    ];
    const items: Item[] = [];
    rows.forEach((row, index) => {
        const previous = rows[index - 1];
        const next = rows[index + 1];
        const at = new Date(row.at);
        if (!previous || at.getTime() - new Date(previous.at).getTime() > NEW_SECTION_MS) {
            items.push({ kind: "time", key: `time-${row.item.key}`, label: timeLabel(at) });
        }
        items.push({ ...row.item, tail: !next || next.role !== row.role } as Item);
    });
    if (answering) items.push({ kind: "answer", key: "answer" });
    return items.reverse();
};

const STATUS_TEXT: Record<Status, string> = {
    connecting: "Connecting…",
    online: "Online",
    offline: "Offline · reconnecting",
    unauthorized: "Access code not accepted",
};

const Header = ({
    palette,
    status,
    mood,
    onMore,
    topInset,
    raised,
}: {
    palette: Palette;
    status: Status;
    mood: DotMood;
    onMore: () => void;
    topInset: number;
    raised: boolean;
}) => {
    const subtitle = STATUS_TEXT[status];
    const dot = status === "online" ? palette.accent : status === "unauthorized" ? palette.danger : palette.faint;
    return (
        <View
            style={[
                styles.header,
                { paddingTop: Math.max(topInset, 12), backgroundColor: palette.background },
                raised && { borderBottomColor: palette.hairline },
            ]}
        >
            <View style={styles.headerSide} />
            <View style={styles.headerCenter}>
                <Pressable onLongPress={() => router.push("/dot")} accessibilityHint="Hold to see the mascot's moves">
                    <Dot size={36} mood={mood} />
                </Pressable>
                <View>
                    <Text style={[type.title, { color: palette.text }]}>Conscious</Text>
                    <View style={styles.statusRow}>
                        <View style={[styles.statusDot, { backgroundColor: dot }]} />
                        <Animated.Text
                            key={subtitle}
                            entering={FadeIn.duration(200)}
                            style={[type.caption, { color: palette.muted }]}
                            numberOfLines={1}
                        >
                            {subtitle}
                        </Animated.Text>
                    </View>
                </View>
            </View>
            <View style={[styles.headerSide, styles.headerRight]}>
                <Pressable onPress={onMore} hitSlop={10} accessibilityLabel="Settings" style={styles.iconButton}>
                    <More color={palette.muted} />
                </Pressable>
            </View>
        </View>
    );
};

const SUGGESTIONS = [
    "Remind me to call mum tomorrow at 6pm",
    "What's the weather like this weekend?",
    "Help me plan dinner for Friday",
];

const Welcome = ({ palette, onPick }: { palette: Palette; onPick: (text: string) => void }) => (
    <Animated.View entering={FadeIn.duration(400)} style={styles.welcome}>
        <Dot size={88} />
        <Text style={[type.display, styles.welcomeTitle, { color: palette.text }]}>Hi, I'm Conscious.</Text>
        <Text style={[type.body, styles.welcomeText, { color: palette.muted }]}>
            I remember things, keep an eye on your day and look things up, so you don't have to.
        </Text>
        <View style={styles.suggestions}>
            {SUGGESTIONS.map((suggestion, index) => (
                <Animated.View key={suggestion} entering={FadeInDown.delay(150 + index * 70).duration(350)}>
                    <Pressable
                        onPress={() => onPick(suggestion)}
                        style={({ pressed }) => [
                            styles.suggestion,
                            {
                                backgroundColor: pressed ? palette.surfacePressed : palette.surface,
                                borderColor: palette.hairline,
                            },
                        ]}
                    >
                        <Text style={[type.small, { color: palette.text }]}>{suggestion}</Text>
                    </Pressable>
                </Animated.View>
            ))}
        </View>
    </Animated.View>
);

export const ChatScreen = ({ connection, onDisconnect }: { connection: Connection; onDisconnect: () => void }) => {
    const palette = usePalette();
    const insets = useSafeAreaInsets();
    const chat = useConscious(connection);
    const list = useRef<FlatList<Item>>(null);
    const [raised, setRaised] = useState(false);
    const [awayFromBottom, setAwayFromBottom] = useState(false);
    const [toast, setToast] = useState<string>();
    const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

    // Only messages that arrive while the chat is open fade in; history appears at once.
    const historyLength = useRef<number | null>(null);
    if (chat.loaded && historyLength.current === null) historyLength.current = chat.entries.length;

    const answering = chat.typing || chat.draft.text.length > 0;
    const items = useMemo(
        () => buildItems(chat.entries, chat.pending, answering, historyLength.current ?? Number.POSITIVE_INFINITY),
        [chat.entries, chat.pending, answering],
    );
    const activity = chat.draft.tool && !chat.draft.text ? toolLabel(chat.draft.tool) : undefined;
    const mood = useDotMood({ status: chat.status, answering, entries: chat.entries, error: chat.error });
    // One character, one place: while the dot works inline next to the answer, the header one rests.
    const headerMood = mood === "thinking" && !chat.draft.text ? "idle" : mood;

    const keyboard = useAnimatedKeyboard();
    const composerBottom = Math.max(insets.bottom, 10);
    const keyboardStyle = useAnimatedStyle(() => ({
        paddingBottom: Math.max(keyboard.height.value - composerBottom + 10, 0),
    }));

    const showToast = useCallback((text: string) => {
        clearTimeout(toastTimer.current);
        setToast(text);
        toastTimer.current = setTimeout(() => setToast(undefined), 1400);
    }, []);

    const copy = useCallback(
        async (text: string) => {
            await Clipboard.setStringAsync(text);
            if (Platform.OS !== "web") void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            showToast("Copied");
        },
        [showToast],
    );

    const send = useCallback(
        (text: string, attachments: Parameters<typeof chat.send>[1] = []) => {
            chat.send(text, attachments);
            list.current?.scrollToOffset({ offset: 0, animated: true });
        },
        [chat.send],
    );

    const more = () => {
        const disconnect = () =>
            Alert.alert("Disconnect?", "You'll need the address and access code to connect again.", [
                { text: "Cancel", style: "cancel" },
                { text: "Disconnect", style: "destructive", onPress: onDisconnect },
            ]);
        const startFresh = () =>
            Alert.alert(
                "Start fresh?",
                "Conscious forgets this chat, everything it knows about you, and your reminders. This can't be undone.",
                [
                    { text: "Cancel", style: "cancel" },
                    { text: "Start fresh", style: "destructive", onPress: chat.startFresh },
                ],
            );
        if (Platform.OS === "ios") {
            ActionSheetIOS.showActionSheetWithOptions(
                {
                    title: connection.server,
                    options: ["The Dot", "Start fresh", "Disconnect", "Cancel"],
                    destructiveButtonIndex: [1, 2],
                    cancelButtonIndex: 3,
                },
                (index) => {
                    if (index === 0) router.push("/dot");
                    if (index === 1) startFresh();
                    if (index === 2) disconnect();
                },
            );
        } else if (Platform.OS === "web") {
            // The browser preview has no native dialogs to confirm with.
            if (globalThis.confirm?.("Start fresh? Conscious forgets this chat, what it knows about you, and your reminders.")) {
                chat.startFresh();
            } else {
                onDisconnect();
            }
        } else {
            Alert.alert(connection.server, undefined, [
                { text: "Start fresh", style: "destructive", onPress: startFresh },
                { text: "Disconnect", style: "destructive", onPress: disconnect },
                { text: "Cancel", style: "cancel" },
            ]);
        }
    };

    const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
        // Inverted: offset 0 is the newest message, the end of the content is the oldest.
        setAwayFromBottom(contentOffset.y > 320);
        setRaised(contentOffset.y + layoutMeasurement.height < contentSize.height - 4);
    };

    const renderItem = ({ item }: { item: Item }) => {
        switch (item.kind) {
            case "time":
                return <Text style={[type.caption, styles.time, { color: palette.faint }]}>{item.label}</Text>;
            case "entry":
                return (
                    <View style={item.tail ? styles.groupEnd : styles.groupInside}>
                        <EntryMessage
                            entry={item.entry}
                            tail={item.tail}
                            animate={item.animate}
                            connection={connection}
                            palette={palette}
                            onCopy={copy}
                        />
                    </View>
                );
            case "pending":
                return (
                    <View style={item.tail ? styles.groupEnd : styles.groupInside}>
                        <PendingMessage
                            pending={item.pending}
                            tail={item.tail}
                            connection={connection}
                            palette={palette}
                            onRetry={chat.retry}
                        />
                    </View>
                );
            case "answer":
                return (
                    <View style={styles.groupEnd}>
                        {chat.draft.text ? (
                            <View style={styles.streaming}>
                                <Markdown text={chat.draft.text} palette={palette} />
                            </View>
                        ) : (
                            <Thinking palette={palette} label={activity} />
                        )}
                    </View>
                );
        }
    };

    const empty = chat.loaded && items.length === 0;

    return (
        <View style={[styles.screen, { backgroundColor: palette.background }]}>
            <Header
                palette={palette}
                status={chat.status}
                mood={headerMood}
                onMore={more}
                topInset={insets.top}
                raised={raised && !empty}
            />
            <Tasks tasks={chat.tasks} palette={palette} />
            <Animated.View style={[styles.flex, keyboardStyle]}>
                {empty ? (
                    <Welcome palette={palette} onPick={(text) => send(text)} />
                ) : (
                    <FlatList
                        ref={list}
                        data={items}
                        inverted
                        keyExtractor={(item) => item.key}
                        renderItem={renderItem}
                        contentContainerStyle={styles.content}
                        keyboardDismissMode="interactive"
                        keyboardShouldPersistTaps="handled"
                        onScroll={onScroll}
                        scrollEventThrottle={32}
                        initialNumToRender={20}
                        maxToRenderPerBatch={20}
                        windowSize={11}
                    />
                )}
                {awayFromBottom && !empty ? (
                    <Animated.View
                        entering={FadeIn.duration(150)}
                        exiting={FadeOut.duration(150)}
                        style={styles.jumpWrap}
                        pointerEvents="box-none"
                    >
                        <Pressable
                            onPress={() => list.current?.scrollToOffset({ offset: 0, animated: true })}
                            accessibilityLabel="Jump to the latest message"
                            style={[styles.jump, { backgroundColor: palette.surface, shadowColor: palette.shadow }]}
                        >
                            <ChevronDown color={palette.text} />
                        </Pressable>
                    </Animated.View>
                ) : null}
                {chat.error ? (
                    <Pressable onPress={chat.clearError} style={styles.errorWrap}>
                        <Animated.Text
                            entering={FadeIn}
                            style={[type.small, styles.error, { color: palette.danger, backgroundColor: palette.surface }]}
                        >
                            {chat.error}
                        </Animated.Text>
                    </Pressable>
                ) : null}
                <Composer palette={palette} onSend={send} bottomInset={composerBottom} />
            </Animated.View>
            {toast ? (
                <Animated.View
                    entering={FadeInDown.duration(180)}
                    exiting={FadeOutUp.duration(180)}
                    style={[styles.toast, { top: insets.top + 64, backgroundColor: palette.text }]}
                    pointerEvents="none"
                >
                    <Text style={[type.small, styles.toastText, { color: palette.background }]}>{toast}</Text>
                </Animated.View>
            ) : null}
        </View>
    );
};

const styles = StyleSheet.create({
    screen: { flex: 1 },
    flex: { flex: 1 },
    header: {
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 12,
        paddingBottom: 10,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: "transparent",
        zIndex: 2,
    },
    headerSide: { width: 44 },
    headerRight: { alignItems: "flex-end" },
    headerCenter: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 },
    statusRow: { flexDirection: "row", alignItems: "center", gap: 5 },
    statusDot: { width: 6, height: 6, borderRadius: 3 },
    iconButton: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
    content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
    groupEnd: { marginTop: 18 },
    groupInside: { marginTop: 4 },
    time: { textAlign: "center", marginTop: 26, marginBottom: 2, fontWeight: "500" },
    streaming: { paddingRight: 24 },
    welcome: { flex: 1, justifyContent: "center", paddingHorizontal: 28, gap: 14 },
    welcomeTitle: { marginTop: 10 },
    welcomeText: { maxWidth: 340 },
    suggestions: { marginTop: 18, gap: 8, alignItems: "flex-start" },
    suggestion: {
        borderRadius: 18,
        borderWidth: StyleSheet.hairlineWidth,
        paddingHorizontal: 14,
        paddingVertical: 10,
    },
    jumpWrap: { position: "absolute", right: 16, bottom: 72, alignItems: "flex-end" },
    jump: {
        width: 38,
        height: 38,
        borderRadius: 19,
        alignItems: "center",
        justifyContent: "center",
        shadowOpacity: 1,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 3 },
        elevation: 4,
    },
    errorWrap: { alignItems: "center", paddingHorizontal: 16 },
    error: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 14, overflow: "hidden" },
    toast: { position: "absolute", alignSelf: "center", borderRadius: 16, paddingHorizontal: 14, paddingVertical: 7 },
    toastText: { fontWeight: "600" },
});
