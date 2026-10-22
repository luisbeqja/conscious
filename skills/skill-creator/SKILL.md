---
name: skill-creator
description: "Author or review AgentSkills: create, repair, validate, or restructure SKILL.md files and bundled resources."
---

# Skill Creator

## Workflow

1. Establish the contract.
   - Read the existing skill and its resources, or collect concrete requests for a new skill.
   - Separate actual workflow branches from synonyms for the same branch.
   - **Done when:** every branch has a concrete trigger, expected outcome, and persistence target.

2. Structure the skill.
   - Map shared ordered procedure to `SKILL.md`; end every step with a checkable completion criterion and finish with verification.
   - Keep routing conditions in `description`; start the body with execution.
   - Map branch-only detail to `references/`, repeatable helpers to `scripts/`, output resources to `assets/`.
   - **Done when:** every planned resource has one purpose and a direct pointer from `SKILL.md`.

3. Draft and save.
   - Save `SKILL.md` with `skills_save_skill`; it keeps the previous version so the user can undo.
   - Write any `references/`, `scripts/` or `assets/` files into `skills/<name>/` with `computer_write_file`.
   - **Done when:** the saved skill implements every branch from step 1 and contains every resource from step 2.

4. Validate.
   - Run `python {baseDir}/scripts/quick_validate.py <skill-directory>` and execute every touched helper's focused test.
   - **Done when:** frontmatter passes, resource pointers resolve, and every touched helper passes its focused test.

## Frontmatter

Required: `name`, `description`.

Optional: `license`, `version`, `platforms` (`linux`, `macos`, `windows`), and requirements under `metadata.conscious.requires`: `bins` (all must be installed), `anyBins` (one must be), `env` (secrets the skill needs). A skill whose requirements are not met is hidden. If it fetches from the web, add `conscious.json` next to it with `{"internet": true}`. Add optional fields only when they change what runs or when the skill shows.
