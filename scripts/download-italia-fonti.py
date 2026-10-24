#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "lxml>=5",
#   "markdownify>=0.13",
#   "pypdf>=5",
#   "trafilatura>=2.0",
# ]
# ///
"""Download every official page listed on https://www.italiaaperta.it/fonti
(ministries, INPS, Agenzia delle Entrate, regions, comuni, EU portals) and turn
each one into a Markdown file an agent can read.

    uv run scripts/download-italia-fonti.py --out .conscious/italy/download

Needs uv and curl. What lands in --out:

    INDEX.md        every page, by scope and authority, linked to its Markdown file
    pages/<scope>/<authority>/<title>.md
                    the text of one page; its source URL is in the frontmatter
    manifest.json   one record per link on /fonti: authority, title, URL, status, file
    failures.csv    the links that could not be downloaded or read, and why
    raw/            the downloaded HTML and PDF files

A rerun rebuilds pages/ from raw/ and only downloads what failed before
(errors, bot walls, maintenance pages). Pass --refresh to download everything
again. Each site gets at most two requests at a time, and robots.txt is respected.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import datetime as dt
import hashlib
import io
import json
import re
import shutil
import sys
import time
import unicodedata
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from urllib.robotparser import RobotFileParser

import lxml.html

FONTI_URL = "https://www.italiaaperta.it/fonti"
OUT = Path(".conscious/italy/download")
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
)
ROBOTS_AGENT = "italia-fonti"
# Below this many characters of text the page is probably built by JavaScript;
# the file is kept but marked "thin".
THIN_CHARS = 300
# trafilatura keeps the main text of a page and drops menus. When it loses more
# than this share of the long paragraphs in <main>, all of <main> is converted.
MIN_COVERAGE = 0.7
MAX_EXTRA_LINKS = 60
# Bot walls and maintenance pages that answer 200 with a normal-looking page.
ERROR_TITLE = re.compile(
    r"^\s*(accesso negato|access denied|forbidden|request rejected|attention required|just a moment"
    r"|pagina non trovata|page not found|manutenzione|maintenance|servizio non disponibile"
    r"|service unavailable)\s*([-|–:·]|$)|maintenance page|\b40[34] (forbidden|not found)\b",
    re.IGNORECASE,
)
DROP_IN_MAIN = (
    ".//nav|.//aside|.//script|.//style|.//noscript|.//template|.//svg|.//img|.//picture"
    "|.//video|.//audio|.//iframe|.//button|.//select|.//input|.//textarea|.//*[@role='navigation']"
)
NAV_HINT = re.compile(r"breadcrumb|menu|sidebar|share|social|cookie|skip|pagination", re.IGNORECASE)
SHARE_LINK = re.compile(r"/sharer|/intent/|/share|api\.whatsapp\.com|pinterest\.com/pin", re.IGNORECASE)


@dataclass
class Link:
    scope: str
    scope_label: str
    scope_note: str
    authority: str
    title: str
    url: str
    kind: str


@dataclass
class Page:
    url: str
    links: list[Link]
    id: str
    path: str
    status: str = "pending"
    detail: str = ""
    final_url: str = ""
    content_type: str = ""
    raw: str = ""
    method: str = ""
    language: str = ""
    page_date: str = ""
    chars: int = 0


def clean(text: str) -> str:
    return " ".join(text.split())


def slug(text: str, max_len: int = 80) -> str:
    text = "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))
    text = re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-").lower()
    return text[:max_len].rstrip("-") or "pagina"


def parse_fonti(html: bytes) -> list[Link]:
    doc = lxml.html.fromstring(html)
    links = []
    for section in doc.xpath("//section[@data-scope]"):
        scope = section.get("data-scope")
        h2 = section.find("h2")
        scope_label = clean(h2.text or scope) if h2 is not None else scope
        scope_note = clean(section.xpath("string(p[1])"))
        for group in section.xpath(".//div[h3]"):
            authority = clean(group.xpath("string(h3)"))
            for a in group.xpath("./ul/li/a[@href]"):
                links.append(
                    Link(
                        scope=scope,
                        scope_label=scope_label,
                        scope_note=scope_note,
                        authority=authority,
                        title=clean(a.xpath("string(span[1])")),
                        url=a.get("href").strip(),
                        kind=clean(a.xpath("string(small/em)")),
                    )
                )
    return links


def plan_pages(links: list[Link]) -> list[Page]:
    by_url: dict[str, list[Link]] = {}
    for link in links:
        by_url.setdefault(link.url, []).append(link)
    pages, taken = [], set()
    for url, group in by_url.items():
        first = group[0]
        page_id = hashlib.sha1(url.encode()).hexdigest()[:12]
        path = f"pages/{first.scope}/{slug(first.authority)}/{slug(first.title)}.md"
        if path in taken:
            path = path[: -len(".md")] + f"-{page_id[:6]}.md"
        taken.add(path)
        pages.append(Page(url=url, links=group, id=page_id, path=path))
    return pages


class CurlError(Exception):
    pass


async def curl(url: str, dest: Path, max_time: int = 60) -> tuple[int, str, str]:
    """Download url into dest; returns (HTTP status, content type, final URL).

    curl rather than a Python HTTP client: poliziadistato.it answers Python clients
    with an "Accesso negato" page, and a few servers break on old TLS ciphers or
    malformed chunked responses that curl copes with. No --compressed: some servers
    send broken gzip (ausl.re.it, microcredito.gov.it).
    """
    process = await asyncio.create_subprocess_exec(
        "curl", "--silent", "--show-error", "--location", "--max-redirs", "10",
        "--connect-timeout", "20", "--max-time", str(max_time), "--max-filesize", "52428800",
        "--retry", "2", "--retry-delay", "3", "--retry-all-errors",
        "--user-agent", USER_AGENT,
        "--header", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "--header", "Accept-Language: it-IT,it;q=0.9,en;q=0.6",
        "--output", str(dest),
        "--write-out", "%{http_code}\n%{content_type}\n%{url_effective}",
        url,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    if process.returncode != 0:
        dest.unlink(missing_ok=True)
        message = stderr.decode(errors="replace").strip().splitlines()
        raise CurlError(message[-1] if message else f"curl exited with {process.returncode}")
    status, content_type, final_url = (stdout.decode(errors="replace").split("\n") + ["", ""])[:3]
    return int(status or 0), content_type.split(";")[0].strip().lower(), final_url.strip()


class Fetcher:
    def __init__(self, out: Path, per_host: int, total: int, delay: float):
        self.raw = out / "raw"
        self.delay = delay
        self.hosts: defaultdict[str, asyncio.Semaphore] = defaultdict(lambda: asyncio.Semaphore(per_host))
        self.total = asyncio.Semaphore(total)
        self.robots: dict[str, RobotFileParser | None] = {}
        self.robots_locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

    async def allowed(self, url: str) -> bool:
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        async with self.robots_locks[origin]:
            if origin not in self.robots:
                self.robots[origin] = await self._robots(origin)
        rules = self.robots[origin]
        return rules is None or rules.can_fetch(ROBOTS_AGENT, url)

    async def _robots(self, origin: str) -> RobotFileParser | None:
        dest = self.raw / f"robots-{hashlib.sha1(origin.encode()).hexdigest()[:12]}.txt"
        try:
            async with self.total:
                status, content_type, _ = await curl(f"{origin}/robots.txt", dest, max_time=20)
            if status != 200 or "html" in content_type:
                return None
            rules = RobotFileParser()
            rules.parse(dest.read_text(errors="replace").splitlines())
            return rules
        except CurlError:
            return None
        finally:
            dest.unlink(missing_ok=True)

    async def get(self, url: str, dest: Path) -> tuple[int, str, str]:
        async with self.hosts[urlsplit(url).netloc]:
            async with self.total:
                result = await curl(url, dest)
            await asyncio.sleep(self.delay)
            return result


def norm(text: str) -> str:
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    return re.sub(r"[\W_]+", " ", unicodedata.normalize("NFKC", text).lower())


def main_region(tree, base_url: str):
    """The page's <main> (or the closest thing), without menus and media, with absolute links."""
    region = (tree.xpath("//main") or tree.xpath("//*[@role='main']") or tree.xpath("//article") or [None])[0]
    if region is None:
        region = tree.find("body") if tree.find("body") is not None else tree
        for block in region.xpath(".//header[not(ancestor::article)]|.//footer[not(ancestor::article)]"):
            block.drop_tree()
    for block in region.xpath(DROP_IN_MAIN):
        block.drop_tree()
    for block in region.xpath(".//*[@class or @id]"):
        if NAV_HINT.search(f"{block.get('class', '')} {block.get('id', '')}"):
            text = len(clean(block.text_content()))
            linked = sum(len(clean(a.text_content())) for a in block.iter("a"))
            if text == 0 or linked / text > 0.6:
                block.drop_tree()
    base_href = tree.xpath("string(//base/@href)").strip()
    base = urljoin(base_url, base_href) if base_href else base_url
    region.make_links_absolute(base, resolve_base_href=False, handle_failures="discard")
    return region


