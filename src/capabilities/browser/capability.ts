import { posix } from "node:path";
import { Type } from "typebox";
import type { BrowserProvider, BrowserTab } from "../../browser/browser.js";
import { clickIsCommit, typingIsRefused } from "../../browser/guard.js";
import type { LiveViews } from "../../browser/live-view.js";
import { promptFile } from "../../prompts/prompt-file.js";
import type { SandboxProvider } from "../../sandbox/sandbox.js";
import { type Capability, defineTool, type ToolContext } from "../types.js";

// A page is read in parts this long; the tree of a big page runs to hundreds of thousands.
const PAGE_CHARS = 10_000;
const MAX_FILE_BYTES = 20_000_000;
const MAX_IMAGE_BYTES = 4_000_000;
// Enter and Space are left out on purpose: they can press a focused "Pay" button past the guard.
const KEYS = ["Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"];
const EXTENSIONS: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "application/pdf": "pdf",
    "text/csv": "csv",
    "text/plain": "txt",
    "application/json": "json",
};

const ref = Type.String({ description: "The element's ref from the page, like e12." });

const commitRefused = (label: string, why: string) =>
    new Error(
        `Not done: "${label}" would act for the user (${why}). That needs their explicit yes, which is not built yet. Stop here and tell them exactly what is left to click; they can do it themselves.`,
    );

/**
 * A real Chrome for the agent, on a computer of the user's own: it opens pages, clicks and types,
 * takes screenshots, finds and saves pictures and files, and stays signed in to the sites the
 * user signed in to themselves through a live view. Clicks that pay, book or send are refused.
 */
