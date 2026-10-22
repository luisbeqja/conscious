const API = "https://api.github.com";

const get = async (ctx, path) => {
    const res = await ctx.http({ url: `${API}${path}`, headers: { "x-github-api-version": "2022-11-28" } });
    if (res.status !== 200) throw new Error(`GitHub answered ${res.status}: ${res.body?.message ?? "no details"}`);
    return res.body;
};

const limit = (params) => Math.min(Math.max(params.limit ?? 15, 1), 50);

export const tools = {
    async github_list_notifications(params, ctx) {
        const items = await get(ctx, `/notifications?per_page=${limit(params)}`);
        return items.map((item) => ({
            repo: item.repository.full_name,
            title: item.subject.title,
            type: item.subject.type,
            reason: item.reason,
            updatedAt: item.updated_at,
        }));
    },

    async github_list_pull_requests(params, ctx) {
        const terms = ["type:pr", "author:@me"];
        if (params.since) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(params.since)) throw new Error("since must be YYYY-MM-DD");
            terms.push(`created:>=${params.since}`);
        }
        if (params.state === "open" || params.state === "closed") terms.push(`state:${params.state}`);
        const query = encodeURIComponent(terms.join(" "));
        const found = await get(ctx, `/search/issues?q=${query}&sort=created&order=desc&per_page=${limit(params)}`);
        return {
            total: found.total_count,
            pullRequests: found.items.map((item) => ({
                repo: item.repository_url.replace("https://api.github.com/repos/", ""),
                number: item.number,
                title: item.title,
                state: item.state,
                createdAt: item.created_at,
                url: item.html_url,
            })),
        };
    },

    async github_list_issues(params, ctx) {
        const items = await get(ctx, `/issues?filter=assigned&state=open&per_page=${limit(params)}`);
        return items.map((item) => ({
            repo: item.repository?.full_name,
            number: item.number,
            title: item.title,
            pullRequest: Boolean(item.pull_request),
            url: item.html_url,
        }));
    },

    async github_create_issue(params, ctx) {
        if (!/^[\w.-]+\/[\w.-]+$/.test(params.repo)) throw new Error("repo must look like owner/name");
        const res = await ctx.http({
            method: "POST",
            url: `${API}/repos/${params.repo}/issues`,
            headers: { "x-github-api-version": "2022-11-28" },
            body: { title: params.title, body: params.body ?? "" },
        });
        if (res.status !== 201) throw new Error(`GitHub answered ${res.status}: ${res.body?.message ?? "no details"}`);
        return { number: res.body.number, url: res.body.html_url };
    },
};