def region_links(region, page_url: str, text: str) -> list[str]:
    """Links in <main> that the extracted text does not already contain."""
    lines, seen = [], {page_url.split("#")[0].rstrip("/")}
    for a in region.iter("a"):
        href = (a.get("href") or "").strip()
        if not href.startswith(("http://", "https://")) or SHARE_LINK.search(href):
            continue
        key = href.split("#")[0].rstrip("/")
        label = clean(a.text_content()) or clean(a.get("title") or a.get("aria-label") or "")
        if key in seen or len(label) < 3 or href in text:
            continue
        seen.add(key)
        lines.append(f"- [{label.replace(']', ')')}]({href})")
    return lines[:MAX_EXTRA_LINKS]


def convert_region(region) -> str:
    from markdownify import markdownify

    for a in region.iter("a"):
        a.attrib.pop("title", None)
        if not (a.get("href") or "").startswith(("http://", "https://", "mailto:", "tel:")):
            a.attrib.pop("href", None)
    markdown = markdownify(lxml.html.tostring(region, encoding="unicode"), heading_style="ATX", bullets="-")
    markdown = re.sub(r"\[\s*\]\([^)]*\)", "", markdown)
    return tidy(markdown)


def tidy(markdown: str) -> str:
    markdown = re.sub(r"[ \t]+\n", "\n", markdown)
    return re.sub(r"\n{3,}", "\n\n", markdown).strip()


