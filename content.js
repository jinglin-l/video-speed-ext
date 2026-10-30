/*
 * Private Video Speed: content script
 * ===================================
 *
 * This is the whole extension. Firefox injects this file into every page and
 * every iframe (see manifest.json), and it does three things:
 *
 *   1. Finds <video> elements, including ones added later (YouTube, Twitch and
 *      friends build their players dynamically), and attaches a small speed
 *      badge to each one.
 *   2. Listens for the S / D / R / Z / X / V shortcuts and changes every
 *      tracked video's `playbackRate` or `currentTime`.
 *   3. Re-applies the chosen speed when a site quietly resets it, e.g. when
 *      YouTube loads the next video in the same <video> element.
 *
 * PRIVACY MODEL: this is why the extension exists, so it is spelled out here.
 *   - manifest.json requests NO `permissions` at all: no storage, no tabs, no
 *     webRequest, no host permissions for background fetches. There is also no
 *     background script. Content scripts can't talk to anything except the
 *     page they run in, so there is nowhere for data to go.
 *   - The keydown listener reads only `event.key` and modifier flags, compares
 *     the key against six letters, and throws everything else away. Nothing is
 *     recorded, buffered or stored.
 *   - This file never calls fetch, XMLHttpRequest, WebSocket, sendBeacon or
 *     browser.* APIs. You can confirm that with:
 *       grep -nE "fetch|XMLHttp|WebSocket|sendBeacon|browser\.|chrome\." content.js
 *     (The only hits should be inside this comment.)
 *   - Speed lives in a plain variable, so it's remembered per tab, per page
 *     load, and forgotten on reload. Persisting it across sites would need the
 *     `storage` permission, which was deliberately left out.
 */
