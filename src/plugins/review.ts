import { Broker, fixtureTransport } from "./broker.js";
import { manifestProblems, type PluginPackage } from "./manifest.js";
import type { PluginSandbox } from "./sandbox/sandbox.js";

export interface ReviewResult {
    passed: boolean;
    problems: string[];
}

/**
 * A tripwire, not the boundary: it is easy to write code that slips past a regex. The
 * sandbox and the broker are what actually contain a plugin; this only rejects the obvious
 * early, with a message the authoring agent can act on.
 */
const FORBIDDEN_CODE: ReadonlyArray<[RegExp, string]> = [
    [/\bimport\b/, "imports (a plugin is one module with no imports)"],
    [/\brequire\s*\(/, "require()"],
    [/\bprocess\b/, "process"],
    [/\bglobalThis\b/, "globalThis"],
    [/\beval\s*\(|\bFunction\s*\(/, "code generated from strings"],
    [/\bWebAssembly\b/, "WebAssembly"],
    [/\bfetch\s*\(/, "fetch() (use ctx.http)"],
];

/** Text the model will read as tool descriptions or skill: it must not try to steer the model. */
const STEERING = /ignore (all |any )?(previous|prior|above)|system prompt|you are now|disregard|do not tell the user/i;

const staticProblems = (pkg: PluginPackage): string[] => {
    const problems = FORBIDDEN_CODE.filter(([pattern]) => pattern.test(pkg.code)).map(
        ([, what]) => `code: uses ${what}`,
    );
    const modelFacing = [pkg.skill, ...pkg.manifest.tools.map((tool) => tool.description)];
    if (modelFacing.some((text) => STEERING.test(text))) {
        problems.push("descriptions: text addressed to the model reads like instructions, not a description");
    }
    if (pkg.code.length > 100_000) problems.push("code: longer than 100,000 characters");
    if (pkg.skill.length > 4_000) problems.push("skill: longer than 4,000 characters");
    return problems;
};

/**
 * What every version goes through before anyone else can install it: the manifest is valid,
 * the code passes the tripwire, it exports exactly the tools it declares, and every tool has a
 * test that passes in the sandbox against recorded responses, calling only declared hosts.
 */
export const reviewPlugin = async (pkg: PluginPackage, sandbox: PluginSandbox): Promise<ReviewResult> => {
    const problems = manifestProblems(pkg.manifest);
    if (problems.length) return { passed: false, problems };
    problems.push(...staticProblems(pkg));
    if (problems.length) return { passed: false, problems };

    const { manifest } = pkg;
    const noNetwork = async () => {
        throw new Error("Listing tools makes no requests");
    };
    let exported: string[];
    try {
        exported = (await sandbox.run({ code: pkg.code, tool: null, params: {}, http: noNetwork })) as string[];
    } catch (error) {
        return { passed: false, problems: [`code: does not load (${(error as Error).message})`] };
    }
    const declared = manifest.tools.map((tool) => tool.name);
    for (const name of declared) {
        if (!exported.includes(name)) problems.push(`code: does not export the declared tool "${name}"`);
    }
    for (const name of exported) {
        if (!declared.includes(name)) problems.push(`code: exports "${name}", which the manifest does not declare`);
    }
    for (const tool of manifest.tools) {
        if (!pkg.tests.some((test) => test.tool === tool.name)) problems.push(`tests: "${tool.name}" has no test`);
    }
    if (problems.length) return { passed: false, problems };

    for (const [index, test] of pkg.tests.entries()) {
        const tool = manifest.tools.find((candidate) => candidate.name === test.tool);
        if (!tool) {
            problems.push(`tests[${index}]: "${test.tool}" is not a declared tool`);
            continue;
        }
        const broker = new Broker({
            hosts: manifest.hosts,
            effect: tool.effect,
            transport: fixtureTransport(test.responses),
        });
        try {
            await sandbox.run({ code: pkg.code, tool: test.tool, params: test.params, http: broker.request });
        } catch (error) {
            problems.push(`tests[${index}] ${test.tool}: ${(error as Error).message}`);
        }
        for (const violation of broker.violations) {
            problems.push(
                `tests[${index}] ${test.tool}: refused ${violation.method} ${violation.url} (${violation.reason})`,
            );
        }
    }
    return { passed: problems.length === 0, problems };
};
