# The landing page

A static page with no build step: `index.html`, `styles.css` and two scripts.

- `art.js` draws the paintings in the hero: public-domain works shaded in characters by [ascii.rest](https://github.com/bas3line/ascii)'s `drawing()`, each on a dark canvas that resizes to it. A new one prints in about every 3.3 seconds; hovering holds it, a click shows the next.
- `chat.js` plays the conversation in the hero, answers what you type (honestly: it's a demo), and runs the model picker further down.

## Run it

Any static server works; module scripts need `http://`, not `file://`.

```bash
python3 -m http.server 8080 -d site
```

## What's in here

| Folder | What | Licence |
|---|---|---|
| `paintings/` | 8 paintings, greyscale, 900 px | Public domain, from Wikimedia Commons |
| `fonts/` | Cormorant Garamond, Hanken Grotesk, IBM Plex Mono (Latin subsets) | SIL Open Font License, files included |
| `vendor/ascii.rest/` | The 6 modules `drawing()` needs, from ascii.rest 0.4.0 | MIT, file included |

The fonts are served from this site, not from Google Fonts, so no visitor's address goes to Google.

The paintings: Vermeer's *Girl with a Pearl Earring* and *The Milkmaid*, Hokusai's *The Great Wave off Kanagawa*, Leonardo's *Mona Lisa*, Friedrich's *Wanderer above the Sea of Fog*, Van Gogh's *Self-Portrait with Grey Felt Hat*, Whistler's *Arrangement in Grey and Black No. 1* and Rembrandt's *Self-Portrait* (1659). Each has its own crop and contrast in `art.js`, so its subject reads in characters.

## Deploy

It runs as its own Railway service, `site`, in the `conscious` project, so a deploy never restarts the assistant. Railpack sees `index.html` and serves the folder with Caddy. From a copy of this folder:

```bash
railway up --service site --environment production --ci
```
