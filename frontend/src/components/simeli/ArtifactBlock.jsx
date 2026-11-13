import React from 'react'
import { Download, Loader2 } from 'lucide-react'
import { aiDocumentsAPI } from '../../services/api'
import useIsDark from '../../hooks/useIsDark'

/**
 * Something Simeli made, shown in the conversation.
 *
 * NO CARD
 * ---------------------------------------------------------------------------
 * The first version of this wrapped every artifact in a bordered panel with a
 * title bar, a type badge and a permanent Download button. That is a widget
 * parked in a conversation, and it reads as one — the eye stops at the border
 * before it reaches the content.
 *
 * A diagram belongs in the message the way a paragraph does: prose, then the
 * thing, then more prose, on the same ground, separated by nothing but space.
 * So there is no border, no background, no header and no badge here. The
 * artifact's own title is the model's job to write in its sentence, where it
 * reads better anyway.
 *
 * Download survives as an action that appears on hover, because taking a copy
 * away is a real thing to want and not a thing to look at all the time.
 *
 * FITTING THE CONTENT
 * ---------------------------------------------------------------------------
 * The shared preview used `h-64` and `bg-white`: every artifact was 256px tall
 * whatever it contained, on a white rectangle in the middle of a near-black
 * chat. Both had to go.
 *
 * Height cannot be measured from outside — the frame is sandboxed WITHOUT
 * allow-same-origin (see below), so its document is unreachable by design. The
 * frame reports its own height instead: a few lines injected into the document
 * post the scroll height up on load and on every resize, and the parent trusts
 * exactly one thing from that message, a number it clamps. Nothing else the
 * frame says is listened to.
 */

const VISUAL = new Set(['html', 'svg', 'image', 'png', 'jpeg', 'jpg'])

const MIN_H = 120

/**
 * The tallest an artifact may be, as a share of the window.
 *
 * A diagram that runs past the fold stops being a diagram and becomes a page
 * you scroll — and the conversation it belongs to disappears above it. Capping
 * against the viewport rather than a fixed pixel count is what makes this work
 * on a phone and a 27" monitor from the same code.
 */
const capFor = () => Math.max(MIN_H, Math.round((typeof window === 'undefined' ? 900 : window.innerHeight) * 0.72))

/**
 * Wrap the artifact so it sits on the conversation's ground, in the reader's
 * theme, fits the screen, builds itself in, and can tell us how tall it is.
 *
 * WHY THE FIRST ATTEMPT STILL CAME OUT WHITE
 * ---------------------------------------------------------------------------
 * It set `html, body { background: transparent }` and stopped there. Most AI
 * HTML does not put its background on the body — it puts it on a wrapper div,
 * or a `.container`, or the chart library's own root — so a white slab kept
 * appearing in the middle of a dark chat.
 *
 * WHAT THE SHIM DOES
 * ---------------------------------------------------------------------------
 * Theme       color-scheme follows the app; html and body forced transparent;
 *             body inherits the theme's ink. In DARK only, a pass clears
 *             white and near-white backgrounds — a white panel is only ever a
 *             mistake there, and in light mode the same panel is correct and
 *             is left alone. Explicit non-white colours are never touched.
 *
 * Fit         Images, SVG, tables and pre are capped to the column width, and
 *             an SVG with a viewBox gets height:auto so it scales instead of
 *             overflowing. The parent then caps the frame against the window.
 *
 * Build       Everything appears in sequence rather than all at once: top
 *             level blocks fade up on a stagger, and SVG shapes follow, with
 *             strokes drawing themselves along their own length. It is
 *             ordinary CSS on a delay — nothing is genuinely being computed —
 *             but a diagram that assembles reads as a diagram that was made
 *             for you, and it gives the eye an order to follow.
 *
 * Tabs        A section carrying data-sim-tab="Label" becomes a tab. Two or
 *             more and the shim builds a chip row and shows one at a time,
 *             which is how a dense artifact stops being a wall. Nothing to
 *             detect heuristically and nothing to break: an artifact without
 *             the attribute renders exactly as it did.
 *
 * All of it is skipped under prefers-reduced-motion except the layout itself.
 */
