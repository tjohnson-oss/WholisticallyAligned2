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

## The `?tier=` forwarding matters

After checkout the buyer returns to the Kajabi page as `?tier=results`. The
assessment reads that from `location.search` — which, inside an iframe, is the
**Worker's** URL, not Kajabi's. Without the forwarding block in the snippet the
parameter never arrives, the retrieve-by-email screen never appears, and a
paying customer cannot reach their results at all. Only `results` and
`enrolled` are passed through; nothing else is forwarded.

## After pasting — check these

1. The assessment renders and the iframe grows to fit (no inner scrollbar).
2. Moving between steps scrolls the Kajabi page, not just the frame.
3. Completing the assessment shows the free summary and the $49 unlock button.
4. The Spanish page loads in Spanish.
5. On a phone: no horizontal scrolling, and the page still resizes.
6. Visit `<page>?tier=results` — it must show "Open your results", not the
   start of the assessment. If it shows the assessment, the forwarding block
   is missing from the snippet.

## Known blocker on the live pages

Both assessment pages carry custom JS that redirects **returning** visitors to
`/library`, which sends anyone not logged in to `/login`:

    if (localStorage.getItem("specialPageSeen") === "true") {
      window.location.replace(libraryURL);
    }

The first visit sets the flag; every visit after that redirects. This also
breaks the post-purchase return path, since the buyer comes back to the same
page — so a customer who has paid $49 lands on a login wall instead of their
results. It must be removed from both pages before launch.

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

---

# Post-purchase results pages

Kajabi's offer redirect cannot carry a query string, so it cannot point at
`/assesment?tier=results`. Instead, make two ordinary Kajabi pages whose embed
has `?tier=results` baked into the iframe src, and redirect the offers to those.

| new Kajabi page | paste | offer redirect |
|---|---|---|
| `/assessment-results` | `waam2/kajabi-embed-results-en.html` | WAAM Results Unlock (`kcuTVJPo`) |
| `/assessment-results-es` | `waam2/kajabi-embed-results-es.html` | (Spanish equivalent, if offered) |

The page names are a suggestion — any URL works, since the redirect just points
at whichever page holds the snippet. What matters is that these pages are NOT
the assessment pages: they open straight onto "Open your results".

Do not put the `specialPageSeen` script on these pages either; a buyer arriving
after checkout would be redirected to `/login` instead of their report.

## Coupon findings (2026-10-21)

`WAAMCREDIT49` exists but has two problems, both on the Kajabi side:

1. **It is 49% off, not $49 off.** Measured at checkout: the $149 enrollment
   became $75.99 and the $499 prepaid became $254.49. The results page
   advertises $100 and $450, so the prepaid offer undercharges by ~$196.
2. **`?coupon=WAAMCREDIT49` in the URL does not auto-apply.** The code has to
   be typed into the discount field by hand. The results page appends it as a
   query parameter, which Kajabi ignores — so a buyer following the credit link
   is quoted $100 and charged $149.

Until both are fixed, the 24-hour enrollment credit does not work as described.
Fixing (1) alone still leaves the buyer charged full price via the link.

## Enrollment offer pricing, as configured

Confirmed at checkout for `E6k3ytnz`: **$79.00/month, 30-day trial, setup fee
$149.00**, so "Due now" is $149.00. The results page says "$149 today, then
$79/month", which matches the money but not the trial — the first $79 lands a
month later than the copy implies.