def extract(raw_path: str, content_type: str, url: str) -> dict:
    """Runs in a worker process: turns one downloaded file into Markdown."""
    data = Path(raw_path).read_bytes()
    if data.startswith(b"%PDF-") or "pdf" in content_type:
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(data))
        text = "\n\n".join((page.extract_text() or "").strip() for page in reader.pages).strip()
        return {"status": "ok", "text": text, "body_chars": len(text), "method": "pdf"}
    if "html" not in content_type and "xml" not in content_type and not data.lstrip().startswith(b"<"):
        return {"status": "unsupported", "detail": f"content type {content_type or 'unknown'}"}

    import trafilatura
    from trafilatura.utils import load_html

    tree = load_html(data)
    if tree is None:
        return {"status": "unreadable", "detail": "could not parse the HTML"}
    title = clean(tree.findtext(".//title") or "")
    if ERROR_TITLE.search(title):
        return {"status": "error_page", "detail": f"the site answered with “{title}”"}
    language = (tree.get("lang") or tree.get("xml:lang") or "").split("-")[0].lower()
    metadata = trafilatura.extract_metadata(data, default_url=url)
    page_date = metadata.date if metadata is not None and metadata.date else ""

    extracted = trafilatura.extract(
        data,
        url=url,
        output_format="markdown",
        include_links=True,
        include_tables=True,
        include_formatting=True,
        include_comments=False,
    )
    relative_link = r"\]\((?!https?:|mailto:|tel:|#)([^)\s]+)\)"
    extracted = re.sub(relative_link, lambda m: f"]({urljoin(url, m[1])})", extracted or "")
    extracted = tidy(extracted)

    region = main_region(tree, url)
    paragraphs = [
        norm(text)[:60].strip()
        for el in region.xpath(".//p|.//li[not(.//li)]|.//td|.//dd")
        if len(text := clean(el.text_content())) >= 80
    ]
    found = norm(extracted)
    coverage = sum(p in found for p in paragraphs) / len(paragraphs) if paragraphs else 1.0
    if coverage < MIN_COVERAGE or len(extracted) < THIN_CHARS:
        converted = convert_region(region)
        if len(converted) > len(extracted):
            return {
                "status": "ok", "text": converted, "body_chars": len(converted), "method": "main",
                "language": language, "page_date": page_date,
            }
    extra = region_links(region, url, extracted)
    text = extracted + ("\n\n## Links on this page\n\n" + "\n".join(extra) if extra else "")
    return {
        "status": "ok", "text": text, "body_chars": len(extracted), "method": "trafilatura",
        "language": language, "page_date": page_date,
    }


