# Security

Conscious holds people's messages, memory and account tokens, so security reports are welcome and taken seriously.

## Report a vulnerability

Report it privately through GitHub: the repository's **Security** tab, then **Report a vulnerability**. Do not open a public issue or pull request for it.

Say what an attacker can do, and how: the steps, the configuration it needs (for example `CONSCIOUS_SANDBOX=e2b`, or the app port reachable from the internet), and the commit you tested. Once a fix is out, the advisory is published with credit to you, unless you prefer otherwise.

Only the latest `main` is supported. There are no releases yet.

## What counts

Anything that breaks one of the promises in [`docs/architecture.md`](docs/architecture.md), for example:

- a secret reaching the model, the chat, a log or the user's computer, or the Vault giving a token to a host it was not approved for;
- a plugin escaping its sandbox, or reaching a host it did not declare;
- a `commit` tool running without the user's yes, or the browser clicking the last pay, send or delete button;
- one user reaching another user's conversation, memory, computer, browser or accounts;
- a sender not in `CONSCIOUS_ALLOWED_USERS` getting answers, or a phone app connecting without a valid access code;
- a page the agent reads making it fetch internal addresses, or run tools the user did not ask for.

Prompt injection that only changes what the agent says, without crossing one of these lines, is a bug: open a normal issue.

## Running your own install

- Keep `.env` and the data folder (`.conscious/`, or `CONSCIOUS_DATA_DIR`) private. In production, set `CONSCIOUS_VAULT_KEY` from a secret manager instead of letting Conscious write `vault.key` next to the data.
- List only your own senders in `CONSCIOUS_ALLOWED_USERS`.
- Do not put the app or Vault port on the internet without https. The phone app's access code is its only lock.