(() => {
  "use strict";

  // Guard against double injection. With all_frames, each frame gets its own
  // copy, which is intended. But some pages re-run scripts (e.g. bfcache
  // restores), and two copies would double every keypress.
  if (window.__privateVideoSpeedLoaded) return;
  window.__privateVideoSpeedLoaded = true;

  // ---------------------------------------------------------------------------
  // Tunables. These match the original extension's defaults so muscle memory
  // carries over.
  // ---------------------------------------------------------------------------
  const SPEED_STEP = 0.1;
  // Firefox mutes audio outside roughly 0.25x-4x but still plays the video.
  // The range is wide like the original's, and the browser clamps anything
  // it can't do.
  const MIN_SPEED = 0.07;
  const MAX_SPEED = 16;
  const SEEK_SECONDS = 10;

  // Key -> action. Matched case-insensitively on `event.key` (the character
  // produced) rather than `event.code` (the physical key), so it behaves
  // sensibly on non-QWERTY layouts, same as the original.
  const KEYMAP = {
    s: () => changeSpeed(-SPEED_STEP),
    d: () => changeSpeed(+SPEED_STEP),
    r: () => resetSpeed(),
    z: () => seek(-SEEK_SECONDS),
    x: () => seek(+SEEK_SECONDS),
    v: () => toggleBadges(),
  };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  // The speed the user wants for this page. It is the source of truth: when a
  // site resets a video to 1x, it gets re-applied from here.
  let targetSpeed = 1.0;

  // `R` toggles between 1x and the last non-1x speed, which is the original's
  // "reset" behavior. Pressing R twice returns you to where you were.
  let lastNonDefaultSpeed = 1.8;

  let badgesVisible = true;

  // Every video we've attached to, mapped to its badge. A Map, not a WeakMap,
  // because the shortcuts need to *iterate* over the videos, and WeakMaps
  // can't be iterated. To avoid leaks on long-lived single-page apps, entries
  // for videos removed from the DOM get pruned in `liveVideos()`.
  const tracked = new Map(); // HTMLVideoElement -> { host, label }

  // ---------------------------------------------------------------------------
  // Core actions
  // ---------------------------------------------------------------------------

  function clamp(v) {
    // Round to 2 decimals so repeated +0.1 steps don't drift into 1.7000000002.
    return Math.round(Math.min(MAX_SPEED, Math.max(MIN_SPEED, v)) * 100) / 100;
  }

  function setAllSpeeds(speed) {
    targetSpeed = clamp(speed);
    if (targetSpeed !== 1) lastNonDefaultSpeed = targetSpeed;
    for (const video of liveVideos()) applySpeed(video);
  }

  function changeSpeed(delta) {
    setAllSpeeds(targetSpeed + delta);
  }

  function resetSpeed() {
    setAllSpeeds(targetSpeed === 1 ? lastNonDefaultSpeed : 1);
  }

  function seek(seconds) {
    for (const video of liveVideos()) {
      // Clamp to the start. Past the end is fine, since the browser just ends
      // the video. `duration` can be Infinity for live streams, so it isn't
      // used here.
      video.currentTime = Math.max(0, video.currentTime + seconds);
    }
  }

  function toggleBadges() {
    badgesVisible = !badgesVisible;
    for (const { host } of tracked.values()) {
      host.style.display = badgesVisible ? "" : "none";
    }
  }

  function applySpeed(video) {
    if (video.playbackRate !== targetSpeed) video.playbackRate = targetSpeed;
    updateLabel(video);
  }

  function updateLabel(video) {
    const entry = tracked.get(video);
    if (entry) entry.label.textContent = video.playbackRate.toFixed(2);
  }

  /** Tracked videos still in the document; drops the ones that were removed. */
  function liveVideos() {
    for (const [video, { host }] of tracked) {
      if (!video.isConnected) {
        host.remove();
        tracked.delete(video);
      }
    }
    return [...tracked.keys()];
  }

  // ---------------------------------------------------------------------------
  // Attaching to videos
  // ---------------------------------------------------------------------------

  function attach(video) {
    if (tracked.has(video) || !video.parentElement) return;

    // Badge placement: the badge is inserted as a sibling right before the
    // <video>. That's the original extension's approach, and it's chosen over
    // a page-level fixed overlay for one big reason: fullscreen. In
    // fullscreen, only the fullscreen element's subtree is rendered, and site
    // players fullscreen their container, not <body>. A sibling inside the
    // container stays visible; a body-level overlay would vanish.
    //
    // It's `position:absolute` with NO top/left on purpose. An absolute box
    // without offsets sits at its "static position", which is where it would
    // have been in normal flow. That's directly before the video, i.e. the
    // video's top-left corner, wherever the video is. Using top:0;left:0
    // instead (the original's choice) pins it to the nearest *positioned*
    // ancestor. When the parent isn't positioned, that can be the whole page,
    // which made badges stack in the page corner during testing. Being
    // absolute, the badge takes up no space and doesn't shift the layout.
    const host = document.createElement("div");
    // `all:initial` wipes any inherited site CSS. It must come first, because
    // later declarations in the same block override the shorthand.
    host.style.cssText =
      "all:initial;position:absolute;z-index:2147483647;";
    if (!badgesVisible) host.style.display = "none";

    // A closed shadow root isolates the badge's markup and CSS from the page:
    // site styles can't break it, and page scripts can't easily reach in.
    const root = host.attachShadow({ mode: "closed" });
    // The markup is a fixed string with no interpolated values, so innerHTML
    // can't inject anything (and Mozilla's linter stays happy).
    root.innerHTML = `
      <style>
        .badge {
          margin: 10px; padding: 3px 6px;
          font: 600 13px/1.2 system-ui, sans-serif;
          color: #fff; background: rgba(0,0,0,.55);
          border-radius: 5px; user-select: none; cursor: grab;
          display: inline-flex; gap: 4px; align-items: center;
          opacity: .6; transition: opacity .15s;
          /* Without this, a touch drag would scroll the page instead of
             moving the badge. */
          touch-action: none;
        }
        .badge:hover { opacity: 1; }
        .badge.dragging { cursor: grabbing; opacity: 1; }
        /* Buttons only show on hover, like the original: unobtrusive by
           default, clickable when you go looking for them. */
        button {
          display: none; font: inherit; color: inherit;
          background: rgba(255,255,255,.15); border: 0; border-radius: 3px;
          padding: 0 6px; cursor: pointer;
        }
        .badge:hover button { display: inline-block; }
        button:hover { background: rgba(255,255,255,.35); }
      </style>
      <div class="badge">
        <span class="label">1.00</span>
        <button data-act="z" title="Rewind (Z)">«</button>
        <button data-act="s" title="Slower (S)">−</button>
        <button data-act="d" title="Faster (D)">+</button>
        <button data-act="x" title="Advance (X)">»</button>
        <button data-act="v" title="Hide (V)">×</button>
      </div>`;

    const badge = root.querySelector(".badge");
    // Swallow pointer events so clicking the badge doesn't also reach the
    // player underneath. On YouTube, that would toggle play/pause on every
    // click. mousedown/pointerdown are included because some players act on
    // those, not on click.
    for (const type of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "dblclick"]) {
      badge.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type === "click") {
          e.preventDefault();
          const act = e.target.closest?.("button")?.dataset.act;
          if (act) KEYMAP[act]();
        }
      });
    }

    enableDragging(host, badge);

    video.parentElement.insertBefore(host, video);
    tracked.set(video, { host, label: root.querySelector(".label") });

    // Re-assert our speed when a site resets it. YouTube, for example,
    // reuses one <video> element and sets it back to 1x when the next video
    // loads. `loadedmetadata` (new source) and `play` are the moments sites
    // typically do that. This intentionally does NOT fight every
    // `ratechange`. If you pick a speed from the site's own menu, it sticks
    // until the next play/load, which avoids an endless tug-of-war with
    // players that re-set the rate in a loop.
    video.addEventListener("loadedmetadata", () => applySpeed(video));
    video.addEventListener("play", () => applySpeed(video));
    video.addEventListener("ratechange", () => updateLabel(video));

    applySpeed(video);
  }

  /**
   * Lets the user drag a badge out of the way when it covers something they
   * need to click (a site's own button in the video's top-left corner, say).
   *
   * How it moves: a CSS `transform: translate()` on the host, layered on top
   * of the static-position trick described in `attach()`. Changing top/left
   * instead would pin the badge to the nearest positioned ancestor and bring
   * back the page-corner stacking bug. A transform is relative to wherever the
   * badge already sits, so the badge still follows its video, just offset.
   *
   * Grab anywhere on the badge except its buttons. Drags that start on a
   * button are ignored so the buttons keep working as plain clicks.
   * Double-click the badge to put it back in the corner.
   *
   * The offset lives in a closure variable, per badge, and is forgotten on
   * reload, same as the speed (persisting it would need `storage`).
   */
  function enableDragging(host, badge) {
    let offsetX = 0;
    let offsetY = 0;
    // Set while a drag is in progress: where the pointer went down, and the
    // offset at that moment. Each move computes the new offset from these,
    // not by accumulating per-event deltas, so no rounding drift builds up.
    let start = null;

    const place = () => {
      host.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
    };

    badge.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest?.("button")) return;
      start = { x: e.clientX, y: e.clientY, offsetX, offsetY };
      // Pointer capture keeps the moves coming to the badge even when the
      // cursor outruns it, or slides over an iframe that would otherwise
      // swallow them.
      badge.setPointerCapture(e.pointerId);
      badge.classList.add("dragging");
      // Stops the browser from starting a text selection or native drag.
      e.preventDefault();
    });

    badge.addEventListener("pointermove", (e) => {
      if (!start) return;
      offsetX = start.offsetX + (e.clientX - start.x);
      offsetY = start.offsetY + (e.clientY - start.y);
      place();
      // Players like YouTube show or hide their controls on mouse movement.
      // While dragging, the movement belongs to the badge.
      e.stopPropagation();
    });

    // pointercancel fires when the browser takes the pointer away, e.g. a
    // touch turning into a system gesture. Treat it like a normal release.
    const end = () => {
      start = null;
      badge.classList.remove("dragging");
    };
    badge.addEventListener("pointerup", end);
    badge.addEventListener("pointercancel", end);

    badge.addEventListener("dblclick", (e) => {
      if (e.target.closest?.("button")) return; // fast clicks on − / + aren't a reset
      offsetX = offsetY = 0;
      place();
    });
  }

  // Initial scan, then watch for videos added later. One MutationObserver on
  // the whole document is cheap, because the callback only does work when an
  // added subtree actually contains a <video>.
  //
  // Known limitation: videos inside *shadow DOM* (rare; some custom players
  // use it) aren't found, because querySelectorAll doesn't cross shadow
  // boundaries. Walking every shadow root on every mutation would be costly
  // on busy pages, and the original extension has the same gap.
  document.querySelectorAll("video").forEach(attach);

  new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.tagName === "VIDEO") attach(node);
        else if (node.querySelector) node.querySelectorAll("video").forEach(attach);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts
  // ---------------------------------------------------------------------------

  /** True when the user is typing into something, so letters must pass through. */
  function isTyping(e) {
    // composedPath()[0] is the real innermost target, even when the input sits
    // inside a shadow root (e.g. YouTube's comment box). `e.target` would only
    // report the shadow host there.
    const el = e.composedPath?.()[0] ?? e.target;
    if (!(el instanceof Element)) return false;
    return (
      el.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)
    );
  }

  window.addEventListener(
    "keydown",
    (e) => {
      // Leave Ctrl/Cmd/Alt combos alone (Cmd+D bookmarks, Ctrl+S saves, etc.).
      // Shift is allowed through because Caps Lock or Shift+S arriving as
      // "S" is harmless.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.repeat && e.key.toLowerCase() === "v") return; // holding V shouldn't flicker
      if (isTyping(e)) return;

      const action = KEYMAP[e.key.toLowerCase()];
      if (!action) return; // Not one of the six letters, so ignore it and remember nothing.

      // On pages with no video, don't hijack keys (some sites use S/D/X for
      // their own shortcuts).
      if (liveVideos().length === 0) return;

      action();
      // Stop the site from also handling the key, e.g. YouTube's own
      // shortcuts on overlapping letters.
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    // Capture phase on window means we see the key before the page's own
    // handlers, which some players use to swallow keystrokes.
    true
  );
})();
