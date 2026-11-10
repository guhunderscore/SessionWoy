/**
 * Session marker on the tab's favicon (ADR 0003, D4): the site's own favicon with a dot in the
 * session color in the bottom-right corner. If the favicon cannot be read (missing, or cross-origin
 * without CORS, which taints the canvas), a plain circle in the session color is used instead.
 *
 * Runs in the ISOLATED world of the top frame (shares the DOM with the page). The page's own icon
 * links are disabled (rel renamed, original kept in a data attribute) and restored when the tab
 * leaves its session. A MutationObserver re-applies the marker when the page changes its favicon
 * (e.g. unread counters), and ignores our own edits.
 */

const OURS = 'data-sessionwoy-icon';
const SAVED_REL = 'data-sessionwoy-rel';
const SIZE = 32;
const LOAD_TIMEOUT_MS = 3000;

let color: string | null = null;
let generation = 0;
let observer: MutationObserver | null = null;
let reapplyTimer: ReturnType<typeof setTimeout> | undefined;
/** href of the page icon we last composed, to skip redundant work. */
let lastSource = '';

const isTopFrame = (() => {
  try {
    return window.top === window;
  } catch {
    return false;
  }
})();

function pageIconLinks(): HTMLLinkElement[] {
  return [...document.querySelectorAll<HTMLLinkElement>('link[rel]')].filter(
    (l) => !l.hasAttribute(OURS) && /(^|\s)icon(\s|$)/i.test(l.getAttribute(SAVED_REL) ?? l.rel),
  );
}

/** Best page favicon: an SVG or a 32px icon if declared, else the last icon link, else /favicon.ico. */
function sourceUrl(): string {
  const links = pageIconLinks();
  const pick =
    links.find((l) => /svg/i.test(l.type) || /\.svg(\?|$)/i.test(l.href)) ??
    links.find((l) => /(^|\s)32x32(\s|$)/.test(l.getAttribute('sizes') ?? '')) ??
    links.at(-1);
  return pick?.href || new URL('/favicon.ico', location.href).href;
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve(null), LOAD_TIMEOUT_MS);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img.naturalWidth > 0 ? img : null);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    img.src = url;
  });
}

function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = SIZE * 0.08;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
}

/** Returns a PNG data URL and whether the page's own favicon was used. */
async function compose(fill: string): Promise<{ url: string; source: 'page' | 'fallback' }> {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  const img = await loadImage(sourceUrl());
  if (img) {
    try {
      ctx.drawImage(img, 0, 0, SIZE, SIZE);
      circle(ctx, SIZE * 0.72, SIZE * 0.72, SIZE * 0.24, fill);
      return { url: canvas.toDataURL('image/png'), source: 'page' }; // throws if the canvas is tainted
    } catch {
      ctx.clearRect(0, 0, SIZE, SIZE);
    }
  }
  circle(ctx, SIZE / 2, SIZE / 2, SIZE * 0.4, fill);
  return { url: canvas.toDataURL('image/png'), source: 'fallback' };
}

function withoutObserver(fn: () => void): void {
  observer?.disconnect();
  try {
    fn();
  } finally {
    if (observer && color) observer.observe(document.head ?? document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'rel'] });
  }
}

function install(url: string, source: 'page' | 'fallback', fill: string): void {
  withoutObserver(() => {
    for (const l of pageIconLinks()) {
      if (!l.hasAttribute(SAVED_REL)) {
        l.setAttribute(SAVED_REL, l.rel);
        l.rel = 'sessionwoy-disabled-icon';
      }
    }
    let link = document.querySelector<HTMLLinkElement>(`link[${OURS}]`);
    if (!link) {
      link = document.createElement('link');
      link.setAttribute(OURS, '');
      (document.head ?? document.documentElement).appendChild(link);
    }
    link.rel = 'icon';
    link.type = 'image/png';
    link.href = url;
    link.dataset.sessionwoyColor = fill;
    link.dataset.sessionwoySource = source;
  });
}

async function apply(): Promise<void> {
  const fill = color;
  if (!fill) return;
  const gen = ++generation;
  // Compose from the page icon as it was before we disabled it.
  const src = sourceUrl();
  let result: { url: string; source: 'page' | 'fallback' };
  try {
    result = await compose(fill);
  } catch {
    return;
  }
  if (gen !== generation || color !== fill) return; // superseded
  lastSource = src;
  install(result.url, result.source, fill);
}

function onMutations(): void {
  // The page added or changed an icon: re-compose (debounced) unless nothing relevant changed.
  if (reapplyTimer) clearTimeout(reapplyTimer);
  reapplyTimer = setTimeout(() => {
    const ours = document.querySelector<HTMLLinkElement>(`link[${OURS}]`);
    const fresh = pageIconLinks().some((l) => !l.hasAttribute(SAVED_REL));
    if (fresh || !ours || ours.rel !== 'icon' || sourceUrl() !== lastSource) void apply();
  }, 100);
}

function whenDomReady(fn: () => void): void {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
  else fn();
}

/** Shows (or recolors) the session marker on this tab's favicon. */
export function setSessionFavicon(fill: string): void {
  if (!isTopFrame || color === fill) return;
  color = fill;
  whenDomReady(() => {
    if (color !== fill) return;
    observer ??= new MutationObserver(onMutations);
    void apply();
  });
}

/** Removes the marker and restores the page's own favicon links. */
export function clearSessionFavicon(): void {
  if (!isTopFrame || color === null) return;
  color = null;
  generation++;
  if (reapplyTimer) clearTimeout(reapplyTimer);
  observer?.disconnect();
  observer = null;
  document.querySelector(`link[${OURS}]`)?.remove();
  for (const l of document.querySelectorAll<HTMLLinkElement>(`link[${SAVED_REL}]`)) {
    l.rel = l.getAttribute(SAVED_REL) ?? 'icon';
    l.removeAttribute(SAVED_REL);
  }
}
