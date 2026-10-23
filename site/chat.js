// The conversation in the hero: three scripted threads that play in turn, a text box that answers what you write,
// and, further down, the model picker in "Runs on your machine".

// Each scene is one thread. me: you write it; c: Conscious answers; tool: what it did; sep: time passing;
// react: an emoji on your last message; choices and pick: buttons in Conscious's message, and the one you tap.
// painting: the one the hero shows when you pick this scene.
const SCENES = [
  { via: "on iMessage", when: "Saturday 21:40", painting: "whistler", steps: [
    { me: "Remind me to call mum tomorrow at 9" },
    { tool: "reminders · tomorrow 09:00" },
    { c: "Done. Tomorrow at 9:00 I'll nudge you to call mum." },
    { me: "Actually, make it every Sunday" },
    { tool: "reminders · every Sunday 09:00" },
    { c: "Changed: every Sunday at 9:00. Her birthday is on 12 May, you told me in March. Want a reminder for that too?" },
    { me: "Yes please" },
    { react: "❤️" },
    { tool: "reminders · 5 May, every year" },
    { c: "Added. I'll remind you a week before, so there's time to find a present." },
  ] },
  { via: "on WhatsApp", when: "Today 12:15", painting: "wanderer", steps: [
    { me: "Find me a flight to Lisbon in November, under €120" },
    { c: "On it. I'll keep chatting while I look." },
    { tool: "background agent · flights.search" },
    { me: "What's the weather like there in November?" },
    { tool: "weather · Lisbon, November" },
    { c: "Mild: 15 to 18° in the day, with some rain. Bring a light jacket." },
    { sep: "4 minutes later" },
    { tool: "background agent · done, 214 fares checked" },
    { c: "Found one: Friday 14 Nov, €96, direct with TAP.", choices: ["Send the booking link", "Watch the price"], pick: 1 },
    { tool: "scheduled check · every day 08:00" },
    { c: "I'll check every morning at 8 and only write if it drops below €96." },
  ] },
  { via: "on iMessage", when: "Monday 08:02", painting: "milkmaid", steps: [
    { me: "What's on this week?" },
    { tool: "google calendar · 6 events read" },
    { c: "Dentist Tuesday at 8:30, Marta's birthday on Thursday (no present yet), padel Saturday at 10." },
    { me: "Any ideas for Marta?" },
    { tool: "memory · people/marta.md" },
    { c: "She's into ceramics. A pottery class for two at Atelier Terra: €65, Saturday afternoons." },
    { me: "Perfect. Can you move the dentist to next week?" },
    { react: "👍" },
    { tool: "gmail · draft to Dr. Weber's office" },
    { c: "I've drafted an email asking for next Tuesday. It's in your Drafts: have a look and send it when you're ready." },
  ] },
];

