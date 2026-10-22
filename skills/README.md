# Bundled skills

Every folder here is one skill in the [AgentSkills](https://agentskills.io) format, and ships with Conscious. When a user's computer starts, Conscious copies these folders into its `skills/`, where the agent reads them next to the skills it learned for that user. If the user already has a skill with the same name, theirs is kept.

```
<name>/
├─ SKILL.md         frontmatter (name, description, requirements) and the instructions
├─ conscious.json   optional: whether the skill needs the internet
└─ scripts/ …       optional: files the instructions use
```

A skill is hidden from the agent when it cannot run on the computer: a program it needs is missing, it needs a secret (the computer holds none), it is for another operating system, or it needs the internet and the computer has none. Requirements are read from `metadata.conscious`, and from the same keys under another agent's name, so a copied skill loads unchanged.

## Copying a skill from another project

```bash
pnpm skills:import https://github.com/<owner>/<repo> skills/<name> --commit <40-char sha> --internet
```

It copies the folder exactly as it is at that commit, and checks its license. Only MIT and Apache-2.0 skills are accepted. Pass `--internet` when the skill fetches from the web. To move to a newer upstream version, run it again with the new commit and `--replace`, and review the diff like any other change.
