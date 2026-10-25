import type { IncomingFile } from "../media/incoming.js";
import type { Transcriber } from "../media/transcribe.js";

/**
 * A voice note as the agent reads it: what was said, marked as a voice note. A string instead is
 * the whole answer, sent without the agent, when there is nothing to hand it.
 */
export const hearVoiceNote = async (
    transcriber: Transcriber | undefined,
    audio: () => Promise<Uint8Array>,
    mimeType: string,
    channel: string,
): Promise<{ text: string; files: IncomingFile[] } | string> => {
    if (!transcriber) return "I can't listen to voice notes on this install yet. Could you write it?";
    try {
        const said = await transcriber.transcribe(await audio(), mimeType);
        if (!said) return "I couldn't make out that voice note. Could you say it again, or write it?";
        return { text: `(voice note) ${said}`, files: [] };
    } catch (error) {
        console.error(`[${channel}] voice note failed`, error);
        return "I couldn't listen to that voice note just now. Could you write it?";
    }
};