// What you write gets an honest answer: this page is a demo.
function replyTo(text) {
  const quote = text.length > 60 ? `${text.slice(0, 57)}…` : text;
  if (/remind|nudge|don't let me forget|dont let me forget/i.test(text)) {
    const what = quote.replace(/^(hey,?\s+)?(please\s+)?(can you\s+)?(remind me|nudge me)\s*/i, "").replace(/[.?!]+$/, "");
    const done = what && what !== quote ? `Done. I'll remind you ${/^(to|about|that)\s/i.test(what) ? what : `about ${what}`}.` : `Done. I'll remind you: “${quote}”`;
    return [{ tool: "reminders · created" }, { c: done }];
  }
  if (/flight|fly|trip|travel|hotel|train/i.test(text)) {
    return [{ c: "On it. I'll keep chatting while I look." }, { tool: "background agent · started" }, { c: "This page is only a demo, so the search stops here. Get early access and I'll find it for real." }];
  }
  if (/week|calendar|today|tomorrow|plans?|busy|schedule|meeting/i.test(text)) {
    return [{ tool: "google calendar · not connected here" }, { c: "This demo can't see your calendar. With the real Conscious you connect Google once, and I'll tell you what's coming." }];
  }
  return [{ tool: "conscious · demo" }, { c: "This page only knows a few conversations. Get early access and text the real me: I'll take it from there." }];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const talk = document.getElementById("talk");
const typed = document.getElementById("typed");
const statusEl = document.getElementById("status");
const viaEl = document.getElementById("via");
const chips = [...document.querySelectorAll("#chips button")];
let runId = 0; // a new exchange cancels the one playing
let autoplay = true;

function setStatus(text, busy) {
  statusEl.textContent = text;
  statusEl.classList.toggle("busy", !!busy);
}

function add(cls, text) {
  const d = document.createElement("div");
  d.className = cls;
  if (text) d.textContent = text;
  talk.appendChild(d);
  while (talk.children.length > 24) talk.firstElementChild.remove();
  requestAnimationFrame(() => requestAnimationFrame(() => d.classList.add("in")));
  return d;
}

// Once you take part, screen readers hear the replies; the autoplay stays quiet.
function joinIn() {
  autoplay = false;
  talk.setAttribute("aria-live", "polite");
}

async function play(steps, { clear = false, via = null, when = null, typeFirst = true } = {}) {
  const id = ++runId;
  const alive = () => id === runId;
  talk.querySelectorAll(".typing").forEach((d) => d.remove());
  if (clear) talk.replaceChildren();
  if (via) viaEl.textContent = via;
  if (when) add("sep", when);
  let lastMe = null;
  let first = true;
  for (const st of steps) {
    if (st.me !== undefined) {
      if (typeFirst || !first) { // type it into the box first
        setStatus("typing…");
        for (let k = 1; k <= st.me.length; k += 2) { typed.value = st.me.slice(0, k); await sleep(20); if (!alive()) return; }
        await sleep(240); if (!alive()) return;
      }
      typed.value = "";
      lastMe = add("bubble me", st.me);
      await sleep(550); if (!alive()) return;
    } else if (st.react) {
      await sleep(250); if (!alive()) return;
      if (lastMe) {
        const r = document.createElement("span");
        r.className = "react";
        r.textContent = st.react;
        lastMe.appendChild(r);
        requestAnimationFrame(() => requestAnimationFrame(() => r.classList.add("in")));
      }
      await sleep(450); if (!alive()) return;
    } else if (st.tool) {
      setStatus(`working · ${st.tool.split(" · ")[0]}`, true);
      await sleep(650); if (!alive()) return;
      add("tool", st.tool);
      await sleep(400); if (!alive()) return;
    } else if (st.sep) {
      add("sep", st.sep);
      await sleep(900); if (!alive()) return;
    } else if (st.c) {
      setStatus("typing…", true);
      const dots = add("bubble c typing");
      dots.innerHTML = "<i></i><i></i><i></i>";
      await sleep(850); if (!alive()) return;
      dots.remove();
      const b = add("bubble c", st.c);
      setStatus("replied just now");
      await sleep(900 + st.c.length * 14); if (!alive()) return; // time to read it
      if (st.choices) {
        const row = document.createElement("div");
        row.className = "choices";
        for (const t of st.choices) {
          const x = document.createElement("span");
          x.textContent = t;
          row.appendChild(x);
        }
        b.appendChild(row);
        await sleep(1100); if (!alive()) return;
        row.children[st.pick].classList.add("on");
        await sleep(600); if (!alive()) return;
        lastMe = add("bubble me", st.choices[st.pick]);
        await sleep(550); if (!alive()) return;
      }
    }
    first = false;
  }
}

function scene(i, picked) {
  chips.forEach((b, j) => b.classList.toggle("on", j === i));
  if (picked) document.dispatchEvent(new CustomEvent("show-painting", { detail: SCENES[i].painting }));
  return play(SCENES[i].steps, { clear: true, via: SCENES[i].via, when: SCENES[i].when });
}

document.getElementById("chips").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  joinIn();
  scene(Number(b.dataset.scene), true);
});

document.getElementById("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = typed.value.trim();
  if (!text) return;
  joinIn();
  chips.forEach((b) => b.classList.remove("on"));
  play([{ me: text }, ...replyTo(text)], { typeFirst: false });
});

// Clicking into the box stops the demo, so it never types over you.
typed.addEventListener("focus", () => {
  if (!autoplay) return;
  joinIn();
  if (typed.value) { runId++; typed.value = ""; setStatus("replies in seconds"); }
});

(async () => {
  await sleep(1000);
  for (let i = 0; autoplay; i = (i + 1) % SCENES.length) {
    await scene(i, false);
    if (!autoplay) break;
    await sleep(3500);
  }
})();

// ---------- the model picker in "Runs on your machine" ----------

const ENV = {
  mistral: "CONSCIOUS_MODEL_PROVIDER=mistral",
  anthropic: "CONSCIOUS_MODEL_PROVIDER=anthropic",
  openai: "CONSCIOUS_MODEL_PROVIDER=openai",
  local: "CONSCIOUS_MODEL_PROVIDER=local  # Ollama, LM Studio, vLLM",
};
const picker = document.getElementById("picker");
picker.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  for (const x of picker.children) x.classList.toggle("on", x === b);
  document.getElementById("env").textContent = ENV[b.dataset.provider];
});
