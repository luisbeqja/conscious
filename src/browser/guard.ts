/** What a click or a keystroke would land on, read from the page before acting. */
export interface ElementInfo {
    tag: string;
    /** The input or button `type` attribute, lowercase. */
    type: string;
    /** The label a person sees: its text, value, aria-label or title. */
    name: string;
    autocomplete: string;
    /** The element's own name and id, for fields that only say what they are there. */
    fieldHint: string;
    /** What the form it belongs to asks for. */
    formAsksFor: ("card" | "password")[];
    /** Clicking it submits its form. */
    submitsForm: boolean;
    /** A plain link: clicking it only opens another page. */
    navigates: boolean;
}

// Labels that act in the world for the user, in the languages Conscious's users write in. Matched
// as whole words, accents ignored. Words that are as often harmless ("accept" on cookie banners,
// "apply" on filters, "remove" from a cart, "checkout", which only opens the payment page) are left out.
const COMMIT_WORDS = [
    // English
    "pay",
    "pay now",
    "buy",
    "buy now",
    "purchase",
    "place order",
    "order now",
    "complete order",
    "submit order",
    "complete purchase",
    "book",
    "book now",
    "reserve",
    "confirm booking",
    "confirm and pay",
    "cancel booking",
    "cancel order",
    "cancel subscription",
    "send",
    "post",
    "publish",
    "tweet",
    "delete",
    "transfer",
    "donate",
    "subscribe",
    "sign up",
    "register",
    // Italian
    "paga",
    "paga ora",
    "acquista",
    "compra",
    "compra ora",
    "ordina ora",
    "effettua l'ordine",
    "completa l'ordine",
    "conferma l'ordine",
    "prenota",
    "prenota ora",
    "conferma prenotazione",
    "annulla prenotazione",
    "annulla ordine",
    "disdici",
    "invia",
    "pubblica",
    "elimina",
    "bonifico",
    "dona",
    "iscriviti",
    "registrati",
    // Spanish and Portuguese
    "pagar",
    "comprar",
    "finalizar compra",
    "reservar",
    "enviar",
    "publicar",
    "eliminar",
    "borrar",
    "apagar",
    "registrarse",
    "suscribirse",
    "donar",
    // French
    "payer",
    "acheter",
    "commander",
    "reserver",
    "envoyer",
    "publier",
    "supprimer",
    "s'inscrire",
    "faire un don",
    // German
    "bezahlen",
    "kaufen",
    "jetzt kaufen",
    "bestellen",
    "zahlungspflichtig bestellen",
    "buchen",
    "senden",
    "absenden",
    "veroffentlichen",
    "loschen",
    "registrieren",
    "spenden",
];

const fold = (text: string): string =>
    text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const COMMIT_LABEL = new RegExp(
    `(^|[^\\p{L}\\p{N}])(${COMMIT_WORDS.map(fold).map(escapeRegex).join("|")})($|[^\\p{L}\\p{N}])`,
    "u",
);

/** The commit word in a label, if there is one. */
export const commitWord = (label: string): string | undefined => COMMIT_LABEL.exec(fold(label))?.[2];

/**
 * Why clicking this would act for the user (pay, book, send, delete), or undefined when it is safe.
 * Such clicks wait for the user's yes, like every other commit.
 */
export const clickIsCommit = (element: ElementInfo): string | undefined => {
    // A link only opens a page ("Post office", "Books"); paying, booking and sending are buttons and forms.
    const word = element.navigates ? undefined : commitWord(element.name);
    if (word) return `its label says "${word}"`;
    if (element.submitsForm && element.formAsksFor.includes("card")) return "it submits a form with card details";
    return undefined;
};

/** Why the agent must not type into this field, or undefined when it may. */
export const typingIsRefused = (element: ElementInfo): string | undefined => {
    const autocomplete = element.autocomplete.toLowerCase();
    if (element.type === "password" || autocomplete.includes("password")) return "password";
    if (autocomplete.startsWith("cc-") || /card|cvc|cvv|iban|security.?code/.test(element.fieldHint.toLowerCase())) {
        return "card";
    }
    return undefined;
};
