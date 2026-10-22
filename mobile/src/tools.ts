/** What the agent is doing, in words, from the name of the tool it called. Undefined shows nothing. */
export const toolLabel = (name: string): string | undefined => {
    if (name.startsWith("reactions_")) return undefined;
    if (name === "web_read_page") return "Reading a page";
    if (name.startsWith("web_")) return "Searching the web";
    if (name.includes("mail")) return "Looking at your mail";
    if (name.startsWith("google_")) return "Checking your calendar";
    if (name.startsWith("reminders_")) return "Setting things up";
    if (name.startsWith("background_")) return "Starting a task in the background";
    if (name === "computer_send_file") return "Sending a file";
    if (name.startsWith("computer_")) return "Using its computer";
    if (name.startsWith("skills_")) return "Reading its notes";
    if (name.startsWith("vault_")) return "Preparing a private link";
    if (name.startsWith("plugins_")) return "Working with a plugin";
    if (name.startsWith("kiwi_")) return "Looking for flights";
    if (name.startsWith("trivago_")) return "Looking for hotels";
    return "Working on it";
};