export const createBrowserCapability = (
    browsers: BrowserProvider,
    liveViews: LiveViews,
    sandboxes: SandboxProvider,
    now: () => Date = () => new Date(),
): Capability => {
    // The last tree each user's agent read, so it can read on without the page shifting under it.
    const trees = new Map<string, { url: string; text: string }>();

    const tabFor = async (context: ToolContext): Promise<BrowserTab> => (await browsers.forUser(context.userId)).tab();

    /** What the agent sees of a page: where it is, and a part of its tree. */
    const look = async (context: ToolContext, tab: BrowserTab, from = 0) => {
        const url = tab.url();
        const cached = trees.get(context.userId);
        const text = from > 0 && cached?.url === url ? cached.text : await tab.snapshot();
        trees.set(context.userId, { url, text });
        const next = from + PAGE_CHARS;
        return {
            url,
            title: await tab.title(),
            page: text.slice(from, next),
            ...(next < text.length
                ? { more: `${text.length - next} more characters: browser_read_page with from=${next}` }
                : {}),
        };
    };

    const save = async (context: ToolContext, name: string, bytes: Uint8Array): Promise<string> => {
        const stamp = now().toISOString().slice(0, 19).replace(/[-:T]/g, "");
        const path = `files/browser/${stamp}-${name}`;
        await (await sandboxes.forUser(context.userId)).writeFile(path, bytes);
        return path;
    };

    const open = defineTool({
        name: "browser_open_page",
        label: "Open a page",
        description:
            "Open a page in your browser, a real Chrome that stays signed in to the sites the user signed in to. Returns the page as a tree of its elements, each with a ref to click or type into.",
        effect: "read",
        parameters: Type.Object({ url: Type.String({ description: "A full address, starting with https://" }) }),
        execute: async (params, context) => {
            const url = params.url.trim();
            if (!/^https?:\/\//i.test(url)) throw new Error("Give a full address, starting with https://");
            const tab = await tabFor(context);
            await tab.goto(url);
            return { data: await look(context, tab) };
        },
    });

    const read = defineTool({
        name: "browser_read_page",
        label: "Read the page",
        description: "The page open in your browser now. `from` reads on in a long page.",
        effect: "read",
        parameters: Type.Object({
            from: Type.Optional(
                Type.Integer({ minimum: 0, description: "Where to read on from, as given by `more`." }),
            ),
        }),
        execute: async (params, context) => ({ data: await look(context, await tabFor(context), params.from ?? 0) }),
    });

    const click = defineTool({
        name: "browser_click",
        label: "Click",
        description:
            "Click an element of the page by its ref. A click that pays, books, orders, sends, posts, deletes or signs up is refused.",
        effect: "draft",
        parameters: Type.Object({ ref }),
        execute: async (params, context) => {
            const tab = await tabFor(context);
            const element = await tab.inspect(params.ref);
            const why = clickIsCommit(element);
            if (why) throw commitRefused(element.name, why);
            await tab.click(params.ref);
            return { data: await look(context, tab) };
        },
    });

    const type = defineTool({
        name: "browser_type",
        label: "Type",
        description:
            "Type into a field of the page by its ref, replacing what is there. `submit` presses Enter after. Never a password or card details.",
        effect: "draft",
        parameters: Type.Object({
            ref,
            text: Type.String(),
            submit: Type.Optional(Type.Boolean({ description: "Press Enter after, e.g. to search." })),
        }),
        execute: async (params, context) => {
            const tab = await tabFor(context);
            const element = await tab.inspect(params.ref);
            const refused = typingIsRefused(element);
            if (refused === "password") {
                throw new Error(
                    "Not typed: you never type a password. Ask the user to sign in themselves with browser_ask_user_to_sign_in.",
                );
            }
            if (refused === "card") {
                throw new Error("Not typed: card and bank details are the user's to enter. Stop here and tell them.");
            }
            if (params.submit && element.formAsksFor.includes("card")) {
                throw commitRefused(element.name || "Enter", "it submits a form with card details");
            }
            await tab.type(params.ref, params.text, params.submit ?? false);
            return { data: await look(context, tab) };
        },
    });

    const press = defineTool({
        name: "browser_press_key",
        label: "Press a key",
        description: "Press a key on the page: close a pop-up with Escape, move through a list with the arrows.",
        effect: "draft",
        parameters: Type.Object({ key: Type.Union(KEYS.map((key) => Type.Literal(key))) }),
        execute: async (params, context) => {
            const tab = await tabFor(context);
            await tab.press(params.key);
            return { data: await look(context, tab) };
        },
    });

    const scroll = defineTool({
        name: "browser_scroll",
        label: "Scroll",
        description: "Scroll the page, so a page that loads more as you go shows it.",
        effect: "read",
        parameters: Type.Object({ direction: Type.Union([Type.Literal("down"), Type.Literal("up")]) }),
        execute: async (params, context) => {
            const tab = await tabFor(context);
            await tab.scroll(params.direction);
            return { data: await look(context, tab) };
        },
    });

    const back = defineTool({
        name: "browser_go_back",
        label: "Go back",
        description: "Go back to the page before.",
        effect: "read",
        parameters: Type.Object({}),
        execute: async (_params, context) => {
            const tab = await tabFor(context);
            await tab.back();
            return { data: await look(context, tab) };
        },
    });

    const screenshot = defineTool({
        name: "browser_take_screenshot",
        label: "Take a screenshot",
        description:
            "See the page as the user would: a picture of the window, or of the whole page from the top. It is saved on your computer too.",
        effect: "read",
        parameters: Type.Object({
            fullPage: Type.Optional(Type.Boolean({ description: "The whole page from the top, not just the window." })),
        }),
        execute: async (params, context) => {
            const tab = await tabFor(context);
            const bytes = await tab.screenshot(params.fullPage ?? false);
            const saved = await save(context, "screenshot.jpg", bytes);
            return {
                data: { url: tab.url(), saved },
                images: [{ data: Buffer.from(bytes).toString("base64"), mimeType: "image/jpeg" }],
                guidance: context.seesImages
                    ? undefined
                    : "You cannot see pictures: describe the page from browser_read_page instead.",
            };
        },
    });

    const findImages = defineTool({
        name: "browser_find_images",
        label: "Find pictures",
        description:
            "The pictures on the page, biggest first: the one the page shares (a product, a place, an article) and the rest, with their addresses.",
        effect: "read",
        parameters: Type.Object({}),
        execute: async (_params, context) => {
            const images = await (await tabFor(context)).images();
            return {
                data: images
                    .sort((a, b) => b.width * b.height - a.width * a.height)
                    .map((image, index) => ({ index, ...image })),
            };
        },
    });

    const saveFile = defineTool({
        name: "browser_save_file",
        label: "Save a picture or file",
        description:
            "Save a picture or file from the web to your computer, with the browser's sign-ins, so files behind a login come too.",
        effect: "draft",
        parameters: Type.Object({
            url: Type.String({ description: "The picture's or file's address, e.g. from browser_find_images." }),
            name: Type.Optional(Type.String({ description: "A short file name, e.g. lisbon-tram." })),
        }),
        execute: async (params, context) => {
            const tab = await tabFor(context);
            const target = new URL(params.url, tab.url() || undefined);
            if (target.protocol !== "https:" && target.protocol !== "http:") throw new Error("Not a web address");
            const { bytes, contentType } = await tab.download(target.href);
            if (bytes.length > MAX_FILE_BYTES) throw new Error("Over 20 MB: too big to keep.");
            const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
            const base =
                (params.name || posix.basename(target.pathname) || "file").replace(/[^\w.-]+/g, "-").slice(0, 60) ||
                "file";
            const extension = EXTENSIONS[mime];
            const name =
                extension && !base.toLowerCase().endsWith(`.${extension}`)
                    ? `${base.replace(/\.[a-z0-9]{1,5}$/i, "")}.${extension}`
                    : base;
            const saved = await save(context, name, bytes);
            const showable = mime.startsWith("image/") && mime !== "image/svg+xml" && bytes.length <= MAX_IMAGE_BYTES;
            return {
                data: { saved, type: mime, bytes: bytes.length },
                images: showable ? [{ data: Buffer.from(bytes).toString("base64"), mimeType: mime }] : undefined,
                guidance:
                    "To give it to the user while answering them, send it with computer_send_file. In a background job, say where it is saved.",
            };
        },
    });

    const signIn = defineTool({
        name: "browser_ask_user_to_sign_in",
        label: "Ask the user to sign in",
        description:
            "Whenever the user wants you signed in to a website in your browser (GitHub, Amazon, an airline): open its sign-in page and get a private link that shows your browser, so the user signs in themselves. You never see or type their password, and the browser stays signed in for next time. Not the Vault: that is for tools and plugins.",
        effect: "draft",
        parameters: Type.Object({
            url: Type.String({ description: "The site's sign-in page, starting with https://" }),
            site: Type.String({ description: "The site's name, as the user knows it." }),
        }),
        execute: async (params, context) => {
            if (!/^https?:\/\//i.test(params.url.trim()))
                throw new Error("Give a full address, starting with https://");
            const session = await browsers.forUser(context.userId);
            await (await session.tab()).goto(params.url.trim());
            const { link } = liveViews.open(context.userId, await session.liveView());
            return {
                data: { link, expiresInMinutes: 15 },
                guidance: `Send the user this link in one short message: it shows your browser on the ${params.site} sign-in page, where they sign in themselves, then tell you they are done. Never send it anywhere else. Stop now: in the chat, wait for their reply; in a background job, end with the link and what you will do once they are in.`,
            };
        },
    });

    return {
        id: "browser",
        summary:
            "Your own browser: open pages, click and type, take screenshots, find and save pictures and files, and use sites the user signed in to.",
        skill: promptFile(import.meta.url, "SKILL.md"),
        tools: [open, read, click, type, press, scroll, back, screenshot, findImages, saveFile, signIn],
    };
};
