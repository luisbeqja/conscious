import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { ModelRuntime } from "../src/engine/models.js";
import { createReactor, REACTIONS } from "../src/engine/reactions.js";

/** A model that answers each call with the next of `replies`, and keeps what it was asked. */
const model = (...replies: string[]) => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const asked: string[] = [];
    faux.setResponses(
        replies.map((reply) => (context) => {
            asked.push(JSON.stringify(context.messages));
            return fauxAssistantMessage(fauxText(reply));
        }),
    );
    const runtime: ModelRuntime = {
        model: faux.getModel(),
        streamFn: (streamed, context, options) => models.streamSimple(streamed, context, options),
    };
    return { runtime, asked };
};

describe("createReactor", () => {
    it("reacts with the emoji the model picks, in the form the list keeps it", async () => {
        const { runtime, asked } = model("🎉", "❤", " 👍 \n");
        const reactor = createReactor(runtime);

        expect(await reactor.choose("User: I got the job!!")).toBe("🎉");
        // A heart without its variation selector is still the heart on the list.
        expect(await reactor.choose("User: thank you so much")).toBe("❤️");
        expect(await reactor.choose("User: ok, deal")).toBe("👍");
        expect(asked[0]).toContain("I got the job!!");
    });

    it("does not react when the model says none, or answers with anything off the list", async () => {
        const { runtime } = model("none", "🙂", "🎉 congrats!");
        const reactor = createReactor(runtime);

        expect(await reactor.choose("User: what's the weather tomorrow?")).toBeUndefined();
        expect(await reactor.choose("User: hi")).toBeUndefined();
        expect(await reactor.choose("User: passed my exam")).toBeUndefined();
    });

    it("keeps to emoji Telegram accepts as reactions", () => {
        // Telegram's fixed set for bots, written without U+FE0F; 🙂 and 😂 are not in it.
        const telegram = new Set([
            ..."👍👎❤🔥🥰👏😁🤔🤯😱🤬😢🎉🤩🤮💩🙏👌🕊🤡🥱🥴😍🐳🌚🌭💯🤣⚡🍌🏆💔🤨😐🍓🍾💋🖕😈😴😭🤓👻👀🎃🙈😇😨🤝✍🤗🫡🎅🎄☃💅🤪🗿🆒💘🙉🦄😘💊🙊😎👾🤷😡",
        ]);
        for (const emoji of REACTIONS) expect(telegram.has(emoji.replace(/️/g, ""))).toBe(true);
    });
});
