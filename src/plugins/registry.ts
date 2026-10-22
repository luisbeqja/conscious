import { createHash } from "node:crypto";
import type { PluginPackage } from "./manifest.js";

/**
 * - `bundled`: ships in the repository's `plugins/` folder, reviewed as a pull request. Every user can install it.
 * - `agent`: written by the agent on this install. Only the user it was written for can install it.
 */
export type PluginSource = "bundled" | "agent";

export interface PluginVersion {
    pkg: PluginPackage;
    /** Content hash. An install pins it, so a version can never change under a user. */
    hash: string;
    author: string;
    source: PluginSource;
    publishedAt: Date;
    /** Why it was disabled. A disabled version runs for nobody. */
    quarantined?: string;
}

export interface PluginListing {
    id: string;
    name: string;
    summary: string;
    version: string;
    source: PluginSource;
    connector?: string;
    tools: string[];
}

/** A version as saved to disk. */
export interface SavedVersion extends Omit<PluginVersion, "publishedAt" | "source"> {
    source?: PluginSource;
    publishedAt: string;
}

/** The author of the repository's bundled plugins. */
export const BUNDLED_AUTHOR = "conscious";

export const hashPackage = (pkg: PluginPackage): string =>
    createHash("sha256")
        .update(JSON.stringify([pkg.manifest, pkg.code, pkg.skill]))
        .digest("hex");

const compareVersions = (a: string, b: string): number => {
    const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
    for (let index = 0; index < 3; index++) {
        const difference = (x[index] ?? 0) - (y[index] ?? 0);
        if (difference) return difference;
    }
    return 0;
};

/**
 * The plugins on this install: the bundled ones and the ones the agent wrote. Nothing is shared
 * with other installs. `onChange` is called after every change, so the state can be saved.
 */
export class PluginRegistry {
    private readonly plugins = new Map<string, PluginVersion[]>();
    private readonly reserved = new Set<string>();
    onChange?: () => void;

    /** Built-in capability ids a plugin may not take. */
    reserve(ids: Iterable<string>): this {
        for (const id of ids) this.reserved.add(id);
        return this;
    }

    publish(pkg: PluginPackage, options: { author: string; source: PluginSource }): PluginVersion {
        const { id, version } = pkg.manifest;
        if (this.reserved.has(id)) throw new Error(`"${id}" is a built-in capability; pick another id`);
        const versions = this.plugins.get(id) ?? [];
        const owner = versions[0]?.author;
        if (owner && owner !== options.author) throw new Error(`"${id}" belongs to another author; pick another id`);
        if (versions.some((existing) => existing.pkg.manifest.version === version)) {
            throw new Error(`${id}@${version} already exists; raise the version`);
        }
        const published: PluginVersion = {
            pkg,
            hash: hashPackage(pkg),
            author: options.author,
            source: options.source,
            publishedAt: new Date(),
        };
        this.plugins.set(id, [...versions, published]);
        this.onChange?.();
        return published;
    }

    /**
     * Loads a plugin from the repository's `plugins/` folder. The folder is the source of truth
     * for its own plugins: a changed file replaces the saved copy.
     */
    seed(pkg: PluginPackage): void {
        const existing = this.get(pkg.manifest.id, pkg.manifest.version);
        if (!existing) {
            this.publish(pkg, { author: BUNDLED_AUTHOR, source: "bundled" });
            return;
        }
        if (existing.author !== BUNDLED_AUTHOR) {
            throw new Error(`${pkg.manifest.id} is taken by a plugin the agent wrote; rename the bundled plugin`);
        }
        const hash = hashPackage(pkg);
        if (existing.hash === hash) return;
        Object.assign(existing, { pkg, hash, source: "bundled", quarantined: undefined });
        this.onChange?.();
    }

    snapshot(): SavedVersion[] {
        return [...this.plugins.values()].flat().map((version) => ({
            ...version,
            publishedAt: version.publishedAt.toISOString(),
        }));
    }

    restore(saved: readonly SavedVersion[]): void {
        this.plugins.clear();
        for (const { pkg, hash, author, quarantined, publishedAt, source } of saved) {
            const id = pkg.manifest.id;
            this.plugins.set(id, [
                ...(this.plugins.get(id) ?? []),
                {
                    pkg,
                    hash,
                    author,
                    quarantined,
                    // Saves from before sources existed: the bundled plugins are the ones by Conscious.
                    source: source ?? (author === BUNDLED_AUTHOR ? "bundled" : "agent"),
                    publishedAt: new Date(publishedAt),
                },
            ]);
        }
    }

    get(id: string, version: string): PluginVersion | undefined {
        return this.plugins.get(id)?.find((candidate) => candidate.pkg.manifest.version === version);
    }

    /** The newest version this user may install. */
    latest(id: string, userId: string): PluginVersion | undefined {
        return (this.plugins.get(id) ?? [])
            .filter((candidate) => this.visible(candidate, userId))
            .sort((a, b) => compareVersions(b.pkg.manifest.version, a.pkg.manifest.version))[0];
    }

    /** Plugins matching every word of the query, bundled ones first. */
    search(query: string, userId: string): PluginListing[] {
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        const listings: PluginListing[] = [];
        for (const id of this.plugins.keys()) {
            const version = this.latest(id, userId);
            if (!version) continue;
            const { manifest } = version.pkg;
            const haystack = [manifest.id, manifest.name, manifest.summary, ...manifest.tools.map((t) => t.description)]
                .join(" ")
                .toLowerCase();
            if (!words.every((word) => haystack.includes(word))) continue;
            listings.push({
                id,
                name: manifest.name,
                summary: manifest.summary,
                version: manifest.version,
                source: version.source,
                connector: manifest.auth?.connector,
                tools: manifest.tools.map((tool) => tool.name),
            });
        }
        return listings.sort((a, b) => Number(b.source === "bundled") - Number(a.source === "bundled"));
    }

    quarantine(id: string, version: string, reason: string): void {
        const published = this.get(id, version);
        if (!published || published.quarantined) return;
        published.quarantined = reason;
        this.onChange?.();
    }

    private visible(version: PluginVersion, userId: string): boolean {
        if (version.quarantined) return false;
        return version.source === "bundled" || version.author === userId;
    }
}

export interface Install {
    id: string;
    version: string;
    hash: string;
}

/** Which plugin versions each user has. Pinned by hash: a new version is never applied silently. */
export class PluginInstalls {
    private readonly installs = new Map<string, Map<string, Install>>();
    onChange?: () => void;

    add(userId: string, install: Install): void {
        const mine = this.installs.get(userId) ?? new Map<string, Install>();
        mine.set(install.id, install);
        this.installs.set(userId, mine);
        this.onChange?.();
    }

    remove(userId: string, id: string): boolean {
        const removed = this.installs.get(userId)?.delete(id) ?? false;
        if (removed) this.onChange?.();
        return removed;
    }

    snapshot(): Record<string, Install[]> {
        return Object.fromEntries([...this.installs].map(([userId, mine]) => [userId, [...mine.values()]]));
    }

    restore(saved: Record<string, readonly Install[]>): void {
        this.installs.clear();
        for (const [userId, installs] of Object.entries(saved)) {
            this.installs.set(userId, new Map(installs.map((install) => [install.id, install])));
        }
    }

    list(userId: string): Install[] {
        return [...(this.installs.get(userId)?.values() ?? [])];
    }
}