def write_markdown(out: Path, page: Page, text: str, today: str) -> None:
    first = page.links[0]
    meta = {
        "title": first.title,
        "authority": first.authority,
        "scope": first.scope,
        "kind": "portal" if first.kind else "page",
        "source": page.url,
    }
    if page.final_url and page.final_url != page.url:
        meta["final_url"] = page.final_url
    if page.language and page.language != "it":
        meta["language"] = page.language
    if page.page_date:
        meta["page_date"] = page.page_date
    meta["downloaded"] = today
    if len(page.links) > 1:
        meta["also_listed_under"] = sorted({link.authority for link in page.links[1:]})
    lines = ["---", *(f"{key}: {json.dumps(value, ensure_ascii=False)}" for key, value in meta.items()), "---", ""]
    lines += [f"# {first.title}", "", text, ""]
    target = out / page.path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("\n".join(lines), encoding="utf-8")


async def download(page: Page, fetcher: Fetcher, out: Path) -> bool:
    if not await fetcher.allowed(page.url):
        page.status, page.detail = "robots", "robots.txt asks bots not to fetch this page"
        return False
    part = out / "raw" / f"{page.id}.part"
    try:
        status, page.content_type, page.final_url = await fetcher.get(page.url, part)
    except CurlError as error:
        page.status, page.detail = "error", str(error)[:300]
        return False
    if status != 200:
        part.unlink(missing_ok=True)
        page.status, page.detail = "http", f"HTTP {status}"
        return False
    with part.open("rb") as handle:
        is_pdf = handle.read(5) == b"%PDF-" or "pdf" in page.content_type
    page.raw = f"raw/{page.id}{'.pdf' if is_pdf else '.html'}"
    part.replace(out / page.raw)
    (out / "raw" / f"{page.id}.json").write_text(
        json.dumps(
            {
                "url": page.url,
                "final_url": page.final_url,
                "content_type": page.content_type,
                "raw": page.raw,
                "fetched_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
            },
            indent=2,
        )
    )
    return True


async def process(page: Page, fetcher: Fetcher, pool: ProcessPoolExecutor, out: Path, refresh: bool, today: str):
    sidecar = out / "raw" / f"{page.id}.json"
    saved = json.loads(sidecar.read_text()) if sidecar.exists() and not refresh else None
    if saved and (out / saved["raw"]).exists():
        page.final_url, page.content_type, page.raw = saved["final_url"], saved["content_type"], saved["raw"]
    elif not await download(page, fetcher, out):
        return
    try:
        result = await asyncio.get_running_loop().run_in_executor(
            pool, extract, str(out / page.raw), page.content_type, page.final_url or page.url
        )
    except Exception as error:  # one broken file should not stop the run
        result = {"status": "unreadable", "detail": f"{type(error).__name__}: {error}"[:300]}
    page.status, page.detail = result["status"], result.get("detail", "")
    if page.status == "error_page":
        # Forget the download so the next run tries again.
        (out / page.raw).unlink(missing_ok=True)
        sidecar.unlink(missing_ok=True)
    if page.status != "ok":
        return
    page.method, page.language = result["method"], result.get("language", "")
    page.page_date, page.chars = result.get("page_date", ""), result["body_chars"]
    if page.chars < THIN_CHARS:
        page.status = "thin"
        page.detail = f"only {page.chars} characters of text: the page is probably built by JavaScript"
    write_markdown(out, page, result["text"], today)


