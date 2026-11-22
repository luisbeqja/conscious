import { promptFile } from "../../../prompts/prompt-file.js";

/** A site Conscious has a guide for: how it works, where things are, what is the user's to do. */
export interface SiteGuide {
    id: string;
    name: string;
    hosts: RegExp;
    text: () => string;
}

export const SITE_GUIDES: readonly SiteGuide[] = [
    {
        id: "anpr",
        name: "ANPR, the Anagrafe Nazionale",
        hosts: /(^|\.)(anagrafenazionale\.interno\.it|anpr\.interno\.it)$/,
        text: () => promptFile(import.meta.url, "anpr.md"),
    },
];

/** The guide for the site at this address, if there is one. */
export const guideFor = (url: string): SiteGuide | undefined => {
    let host: string;
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return undefined;
    }
    return SITE_GUIDES.find((guide) => guide.hosts.test(host));
};