function wrap(content, contentType, channel, dark, cap) {
  const body = contentType === 'svg'
    ? `<div id="sim-root">${content}</div>`
    : content

  const ink = dark ? '#d6e2fb' : '#101a33'
  const faint = dark ? '#8fa6ce' : '#5a6784'
  const line = dark ? 'rgba(120,150,230,0.22)' : 'rgba(15,23,42,0.14)'
  const chipOn = dark ? 'linear-gradient(135deg,#7c3aed,#8b5cf6)' : 'linear-gradient(135deg,#6d28d9,#7c3aed)'

  const shim = `
<style>
  :root { color-scheme: ${dark ? 'dark' : 'light'}; }
  html, body {
    margin: 0;
    background: transparent !important;
    color: ${ink};
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  /* Nothing may push past the column it was given. */
  img, svg, table, pre, canvas { max-width: 100%; }
  svg[viewBox] { height: auto; }
  table { width: 100%; border-collapse: collapse; }
  /* Only where no fill was authored: a presentation attribute loses to CSS, so
     an unqualified rule here would repaint a deliberately orange label. */
  svg text:not([fill]), text:not([fill]) { fill: currentColor; }

  /* --- the build ------------------------------------------------------- */
  @keyframes sim-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  @keyframes sim-pop  { from { opacity: 0; transform: scale(0.92); } to { opacity: 1; transform: none; } }
  @keyframes sim-draw { to { stroke-dashoffset: 0; } }
  .sim-in    { animation: sim-rise 460ms cubic-bezier(.22,.68,.36,1) both; }
  .sim-in-el { animation: sim-pop 380ms cubic-bezier(.22,.68,.36,1) both; transform-origin: center; }
  .sim-line  { animation: sim-draw 700ms cubic-bezier(.33,.9,.4,1) both; }

  /* --- tabs ------------------------------------------------------------ */
  #sim-tabs { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 0 12px; }
  #sim-tabs button {
    padding: 5px 12px; border-radius: 999px; font: inherit; font-size: 12px; font-weight: 550;
    color: ${faint}; background: transparent; border: 1px solid ${line}; cursor: pointer;
  }
  #sim-tabs button[aria-selected="true"] { color: #fff; border-color: transparent; background: ${chipOn}; }
  [data-sim-tab][hidden] { display: none !important; }

  @media (prefers-reduced-motion: reduce) {
    .sim-in, .sim-in-el, .sim-line { animation: none !important; stroke-dashoffset: 0 !important; }
  }
</style>
<script>
(function () {
  var DARK = ${dark ? 'true' : 'false'};
  var CHANNEL = ${JSON.stringify(channel)};
  var CAP = ${Number(cap) || 700};
  var still = matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Is this colour white, or close enough that it reads as a white sheet? */
  function nearWhite(value) {
    if (!value) return false;
    /* Double-escaped on purpose. This regex lives inside a JS template
       literal, and a template literal eats \\( as an escape for ( — so a
       singly-escaped version emitted /rgba?(([^)]+))/, which captured
       "(255, 255, 255", parseFloat gave NaN, and no colour ever matched. */
    var m = value.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return false;
    var p = m[1].split(',').map(function (n) { return parseFloat(n); });
    if (p.length > 3 && p[3] === 0) return false;
    return p[0] > 232 && p[1] > 232 && p[2] > 232;
  }

  /* Rein in anything wider than the column it was given.

     The stylesheet caps img, svg, table, pre and canvas, which covers most
     of it — but a div with an explicit width:1400px sails straight past a
     max-width rule it never inherits, and the artifact ends up with a
     horizontal scrollbar or content off the edge. Nothing in a conversation
     should scroll sideways, so over-wide elements are measured and clamped.

     Skipped inside a container that scrolls on purpose: a wide table someone
     deliberately made swipeable is not a mistake. */
  function fit() {
    var docW = document.documentElement.clientWidth;
    if (!docW) return;
    var all = document.querySelectorAll('body *');
    for (var i = 0; i < all.length && i < 4000; i++) {
      var el = all[i];
      if (el.id === 'sim-tabs') continue;
      if (el.getBoundingClientRect().width <= docW + 1) continue;

      var scroller = false;
      for (var a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        var ox = getComputedStyle(a).overflowX;
        if (ox === 'auto' || ox === 'scroll') { scroller = true; break; }
      }
      if (scroller) continue;

      el.style.setProperty('max-width', '100%', 'important');
      /* An explicit width has to go too, or max-width only clips it. */
      if (getComputedStyle(el).width !== 'auto') el.style.setProperty('width', 'auto', 'important');
      el.style.setProperty('box-sizing', 'border-box', 'important');
    }
  }

  function deWhite() {
    if (!DARK) return;
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length && i < 4000; i++) {
      var el = all[i], cs = getComputedStyle(el);
      if (nearWhite(cs.backgroundColor)) el.style.setProperty('background-color', 'transparent', 'important');
      if (nearWhite(cs.borderTopColor) && parseFloat(cs.borderTopWidth) > 0) {
        el.style.setProperty('border-color', 'rgba(120,150,230,0.18)', 'important');
      }
    }
  }

  /* --- tabs ------------------------------------------------------------
     Preferred: the author marked sections with data-sim-tab.

     Failing that, they get worked out. Asked for five charts, a model
     reliably emits five stacked blocks in one long sheet — it has to
     remember a convention to do otherwise, and it does not. So a document
     that is too tall AND is visibly made of repeated chart blocks is split
     here, without anyone having to ask.

     Both conditions matter. Repetition alone is not enough: two small charts
     side by side are fine as they are, and tabbing them would hide half of a
     comparison. It is the length that makes stacking a problem. */
  function isVisual(el) {
    /* Case-insensitive on purpose. An SVG element is in the SVG namespace and
       keeps its lowercase tagName — 'svg', never 'SVG' — so an uppercase
       comparison silently never matches. That missed exactly the shape where
       the chart is a direct sibling of its heading rather than wrapped in a
       div, which is one of the commonest things a model emits. */
    return /^(svg|canvas|table)$/i.test(el.tagName) || !!el.querySelector('svg, canvas, table');
  }

  function isHeading(el) {
    return /^H[1-6]$/.test(el.tagName);
  }

  function kidsOf(el) {
    return [].slice.call(el.children).filter(function (c) {
      return c.tagName !== 'SCRIPT' && c.tagName !== 'STYLE' && c.id !== 'sim-tabs';
    });
  }

  /* Find the repeated chart blocks in a document nobody labelled.
     ---------------------------------------------------------------------
     The first version demanded that EVERY child of a container contain a
     chart. One <h1> above the charts — which real output almost always has —
     and the whole thing was rejected, which is why five charts kept arriving
     as one long sheet.

     Two passes now, in order of how good a tab name they produce:

       A. Segment on headings. A container holding h2/chart, h2/chart, … is
          the commonest shape and it names itself. Everything before the
          first heading stays put as the artifact's title.
       B. Otherwise take the children that contain a chart, ignoring the ones
          that do not. A leading title or intro is left where it is.

     Whichever finds the most blocks wins, since a deeper container usually
     means the real repeating unit rather than the page wrapper. */
  function findBlocks() {
    var containers = [document.body].concat([].slice.call(document.querySelectorAll('body *')).slice(0, 600));
    var best = null;

    for (var i = 0; i < containers.length; i++) {
      var kids = kidsOf(containers[i]);
      if (kids.length < 2) continue;

      /* --- A: heading segmentation --- */
      var headings = kids.filter(isHeading);
      if (headings.length >= 2) {
        var groups = [];
        var current = null;
        for (var k = 0; k < kids.length; k++) {
          if (isHeading(kids[k])) { current = [kids[k]]; groups.push(current); }
          else if (current) current.push(kids[k]);
        }
        var withVisual = groups.filter(function (g) {
          return g.some(isVisual);
        });
        if (withVisual.length >= 2 && (!best || withVisual.length > best.length)) {
          best = withVisual.map(function (g) { return { group: g }; });
        }
      }

      /* --- B: children that carry a chart --- */
      var visual = kids.filter(isVisual);
      if (visual.length >= 2 && (!best || visual.length > best.length)) {
        best = visual.map(function (el) { return { group: [el] }; });
      }
    }
    return best;
  }

  /* A heading-segmented block is several sibling elements, not one. They are
     wrapped so the tab can hide them as a unit — done in place, so nothing
     moves and no styling that targeted the originals is lost. */
  function materialise(blocks) {
    return blocks.map(function (b) {
      if (b.group.length === 1) return b.group[0];
      var box = document.createElement('div');
      b.group[0].parentNode.insertBefore(box, b.group[0]);
      b.group.forEach(function (el) { box.appendChild(el); });
      return box;
    });
  }

  /* What to call a tab: the block's own heading, then an SVG title, then its
     first few words. A tab labelled "View 3" tells the reader nothing. */
  function labelFor(el, i) {
    var h = el.querySelector('h1, h2, h3, h4, h5, h6, [data-sim-title]');
    var t = h && h.textContent ? h.textContent : (el.querySelector('svg title') || {}).textContent;
    if (!t) t = (el.textContent || '').trim().split(/\\s+/).slice(0, 3).join(' ');
    t = (t || '').trim().replace(/\\s+/g, ' ');
    return t ? t.slice(0, 28) : ('View ' + (i + 1));
  }

  function autoTab() {
    if (document.querySelector('[data-sim-tab]')) return;      /* author knows best */
    /* The honest criterion is simply "does it fit". If the document is taller
       than the frame will ever be, stacking is already costing the reader
       something. CAP * 1.15 was a guess with slack in it that let a
       five-chart sheet through. */
    if (document.body.scrollHeight <= CAP) return;
    var found = findBlocks();
    if (!found || found.length < 2) return;
    materialise(found).forEach(function (el, i) {
      el.setAttribute('data-sim-tab', labelFor(el, i));
    });
  }

  var panels = [];
  function buildTabs() {
    if (panels.length < 2 || document.getElementById('sim-tabs')) return;
    var bar = document.createElement('div');
    bar.id = 'sim-tabs';
    bar.setAttribute('role', 'tablist');
    panels[0].parentNode.insertBefore(bar, panels[0]);

    panels.forEach(function (panel, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = panel.getAttribute('data-sim-tab') || ('View ' + (i + 1));
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
      b.onclick = function () {
        panels.forEach(function (p, j) { p.hidden = j !== i; });
        [].slice.call(bar.children).forEach(function (c, j) {
          c.setAttribute('aria-selected', j === i ? 'true' : 'false');
        });
        build(panels[i]);
        report();
      };
      bar.appendChild(b);
      panel.hidden = i !== 0;
    });
  }

  /* --- the build ------------------------------------------------------- */
  function build(scope) {
    if (still) return;
    var root = scope || document.body;
    var step = 0;

    var blocks = [].slice.call(root.children || []).filter(function (el) {
      return el.id !== 'sim-tabs' && el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE';
    });
    blocks.forEach(function (el) {
      el.classList.remove('sim-in');
      void el.offsetWidth;                        /* restart the animation */
      el.style.animationDelay = (step++ * 70) + 'ms';
      el.classList.add('sim-in');
    });

    [].slice.call(root.querySelectorAll('svg')).forEach(function (svg) {
      var shapes = [].slice.call(svg.querySelectorAll('rect, circle, ellipse, text, polygon, image'));
      shapes.forEach(function (el) {
        el.style.animationDelay = (140 + step * 45) + 'ms';
        el.classList.add('sim-in-el');
        step++;
      });
      [].slice.call(svg.querySelectorAll('path, line, polyline')).forEach(function (el) {
        var len = 0;
        try { len = el.getTotalLength ? el.getTotalLength() : 0; } catch (e) { len = 0; }
        if (!len || !isFinite(len)) {
          el.style.animationDelay = (140 + step * 45) + 'ms';
          el.classList.add('sim-in-el');
        } else {
          el.style.strokeDasharray = len;
          el.style.strokeDashoffset = len;
          el.style.animationDelay = (140 + step * 45) + 'ms';
          el.classList.add('sim-line');
        }
        step++;
      });
    });
  }

  var last = 0;
  function report() {
    var d = document.documentElement, b = document.body;
    var h = Math.max(
      b ? b.scrollHeight : 0, b ? b.offsetHeight : 0,
      d ? d.scrollHeight : 0, d ? d.offsetHeight : 0
    );
    if (h && Math.abs(h - last) > 2) {
      last = h;
      parent.postMessage({ channel: CHANNEL, height: h }, '*');
    }
  }

  /* Deciding whether to tab depends on the document's height, and height is
     not reliable at load: a font or an image that has not settled measures
     short, the tall check fails, and five charts stay stacked. It was doing
     exactly that — tabbing on a warm cache and not on a cold one.

     So it is attempted repeatedly and is idempotent: once tabs exist the
     function does nothing, and until they do every tick gets another go. */
  function maybeTab() {
    if (document.getElementById('sim-tabs')) return false;
    autoTab();
    var found = [].slice.call(document.querySelectorAll('[data-sim-tab]'));
    if (found.length < 2) return false;
    panels = found;
    buildTabs();
    build(panels[0]);
    return true;
  }

  function start() {
    deWhite();
    fit();
    /* After fit(), because the decision depends on how tall the document is
       once it has been reined in to the column. */
    if (!maybeTab()) build(null);
    report();
  }

  window.addEventListener('load', start);
  window.addEventListener('resize', function () { fit(); report(); });
  if (window.ResizeObserver && document.body) new ResizeObserver(report).observe(document.body);
  /* Twice more: a chart library that paints after load would otherwise put its
     own white canvas back and be measured at the wrong height. */
  setTimeout(function () { deWhite(); fit(); maybeTab(); report(); }, 80);
  setTimeout(function () { deWhite(); fit(); maybeTab(); report(); }, 500);
  /* One late attempt for a chart library that paints well after load. */
  setTimeout(function () { fit(); maybeTab(); report(); }, 1200);
})();
<\/script>`

  // Appended rather than prepended: a full document already has its own head,
  // and a style tag at the end still applies while a script at the end runs
  // after the content it is measuring exists.
  return `${body}${shim}`
}

