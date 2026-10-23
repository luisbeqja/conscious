# Bundled plugins

Every folder here is one plugin that ships with Conscious. There are none yet: Conscious writes the plugins each user needs, and a good one can be offered here. Each was reviewed as a pull request, and Conscious loads them at start for every user of an install.

```
<id>/
├─ manifest.json   id, version, name, summary, hosts, auth?, tools
├─ plugin.js       one ES module, no imports: export const tools = { <tool>: async (params, ctx) => result }
├─ SKILL.md        how the agent should use the tools
└─ tests.json      at least one test per tool, with recorded responses
```

To add one, or to offer a plugin your agent wrote to everyone who runs Conscious, open a pull request with its folder. `pnpm test` reviews every plugin here in the sandbox.
