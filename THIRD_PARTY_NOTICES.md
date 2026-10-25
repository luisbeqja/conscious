# Third-party notices

Conscious is under the [MIT License](LICENSE). Some files in this repository come from other open-source projects and keep their own license and copyright notice, listed here.

## Skills

These skills in `skills/` are copied from other projects at the commit listed, then changed for Conscious: paths, frontmatter keys, tool names and user agents. Each one's `conscious.json` records where it came from, and its project's license is in [`licenses/`](licenses/). `docx`, `pdf` and `xlsx` also carry their own `LICENSE`, and `skill-creator` its `license.txt`.

| Skill | Copied from | Commit | License |
| --- | --- | --- | --- |
| `blocked-page-recovery` | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/8237c7f8ec179c88857f24a174509d985af704b7/skills/web/blocked-page-recovery) | `8237c7f8ec17` | [MIT](licenses/nousresearch-hermes-agent.txt), © 2025 Nous Research |
| `document-to-action-items` | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/8237c7f8ec179c88857f24a174509d985af704b7/skills/productivity/document-to-action-items) | `8237c7f8ec17` | [MIT](licenses/nousresearch-hermes-agent.txt), © 2025 Nous Research |
| `docx` | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/8237c7f8ec179c88857f24a174509d985af704b7/skills/productivity/docx) | `8237c7f8ec17` | [MIT](skills/docx/LICENSE), © 2026 Nous Research |
| `duckduckgo-search` | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/8237c7f8ec179c88857f24a174509d985af704b7/optional-skills/research/duckduckgo-search) | `8237c7f8ec17` | [MIT](licenses/nousresearch-hermes-agent.txt), © 2025 Nous Research |
| `email-inbox-triage` | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/8237c7f8ec179c88857f24a174509d985af704b7/skills/email/email-inbox-triage) | `8237c7f8ec17` | [MIT](licenses/nousresearch-hermes-agent.txt), © 2025 Nous Research |
| `fitness-nutrition` | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/8237c7f8ec179c88857f24a174509d985af704b7/optional-skills/health/fitness-nutrition) | `8237c7f8ec17` | [MIT](licenses/nousresearch-hermes-agent.txt), © 2025 Nous Research |
| `maps` | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/8237c7f8ec179c88857f24a174509d985af704b7/skills/productivity/maps) | `8237c7f8ec17` | [MIT](licenses/nousresearch-hermes-agent.txt), © 2025 Nous Research |
| `pdf` | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/8237c7f8ec179c88857f24a174509d985af704b7/skills/productivity/pdf) | `8237c7f8ec17` | [MIT](skills/pdf/LICENSE), © 2026 Nous Research |
| `product-price-monitor` | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/8237c7f8ec179c88857f24a174509d985af704b7/skills/productivity/product-price-monitor) | `8237c7f8ec17` | [MIT](licenses/nousresearch-hermes-agent.txt), © 2025 Nous Research |
| `reddit-reading` | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/8237c7f8ec179c88857f24a174509d985af704b7/optional-skills/social-media/reddit-reading) | `8237c7f8ec17` | [MIT](licenses/nousresearch-hermes-agent.txt), © 2025 Nous Research |
| `rss-feeds` | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/8237c7f8ec179c88857f24a174509d985af704b7/optional-skills/research/rss-feeds) | `8237c7f8ec17` | [MIT](licenses/nousresearch-hermes-agent.txt), © 2025 Nous Research |
| `stocks` | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/8237c7f8ec179c88857f24a174509d985af704b7/optional-skills/finance/stocks) | `8237c7f8ec17` | [MIT](licenses/nousresearch-hermes-agent.txt), © 2025 Nous Research |
| `watchers` | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/8237c7f8ec179c88857f24a174509d985af704b7/optional-skills/devops/watchers) | `8237c7f8ec17` | [MIT](licenses/nousresearch-hermes-agent.txt), © 2025 Nous Research |
| `xlsx` | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/8237c7f8ec179c88857f24a174509d985af704b7/skills/productivity/xlsx) | `8237c7f8ec17` | [MIT](skills/xlsx/LICENSE), © 2026 Nous Research |
| `youtube-content` | [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/8237c7f8ec179c88857f24a174509d985af704b7/skills/media/youtube-content) | `8237c7f8ec17` | [MIT](licenses/nousresearch-hermes-agent.txt), © 2025 Nous Research |
| `weather` | [OpenClaw](https://github.com/openclaw/openclaw/tree/c5650f3a5e59d6523c913a8ebfff2b787cf58435/skills/weather) | `c5650f3a5e59` | [MIT](licenses/openclaw-openclaw.txt), © 2026 OpenClaw Foundation |
| `skill-creator` | [OpenClaw](https://github.com/openclaw/openclaw/tree/c5650f3a5e59d6523c913a8ebfff2b787cf58435/skills/skill-creator) | `c5650f3a5e59` | [Apache-2.0](skills/skill-creator/license.txt) |

In `skill-creator`, Conscious changed `SKILL.md` (the agent saves skills with `skills_save_skill`), `scripts/quick_validate.py` and `scripts/test_quick_validate.py` (the validator accepts the frontmatter keys Conscious's skills use).

`sunday-reset` was written for Conscious.

## MCP server manifests

`mcp/*/manifest.yaml` (AllTrails, Dropbox, Kiwi.com, Notion, Strava, Todoist, trivago) are adapted from Hermes Agent's [`optional-mcps/`](https://github.com/NousResearch/hermes-agent/tree/8237c7f8ec179c88857f24a174509d985af704b7/optional-mcps) at commit `8237c7f8ec17`, under the [MIT License](licenses/nousresearch-hermes-agent.txt), © 2025 Nous Research.

## Landing page

`site/` ships fonts under the SIL Open Font License (license files in `site/fonts/`), six modules of [ascii.rest](https://github.com/bas3line/ascii) under the MIT License (`site/vendor/ascii.rest/LICENSE`), and public-domain paintings from Wikimedia Commons. See [`site/README.md`](site/README.md).

## Phone app

The icons in `mobile/assets/` are placeholders from Expo's default app template, under the 0BSD license.

## Dependencies

Packages installed by pnpm and npm are not part of this repository. Each comes with its own license.
