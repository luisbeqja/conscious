import { useEffect, useRef, useState } from "react";
import type { AppEntry } from "../protocol";
import type { Status } from "../chat/useConscious";
import type { DotMood } from "./motion";

const FLASH_MS = 1_600;

/**
 * The Dot's state, from what Conscious is really doing. It confirms only when an answer actually arrived and
 * shows an error only for a real one, so the motion can be trusted.
 */
export const useDotMood = ({
    status,
    answering,
    entries,
    error,
}: {
    status: Status;
    answering: boolean;
    entries: AppEntry[];
    error?: string;
}): DotMood => {
    const [flash, setFlash] = useState<"confirmed" | "error">();
    const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
    const lastAnswer = entries.findLast((entry) => entry.role === "assistant");
    const seenAnswer = useRef<string | undefined>(undefined);
    const loaded = useRef(false);

    useEffect(() => {
        // History arriving on connect is not news; only answers that come in while the chat is open are.
        if (!loaded.current) {
            if (status !== "online") return;
            loaded.current = true;
            seenAnswer.current = lastAnswer?.id;
            return;
        }
        if (!lastAnswer || lastAnswer.id === seenAnswer.current) return;
        seenAnswer.current = lastAnswer.id;
        clearTimeout(timer.current);
        setFlash("confirmed");
        timer.current = setTimeout(() => setFlash(undefined), FLASH_MS);
    }, [lastAnswer, status]);

    useEffect(() => {
        if (!error) return;
        clearTimeout(timer.current);
        setFlash("error");
        timer.current = setTimeout(() => setFlash(undefined), FLASH_MS);
    }, [error]);

    useEffect(() => () => clearTimeout(timer.current), []);

    if (status === "offline" || status === "unauthorized") return "error";
    if (flash) return flash;
    if (answering) return "thinking";
    const last = entries[entries.length - 1];
    if (last?.role === "assistant" && last.text.trim().endsWith("?")) return "awaiting";
    return "idle";
};
