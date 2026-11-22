# ANPR, the Anagrafe Nazionale (anagrafenazionale.interno.it, sc.anpr.interno.it)

The national registry of residents: the user's registered data, certificates, autocertificazioni, change of address. Checked on 22 November 2026.

## Sign in

- Skip the home page: open `https://spid.anpr.interno.it/rp/<provider>/anpr5` straight away, with the user's provider: `poste`, `aruba`, `infocert`, `sielte`, `namirial`, `lepida`, `register`, `teamsystem`, `etna`, `infocamere`, `intesi`, `titt`. CIE is `/rp/cie/anpr5`.
- On Poste ID's page, use browser_ask_user_to_approve_in_app. Then Poste asks to pass on the tax code ("ACCONSENTO"): that is the user's, hand it over with browser_ask_user_to_act.
- On the first access only, the Anagrafe asks to confirm the privacy notice (a checkbox and "Conferma"): also the user's.
- The session lasts minutes. Do the whole job right after signing in.
- After signing in, `https://sc.anpr.interno.it/serviziCittadino/home` shows the user's data: name, tax code, date and place of birth, registered address. Read it there instead of asking them.

## What to offer

- For a public office, an **autocertificazione** is worth the same as a certificate. It is free and made at once as a PDF. Offer it first.
- A **certificate** is never free without a legal reason: either "in bollo", 16 euro paid on pagoPA, or "in esenzione", with a reason from the law (separation or divorce, adoption, an ONLUS, a sports club, court use, a foreign pension…). The reason is the user's declaration: never pick one. A certificate is for dealings between private parties.

## Autocertificazione, step by step

1. Open `https://sc.anpr.interno.it/serviziCittadino/servizi/info/autocertificazioni` and click "Richiedi autocertificazione".
2. Every kind of data comes ticked: nascita, famiglia, stato civile, residenza, cittadinanza, esistenza in vita. Untick what the user did not ask for, so the PDF shows nothing more, and click "Salva i dati e vai Avanti", all in one browser_click with `next`.
3. The ID document number is filled in already when the comune sent it. Click "Avanti".
4. On the summary, click "Ottieni" with browser_click. It makes the document; no file comes yet.
5. Then use browser_download on "Scarica autocertificazione". The PDF is named `Autocertificazione-<NAME>-<SURNAME>.pdf`.
6. Send it with computer_send_file. Tell the user it needs their signature, place and date before they hand it in.

## Certificates, step by step

`https://sc.anpr.interno.it/serviziCittadino/servizi/certificati` → "certificati anagrafici" → "Richiedi certificato". A "Valida la tua email" window: "Prosegui". "Termini e condizioni": "Conferma e accedi al servizio" (it only says they read it). Then: who it is for, which kind, the use (bollo or exemption, see above), the summary.

## On the way

- A notice with "Elimina messaggio" only closes it: press Escape instead, the guard refuses "elimina".