def write_reports(out: Path, links: list[Link], pages: list[Page], today: str) -> None:
    by_url = {page.url: page for page in pages}
    saved = {"ok", "thin"}

    manifest = []
    for link in links:
        page = by_url[link.url]
        manifest.append(
            {
                "scope": link.scope,
                "authority": link.authority,
                "title": link.title,
                "url": link.url,
                "kind": "portal" if link.kind else "page",
                "status": page.status,
                "detail": page.detail or None,
                "file": page.path if page.status in saved else None,
                "final_url": page.final_url or None,
                "method": page.method or None,
                "language": page.language or None,
                "page_date": page.page_date or None,
                "chars": page.chars,
            }
        )
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    with (out / "failures.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["status", "detail", "authority", "title", "url"])
        for page in pages:
            if page.status != "ok":
                writer.writerow([page.status, page.detail, page.links[0].authority, page.links[0].title, page.url])

    authorities = {link.authority for link in links}
    stored = sum(page.status in saved for page in pages)
    lines = [
        "# Italian official sources",
        "",
        f"{len(pages)} official pages from {len(authorities)} public authorities, as listed on {FONTI_URL},",
        f"downloaded on {today}. {stored} are saved as Markdown under `pages/`, each with its source URL",
        "at the top. *Thin* pages have little text, usually because the site builds them with JavaScript;",
        "the source URL is the place to check. Pages *not downloaded* are listed with the reason in `failures.csv`.",
        "",
    ]
    scope_counts = Counter(link.scope for link in links)
    groups: dict[str, dict[str, list[Link]]] = {}
    for link in links:
        groups.setdefault(link.scope, {}).setdefault(link.authority, []).append(link)
    for scope, by_authority in groups.items():
        first = next(iter(by_authority.values()))[0]
        lines += [f"## {first.scope_label} ({scope_counts[scope]})", "", first.scope_note, ""]
        for authority, entries in by_authority.items():
            lines += [f"### {authority}", ""]
            for link in entries:
                page = by_url[link.url]
                portal = " (portal)" if link.kind else ""
                if page.status == "ok":
                    lines.append(f"- [{link.title}]({page.path}){portal}")
                elif page.status == "thin":
                    lines.append(f"- [{link.title}]({page.path}){portal}, thin, see {link.url}")
                else:
                    lines.append(f"- {link.title}{portal}, not downloaded: {link.url}")
            lines.append("")
    (out / "INDEX.md").write_text("\n".join(lines), encoding="utf-8")


async def run(args: argparse.Namespace) -> int:
    out: Path = args.out.resolve()
    (out / "raw").mkdir(parents=True, exist_ok=True)
    today = dt.date.today().isoformat()
    started = time.monotonic()

    print(f"Reading the list of sources from {FONTI_URL}")
    listing = out / "raw" / "fonti.html"
    try:
        status, _, _ = await curl(FONTI_URL, listing)
    except CurlError as error:
        print(f"Could not download the list: {error}", file=sys.stderr)
        return 1
    links = parse_fonti(listing.read_bytes()) if status == 200 else []
    if not links:
        print(f"No links found on {FONTI_URL} (HTTP {status}): the page probably changed.", file=sys.stderr)
        return 1
    pages = plan_pages(links)
    if args.limit:
        pages = pages[: args.limit]
        keep = {page.url for page in pages}
        links = [link for link in links if link.url in keep]
    hosts = len({urlsplit(page.url).netloc for page in pages})
    print(f"{len(links)} links, {len(pages)} unique pages on {hosts} sites. Saving to {out}")
    # pages/ is rebuilt from raw/ on every run, so no file outlives its source.
    shutil.rmtree(out / "pages", ignore_errors=True)

    fetcher = Fetcher(out, per_host=args.per_host, total=args.concurrency, delay=args.delay)
    with ProcessPoolExecutor() as pool:

        async def run_pass(batch: list[Page]) -> None:
            tasks = [asyncio.create_task(process(page, fetcher, pool, out, args.refresh, today)) for page in batch]
            for done, task in enumerate(asyncio.as_completed(tasks), start=1):
                await task
                if done % 100 == 0 or done == len(tasks):
                    statuses = Counter(page.status for page in batch if page.status != "pending")
                    summary = ", ".join(f"{count} {status}" for status, count in statuses.most_common())
                    print(f"  {done}/{len(tasks)} done ({summary})", flush=True)

        await run_pass(pages)
        retry = [page for page in pages if page.status in {"http", "error"}]
        if retry:
            # Busy servers sometimes answer 404 or drop the connection: one more try, a little later.
            print(f"Trying the {len(retry)} failed pages once more")
            await asyncio.sleep(10)
            for page in retry:
                page.status, page.detail = "pending", ""
            await run_pass(retry)

    write_reports(out, links, pages, today)
    print(f"\nFinished in {(time.monotonic() - started) / 60:.1f} min.")
    for status, count in Counter(page.status for page in pages).most_common():
        print(f"  {status:<12}{count}")
    print(f"Start here: {out / 'INDEX.md'}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=OUT, help=f"output folder (default: {OUT})")
    parser.add_argument("--limit", type=int, default=0, help="only the first N pages, to try the script out")
    parser.add_argument("--refresh", action="store_true", help="download every page again, even if raw/ has it")
    parser.add_argument("--concurrency", type=int, default=24, help="downloads in flight across all sites")
    parser.add_argument("--per-host", type=int, default=2, help="downloads in flight to one site")
    parser.add_argument("--delay", type=float, default=0.5, help="seconds between two downloads from one site")
    return asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
