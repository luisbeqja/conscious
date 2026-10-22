import { Image } from "expo-image";
import { memo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, ZoomIn } from "react-native-reanimated";
import { Document } from "../icons";
import type { AppEntry, AppFile } from "../protocol";
import { type Connection, fileUrl } from "../storage";
import { type Palette, type } from "../theme";
import { Markdown } from "./Markdown";
import type { Attachment, Pending } from "./useConscious";

const IMAGE_WIDTH = 236;

const isImage = (mimeType: string) => mimeType.startsWith("image/");

const fileSize = (bytes: number) =>
    bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1000))} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`;

/** A photo at its own shape, once it has loaded; square until then. */
const Photo = ({ uri, headers, palette }: { uri: string; headers?: Record<string, string>; palette: Palette }) => {
    const [ratio, setRatio] = useState(1);
    return (
        <Image
            source={{ uri, headers }}
            style={[
                styles.photo,
                { width: IMAGE_WIDTH, aspectRatio: Math.min(Math.max(ratio, 0.6), 1.8) },
                { backgroundColor: palette.surfacePressed },
            ]}
            contentFit="cover"
            transition={180}
            onLoad={(event) => {
                if (event.source.width && event.source.height) setRatio(event.source.width / event.source.height);
            }}
        />
    );
};

const FileCard = ({ file, palette }: { file: AppFile | Attachment; palette: Palette }) => (
    <View style={[styles.fileCard, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
        <View style={[styles.fileIcon, { backgroundColor: palette.accentSoft }]}>
            <Document color={palette.accent} />
        </View>
        <View style={styles.flexShrink}>
            <Text numberOfLines={1} style={[type.small, styles.fileName, { color: palette.text }]}>
                {file.name}
            </Text>
            {"size" in file ? (
                <Text style={[type.caption, { color: palette.muted }]}>{fileSize(file.size)}</Text>
            ) : null}
        </View>
    </View>
);

const Files = ({
    files,
    connection,
    palette,
}: {
    files: (AppFile | Attachment)[];
    connection: Connection;
    palette: Palette;
}) => (
    <View style={styles.files}>
        {files.map((file) => {
            const key = "id" in file ? file.id : file.uri;
            if (!isImage(file.mimeType)) return <FileCard key={key} file={file} palette={palette} />;
            return "id" in file ? (
                <Photo
                    key={key}
                    uri={fileUrl(connection.server, file.id)}
                    headers={{ Authorization: `Bearer ${connection.code}` }}
                    palette={palette}
                />
            ) : (
                <Photo key={key} uri={file.uri} palette={palette} />
            );
        })}
    </View>
);

interface BubbleProps {
    text: string;
    files: (AppFile | Attachment)[];
    reaction?: string;
    /** The last message in a run from the same side, which gets the tail corner. */
    tail: boolean;
    faded?: boolean;
    connection: Connection;
    palette: Palette;
    onLongPress: () => void;
}

const UserBubble = ({ text, files, reaction, tail, faded, connection, palette, onLongPress }: BubbleProps) => (
    <View style={[styles.userRow, reaction ? styles.withReaction : null]}>
        {files.length ? <Files files={files} connection={connection} palette={palette} /> : null}
        {text ? (
            <Pressable onLongPress={onLongPress} delayLongPress={300} style={styles.bubbleWrap}>
                {({ pressed }) => (
                    <View
                        style={[
                            styles.userBubble,
                            tail && styles.userTail,
                            { backgroundColor: pressed ? palette.bubblePressed : palette.bubble },
                            faded && styles.faded,
                        ]}
                    >
                        <Text style={[type.body, { color: palette.onAccent }]}>{text}</Text>
                    </View>
                )}
            </Pressable>
        ) : null}
        {reaction ? (
            <Animated.View
                entering={ZoomIn.springify().damping(12)}
                style={[styles.reaction, { backgroundColor: palette.surface, shadowColor: palette.shadow }]}
            >
                <Text style={styles.reactionText}>{reaction}</Text>
            </Animated.View>
        ) : null}
    </View>
);

const AssistantMessage = ({ text, files, connection, palette, onLongPress }: BubbleProps) => (
    <Pressable onLongPress={onLongPress} delayLongPress={300} style={styles.assistantRow}>
        {files.length ? <Files files={files} connection={connection} palette={palette} /> : null}
        {text ? <Markdown text={text} palette={palette} /> : null}
    </Pressable>
);

export const EntryMessage = memo(
    ({
        entry,
        tail,
        animate,
        connection,
        palette,
        onCopy,
    }: {
        entry: AppEntry;
        tail: boolean;
        animate: boolean;
        connection: Connection;
        palette: Palette;
        onCopy: (text: string) => void;
    }) => {
        const props: BubbleProps = {
            text: entry.text,
            files: entry.files ?? [],
            reaction: entry.reaction,
            tail,
            connection,
            palette,
            onLongPress: () => entry.text && onCopy(entry.text),
        };
        const body = entry.role === "user" ? <UserBubble {...props} /> : <AssistantMessage {...props} />;
        return animate ? <Animated.View entering={FadeIn.duration(220)}>{body}</Animated.View> : body;
    },
);

export const PendingMessage = ({
    pending,
    tail,
    connection,
    palette,
    onRetry,
}: {
    pending: Pending;
    tail: boolean;
    connection: Connection;
    palette: Palette;
    onRetry: (clientId: string) => void;
}) => (
    <Animated.View entering={FadeIn.duration(160)}>
        <UserBubble
            text={pending.text}
            files={pending.attachments}
            tail={tail}
            faded={pending.state !== "failed"}
            connection={connection}
            palette={palette}
            onLongPress={() => {}}
        />
        {pending.state === "failed" ? (
            <Pressable onPress={() => onRetry(pending.clientId)} hitSlop={8} style={styles.failed}>
                <Text style={[type.caption, { color: palette.danger }]}>Not sent · Tap to try again</Text>
            </Pressable>
        ) : null}
    </Animated.View>
);

const styles = StyleSheet.create({
    userRow: { alignItems: "flex-end", gap: 4, paddingLeft: 56 },
    withReaction: { paddingBottom: 14 },
    bubbleWrap: { maxWidth: "100%" },
    userBubble: { borderRadius: 21, paddingHorizontal: 15, paddingVertical: 9 },
    userTail: { borderBottomRightRadius: 6 },
    faded: { opacity: 0.55 },
    assistantRow: { paddingRight: 24, gap: 8 },
    files: { gap: 4 },
    photo: { borderRadius: 18 },
    fileCard: {
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        borderRadius: 16,
        borderWidth: StyleSheet.hairlineWidth,
        padding: 10,
        paddingRight: 16,
        maxWidth: 280,
    },
    fileIcon: { width: 40, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center" },
    fileName: { fontWeight: "600" },
    flexShrink: { flexShrink: 1 },
    reaction: {
        position: "absolute",
        bottom: 0,
        right: 10,
        minWidth: 30,
        height: 26,
        paddingHorizontal: 6,
        borderRadius: 13,
        alignItems: "center",
        justifyContent: "center",
        shadowOpacity: 1,
        shadowRadius: 6,
        shadowOffset: { width: 0, height: 2 },
        elevation: 3,
    },
    reactionText: { fontSize: 15, lineHeight: 19 },
    failed: { alignSelf: "flex-end", marginTop: 6 },
});
