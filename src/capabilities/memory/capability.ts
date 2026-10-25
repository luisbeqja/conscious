import { Type } from "typebox";
import { type Memory, type MemoryStore, newId, type Person, parseBirthday } from "../../memory/memory.js";
import { promptFile } from "../../prompts/prompt-file.js";
import { type Capability, defineTool, type ToolContext } from "../types.js";

const findPerson = (memory: Memory, nameOrId: string): Person | undefined => {
    const wanted = nameOrId.trim().replace(/^#/, "").toLowerCase();
    return memory.people.find((person) => person.id === wanted || person.name.toLowerCase() === wanted);
};

const DAY_MS = 86_400_000;

/**
 * Two yearly nudges for a birthday, as checks so the words fit what Conscious knows by then: a week
 * before, with time to find a present, and on the morning of the day. A 29 February birthday is
 * marked on the 28th, which every year has.
 */
const armBirthday = (person: Person, context: ToolContext): string[] => {
    const [month, rawDay, year] = parseBirthday(person.birthday ?? "") ?? [];
    if (!month || !rawDay) return [];
    const day = month === 2 && rawDay === 29 ? 28 : rawDay;
    // Any year without 29 February gives the date a week before.
    const before = new Date(Date.UTC(2025, month - 1, day) - 7 * DAY_MS);
    const who = person.relation ? `${person.name} (the user's ${person.relation})` : person.name;
    const age = year ? ` They were born in ${year}, so say how old they turn if it fits.` : "";
    const add = (title: string, cron: string, job: string) =>
        context.scheduler.add({
            userId: context.userId,
            text: title,
            check: job,
            cron,
            timezone: context.timezone,
            unprompted: true,
        }).id;
    return [
        add(
            `${person.name}'s birthday in a week`,
            `0 18 ${before.getUTCDate()} ${before.getUTCMonth() + 1} *`,
            `${who} has a birthday in a week. Tell the user in a short message, like a friend would, and suggest one or two present or plan ideas that fit what you remember about ${person.name}. Offer to set a reminder to get it. If you remember that the user no longer sees ${person.name}, send nothing.`,
        ),
        add(
            `${person.name}'s birthday`,
            `0 9 ${day} ${month} *`,
            `Today is ${who}'s birthday.${age} Remind the user in one short, warm message, and nudge them to call or write to ${person.name}. If you remember that the user no longer sees ${person.name}, send nothing.`,
        ),
    ];
};

const disarm = (person: Person, context: ToolContext): void => {
    for (const id of person.reminders ?? []) context.scheduler.cancel(context.userId, id);
    person.reminders = undefined;
};

/** What Conscious knows about the user and the people in their life, kept apart from the conversation. */
export const createMemoryCapability = (store: MemoryStore): Capability => {
    const remember = defineTool({
        name: "memory_remember_fact",
        label: "Remember",
        description:
            "Write down one thing about the user, or about someone in their life when `person` is set (a name or id; they are added if new).",
        effect: "draft",
        parameters: Type.Object({
            text: Type.String({
                description: "One short line, e.g. 'Allergic to peanuts', 'Just started at a new gym'.",
            }),
            person: Type.Optional(Type.String()),
        }),
        execute: async (params, context) => {
            const memory = await store.load(context.userId);
            const fact = { id: newId(), text: params.text.trim() };
            if (params.person) {
                let person = findPerson(memory, params.person);
                if (!person) {
                    person = { id: newId(), name: params.person.trim(), notes: [] };
                    memory.people.push(person);
                }
                person.notes.push(fact);
            } else {
                memory.about.push(fact);
            }
            await store.save(context.userId, memory);
            return { data: { id: fact.id } };
        },
    });

    const savePerson = defineTool({
        name: "memory_save_person",
        label: "Remember someone",
        description:
            "Add someone in the user's life, or update who they are and their birthday. Matched by name, so call it again to change a detail.",
        effect: "draft",
        parameters: Type.Object({
            name: Type.String({ description: "What the user calls them: 'Mum', 'Giulia', 'Marco from football'." }),
            relation: Type.Optional(Type.String({ description: "Who they are to the user: 'sister', 'partner'." })),
            birthday: Type.Optional(
                Type.String({ description: "MM-DD, or YYYY-MM-DD when the year is known, e.g. 03-14." }),
            ),
        }),
        execute: async (params, context) => {
            if (params.birthday && !parseBirthday(params.birthday)) {
                return { data: { error: `"${params.birthday}" is not a date. Use MM-DD or YYYY-MM-DD.` } };
            }
            const memory = await store.load(context.userId);
            let person = findPerson(memory, params.name);
            if (!person) {
                person = { id: newId(), name: params.name.trim(), notes: [] };
                memory.people.push(person);
            }
            if (params.relation) person.relation = params.relation.trim();
            const birthday = params.birthday?.trim();
            if (birthday && birthday !== person.birthday) {
                disarm(person, context);
                person.birthday = birthday;
                person.reminders = armBirthday(person, context);
            }
            await store.save(context.userId, memory);
            return {
                data: {
                    id: person.id,
                    birthdayNudges: person.reminders?.length ? "a week before and on the day" : undefined,
                },
            };
        },
    });

    const forget = defineTool({
        name: "memory_forget",
        label: "Forget",
        description: "Forget one line by its id: a fact, a note about someone, or a person with everything about them.",
        effect: "draft",
        parameters: Type.Object({ id: Type.String({ description: "The id after # on the line." }) }),
        execute: async (params, context) => {
            const id = params.id.trim().replace(/^#/, "");
            const memory = await store.load(context.userId);
            const before = JSON.stringify(memory);
            memory.about = memory.about.filter((fact) => fact.id !== id);
            for (const person of memory.people.filter((candidate) => candidate.id === id)) disarm(person, context);
            memory.people = memory.people.filter((person) => person.id !== id);
            for (const person of memory.people) person.notes = person.notes.filter((note) => note.id !== id);
            const forgotten = JSON.stringify(memory) !== before;
            if (forgotten) await store.save(context.userId, memory);
            return { data: { forgotten } };
        },
    });

    return {
        id: "memory",
        summary: "Your memory of the user and the people in their life: remember, update and forget.",
        skill: promptFile(import.meta.url, "SKILL.md"),
        tools: [remember, savePerson, forget],
    };
};
