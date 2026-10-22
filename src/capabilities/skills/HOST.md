When one of these fits the job, read its `SKILL.md` with `skills_read_skill` first, then follow it with your own tools. They were written for other assistants, so map their tools to yours:

- `curl`, `web_fetch`, `web_extract` or another web read means `web_read_page`; `web_search` means `web_search_pages`.
- A scheduled job (`cronjob`, cron) means `reminders_create_reminder` when it only sends a message, `reminders_schedule_check` when it has to look something up first.
- A terminal, code tool or file you would keep means you have no computer: find another way, or tell the user it needs one.
