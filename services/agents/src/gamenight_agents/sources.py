"""Web sources for quiz questions: a Tavily search, run by code, whose pages the writer quotes and the checker re-reads.

The model never picks a URL to fetch. Code searches (the player's topic and how they described it), keeps each page's
text, and numbers the pages; the writer cites a page by its number and quotes it, and the checker finds the quote in
the text this code already holds. Forums, social posts, fan wikis and other user-written sites are left out of the
search and refused if they slip through; the judge then rules on whether what's left is reputable.

Without TAVILY_API_KEY there's no web search: questions come from English Wikipedia, as before.
"""

import os
import re
import urllib.parse
from dataclasses import dataclass

import httpx

TAVILY_SEARCH = "https://api.tavily.com/search"
MAX_RESULTS = 6
PROMPT_CHARS = 5000  # of each page, shown to the writer
MIN_TEXT = 400  # a page shorter than this has nothing to quote

# User-written or social sites: no editor stands behind what they say.
BLOCKED = (
    "reddit.com", "quora.com", "answers.com", "fandom.com", "wikia.com", "facebook.com", "instagram.com",
    "tiktok.com", "x.com", "twitter.com", "threads.net", "pinterest.com", "tumblr.com", "youtube.com", "medium.com",
    "substack.com", "blogspot.com", "wordpress.com", "stackexchange.com", "stackoverflow.com", "4chan.org",
    "linkedin.com", "brainly.com", "chegg.com", "coursehero.com", "scribd.com", "wikihow.com", "everything2.com",
    "imdb.com",  # its trivia pages are user-submitted
)


@dataclass(frozen=True)
class Source:
    number: int
    url: str
    title: str
    text: str

    @property
    def site(self) -> str:
        return host(self.url)


def tavily_key() -> str | None:
    return os.environ.get("TAVILY_API_KEY") or None


def host(url: str) -> str:
    return (urllib.parse.urlsplit(url).hostname or "").lower().removeprefix("www.")


def blocked(url: str) -> bool:
    """True for anything but an https page on a site that isn't user-written."""
    if not re.match(r"^https://[^\s/?#]+\.[a-z]{2,}(/\S*)?$", url, re.IGNORECASE):
        return True
    site = host(url)
    return any(site == d or site.endswith("." + d) for d in BLOCKED)


def query_for(topic: str, context: str | None) -> str:
    """What to search for: the player's own description when they gave one, the topic otherwise."""
    return f"{topic}: {context} surprising facts" if context else f"{topic} surprising facts"


async def search(http: httpx.AsyncClient, topic: str, context: str | None = None) -> list[Source]:
    """Pages about the topic, numbered from 1, with their text; [] without a key."""
    key = tavily_key()
    if not key:
        return []
    response = await http.post(TAVILY_SEARCH, headers={"Authorization": f"Bearer {key}"}, json={
        "query": query_for(topic, context)[:380], "search_depth": "basic", "max_results": MAX_RESULTS,
        "include_raw_content": "text", "exclude_domains": list(BLOCKED)})
    response.raise_for_status()
    found: list[Source] = []
    for result in response.json().get("results") or []:
        url, text = str(result.get("url") or ""), re.sub(r"\s+", " ", str(result.get("raw_content") or "")).strip()
        if blocked(url) or len(text) < MIN_TEXT or any(s.url == url for s in found):
            continue
        found.append(Source(len(found) + 1, url, " ".join(str(result.get("title") or "").split())[:200], text))
    return found


def for_prompt(sources: list[Source]) -> str:
    """The pages as the writer sees them: numbered, each cut to PROMPT_CHARS."""
    def clean(text: str) -> str:  # a page can't close its own tag and pose as the next one
        return re.sub(r"</?source\b", "(source", text, flags=re.IGNORECASE)

    shown = []
    for s in sources:
        title = clean(s.title).replace('"', "'")
        shown.append(f'<source number="{s.number}" site="{s.site}" title="{title}">\n{clean(s.text[:PROMPT_CHARS])}\n'
                     "</source>")
    return "\n\n".join(shown)
