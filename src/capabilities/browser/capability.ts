import { posix } from "node:path";
import { Type } from "typebox";
import type { BrowserProvider, BrowserTab, DownloadedFile } from "../../browser/browser.js";
import { clickIsCommit, clickIsDeclaration, typingIsRefused } from "../../browser/guard.js";
import type { LiveViews } from "../../browser/live-view.js";
import { type AppApproval, appApproval, appProviders } from "../../browser/spid.js";
import { promptFile } from "../../prompts/prompt-file.js";
import type { SandboxProvider } from "../../sandbox/sandbox.js";
import { type Capability, defineTool, type ToolContext, type ToolOutput } from "../types.js";
import { guideFor, SITE_GUIDES } from "./sites/index.js";

// A page is read in parts this long; the tree of a big page runs to hundreds of thousands.
const PAGE_CHARS = 10_000;
const MAX_FILE_BYTES = 20_000_000;
const MAX_IMAGE_BYTES = 4_000_000;
// A guide read this long ago is read again on the next visit.
const GUIDE_FRESH_MS = 6 * 60 * 60_000;
// How often the page is looked at while the user does their part elsewhere.
const POLL_MS = 2_000;
// As long as a live view link lasts.
const LIVE_VIEW_MINUTES = 15;
// A page may build the file after the click, as the Anagrafe does with its PDFs.
const DOWNLOAD_WAIT_MS = 30_000;
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

/** How Conscious goes on by itself once the user did their part outside the chat. */
export interface BrowserWatching {
    /** Runs the user's request on, in their chat, with a note on what happened; skipped if they wrote since `since`. */
    resume?: (userId: string, note: string, since: number) => Promise<unknown>;
    pollMs?: number;
}

const withoutHash = (url: string): string => url.split("#")[0] ?? url;