export default function ArtifactBlock({ document: doc }) {
  const dark = useIsDark()
  const [content, setContent] = React.useState(null)
  const [loading, setLoading] = React.useState(false)
  const [failed, setFailed] = React.useState(null)
  const [saving, setSaving] = React.useState(false)
  const [height, setHeight] = React.useState(MIN_H)
  // What the frame last told us it needs, before the viewport cap. Kept so a
  // window resize can re-cap without waiting for the frame to speak again.
  const wantedRef = React.useRef(MIN_H)

  // One channel per mounted artifact, so two diagrams in one answer cannot
  // resize each other.
  const channel = React.useMemo(
    () => `sim-artifact-${Math.random().toString(36).slice(2, 10)}`,
    [],
  )

  const type = doc?.content_type || 'pdf'
  const visual = VISUAL.has(type)

  React.useEffect(() => {
    if (!visual || !doc?.document_id || content !== null) return undefined
    let alive = true
    setLoading(true)
    aiDocumentsAPI.download(doc.document_id)
      .then(async (res) => { if (alive) setContent(await res.data.text()) })
      .catch((err) => { if (alive) setFailed(err?.message || 'Could not load it.') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [visual, doc?.document_id, content])

  React.useEffect(() => {
    if (!visual) return undefined
    const onMessage = (e) => {
      // Only a height, only from our own channel, only within bounds. The
      // frame is untrusted content; this is the entire surface it can touch.
      const d = e.data
      if (!d || d.channel !== channel) return
      const h = Number(d.height)
      if (!Number.isFinite(h) || h <= 0) return
      wantedRef.current = h
      setHeight(Math.min(Math.max(h, MIN_H), capFor()))
    }
    // Re-cap on resize as well: rotating a phone or opening the context panel
    // changes how much room the artifact may take, and it should not need to
    // redraw itself to find that out.
    const onResize = () => setHeight(Math.min(Math.max(wantedRef.current, MIN_H), capFor()))

    window.addEventListener('message', onMessage)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('message', onMessage)
      window.removeEventListener('resize', onResize)
    }
  }, [visual, channel])

  if (!doc) return null

  const save = async () => {
    setSaving(true)
    try {
      const res = await aiDocumentsAPI.download(doc.document_id)
      const url = URL.createObjectURL(res.data)
      const a = window.document.createElement('a')
      a.href = url
      a.download = doc.file_name || doc.title || 'artifact'
      // Appended before clicking: a detached anchor does nothing in Firefox.
      window.document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      setFailed('The download failed.')
    } finally {
      setSaving(false)
    }
  }

  const DownloadAction = (
    <button
      type="button"
      onClick={save}
      disabled={saving}
      title="Download"
      aria-label={`Download ${doc.title || doc.file_name || 'artifact'}`}
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-[color:var(--embmis-text-faint)] transition-colors hover:bg-white/5 hover:text-[color:var(--embmis-text-strong)]"
    >
      {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
      Download
    </button>
  )

  // A PDF is genuinely a thing you take away rather than look at here, so it
  // stays a single line with an action instead of pretending to be inline.
  if (!visual) {
    return (
      <div className="my-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-[color:var(--embmis-text-muted)]">
        <span className="truncate font-medium text-[color:var(--embmis-text-strong)]">
          {doc.title || doc.file_name}
        </span>
        <span className="text-[color:var(--embmis-text-faint)]">·</span>
        {DownloadAction}
      </div>
    )
  }

  return (
    <div className="group/artifact relative my-3">
      {loading && (
        <p className="flex items-center gap-2 py-6 text-[12px] text-[color:var(--embmis-text-faint)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading it…
        </p>
      )}

      {failed && !loading && (
        <p className="py-3 text-[12px] text-[color:var(--embmis-text-muted)]">
          {failed} <span className="ml-1">{DownloadAction}</span>
        </p>
      )}

      {content !== null && !loading && (
        <>
          {/* sandbox="allow-scripts" and deliberately NOT allow-same-origin.
              Simeli wrote this document, so it runs in an opaque origin with no
              path to this app's session, storage or DOM. The scripts flag is
              what makes the diagram interactive — clicking a leg, flipping a
              toggle — and it is safe precisely because same-origin is withheld.
              Do not add it to make height measurement easier; the frame reports
              its own height for exactly that reason. */}
          <iframe
            key={dark ? 'dark' : 'light'}
            title={doc.title || 'Diagram'}
            sandbox="allow-scripts"
            srcDoc={wrap(content, type, channel, dark, capFor())}
            style={{ height }}
            className="w-full border-0 bg-transparent"
          />

          <div className="pointer-events-none absolute right-0 top-0 opacity-0 transition-opacity group-hover/artifact:opacity-100">
            <span className="pointer-events-auto">{DownloadAction}</span>
          </div>
        </>
      )}
    </div>
  )
}
