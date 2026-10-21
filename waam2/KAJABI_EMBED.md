# Embedding the WAAM assessment in Kajabi

The v2 assessment is served by the Cloudflare Worker, not pasted into Kajabi.
The Kajabi page holds a short iframe snippet instead of the whole file, so
future fixes ship by deploying the Worker — nothing needs re-pasting.

## What changes

Both live pages hold the **v1 file pasted inline**, with `WAAM_PROXY_URL`
pointing at `https://wholistically-aligned2.vercel.app/api/waam`:

| page | note the spelling |
|---|---|
| `https://www.wholisticallyaligned.com/assesment` | English — one `s` in "assesment" |
| `https://www.wholisticallyaligned.com/assessment-es` | Spanish — two `s` |

Replace the **entire** contents of each Code Block with the matching snippet
below. The old file is ~75KB; all of it goes. If it is left in place below the
snippet, the page renders two assessments.

The snippets are also on disk as paste-ready files, with no markdown fences to
strip: `waam2/kajabi-embed-en.html` and `waam2/kajabi-embed-es.html`.

**Do not cancel Vercel until this swap is live and tested** — the Vercel proxy
is what the current page calls, so cancelling first takes the assessment down.

## English page

Paste into the Kajabi Code Block, replacing everything in it:

```html
<div id="waam-embed-wrap">
  <iframe id="waam-frame"
          src="https://waam-engine.wholisticallyaligned.workers.dev/"
          title="WAAM Assessment"
          style="width:100%;border:0;display:block;min-height:900px"
          scrolling="no"
          allow="clipboard-write"></iframe>
</div>
<script>
(function(){
  var ORIGIN = "https://waam-engine.wholisticallyaligned.workers.dev";
  var frame  = document.getElementById("waam-frame");
  var wrap   = document.getElementById("waam-embed-wrap");

  window.addEventListener("message", function(e){
    // Only trust messages from the Worker that serves the assessment.
    if (e.origin !== ORIGIN) return;
    var d = e.data;
    if (!d || d.waam !== true) return;

    if (d.type === "height" && d.h > 0) {
      frame.style.height = d.h + "px";
      return;
    }
    // The assessment scrolls itself between steps; the iframe has no scrollbar,
    // so the parent page has to do the scrolling instead.
    var top = wrap.getBoundingClientRect().top + window.pageYOffset;
    if (d.type === "scrollTop") {
      window.scrollTo({ top: top, behavior: "smooth" });
    } else if (d.type === "scrollTo" && typeof d.y === "number") {
      window.scrollTo({ top: top + d.y, behavior: "smooth" });
    }
  });
})();
</script>
```

## Spanish page

Identical, except the `src` ends in `/es`:

```
src="https://waam-engine.wholisticallyaligned.workers.dev/es"
```

## After pasting — check these

1. The assessment renders and the iframe grows to fit (no inner scrollbar).
2. Moving between steps scrolls the Kajabi page, not just the frame.
3. Completing the assessment shows the free summary and the $49 unlock button.
4. The Spanish page loads in Spanish.
5. On a phone: no horizontal scrolling, and the page still resizes.

If the frame stays at 900px and never grows, the height messages are not
arriving — check the browser console for a Content-Security-Policy error, which
would mean the Kajabi domain is missing from `ALLOWED_ORIGINS` in
`wrangler.toml`. Both Kajabi origins are currently allowed:

    https://wholisticallyaligned.mykajabi.com
    https://www.wholisticallyaligned.com

## Only after the swap is verified

Cancel the Vercel project. Nothing will reference it once this page is live,
and it was the environment the Anthropic API key was exposed in during the
Sep 22 – Oct 9 infection window.
