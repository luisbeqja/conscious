import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import Animated, { FadeIn, FadeOut, useAnimatedStyle, withSpring, withTiming } from "react-native-reanimated";
import { ArrowUp, Close, Plus } from "../icons";
import { type Palette, type } from "../theme";
import type { Attachment } from "./useConscious";

const MAX_ATTACHMENTS = 4;

const pickPhotos = async (room: number): Promise<Attachment[]> => {
    const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: room > 1,
        selectionLimit: room,
        quality: 0.8,
        base64: true,
    });
    if (result.canceled) return [];
    return result.assets
        .filter((asset) => asset.base64)
        .map((asset, index) => ({
            uri: asset.uri,
            name: asset.fileName ?? `photo-${index + 1}.jpg`,
            mimeType: asset.mimeType ?? "image/jpeg",
            base64: asset.base64 ?? "",
            width: asset.width,
            height: asset.height,
        }));
};

export const Composer = ({
    palette,
    onSend,
    bottomInset,
}: {
    palette: Palette;
    onSend: (text: string, attachments: Attachment[]) => void;
    bottomInset: number;
}) => {
    const [text, setText] = useState("");
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const ready = text.trim().length > 0 || attachments.length > 0;

    const sendStyle = useAnimatedStyle(() => ({
        transform: [{ scale: withSpring(ready ? 1 : 0.86, { damping: 14, stiffness: 260 }) }],
        opacity: withTiming(ready ? 1 : 0.4, { duration: 140 }),
    }));

    const send = () => {
        if (!ready) return;
        if (Platform.OS !== "web") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onSend(text, attachments);
        setText("");
        setAttachments([]);
    };

    const attach = async () => {
        const room = MAX_ATTACHMENTS - attachments.length;
        if (room <= 0) return;
        const picked = await pickPhotos(room);
        if (picked.length) setAttachments((current) => [...current, ...picked].slice(0, MAX_ATTACHMENTS));
    };

    return (
        <View style={[styles.bar, { paddingBottom: bottomInset }]}>
            <Pressable
                onPress={attach}
                accessibilityLabel="Add a photo"
                hitSlop={6}
                style={({ pressed }) => [
                    styles.round,
                    { backgroundColor: pressed ? palette.surfacePressed : palette.surface, borderColor: palette.hairline },
                ]}
            >
                <Plus color={palette.muted} />
            </Pressable>
            <View style={[styles.field, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
                {attachments.length ? (
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.thumbs}
                        keyboardShouldPersistTaps="handled"
                    >
                        {attachments.map((attachment) => (
                            <Animated.View
                                key={attachment.uri}
                                entering={FadeIn.duration(160)}
                                exiting={FadeOut.duration(120)}
                            >
                                <Image source={{ uri: attachment.uri }} style={styles.thumb} contentFit="cover" />
                                <Pressable
                                    onPress={() =>
                                        setAttachments((current) => current.filter((item) => item !== attachment))
                                    }
                                    accessibilityLabel="Remove photo"
                                    hitSlop={8}
                                    style={[styles.remove, { backgroundColor: palette.text }]}
                                >
                                    <Close size={10} color={palette.background} />
                                </Pressable>
                            </Animated.View>
                        ))}
                    </ScrollView>
                ) : null}
                <View style={styles.inputRow}>
                    <TextInput
                        value={text}
                        onChangeText={setText}
                        placeholder="Message"
                        placeholderTextColor={palette.faint}
                        multiline
                        {...(Platform.OS === "web" ? { rows: 1 } : {})}
                        style={[type.body, styles.input, { color: palette.text }]}
                        selectionColor={palette.accent}
                        cursorColor={palette.accent}
                        accessibilityLabel="Message"
                        submitBehavior="newline"
                        onKeyPress={(event) => {
                            // On a keyboard, Enter sends and Shift+Enter adds a line, as in any chat app.
                            const native = event.nativeEvent as { key: string; shiftKey?: boolean };
                            if (Platform.OS === "web" && native.key === "Enter" && !native.shiftKey) {
                                event.preventDefault();
                                send();
                            }
                        }}
                    />
                    <Animated.View style={sendStyle}>
                        <Pressable
                            onPress={send}
                            disabled={!ready}
                            accessibilityLabel="Send"
                            accessibilityRole="button"
                            hitSlop={6}
                            style={({ pressed }) => [
                                styles.send,
                                { backgroundColor: ready ? (pressed ? palette.accentPressed : palette.accent) : palette.faint },
                            ]}
                        >
                            <ArrowUp color={palette.onAccent} size={17} />
                        </Pressable>
                    </Animated.View>
                </View>
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    bar: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 12, paddingTop: 8 },
    round: {
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: StyleSheet.hairlineWidth,
    },
    field: { flex: 1, borderRadius: 21, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
    thumbs: { gap: 8, paddingHorizontal: 10, paddingTop: 10 },
    thumb: { width: 64, height: 64, borderRadius: 12 },
    remove: {
        position: "absolute",
        top: 4,
        right: 4,
        width: 20,
        height: 20,
        borderRadius: 10,
        alignItems: "center",
        justifyContent: "center",
        opacity: 0.85,
    },
    inputRow: { flexDirection: "row", alignItems: "flex-end", minHeight: 40, paddingRight: 4, paddingBottom: 4 },
    input: {
        flex: 1,
        maxHeight: 140,
        paddingLeft: 15,
        paddingRight: 8,
        paddingTop: Platform.select({ ios: 8, default: 7 }),
        paddingBottom: Platform.select({ ios: 4, default: 3 }),
        ...Platform.select({ web: { outlineStyle: "none" } as object, default: {} }),
    },
    send: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
});