const hostOf = (url: string): string => {
    try {
        return new URL(url).hostname;
    } catch {
        return url;
    }
};

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
    watching: BrowserWatching = {},
): Capability => {
    const pollMs = watching.pollMs ?? POLL_MS;
    // One watch per user: the latest hand-over, until the agent acts in the browser again.
    const watches = new Map<string, symbol>();

    /**
     * Watches the user's page while they do their part elsewhere (the SPID app, the live view), and
     * goes on by itself once `moved` says the page moved on, so they need not write "done".
     */
    const watch = (userId: string, until: number, moved: (url: string) => boolean, note: (url: string) => string) => {
        const { resume } = watching;
        if (!resume) return false;
        const token = Symbol(userId);
        watches.set(userId, token);
        const since = Date.now();
        void (async () => {
            while (watches.get(userId) === token && Date.now() < until) {
                await new Promise((done) => setTimeout(done, pollMs));
                if (watches.get(userId) !== token) return;
                const url = await browsers
                    .forUser(userId)
                    .then(async (session) => (await session.tab()).url())
                    .catch(() => undefined);
                if (url && moved(url)) {
                    watches.delete(userId);
                    await resume(userId, note(url), since).catch((error) =>
                        console.error(`[browser] could not go on for ${userId}`, error),
                    );
                    return;
                }
            }
            if (watches.get(userId) === token) watches.delete(userId);
        })();
        return true;
    };
    // The last tree each user's agent read, so it can read on without the page shifting under it.
    const trees = new Map<string, { url: string; text: string }>();

    const tabFor = async (context: ToolContext): Promise<BrowserTab> => {
        // The agent is at the browser again: whatever it was waiting for, it is going on itself.
        watches.delete(context.userId);
        return (await browsers.forUser(context.userId)).tab();
    };

    /** What the agent sees of a page: where it is, and a part of its tree. */
    const look = async (context: ToolContext, tab: BrowserTab, from = 0) => {
        const url = tab.url();
        const cached = trees.get(context.userId);
        const text = from > 0 && cached?.url === url ? cached.text : await tab.snapshot();
        trees.set(context.userId, { url, text });
        const next = from + PAGE_CHARS;
        // A site with a guide says so the first time the agent lands on it, so it never has to remember.
        const guide = guideFor(url);
        const unread = guide && !hasRead(context.userId, guide.id);
        return {
            url,
            title: await tab.title(),
            ...(unread
                ? {
                      siteGuide: `There is a guide to ${guide.name}: read it before going on, with browser_read_site_guide site="${guide.id}".`,
                  }
                : {}),
            page: text.slice(from, next),
            ...(next < text.length
                ? { more: `${text.length - next} more characters: browser_read_page with from=${next}` }
                : {}),
        };
    };

    // Which guides each user's agent read lately: it reads one once, not on every click.
    const guidesRead = new Map<string, Map<string, number>>();
    const hasRead = (userId: string, id: string): boolean => {
        const at = guidesRead.get(userId)?.get(id);
        return at !== undefined && now().getTime() - at < GUIDE_FRESH_MS;
    };

    const readGuide = defineTool({
        name: "browser_read_site_guide",
        label: "Read a site's guide",
        description: `How a site works, from earlier visits: where things are, the quickest way through, and which steps are the user's own. Read it before a job on: ${SITE_GUIDES.map((guide) => `${guide.id} (${guide.name})`).join(", ")}.`,
        effect: "read",
        parameters: Type.Object({
            site: Type.Union(
                SITE_GUIDES.map((guide) => Type.Literal(guide.id)),
                { description: "Which site." },
            ),
        }),
        execute: async (params, context) => {
            const guide = SITE_GUIDES.find((candidate) => candidate.id === params.site);
            if (!guide) throw new Error("No guide for that site.");
            const read = guidesRead.get(context.userId) ?? new Map<string, number>();
            read.set(guide.id, now().getTime());
            guidesRead.set(context.userId, read);
            return {
                data: { site: guide.name, guide: guide.text() },
                guidance:
                    "Follow it where it fits what the user asked. If the site has changed from what it says, trust the page.",
            };
        },
    });

    const save = async (context: ToolContext, name: string, bytes: Uint8Array): Promise<string> => {
        const stamp = now().toISOString().slice(0, 19).replace(/[-:T]/g, "");
        const path = `files/browser/${stamp}-${name}`;
        await (await sandboxes.forUser(context.userId)).writeFile(path, bytes);
        return path;
    };

    /** Keeps a file a click made the browser download, and says where it went. */
    const keep = async (context: ToolContext, file: DownloadedFile, name?: string) => {
        const extension = posix.extname(file.name).toLowerCase();
        const base = (name || posix.basename(file.name, extension) || "file").replace(/[^\w.-]+/g, "-").slice(0, 60);
        const saved = await save(
            context,
            `${base || "file"}${/^\.[a-z0-9]{1,5}$/.test(extension) ? extension : ""}`,
            file.bytes,
        );
        return { saved, name: file.name, bytes: file.bytes.length };
    };

    const keptGuidance =
        "The click downloaded a file, now saved on your computer. To give it to the user while answering them, send it with computer_send_file. In a background job, say where it is saved.";

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

    /** The click is the user's own declaration: they make it in the live view. */
    const declarationRefused = (label: string, why: string) =>
        new Error(
            `Not done: "${label}" would declare something in the user's name (${why}). That choice is theirs alone. Call browser_ask_user_to_act on this page, saying what they are asked to declare, and wait for them.`,
        );

    const click = defineTool({
        name: "browser_click",
        label: "Click",
        description:
            'Click an element of the page by its ref. With `next`, click more elements of the same page after it, in order, in one step: ticking or unticking boxes, picking options, then a button. A click that pays, books, orders, sends, posts, deletes or signs up is refused, and so is one that declares something in the user\'s name (an exemption reason, "dichiaro"). Consents the job needs, like "Acconsento" on SPID, are yours to click.',
        effect: "draft",
        parameters: Type.Object({
            ref,
            next: Type.Optional(
                Type.Array(ref, {
                    maxItems: 12,
                    description:
                        "More refs from the same page to click after the first, in order. Only for steps whose result you need not read in between.",
                }),
            ),
        }),
        execute: async (params, context) => {
            const tab = await tabFor(context);
            const refs = [params.ref, ...(params.next ?? [])];
            const clicked: string[] = [];
            let file: DownloadedFile | undefined;
            for (const target of refs) {
                const element = await tab.inspect(target);
                const why = clickIsCommit(element);
                const declares = why ? undefined : clickIsDeclaration(element);
                // What was clicked before a refusal stays clicked: say so, so nothing is done twice.
                const done = clicked.length ? ` Already clicked first: ${clicked.join(", ")}.` : "";
                if (why) throw new Error(`${commitRefused(element.name, why).message}${done}`);
                if (declares) throw new Error(`${declarationRefused(element.name, declares).message}${done}`);
                file = (await tab.click(target)) ?? file;
                clicked.push(target);
            }
            const page = await look(context, tab);
            const data = refs.length > 1 ? { ...page, clicked } : page;
            if (!file) return { data };
            return { data: { ...data, downloaded: await keep(context, file) }, guidance: keptGuidance };
        },
    });

    const download = defineTool({
        name: "browser_download",
        label: "Download a file",
        description:
            'Click a button that makes the page download a file, like "Scarica il certificato" or "Download PDF", wait for the file, and save it on your computer. For a file the page makes itself, which has no address for browser_save_file. The same clicks are refused as with browser_click.',
        effect: "draft",
        parameters: Type.Object({
            ref,
            name: Type.Optional(Type.String({ description: "A short file name, e.g. autocertificazione-residenza." })),
        }),
        execute: async (params, context) => {
            const tab = await tabFor(context);
            const element = await tab.inspect(params.ref);
            const why = clickIsCommit(element);
            if (why) throw commitRefused(element.name, why);
            const declares = clickIsDeclaration(element);
            if (declares) throw declarationRefused(element.name, declares);
            const file = await tab.click(params.ref, DOWNLOAD_WAIT_MS);
            if (!file) {
                throw new Error(
                    "No file came within 30 seconds. Read the page: it may ask for one more step, or show the file to open instead.",
                );
            }
            return { data: { ...(await keep(context, file, params.name)), url: tab.url() }, guidance: keptGuidance };
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

    /** Sends the user to their SPID app, and goes on by itself once the page moves past the sign-in. */
    const handToApp = (context: ToolContext, tab: BrowserTab, approval: AppApproval): ToolOutput => {
        const from = withoutHash(tab.url());
        const watched = watch(
            context.userId,
            Date.now() + (approval.lifetimeSeconds + 60) * 1000,
            (url) => withoutHash(url) !== from,
            (url) =>
                `[Not from the user: they approved the sign-in in the ${approval.app} app, and your browser moved on to ${url}. Go on with what they asked. Do not ask them whether they approved.]`,
        );
        const after = watched
            ? "Stop now. You need not ask them to tell you when they are done: as soon as the page moves on you are woken to go on, so say they only have to approve."
            : "Stop now and wait for them; once they say they approved, read the page, which goes on by itself.";
        return {
            data: { ...approval, url: tab.url() },
            guidance: `Send the user this link in one short message: they tap it on their phone, the ${approval.app} app opens, and they approve the sign-in there. It lasts about ${Math.round(approval.lifetimeSeconds / 60)} minutes. Never send it anywhere else. ${after} If the code ran out first, reload the provider's page or press its button for a new code, then call browser_ask_user_to_approve_in_app again.`,
        };
    };

    /** Hands the live view over, and goes on by itself once the page moves on as `moved` says. */
    const watchLiveView = (context: ToolContext, from: string, moved: (url: string) => boolean, did: string) =>
        watch(
            context.userId,
            Date.now() + LIVE_VIEW_MINUTES * 60_000,
            moved,
            (url) =>
                `[Not from the user: while they had the live view open, your browser moved on from ${from} to ${url}: ${did}. Read the page and go on with what they asked. Do not ask them whether they are done.]`,
        );

    const signIn = defineTool({
        name: "browser_ask_user_to_sign_in",
        label: "Ask the user to sign in",
        description:
            "Whenever the user wants you signed in to a website in your browser (GitHub, Amazon, an airline, SPID or CIE on a public office's site): open its sign-in page and get a private link that shows your browser, so the user signs in themselves. You never see or type their password, and the browser stays signed in for next time. Leave out `url` when the sign-in page is already open, as after choosing an identity provider. Not the Vault: that is for tools and plugins.",
        effect: "draft",
        parameters: Type.Object({
            url: Type.Optional(
                Type.String({
                    description:
                        "The site's sign-in page, starting with https://. Leave it out to keep the page open now.",
                }),
            ),
            site: Type.String({ description: "The site's name, as the user knows it." }),
        }),
        execute: async (params, context) => {
            const url = params.url?.trim();
            if (url !== undefined && !/^https?:\/\//i.test(url))
                throw new Error("Give a full address, starting with https://");
            const session = await browsers.forUser(context.userId);
            const tab = await session.tab();
            if (url) await tab.goto(url);
            // On a SPID provider whose app can approve the sign-in, that link is better on a phone.
            const transaction = await tab.spidTransaction().catch(() => undefined);
            const approval = transaction && appApproval(transaction);
            if (approval) return handToApp(context, tab, approval);
            const { link } = liveViews.open(context.userId, await session.liveView());
            const from = tab.url();
            const host = hostOf(from);
            // Signing in moves through the provider's own pages; the user is done when the site's own comes back.
            const watched = watchLiveView(
                context,
                from,
                (url) => hostOf(url) !== host,
                `they signed in to ${params.site}`,
            );
            const after = watched
                ? "Stop now: you are woken to go on once they are in, so they need not tell you. In a background job, end with the link and what you will do once they are in."
                : "Then they tell you they are done. Stop now: in the chat, wait for their reply; in a background job, end with the link and what you will do once they are in.";
            return {
                data: { link, expiresInMinutes: LIVE_VIEW_MINUTES },
                guidance: `Send the user this link in one short message: it shows your browser on the ${params.site} sign-in page, where they sign in themselves. Never send it anywhere else. ${after}`,
            };
        },
    });

    const approveInApp = defineTool({
        name: "browser_ask_user_to_approve_in_app",
        label: "Ask the user to approve in their SPID app",
        description: `On an identity provider's SPID sign-in page in your browser, the one that shows a QR code: get a link that opens the provider's app on the user's phone, on this very sign-in. They tap it, approve in the app, and the page goes on by itself. Use it instead of the live view whenever the provider is one of: ${appProviders().join(", ")}. The user is on their phone and cannot scan a QR code on it.`,
        effect: "draft",
        parameters: Type.Object({}),
        execute: async (_params, context) => {
            const tab = await tabFor(context);
            const transaction = await tab.spidTransaction();
            const approval = transaction && appApproval(transaction);
            if (!approval) {
                throw new Error(
                    "This page waits for no app sign-in Conscious knows. Open the identity provider's sign-in page first; for another provider, use browser_ask_user_to_sign_in.",
                );
            }
            return handToApp(context, tab, approval);
        },
    });

    const act = defineTool({
        name: "browser_ask_user_to_act",
        label: "Ask the user to act",
        description:
            'Hand your browser to the user, on the page open now, for a step that is theirs alone: a declaration ("dichiaro", the legal reason for a stamp-duty exemption), a choice only they can make. Not for consents the job needs ("Acconsento" on SPID, a privacy notice): click those yourself. Returns a private link that shows your browser.',
        effect: "draft",
        parameters: Type.Object({
            what: Type.String({
                description:
                    'What they are asked to do there, in plain words, e.g. "allow Poste to pass your tax code to the Anagrafe".',
            }),
        }),
        execute: async (params, context) => {
            const session = await browsers.forUser(context.userId);
            const { link } = liveViews.open(context.userId, await session.liveView());
            const from = (await session.tab()).url();
            const watched = watchLiveView(
                context,
                from,
                (url) => withoutHash(url) !== withoutHash(from),
                `they did their part: ${params.what}`,
            );
            const after = watched
                ? "Say it is their choice, and that you go on by yourself once they have done it. Stop now: you are woken when the page moves on. If it does not move, they will tell you."
                : "Say it is their choice and that you go on once they tell you they are done. Stop now: in the chat, wait for their reply; in a background job, end with the link.";
            return {
                data: { link, expiresInMinutes: LIVE_VIEW_MINUTES, url: from },
                guidance: `Send the user this link in one short message, with what they are asked to do: ${params.what}. Never send it anywhere else. ${after}`,
            };
        },
    });

    return {
        id: "browser",
        summary:
            "Your own browser: open pages, click and type, take screenshots, find and save pictures and files, and use sites the user signed in to.",
        skill: promptFile(import.meta.url, "SKILL.md"),
        tools: [
            open,
            read,
            click,
            download,
            type,
            press,
            scroll,
            back,
            screenshot,
            findImages,
            saveFile,
            signIn,
            approveInApp,
            act,
            readGuide,
        ],
    };
};
