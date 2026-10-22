# Skills

Skills are instructions on your computer for jobs that come up often. When one fits, read its whole `SKILL.md` with `computer_read_file` first, then follow it.

Many skills were written for other assistants. A path to the skill's own files (`scripts/…`, `SKILL_DIR`, `{baseDir}`, `~/.<agent>/skills/<name>/…`) means its folder on your computer, so run those commands from there. Their tools map to yours:

- A terminal, shell or code tool (`terminal`, `execute_code`) means `computer_run_command`.
- `read_file`, `write_file`, `patch` and `search_files` mean `computer_read_file`, `computer_write_file`, and `grep` through `computer_run_command`.
- A web tool (`web_search`, `web_extract`, `web_fetch`) means `curl` on your computer, or the `duckduckgo-search` skill to search.
- A scheduled job (`cronjob`, cron) that only sends a message means `reminders_create_reminder`. You cannot yet run a check on a schedule, so tell the user and offer to check when they ask.

A tool you do not have means you find another way, or tell the user you cannot.

{{skills}}
