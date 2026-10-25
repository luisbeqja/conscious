# Contributing

Bug reports, fixes and new skills, plugins and connectors are welcome. Open an issue first for anything big, so we can agree on the shape before you build it.

## What fits

- **Daily life, not work.** Conscious is a friend for your own life. Work apps and work skills are left out on purpose (see `LIFE_APPS` in `src/capabilities/composio/capability.ts`).
- **Safety in code.** Every tool is `read`, `draft` or `commit`, set honestly. A commit (send, book, pay, delete) waits for the user's yes.
- **Secrets never pass through the chat or the model.** Accounts connect through the Vault; tokens stay on the host and never enter the user's computer.
- **Self-hosted.** Nothing may phone home or depend on a Conscious cloud. Any service an install talks to is one its owner chose and configured.

## Set up

Needs Node >= 22.19 and pnpm.

```bash
pnpm install
cp .env.example .env    # pick a model and set its API key
pnpm chat
```

The tests need no keys and no network: the engine tests run the real loop against a scripted model.

## Before you open a pull request

```bash
pnpm typecheck
pnpm run ci      # Biome lint and format check; `pnpm format` fixes formatting
pnpm test
pnpm build
```

CI runs the same four on every pull request.

- TypeScript is strict, with no `any` and no default exports. Formatting is Biome's: 4 spaces, 120 columns, double quotes.
- Add or update a test in `test/` for what you change.
- Docs and prompts are written plainly, in short sentences. Update `README.md`, `docs/` and `.env.example` when you change what a user sees or sets.
- One change per pull request. Say what changes for the person texting Conscious, and how you checked it.

## Where things go

| To add | Start here |
| --- | --- |
| A capability (tools the agent always has) | [Add a capability](docs/setup.md#add-a-capability) |
| A skill | [`skills/README.md`](skills/README.md) |
| A plugin for every install | [`plugins/README.md`](plugins/README.md) |
| A hosted MCP server | [MCP servers](docs/architecture.md#mcp-servers): a reviewed `mcp/<name>/manifest.yaml` |
| Something in the phone app | [`mobile/README.md`](mobile/README.md); change `mobile/src/protocol.ts` and `src/channels/app.ts` together |

## Code from other projects

Copy only MIT- or Apache-2.0-licensed code, and keep its license and copyright lines with it. Copy skills with `pnpm skills:import` (see [`skills/README.md`](skills/README.md)), and add a row to [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for anything copied.

## Security

Do not open a public issue for a vulnerability. See [`SECURITY.md`](SECURITY.md).

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
