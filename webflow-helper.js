/* Webflow Helper v3.31.0 - 2026-06-02 */

/**
 * Webflow Helper — minimal surface, exposes 28 cmds via `__webflowHelper.run()`
 * (source of truth = the ALLOWED_CMDS array at the end of this file):
 *
 * 1. switchPage — workaround MCP de_page_tool.switch_page (~70% timeout empirically)
 * 2. launchBridgeApp — mount the Webflow MCP Bridge App via direct dispatch
 * 3. appendHtmlEmbedViaUI — create a HtmlEmbed via UI automation (Add panel + paste + Save)
 * 4. updateEmbedViaUI — write content via UI automation (CodeMirror paste + Save click)
 * 5. renameNode — rename any node (HtmlEmbed, DIV, Section, etc.) via 3 Redux dispatches (v3.1.0)
 * 6. setComponentPropsViaUI — override ComponentInstance properties via UI automation (v3.4.0/v3.5.0)
 * 7. setImageSettings — set Image alt mode (inherit/decorative/custom) + loading type (lazy/eager/auto) (v3.7.0)
 * 8. helpEditImagesAltInComponent — batch alt mode edit for ComponentInstance children (v3.11.2)
 * 9. findNodeContext — resolve nodeId → MCP id format + component view context (v3.8.0)
 * 10. listEmbeds — list embeds + their contents (no MCP tool)
 * 11. getEmbedContentViaUI — ground-truth embed read via CodeMirror UI scrape (~3-4s · 100% reliable · async)
 *     v3.24.0 (s572) — l'ancienne `getEmbedContent` (Redux SYNC) a été supprimée car elle retournait
 *     `value: ""` faux négatif sur embeds stale post-write inComponent + sur certaines lectures cross-session.
 *     `getEmbedContentViaUI` devient l'unique interface publique de lecture d'embed — JAMAIS de lecture
 *     Redux exposée pour le contenu (la stale était trop trompeuse à l'audit). Le suffixe `ViaUI` conservé
 *     pour cohérence avec `updateEmbedViaUI`, `appendHtmlEmbedViaUI`, etc.
 * 13. getCurrentPageInfo — 3-source page concordance (DOM/URL/Redux) — MCP de_page_tool.get_current_page has 76% timeout + no DOM check
 * 14. dumpTree — full Navigator tree dump with resolved class names (MCP query_elements BETA broken)
 *     + v3.3.0 option `expandSlotOverrides` — walks Component instance slot overrides
 *       (e.g. FAQ items nested in Section FAQ's faq_list slot) + extracts prop values
 *       from `data.sym.overrides[propId][0].data.value` (text format). Read-only.
 * 15. queryStyleByCombo — resolve combo chain `[parent, combo]` → style_id unique via
 *     Redux parentIndex local walk (~10ms · 100% reliable). Fix gotcha #41 s572
 *     (MCP `parent_style_names` silently ignored on homonymous combos ≥2 occurrences).
 * 16. dumpComboIndex — snapshot Redux registry of homonymous combos (≥2 occurrences
 *     same name) for git-tracked persistence (`project/webflow-state/combo-registry-{siteId}.json`).
 *     Consumed by hook PreToolUse style_tool BLOCK (Phase 3 COMBO-DISAMBIGUATION-ROADMAP).
 * 17. selectNode — select any Navigator node via NODE_CLICKED dispatch (auto-expands the
 *     Navigator; works for collapsed nodes). Intra-component: pass componentInstanceId. (v3.25.0)
 * 18. openComponentView — enter a component edit view via SYMBOL_NODE_FOCUSED dispatch
 *     (derives symbolId from the Symbol node's .componentInstance). (v3.25.0)
 * 19. closeComponentView — exit a component edit view via SYMBOL_NODE_UNFOCUSED dispatch. (v3.25.0)
 *
 * Version history (BREAKING / MINOR / PATCH per release) extracted to
 * `tools/webflow-helper-CHANGELOG.md` to keep this header focused on the
 * current command surface. See `ALLOWED_CMDS` (end of file) for the
 * authoritative command list.
 *
 * Any other cmd called via `__webflowHelper.run('X')` returns
 * `{ ok: false, error: 'CMD_NOT_EXPOSED' }`. Everything else uses the official MCP server.
 *
 * Source: extracted from a Webflow Designer "deck" toolkit (full bundle archived
 * at `tools/_archive/webflow-deck-v9.6.0.js`). Modules retained:
 * Bridge init + run() + write queue, Core Helpers (Redux+DOM), CodeEmbed (incl. UI
 * automation cmds appendHtmlEmbedViaUI / updateEmbedViaUI v3.0.0), switchPage,
 * launchBridgeApp helpers, whitelist filter.
 */

(function() {
  'use strict';

  var VERSION = '3.32.0';
  // Per-version empirical fix notes (addClassViaUI, style-selector UI cmds,
  // CodeMirror integration, etc.) extracted to
  // `tools/webflow-helper-CHANGELOG.md`. The code below is current behaviour.

  if (!window.__webflowHelper) window.__webflowHelper = {};
  var p = window.__webflowHelper;

  p._localCmd = {};

  // ========================================================
  // Write Queue + Cascade Detection
  // ========================================================

  var DEFAULT_WRITE_THROTTLE_MS = 150;

  // Cascade detection — anti-timeout (Chrome DevTools MCP hard-cap 60s) and
  // anti-workflow-corruption (intermediate Redux/WS states aren't visible to the
  // caller, mid-cascade failure leaves orphans with no rollback path).
  //
  // Detection: count consecutive write enqueues within CASCADE_GAP_MS. If a 2nd
  // write is enqueued within the gap (= same evaluate_script cascade), reject
  // with explicit guidance to fragment.
  //
  // Re-entrant sub-calls bypass automatically via `_inFlightDepth > 0`
  // detection. The caller must fragment in N separate evaluate_script calls or
  // wait > CASCADE_GAP_MS.
  var CASCADE_GAP_MS = 2000;     // Same-cascade window — gap > 2s = new session
  var CASCADE_MAX_OPS = 1;       // Max writes per cascade window before reject (zero tolerance)
  var _cascadeLastAt = 0;
  var _cascadeCount = 0;

  // WRITE cmds - routed through FIFO queue with throttle to avoid multiplayer
  // version-vector conflicts. Reads bypass the queue.
  var WRITE_COMMANDS = {
    appendHtmlEmbedViaUI: true,
    updateEmbedViaUI: true,
    renameNode: true,
    switchPage: true,
    setPageCode: true
  };

  var _writeQueueTail = Promise.resolve();
  var _stats = {
    total_enqueued: 0,
    total_completed: 0,
    total_errored: 0,
    current_depth: 0,
    last_write_at: 0,
    last_command: null,
    throttle_ms: DEFAULT_WRITE_THROTTLE_MS
  };

  function isWriteCommand(command) {
    return WRITE_COMMANDS[command] === true;
  }

  function checkCascade() {
    var now = Date.now();
    if (now - _cascadeLastAt < CASCADE_GAP_MS) {
      _cascadeCount += 1;
    } else {
      _cascadeCount = 1;
    }
    _cascadeLastAt = now;
      // Re-entrant sub-calls bypass automatically via _inFlightDepth > 0 in p.run
    // (before reaching here). This function only sees top-level writes.
    if (_cascadeCount > CASCADE_MAX_OPS) {
      return _cascadeCount;
    }
    return 0;
  }

  function enqueueWrite(command, args) {
    _stats.total_enqueued += 1;
    _stats.current_depth += 1;
    var previousTail = _writeQueueTail;
    var task = (async function() {
      try { await previousTail; } catch (e) { /* continue queue regardless */ }
      var result;
      var threw = null;
      try {
        result = await p._localCmd[command](args || {});
      } catch (e) {
        threw = e;
      }
      // Throttle delay AFTER each write (success OR error) to maintain rhythm.
      await new Promise(function(r) { setTimeout(r, _stats.throttle_ms); });
      _stats.current_depth -= 1;
      _stats.last_write_at = Date.now();
      _stats.last_command = command;
      if (threw) {
        _stats.total_errored += 1;
        throw threw;
      }
      _stats.total_completed += 1;
      return result;
    })();
    _writeQueueTail = task;
    return task;
  }

  // Auto re-entrancy detection: counter of in-flight `p.run()` calls. If > 0, we're
  // in a sub-call of a parent cmd → bypass queue + cascade-counter automatically
  // (the parent guarantees atomicity).
  var _inFlightDepth = 0;

  p.run = function(command, args) {
    if (!p._localCmd[command]) {
      return Promise.reject(new Error('[webflow-helper] Unknown command: ' + command));
    }
    var skipThrottle = args && args.__skip_throttle__ === true;
    var isReentrant = _inFlightDepth > 0;
    // Bypass queue: reads, explicit __skip_throttle__, OR re-entrant sub-call.
    if (!isWriteCommand(command) || skipThrottle || isReentrant) {
      _inFlightDepth += 1;
      return Promise.resolve()
        .then(function() { return p._localCmd[command](args || {}); })
        .then(function(result) { _inFlightDepth -= 1; return result; },
              function(err)    { _inFlightDepth -= 1; throw err; });
    }
    // External writes (top-level user call): cascade detection + enqueue
    var exceeded = checkCascade();
    if (exceeded) {
      return Promise.reject(new Error('[webflow-helper] CASCADE_LIMIT_EXCEEDED — write #' + exceeded + ' enqueued within ' +
        CASCADE_GAP_MS + 'ms of previous write (cmd: ' + command + ').\n' +
        '  Why: zero-tolerance cascade policy. ' +
        'Sequential writes in 1 evaluate_script risk partial state + orphan styleBlocks + ' +
        'Designer freeze on Redux/WS eventual consistency mismatch.\n' +
        '  Fix: fragment workflow — 1 evaluate_script per write op. Wait > ' +
        CASCADE_GAP_MS + 'ms or use a separate tool call between writes.\n' +
        '  Re-entrant sub-calls bypass automatically via _inFlightDepth.'));
    }
    _inFlightDepth += 1;
    return enqueueWrite(command, args)
      .then(function(result) { _inFlightDepth -= 1; return result; },
            function(err)    { _inFlightDepth -= 1; throw err; });
  };

  /**
   * Returns a snapshot of write queue counters for debugging.
   *
   * @returns {object} { total_enqueued, total_completed, total_errored,
   * current_depth, last_write_at, last_command, throttle_ms }
   */
  p.writeQueueStats = function() {
    return {
      total_enqueued: _stats.total_enqueued,
      total_completed: _stats.total_completed,
      total_errored: _stats.total_errored,
      current_depth: _stats.current_depth,
      last_write_at: _stats.last_write_at,
      last_command: _stats.last_command,
      throttle_ms: _stats.throttle_ms,
      cascade_count: _cascadeCount,
      cascade_last_at: _cascadeLastAt,
      cascade_gap_ms: CASCADE_GAP_MS,
      cascade_max_ops: CASCADE_MAX_OPS
    };
  };

  /**
   * Adjust the inter-write throttle delay at runtime.
   *
   * @param {number} ms - New delay in milliseconds (clamped to [0, 5000]).
   * Default 150ms simulates human click rhythm. Setting to 0 effectively
   * disables throttling (queue order still respected, no inter-write wait).
   * @returns {object} { ok, throttle_ms, previous_throttle_ms }
   */
  p.setWriteThrottle = function(ms) {
    if (typeof ms !== 'number' || isNaN(ms)) {
      return { ok: false, error: 'ms must be a number', throttle_ms: _stats.throttle_ms };
    }
    var previous = _stats.throttle_ms;
    _stats.throttle_ms = Math.max(0, Math.min(5000, ms));
    return { ok: true, throttle_ms: _stats.throttle_ms, previous_throttle_ms: previous };
  };

  p.version = function() { return VERSION; };
  p.status = function() {
    return {
      version: VERSION,
      localCommands: Object.keys(p._localCmd).length,
      writeQueue: p.writeQueueStats()
    };
  };

  /**
   * Refresh the Webflow MCP Bridge App cache.
   *
   * After a WebSocket mutation via __webflowHelper, MCP Webflow tools
   * (element_tool.query_elements, remove_element, style_tool,...) do NOT see
   * the new state — they operate on a DOM snapshot frozen at MCP Bridge
   * activation.
   *
   * Solution: navigate to the Designer URL with the `?app=<hash>` query param.
   * This re-establishes the Bridge session with a valid token and forces a
   * fresh DOM sync.
   *
   * Why a hidden iframe injection does NOT work: the `?app=<hash>` mechanism
   * creates a server-side session token when Webflow itself opens the
   * extension from a user navigation. Injecting the extension iframe from
   * script-side produces the iframe element in the DOM, but the MCP server
   * cannot validate the session. The navigation (with its reload) is required.
   *
   * @param {string} appHash - The session token found in the MCP error message:
   * "Launch the app using following link https://<site>.design.webflow.com?app=<hash>"
   * Stable per MCP Bridge App installation per site, reusable across calls.
   *
   * @returns {object} { ok, navigating, url } — fire-and-forget. The current
   * JS context is destroyed by the navigation. __webflowHelper must be re-injected
   * after the Designer finishes reloading (typical delay 5-8s).
   */
  p.refreshMcpBridge = function(appHash) {
    if (!appHash || typeof appHash !== 'string' || appHash.length < 32) {
      return { ok: false, error: 'refreshMcpBridge requires a valid appHash string — find it in any MCP "Unable to connect" error message after "?app="' };
    }
    var url = window.location.origin + window.location.pathname + '?app=' + encodeURIComponent(appHash);
    console.log('[webflow-helper] refreshMcpBridge — navigating to', url, '(JS context will be destroyed — re-inject __webflowHelper after Designer is ready, ~5-8s)');
    window.location.href = url;
    return { ok: true, navigating: true, url: url, note: 'Page is reloading. __webflowHelper must be re-injected after reload completes.' };
  };

  console.log('[webflow-helper] v' + VERSION + ' loaded');
})();

/**
 * Core Helpers — shared Redux + DOM utilities consumed by the embed/page/bridge
 * cmds via `__webflowHelper._internal.helpers`.
 *
 * Loads after the bridge IIFE (which creates `_localCmd` + `_internal`) and before
 * the cmd modules.
 *
 * Return convention:
 * { ok: true,...data } on success
 * { ok: false, error: 'snake_case', error_detail: '...' } on failure
 * warnings array contains { kind: 'snake_case', detail: '...' } items
 */
(function() {
  'use strict';

  if (!window.__webflowHelper) {
    console.log('[CoreHelpers] __webflowHelper not initialized — module skipped');
    return;
  }

  var p = window.__webflowHelper;
  p._internal = p._internal || {};

  // Error codes used by the cmds.

  var ERRORS = {
    DISPATCH_REJECTED: 'dispatch_rejected',
    ELEMENT_NOT_FOUND: 'element_not_found',
    INVALID_ARGS: 'invalid_args',
    NOT_CONVERGED: 'not_converged',
    NOT_FOUND: 'not_found',
    NO_CREATORS: 'no_creators',
    NO_STORES: 'no_stores',
    NO_SWITCHPAGE_CREATOR: 'no_switchpage_creator',
    PAGE_NOT_FOUND: 'page_not_found',
    SOCKET_RECONNECT_DROPPED: 'socket_reconnect_dropped',
    SWITCH_COOLDOWN_ACTIVE: 'switch_cooldown_active',
    THUNK_REJECTED: 'thunk_rejected'
  };

  // getCanvasWf — resolve the Designer CANVAS Webflow API (Redux store + styles).
  // Designer "next" (Webflow upstream refactor, observed s623) moved the canvas
  // Redux store into the #site-iframe-next iframe; older Designer builds exposed
  // it on the top window. Prefer the iframe, fall back to the top window so this
  // works on BOTH architectures. NOTE: the Bridge App itself still lives on the
  // top window — use getWfFromTop()/getTopWindow() (LaunchBridge module) for
  // app/launch concerns, not this.
  function getCanvasWf() {
    try {
      var ifr = document.getElementById('site-iframe-next') || document.getElementById('site-iframe');
      var w = ifr && ifr.contentWindow;
      if (w && w._webflow && typeof w._webflow.getState === 'function') return w._webflow;
    } catch (e) {}
    return (window._webflow && typeof window._webflow.getState === 'function') ? window._webflow : null;
  }

  function getReduxState() {
    var wf = getCanvasWf();
    return wf && wf.getState ? wf.getState() : null;
  }

  function getStores() {
    return (window._webflow && window._webflow.stores) || {};
  }

  // ============================================================
  // Immutable.js conversion
  // ============================================================

  function toJS(immutable) {
    if (immutable == null) return immutable;
    if (typeof immutable.toJS === 'function') return immutable.toJS();
    return immutable;
  }

  // ============================================================
  // DOM tree access (AbstractNodeStore)
  // ============================================================

  function getRoot() {
    var state = getReduxState();
    if (!state || !state.AbstractNodeStore) return null;
    return state.AbstractNodeStore.get('root');
  }

  // StyleBlocks access (StyleBlockStore) with 1s TTL cache. Used by listEmbeds
  // to resolve styleBlockIds -> class names without re-walking the registry on
  // every call.

  var _styleBlocksCache = null;
  var _styleBlocksCacheAt = 0;
  var STYLE_BLOCKS_CACHE_TTL = 1000;  // ms

  function getStyleBlocks() {
    var now = Date.now();
    if (_styleBlocksCache && (now - _styleBlocksCacheAt) < STYLE_BLOCKS_CACHE_TTL) {
      return _styleBlocksCache;
    }
    var state = getReduxState();
    if (!state || !state.StyleBlockStore) return null;
    var sbs = state.StyleBlockStore;
    var blocks = sbs.get && sbs.get('styleBlocks');
    if (!blocks) return null;
    _styleBlocksCache = blocks.toJS ? blocks.toJS() : blocks;
    _styleBlocksCacheAt = now;
    return _styleBlocksCache;
  }

  // walkTree(node, callback, opts?)
  // opts.maxDepth (default 50)
  // opts.includeRoot (default true) — if false, skip the start node and only walk children
  // callback(node, depth) — return true to stop walking entirely (early exit)

  function walkTree(node, callback, opts) {
    opts = opts || {};
    var maxDepth = opts.maxDepth != null ? opts.maxDepth : 50;
    var includeRoot = opts.includeRoot !== false;
    var stop = { value: false };
    function recurse(n, depth) {
      if (stop.value || !n || depth > maxDepth) return;
      if (depth > 0 || includeRoot) {
        var r = callback(n, depth);
        if (r === true) { stop.value = true; return; }
      }
      var children = n.get && n.get('children');
      if (children && children.forEach) {
        children.forEach(function(c) { recurse(c, depth + 1); });
      }
    }
    recurse(node, 0);
  }

  // Find a node by ID within a SPECIFIC Immutable tree (rootImm).
  // Use this when the tree is NOT the parent window's _webflow tree (e.g. iframe
  // canvas store accessed by style-write.js).
  // opts.maxDepth (default 50) — same semantics as walkTree.
  function findNodeByIdInTree(rootImm, targetId, opts) {
    var found = null;
    walkTree(rootImm, function(node) {
      if (node.get && node.get('id') === targetId) {
        found = node;
        return true; // stop
      }
    }, opts);
    return found;
  }

  // Convenience wrapper: find a node in the parent window's tree.
  function findNodeById(targetId) {
    var root = getRoot();
    if (!root) return null;
    return findNodeByIdInTree(root, targetId);
  }

  // UUID generator — RFC4122 v4 strict (uses crypto.randomUUID if available).

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // Banner — uniform `[Module] vX.Y.Z — features` console.log format. Reads
  // version dynamically from __webflowHelper.version() so it cannot drift.
  function banner(moduleName, features) {
    var v = (window.__webflowHelper && typeof window.__webflowHelper.version === 'function')
      ? window.__webflowHelper.version()
      : 'unknown';
    return '[' + moduleName + '] v' + v + ' — ' + features;
  }

  // Wrapped expression builders for Webflow internal serialization.

  var wrap = {
    text: function(str) { return { type: 'Text', val: str == null ? '' : str }; },
    boolean: function(b) { return { type: 'Boolean', val: !!b }; },
    string: function(id, str) {
      return {
        type: 'Element',
        val: {
          id: id,
          type: ['Basic', 'String'],
          data: { type: 'Text', val: str == null ? '' : str }
        }
      };
    },
    lineBreak: function(id) {
      return {
        type: 'Element',
        val: {
          id: id,
          type: ['Basic', 'LineBreak'],
          data: { type: 'Record', val: {} }
        }
      };
    }
  };

  p._internal.helpers = {
    // Redux access
    getCanvasWf: getCanvasWf,
    getReduxState: getReduxState,
    getStores: getStores,
    // Immutable conversion
    toJS: toJS,
    // DOM tree
    getRoot: getRoot,
    walkTree: walkTree,
    findNodeById: findNodeById,
    findNodeByIdInTree: findNodeByIdInTree,
    // StyleBlocks (cache TTL 1s)
    getStyleBlocks: getStyleBlocks,
    // Misc
    uuid: uuid,
    wrap: wrap,
    banner: banner,
    errors: ERRORS
  };

  console.log(banner('CoreHelpers', 'helpers exposed via __webflowHelper._internal.helpers'));
})();

/**
 * CodeEmbed — HtmlEmbed read/write via Redux + WebSocket.
 *
 * Cmds: listEmbeds, getEmbedContentViaUI, appendHtmlEmbedViaUI, updateEmbedViaUI, renameNode.
 *
 * Persistence (UI save reverse-engineered): socket message `siteData:update` with
 * - actionType=HTML_EMBED_TEXT_SAVED
 * - messageId consumed from MultiplayerStore.state.nextMessageId (hex counter)
 * - 2-4 conditional diffs: embed.meta.html + value, optionally meta.script
 * (Boolean) on flag change OR content.Distinct→"" (mutually exclusive).
 * - ACK arrives on socket events `$siteData:updateSuccess|Error` (matched by messageId).
 *
 * Limitation: rapid-fire < 1s on the same embed may drop saves (server ACK before
 * commit → oldValue mismatch). Workaround: ≥ 1s between pushes on same embed.
 */
(function() {
  'use strict';
  var p = window.__webflowHelper;
  if (!p) return;

  var store = window._webflow;
  if (!store || !store.dispatch || !store.getState) {
    console.log('[CodeEmbed] Redux not available — embed commands disabled');
    return;
  }

  if (!p._localCmd) p._localCmd = {};

  // HELPERS — delegated to __webflowHelper._internal.helpers (core-helpers.js )
  // ============================================================

  // Validate core-helpers loaded — commands below disabled if absent.
  var helpers = p._internal && p._internal.helpers;
  var errors = helpers && helpers.errors;
  if (!helpers) {
    console.log('[CodeEmbed] core-helpers not loaded — embed commands disabled');
    return;
  }

  var toJS = helpers.toJS;
  var getRoot = helpers.getRoot;
  var getStyleBlocksJS = helpers.getStyleBlocks;  // core returns plain JS dict, not Immutable




  // ============================================================
  // COMMANDS
  // ============================================================

  /**
   * List every HtmlEmbed on the current page.
   * @returns {{ ok: boolean, count: number, embeds: Array<{id: string, classes: string[], length: number, preview: string}> }}
   */
  /**
   * List all HtmlEmbeds in the page tree (FAST · Redux walk).
   *
   * ⚠️ STALE WARNING (v3.14.3) : Returned `length` and `preview` come from local
   * AbstractNodeStore Redux which is NOT auto-resynced after a successful
   * `updateEmbedViaUI` on an inComponent embed — only Designer reload F5 refreshes
   * it. For embeds you've just written in-session, use `getEmbedContentViaUI`
   * (slower but ground-truth) to confirm the value reached server-side.
   */
  p._localCmd.listEmbeds = function() {
    // DOM-based (s623 — Designer "next" removed the Redux AbstractNodeStore that
    // the old node-tree walk relied on). HtmlEmbeds render as `.w-embed` divs in
    // the canvas; enumerate them from the DOM. Covers component-internal embeds
    // too (data-wf-id array). ⚠️ `length`/`preview` reflect the RENDERED innerHTML,
    // NOT the source code — enough to identify an embed; read true source via
    // getEmbedContentViaUI.
    var canvas = document.getElementById('site-iframe-next') || document.getElementById('site-iframe');
    var doc = null;
    try { doc = canvas && canvas.contentDocument; } catch (e) { doc = null; }
    if (!doc || !doc.body) return { ok: false, error: 'No canvas DOM — Designer not loaded?' };

    var els = doc.querySelectorAll('.w-embed');
    var embeds = [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var wid = el.getAttribute('data-w-id');
      var inComponent = false;
      try {
        var arr = JSON.parse(el.getAttribute('data-wf-id') || '[]');
        if (Array.isArray(arr) && arr.length) {
          if (!wid) wid = arr[0];        // component-internal embed: data-w-id absent
          inComponent = arr.length > 1;
        }
      } catch (e) {}
      // design classes only (drop Webflow built-ins like w-embed/w-script)
      var classes = (el.className || '').toString().split(/\s+/).filter(function(c) { return c && c.indexOf('w-') !== 0; });
      var inner = el.innerHTML || '';
      embeds.push({
        id: wid,
        classes: classes,
        length: inner.length,
        preview: inner.replace(/\s+/g, ' ').trim().substring(0, 120),
        inComponent: inComponent
      });
    }
    return { ok: true, count: embeds.length, embeds: embeds, source: 'dom_canvas' };
  };

  /**
   * Read the full content of an embed via UI scrape (SLOW · 100% reliable · ground truth).
   *
   * Workflow (~3-4s native, ~4-5s for inComponent):
   *   1. Deselect (canvas body.click)
   *   2. If embed is nested in Component → double-click instance to enter component view
   *   3. Click embed in canvas (data-w-id native, or data-wf-id*= for component-nested)
   *   4. Click "Settings" tab
   *   5. Click "Open Code Editor" button
   *   6. Read content via OFFICIAL CodeMirror v6 EditorView API :
   *      `cmContent.cmTile.view.state.doc.toString()` — bypasses DOM virtualization
   *      (the alternative .cm-line walk would miss virtualized lines for embeds >~3K chars).
   *      This is exactly what Webflow stores server-side.
   *   7. Click modal close X (read-only, no Save → no "unsaved" prompt)
   *   8. Exit component view if entered
   *
   * v3.24.0 (s572) : devient l'UNIQUE voie de lecture d'embed exposée publiquement.
   * L'ancienne voie Redux SYNC `getEmbedContent` a été supprimée (retournait `value: ""`
   * faux négatif sur certains embeds non vides quand le state Redux était désynchronisé
   * — trop trompeur en audit). Toutes les lectures d'embeds passent désormais par ce
   * chemin UI scrape, ce qui ajoute ~3-4s par lecture mais garantit la véracité. Le
   * suffixe `ViaUI` reste pour signaler la méthode et le coût perf (cohérent avec
   * `updateEmbedViaUI`, `appendHtmlEmbedViaUI`, `addClassViaUI`, etc.).
   *
   * @param {object} args
   * @param {string} args.embedId
   * @param {object} [args.waitMs] Override per-step delays
   * @returns {Promise<object>} `{ ok, id, value, length, lines_read, inComponent, componentInstanceId, durationMs, source: 'codemirror_ui_scrape', error? }`
   *
   * @see docs/lessons/webflow-helper.md §getembedcontentviaui-workflow — empirical workflow
   */
  p._localCmd.getEmbedContentViaUI = async function(args) {
    args = args || {};
    var embedId = args.embedId;
    var waitMs = args.waitMs || {};

    if (!embedId) return { ok: false, error: 'embedId required' };

    var DELAYS = {
      afterDeselect: waitMs.afterDeselect || 250,
      afterDblClick: waitMs.afterDblClick || 600,
      afterSelect: waitMs.afterSelect || 500,
      afterSettingsTab: waitMs.afterSettingsTab || 500,
      afterOpenEditor: waitMs.afterOpenEditor || 800,
      afterClose: waitMs.afterClose || 300,
      afterExitComponent: waitMs.afterExitComponent || 250
    };

    function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
    var start = Date.now();

    // 1. Locate canvas iframe
    var canvas = document.getElementById('site-iframe-next') || document.getElementById('site-iframe');
    if (!canvas) return { ok: false, error: 'canvas iframe not found' };
    var canvasDoc = canvas.contentDocument;
    if (!canvasDoc) return { ok: false, error: 'canvas iframe contentDocument not accessible' };

    // 2. Find embed + detect Component nesting
    var embedEl = canvasDoc.querySelector('[data-w-id="' + embedId + '"]');
    var isInComponent = false;
    var componentInstanceId = null;

    if (!embedEl) {
      embedEl = canvasDoc.querySelector('[data-wf-id*="' + embedId + '"]');
      if (!embedEl) return { ok: false, error: 'embed not found in canvas DOM', embedId: embedId };
      try {
        var pathArr = JSON.parse(embedEl.getAttribute('data-wf-id') || '[]');
        if (Array.isArray(pathArr) && pathArr.length > 1) {
          isInComponent = true;
          componentInstanceId = pathArr[0];
        }
      } catch(e) {}
    }

    // 3. Get UiNodeStore for selection check
    var store = window._webflow;
    if (!store || !store.stores || !store.stores.UiNodeStore) {
      return { ok: false, error: 'Webflow store not accessible' };
    }
    var uiNode = store.stores.UiNodeStore;

    // 4. Pre-check : modal already open ?
    var existingModal = document.querySelector('[data-automation-id="code-embed-editor-modal"]');
    if (existingModal) {
      return {
        ok: false,
        error: 'a code editor modal is already open — close it manually before calling getEmbedContentViaUI',
        embedId: embedId
      };
    }

    try {
      // STEP 1: Deselect (clean state)
      canvasDoc.body.click();
      await wait(DELAYS.afterDeselect);

      // STEP 2: Enter component view if needed
      if (isInComponent) {
        var instanceEl = canvasDoc.querySelector('[data-w-id="' + componentInstanceId + '"]');
        if (!instanceEl) return { ok: false, error: 'component instance not found: ' + componentInstanceId };
        var rect = instanceEl.getBoundingClientRect();
        var x = rect.left + rect.width / 2;
        var y = rect.top + Math.min(rect.height / 2, 40);
        instanceEl.click();
        await wait(150);
        instanceEl.dispatchEvent(new MouseEvent('dblclick', {
          view: canvas.contentWindow,
          bubbles: true, cancelable: true,
          clientX: x, clientY: y, button: 0, detail: 2
        }));
        await wait(DELAYS.afterDblClick);
      }

      // STEP 3: Click embed
      embedEl.click();
      await wait(DELAYS.afterSelect);

      if (uiNode.state.selectedNodeNativeId !== embedId) {
        return {
          ok: false,
          error: 'embed selection failed',
          selectedNode: uiNode.state.selectedNodeNativeId,
          expectedNode: embedId
        };
      }

      // STEP 4: Click Settings tab
      var settingsTab = document.querySelector('[data-automation-id="right-sidebar-settings-tab-link"]');
      if (!settingsTab) return { ok: false, error: 'Settings tab not found' };
      settingsTab.click();
      await wait(DELAYS.afterSettingsTab);

      // STEP 5: Click Open Code Editor
      var openBtn = document.querySelector('button[data-automation-id="OpenCodeEditor"]');
      if (!openBtn) return { ok: false, error: 'OpenCodeEditor button not found (settings panel did not render?)' };
      openBtn.click();
      await wait(DELAYS.afterOpenEditor);

      // STEP 6: Read CodeMirror content via OFFICIAL CodeMirror v6 EditorView API
      // (cmContent.cmTile.view.state.doc.toString() — bypasses DOM virtualization entirely).
      // .cm-line walk would miss virtualized lines for large embeds (>~3K chars).
      var cmContent = document.querySelector('.cm-content');
      if (!cmContent) return { ok: false, error: 'CodeMirror .cm-content not present (modal did not mount?)' };
      var cmTile = cmContent.cmTile;
      if (!cmTile || !cmTile.view || !cmTile.view.state || !cmTile.view.state.doc) {
        return { ok: false, error: 'CodeMirror EditorView/state.doc not accessible via cmContent.cmTile.view' };
      }
      var cmText = cmTile.view.state.doc.toString();
      var lineCount = cmTile.view.state.doc.lines;

      // STEP 7: Close modal (read-only — no Save, no dirty state, no prompt)
      var closeBtn = document.querySelector('[data-automation-id="modal-close-button"]');
      if (closeBtn) {
        closeBtn.click();
      } else {
        // Fallback : Escape key
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
      }
      await wait(DELAYS.afterClose);

      // STEP 8: Exit component view if entered
      if (isInComponent) {
        canvasDoc.body.click();
        await wait(DELAYS.afterExitComponent);
      }

      return {
        ok: true,
        id: embedId,
        value: cmText,
        length: cmText.length,
        line_count: lineCount,
        inComponent: isInComponent,
        componentInstanceId: componentInstanceId,
        durationMs: Date.now() - start,
        source: 'codemirror_editorview_api'
      };
    } catch (e) {
      return {
        ok: false,
        error: 'exception during workflow: ' + (e.message || String(e)),
        embedId: embedId,
        inComponent: isInComponent,
        durationMs: Date.now() - start
      };
    }
  };

  /**
   * Update an HtmlEmbed via UI automation — alternative to `updateEmbed`
   * resilient to Webflow's WebSocket spec drift.
   *
   * Workflow (auto-detects native vs Component instance via data-wf-id PATH):
   *   1. Deselect (canvas body.click)
   *   2. If embed is nested in a Component instance → double-click instance to enter component view
   *   3. Click embed in canvas (data-w-id native, or data-wf-id*= for component-nested)
   *   4. Click "Settings" tab (if Style tab is active)
   *   5. Click "Open Code Editor" button (data-automation-id="OpenCodeEditor")
   *   6. Focus .cm-content (CodeMirror v6), selectAll, dispatch paste event with new content
   *   6.5 [v3.14.3] Verify paste via CodeMirror .cm-line walk (ground truth — what
   *       gets sent to server). Replaces post-save Redux read which was unreliable
   *       for inComponent embeds (store not auto-resynced).
   *   7. Click "Save & Close" button
   *   8. (Component only) Exit component view via body.click
   *
   * @param {object} args
   * @param {string} args.embedId
   * @param {string} args.content                Max ~50K chars (CodeMirror paste handles large fine, server-side limit applies)
   * @param {object} [args.waitMs]               Override per-step delays (afterDeselect, afterDblClick, afterSelect, afterSettingsTab, afterOpenEditor, afterPaste, afterSave, afterExitComponent)
   * @returns {Promise<object>} `{ ok, success, embedId, expectedLength, actualLength, delta, inComponent, componentInstanceId, durationMs, error? }`
   *
   * @see docs/lessons/webflow-helper.md §updateembedviaui-workflow — reverse-engineered selectors + edge cases (session s547)
   */
  p._localCmd.updateEmbedViaUI = async function(args) {
    args = args || {};
    var embedId = args.embedId;
    var content = args.content;
    var waitMs = args.waitMs || {};

    if (!embedId) return { ok: false, error: 'embedId required' };
    if (typeof content !== 'string') return { ok: false, error: 'content (string) required' };

    // [v3.10.0] Tracking for fingerprint fallback resolution
    var resolvedBy = null;
    var originalEmbedId = embedId;

    // [v3.10.0] Extract a stable signature from content : 1st significant line
    // (skipped : empty, pure decorative === / ─, comment delimiters alone).
    // Used to recover the current embed ID when the caller's stored ID is stale
    // (Webflow auto-regenerates embed IDs on delete+recreate, refactor to Component, etc.)
    function extractFingerprint(html) {
      if (!html || typeof html !== 'string') return null;
      var lines = html.split('\n');
      for (var i = 0; i < Math.min(lines.length, 20); i++) {
        var line = lines[i].trim();
        if (!line) continue;
        line = line.replace(/^(<!--|\/\/|\/\*|\*)+\s*/, '').replace(/\s*(-->|\*\/)$/, '').trim();
        if (!line) continue;
        if (/^[=\-─━_*\s]+$/.test(line)) continue; // pure decorative line
        if (line.length < 8) continue;
        return line.substring(0, 80);
      }
      return null;
    }

    var DELAYS = {
      afterDeselect: waitMs.afterDeselect || 250,
      afterDblClick: waitMs.afterDblClick || 600,
      afterSelect: waitMs.afterSelect || 500,
      afterSettingsTab: waitMs.afterSettingsTab || 500,
      afterOpenEditor: waitMs.afterOpenEditor || 800,
      afterPaste: waitMs.afterPaste || 400,
      afterSave: waitMs.afterSave || 3000,
      afterExitComponent: waitMs.afterExitComponent || 250
    };

    function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
    var start = Date.now();

    // 1. Locate canvas iframe (Webflow renders 'site-iframe-next' in current versions)
    var canvas = document.getElementById('site-iframe-next') || document.getElementById('site-iframe');
    if (!canvas) return { ok: false, error: 'canvas iframe not found' };
    var canvasDoc = canvas.contentDocument;
    if (!canvasDoc) return { ok: false, error: 'canvas iframe contentDocument not accessible' };

    // 2. Find embed element + detect Component nesting via data-wf-id PATH
    var embedEl = canvasDoc.querySelector('[data-w-id="' + embedId + '"]');
    var isInComponent = false;
    var componentInstanceId = null;

    if (!embedEl) {
      embedEl = canvasDoc.querySelector('[data-wf-id*="' + embedId + '"]');

      // [v3.10.0] Fingerprint fallback : si pas trouvé par ID, match by content signature
      if (!embedEl) {
        var fp = extractFingerprint(content);
        if (fp) {
          var allEmbedsResult = p._localCmd.listEmbeds();
          if (allEmbedsResult && allEmbedsResult.ok) {
            var matches = allEmbedsResult.embeds.filter(function(e) {
              var theirFp = extractFingerprint(e.preview);
              return theirFp && theirFp.toLowerCase() === fp.toLowerCase();
            });
            if (matches.length === 1) {
              embedId = matches[0].id;
              resolvedBy = 'signature';
              embedEl = canvasDoc.querySelector('[data-w-id="' + embedId + '"]')
                     || canvasDoc.querySelector('[data-wf-id*="' + embedId + '"]');
            } else if (matches.length > 1) {
              return {
                ok: false,
                error: 'embed not found by ID; fingerprint matched ' + matches.length + ' embeds (ambiguous)',
                embedId: originalEmbedId,
                fingerprint: fp,
                candidates: matches.map(function(m) {
                  return { id: m.id, preview: m.preview.substring(0, 60) };
                })
              };
            }
          }
        }
        if (!embedEl) {
          return {
            ok: false,
            error: 'embed not found in canvas DOM (fingerprint fallback ' + (fp ? 'no match' : 'no fingerprint extractable') + ')',
            embedId: originalEmbedId,
            fingerprint: fp
          };
        }
      }
      try {
        var path = JSON.parse(embedEl.getAttribute('data-wf-id') || '[]');
        if (Array.isArray(path) && path.length > 1) {
          isInComponent = true;
          componentInstanceId = path[0];
        }
      } catch(e) {}
    }

    // 3. Get UiNodeStore for selection verification
    var store = window._webflow;
    if (!store || !store.stores || !store.stores.UiNodeStore) {
      return { ok: false, error: 'Webflow store not accessible' };
    }
    var uiNode = store.stores.UiNodeStore;

    // STEP 1: Deselect (clean state)
    canvasDoc.body.click();
    await wait(DELAYS.afterDeselect);

    // STEP 2: Enter component view (Component case only)
    if (isInComponent) {
      var instanceEl = canvasDoc.querySelector('[data-w-id="' + componentInstanceId + '"]');
      if (!instanceEl) return { ok: false, error: 'component instance not found: ' + componentInstanceId };
      var rect = instanceEl.getBoundingClientRect();
      var x = rect.left + rect.width / 2;
      var y = rect.top + Math.min(rect.height / 2, 40);
      instanceEl.click();
      await wait(150);
      instanceEl.dispatchEvent(new MouseEvent('dblclick', {
        view: canvas.contentWindow,
        bubbles: true, cancelable: true,
        clientX: x, clientY: y, button: 0, detail: 2
      }));
      await wait(DELAYS.afterDblClick);
    }

    // STEP 3: Click embed in canvas
    embedEl.click();
    await wait(DELAYS.afterSelect);

    if (uiNode.state.selectedNodeNativeId !== embedId) {
      return {
        ok: false,
        error: 'embed selection failed',
        selectedNode: uiNode.state.selectedNodeNativeId,
        expectedNode: embedId
      };
    }

    // STEP 4: Click Settings tab
    var settingsTab = document.querySelector('[data-automation-id="right-sidebar-settings-tab-link"]');
    if (!settingsTab) return { ok: false, error: 'Settings tab not found' };
    settingsTab.click();
    await wait(DELAYS.afterSettingsTab);

    // STEP 5: Click Open Code Editor
    var openBtn = document.querySelector('button[data-automation-id="OpenCodeEditor"]');
    if (!openBtn) return { ok: false, error: 'OpenCodeEditor button not found (settings panel did not render?)' };
    openBtn.click();
    await wait(DELAYS.afterOpenEditor);

    // STEP 6: Paste content via ClipboardEvent on .cm-content (CodeMirror v6 contenteditable)
    var cmContent = document.querySelector('.cm-content');
    if (!cmContent) return { ok: false, error: 'CodeMirror .cm-content not present (modal did not mount?)' };
    cmContent.focus();
    var sel = document.getSelection();
    var range = document.createRange();
    range.selectNodeContents(cmContent);
    sel.removeAllRanges();
    sel.addRange(range);
    var dt = new DataTransfer();
    dt.setData('text/plain', content);
    cmContent.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await wait(DELAYS.afterPaste);

    // STEP 6.5 [v3.14.3]: PRE-SAVE GROUND TRUTH VERIFY via CodeMirror EditorView API
    // Le Redux store local n'est PAS resync après save UI sur embed inComponent
    // (validé empirique : actualLength reste = ancien content dans Redux malgré save serveur réussi).
    // → on vérifie que le paste a bien atterri dans CodeMirror AVANT de cliquer Save & Close.
    // Lecture via `cmContent.cmTile.view.state.doc.toString()` = API officielle CodeMirror v6,
    // bypasses DOM virtualization (le .cm-line walk manque les lignes virtualisées pour embeds >~3K).
    // CodeMirror est exactement ce que Webflow va envoyer au server → ground truth fiable.
    // Tolérance ±2 chars pour le trailing `\n` strip CodeMirror.
    var cmTilePostPaste = cmContent.cmTile;
    if (!cmTilePostPaste || !cmTilePostPaste.view || !cmTilePostPaste.view.state || !cmTilePostPaste.view.state.doc) {
      return {
        ok: false,
        success: false,
        embedId: embedId,
        error: 'CodeMirror EditorView/state.doc not accessible via cmContent.cmTile.view (paste verify impossible)',
        inComponent: isInComponent,
        componentInstanceId: componentInstanceId,
        durationMs: Date.now() - start
      };
    }
    var cmTextPostPaste = cmTilePostPaste.view.state.doc.toString();
    var pasteVerifyOk = (cmTextPostPaste.length === content.length) || (Math.abs(cmTextPostPaste.length - content.length) <= 2);
    if (!pasteVerifyOk) {
      return {
        ok: false,
        success: false,
        embedId: embedId,
        expectedLength: content.length,
        cmVerifiedLength: cmTextPostPaste.length,
        delta: content.length - cmTextPostPaste.length,
        inComponent: isInComponent,
        componentInstanceId: componentInstanceId,
        durationMs: Date.now() - start,
        error: 'paste verification failed in CodeMirror (expected ' + content.length + ' chars, got ' + cmTextPostPaste.length + ')',
        verify_source: 'codemirror_pre_save'
      };
    }

    // STEP 7: Click Save & Close (text-based since no data-automation-id on this button)
    var saveCloseBtn = Array.from(document.querySelectorAll('button')).find(function(b) {
      return (b.textContent || '').trim() === 'Save & Close';
    });
    if (!saveCloseBtn) return { ok: false, error: 'Save & Close button not found' };
    saveCloseBtn.click();
    await wait(DELAYS.afterSave);

    // STEP 8: Exit component view if entered (clean state for chained calls)
    if (isInComponent) {
      canvasDoc.body.click();
      await wait(DELAYS.afterExitComponent);
    }

    // [v3.14.3] Success based on STEP 6.5 pre-save CodeMirror verify (ground truth).
    // Redux post-save read is unreliable on inComponent (canon §gotcha-redux-stale-inComponent).
    // For guaranteed-fresh re-read post-save, caller can use `getEmbedContentViaUI`.
    var result = {
      ok: true,
      success: true,
      embedId: embedId,
      expectedLength: content.length,
      cmVerifiedLength: cmTextPostPaste.length,
      delta: content.length - cmTextPostPaste.length,
      inComponent: isInComponent,
      componentInstanceId: componentInstanceId,
      durationMs: Date.now() - start,
      verify_source: 'codemirror_pre_save'
    };
    // [v3.10.0] Signal fingerprint resolution so caller can sync its source file
    if (resolvedBy) {
      result.resolved_by = resolvedBy;
      result.old_id = originalEmbedId;
      result.new_id = embedId;
    }
    return result;
  };

  /**
   * Create a new HtmlEmbed via UI automation (Add panel + Code Editor paste + Save).
   *
   * Webflow workflow auto-orchestré (7 steps · ~5-8s) :
   *   1. Deselect (canvas body.click)
   *   2. Click parent in canvas (data-w-id) → sélection parent
   *   3. Open Add panel if not already open (data-automation-id="left-sidebar-add-button")
   *   4. Click HtmlEmbed component (data-automation-id="add-tab-HtmlEmbed")
   *      → embed créé AUTO + modal Code Editor ouvert AUTO + nouvel embed sélectionné
   *   5. Capture new embedId via selectedNodeNativeId
   *   6. Paste content via .cm-content + ClipboardEvent
   *   7. Click "Save & Close"
   *   8. Validate via getEmbedContentViaUI
   *
   * Le flag `w-script` est auto-posé par Webflow au Save UI quand le content contient
   * `<script>` (validé empirique s547) — pas besoin d'appel setEmbedHasScript séparé.
   *
   * @param {object} args
   * @param {string} args.parentId               id du parent (canvas data-w-id ou native id Webflow)
   * @param {string} args.content                content HTML à coller dans le nouvel embed
   * @param {object} [args.waitMs]               override per-step delays (afterDeselect, afterSelectParent, afterOpenAddPanel, afterClickEmbed, afterPaste, afterSave)
   * @returns {Promise<object>} `{ ok, success, embedId, parentId, expectedLength, actualLength, delta, durationMs, error? }`
   *
   * @see docs/lessons/webflow-helper.md §appendhtmlembedviaui-workflow
   */
  p._localCmd.appendHtmlEmbedViaUI = async function(args) {
    args = args || {};
    var parentId = args.parentId;
    var content = args.content;
    var waitMs = args.waitMs || {};

    if (!parentId) return { ok: false, error: 'parentId required' };
    if (typeof content !== 'string') return { ok: false, error: 'content (string) required' };

    var DELAYS = {
      afterDeselect: waitMs.afterDeselect || 250,
      afterSelectParent: waitMs.afterSelectParent || 500,
      afterOpenAddPanel: waitMs.afterOpenAddPanel || 500,
      afterClickEmbed: waitMs.afterClickEmbed || 800,
      afterPaste: waitMs.afterPaste || 400,
      afterSave: waitMs.afterSave || 3000
    };

    function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
    var start = Date.now();

    // 1. Locate canvas iframe
    var canvas = document.getElementById('site-iframe-next') || document.getElementById('site-iframe');
    if (!canvas) return { ok: false, error: 'canvas iframe not found' };
    var canvasDoc = canvas.contentDocument;
    if (!canvasDoc) return { ok: false, error: 'canvas iframe contentDocument not accessible' };

    var store = window._webflow;
    if (!store || !store.stores || !store.stores.UiNodeStore) {
      return { ok: false, error: 'Webflow store not accessible' };
    }
    var uiNode = store.stores.UiNodeStore;

    // STEP 1: Deselect (clean state)
    canvasDoc.body.click();
    await wait(DELAYS.afterDeselect);

    // STEP 2: Select parent in canvas
    var parentEl = canvasDoc.querySelector('[data-w-id="' + parentId + '"]');
    if (!parentEl) {
      // Try data-wf-id PATH for Component case
      parentEl = canvasDoc.querySelector('[data-wf-id*="' + parentId + '"]');
      if (!parentEl) return { ok: false, error: 'parent not found in canvas: ' + parentId };
    }
    parentEl.click();
    await wait(DELAYS.afterSelectParent);

    if (uiNode.state.selectedNodeNativeId !== parentId) {
      return {
        ok: false,
        error: 'parent selection failed',
        selectedNode: uiNode.state.selectedNodeNativeId,
        expectedNode: parentId
      };
    }

    // STEP 3: Open Add panel if not already open
    var embedComp = document.querySelector('[data-automation-id="add-tab-HtmlEmbed"]');
    if (!embedComp) {
      var addBtn = document.querySelector('[data-automation-id="left-sidebar-add-button"]');
      if (!addBtn) return { ok: false, error: 'Add panel button not found' };
      addBtn.click();
      await wait(DELAYS.afterOpenAddPanel);
      embedComp = document.querySelector('[data-automation-id="add-tab-HtmlEmbed"]');
      if (!embedComp) return { ok: false, error: 'add-tab-HtmlEmbed component not visible after opening Add panel' };
    }

    // STEP 4: Click HtmlEmbed component — creates embed AUTO + opens modal AUTO + selects new embed
    embedComp.click();
    await wait(DELAYS.afterClickEmbed);

    // STEP 5: Capture new embedId via selection state (Webflow auto-selects the new node)
    var newEmbedId = uiNode.state.selectedNodeNativeId;
    if (!newEmbedId || newEmbedId === parentId) {
      return { ok: false, error: 'no new embed selected after Add click', selectedNode: newEmbedId };
    }

    // STEP 6: Paste content via ClipboardEvent on .cm-content
    var cmContent = document.querySelector('.cm-content');
    if (!cmContent) return { ok: false, error: 'CodeMirror modal did not open auto', newEmbedId: newEmbedId };

    cmContent.focus();
    var sel = document.getSelection();
    var range = document.createRange();
    range.selectNodeContents(cmContent);
    sel.removeAllRanges();
    sel.addRange(range);
    var dt = new DataTransfer();
    dt.setData('text/plain', content);
    cmContent.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await wait(DELAYS.afterPaste);

    // STEP 7: Click Save & Close
    var saveCloseBtn = Array.from(document.querySelectorAll('button')).find(function(b) {
      return (b.textContent || '').trim() === 'Save & Close';
    });
    if (!saveCloseBtn) return { ok: false, error: 'Save & Close button not found', newEmbedId: newEmbedId };
    saveCloseBtn.click();
    await wait(DELAYS.afterSave);

    // STEP 8: Validate via getEmbedContentViaUI (unique voie de lecture depuis v3.24.0 · async)
    var verify = await p._localCmd.getEmbedContentViaUI({ embedId: newEmbedId });
    var success = !!(verify && verify.ok && verify.value === content);

    return {
      ok: success,
      success: success,
      embedId: newEmbedId,
      parentId: parentId,
      expectedLength: content.length,
      actualLength: verify && verify.length,
      delta: content.length - ((verify && verify.length) || 0),
      durationMs: Date.now() - start,
      error: success ? undefined : 'content verification mismatch after save (expected ' + content.length + ' chars, got ' + (verify && verify.length) + ')',
      verify_ok: !!(verify && verify.ok)
    };
  };

  /**
   * Rename a node (HtmlEmbed, DIV, Section, etc.) via 3 Redux dispatches.
   *
   * Reverse-engineered empirically session s547 : le rename UI Navigator déclenche
   * 3 actions Redux séquentielles qui modifient le state + dispatchent le frame
   * `siteData:update` (`expressionDiff` type `updateMeta` + `metadataDiffs`).
   * Aucune dépendance à un workflow UI complexe (pas de double-clic Navigator,
   * pas de localisation de tree row React).
   *
   * Actions Redux dispatchées :
   *   1. RENAME_TRIGGERED { source: 'navigator', trigger: 'double-click' }
   *      → ouvre l'input rename dans le Navigator (input visible focused)
   *   2. ELEMENT_RENAMED { newName, source: 'navigator', trigger: 'double-click' }
   *      → set le nouveau nom dans le state (utilise selectedNodeNativeId comme cible)
   *   3. FLUSH_RENAME_TRIGGERED {}
   *      → envoie le frame siteData:update au server (persistance)
   *
   * + Enter key dispatch sur l'input actif pour fermer le mode édition UI proprement
   *   (le save server-side a déjà eu lieu à FLUSH — c'est juste cleanup visuel).
   *
   * Marche sur n'importe quel type de node, pas seulement HtmlEmbed.
   *
   * @param {object} args
   * @param {string} args.nodeId               native id du node à renommer (canvas data-w-id ou Webflow native id)
   * @param {string} args.newName              nouveau nom du node
   * @param {object} [args.waitMs]             override per-step delays
   * @returns {Promise<object>} `{ ok, success, nodeId, newName, durationMs, error? }`
   *
   * @see docs/lessons/webflow-helper.md §cluster-rename
   */
  p._localCmd.renameNode = async function(args) {
    args = args || {};
    var nodeId = args.nodeId;
    var newName = args.newName;
    var waitMs = args.waitMs || {};

    if (!nodeId) return { ok: false, error: 'nodeId required' };
    if (typeof newName !== 'string') return { ok: false, error: 'newName (string) required' };
    if (!newName.trim()) return { ok: false, error: 'newName cannot be empty' };

    var DELAYS = {
      afterDeselect: waitMs.afterDeselect || 250,
      afterSelect: waitMs.afterSelect || 500,
      afterRenameTriggered: waitMs.afterRenameTriggered || 100,
      afterElementRenamed: waitMs.afterElementRenamed || 100,
      afterFlush: waitMs.afterFlush || 1500,
      afterEnterCleanup: waitMs.afterEnterCleanup || 300
    };

    function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
    var start = Date.now();

    // 1. Locate canvas iframe
    var canvas = document.getElementById('site-iframe-next') || document.getElementById('site-iframe');
    if (!canvas) return { ok: false, error: 'canvas iframe not found' };
    var canvasDoc = canvas.contentDocument;
    if (!canvasDoc) return { ok: false, error: 'canvas iframe contentDocument not accessible' };

    var webflowStore = window._webflow;
    if (!webflowStore || !webflowStore.dispatch) return { ok: false, error: 'Webflow store/dispatch not accessible' };
    var uiNode = webflowStore.stores && webflowStore.stores.UiNodeStore;
    if (!uiNode) return { ok: false, error: 'UiNodeStore not accessible' };

    // STEP 1: Deselect (clean state)
    canvasDoc.body.click();
    await wait(DELAYS.afterDeselect);

    // STEP 2: Select target node in canvas (canvas click triggers NODE_CLICKED → selection)
    var targetEl = canvasDoc.querySelector('[data-w-id="' + nodeId + '"]');
    if (!targetEl) {
      // Try data-wf-id PATH for Component-nested nodes
      targetEl = canvasDoc.querySelector('[data-wf-id*="' + nodeId + '"]');
      if (!targetEl) return { ok: false, error: 'node not found in canvas: ' + nodeId };
    }
    targetEl.click();
    await wait(DELAYS.afterSelect);

    if (uiNode.state.selectedNodeNativeId !== nodeId) {
      return {
        ok: false,
        error: 'node selection failed',
        selectedNode: uiNode.state.selectedNodeNativeId,
        expectedNode: nodeId
      };
    }

    // STEP 3: Dispatch RENAME_TRIGGERED → opens rename input in Navigator
    webflowStore.dispatch({type: 'RENAME_TRIGGERED', payload: {source: 'navigator', trigger: 'double-click'}});
    await wait(DELAYS.afterRenameTriggered);

    // STEP 4: Dispatch ELEMENT_RENAMED → sets new name in state (uses current selection)
    webflowStore.dispatch({type: 'ELEMENT_RENAMED', payload: {newName: newName, source: 'navigator', trigger: 'double-click'}});
    await wait(DELAYS.afterElementRenamed);

    // STEP 5: Dispatch FLUSH_RENAME_TRIGGERED → sends siteData:update frame to server
    webflowStore.dispatch({type: 'FLUSH_RENAME_TRIGGERED', payload: {}});
    await wait(DELAYS.afterFlush);

    // STEP 6: UI cleanup — dispatch Enter key on the active input to close edit mode
    // (server save already happened at FLUSH; this just closes the visible input)
    var activeInput = document.activeElement;
    if (activeInput && activeInput.tagName === 'INPUT') {
      ['keydown', 'keypress', 'keyup'].forEach(function(type) {
        activeInput.dispatchEvent(new KeyboardEvent(type, {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
          bubbles: true, cancelable: true
        }));
      });
      await wait(DELAYS.afterEnterCleanup);
    }

    // STEP 7: Validate via Navigator DOM
    var treeView = document.querySelector('[data-automation-id="tree-view-container"]');
    var domHasName = treeView ? treeView.textContent.includes(newName) : false;

    return {
      ok: domHasName,
      success: domHasName,
      nodeId: nodeId,
      newName: newName,
      durationMs: Date.now() - start,
      error: domHasName ? undefined : 'new name not found in Navigator DOM after rename'
    };
  };

  console.log('[CodeEmbed] 5 commands registered: listEmbeds, getEmbedContentViaUI, appendHtmlEmbedViaUI, updateEmbedViaUI, renameNode.');
})();

/**
 * Page Switch — `__webflowHelper.switchPage`. Workaround for MCP
 * `de_page_tool.switch_page` which timeouts ~70% of the time empirically.
 */
(function() {
  'use strict';

  if (!window.__webflowHelper || !window.__webflowHelper._localCmd) {
    console.log('[PageSwitch] __webflowHelper not initialized — module skipped');
    return;
  }

  var p = window.__webflowHelper;
  var helpers = p._internal && p._internal.helpers;
  var errors = helpers.errors;
  if (!helpers) {
    console.log('[PageSwitch] core-helpers not loaded — module skipped');
    return;
  }

  function getCanvasWindow() {
    // helpers.getStores() returns stores from the canvas iframe — we need the window for creators.
    var iframe = document.getElementById('site-iframe-next') ||
                 document.getElementById('site-iframe') ||
                 document.querySelector('iframe[src*="webflow.io"]');
    return iframe ? iframe.contentWindow : null;
  }

  function findPageRecord(stores, pageId) {
    // v3.30.0 (s591) : cherche dans staticPages + dynamicPages (Collection Pages
    // detail_*) + componentPages. Le thunk creators.switchPage accepte un record
    // dynamique (validé empirique s591 sur template detail_blog).
    var ps = stores && stores.PageStore && stores.PageStore.state;
    if (!ps || !ps.get) return null;
    var sources = ['staticPages', 'dynamicPages', 'componentPages'];
    for (var i = 0; i < sources.length; i++) {
      var coll = ps.get(sources[i]);
      if (coll && coll.find) {
        var rec = coll.find(function(p) { return p && p.get && p.get('id') === pageId; });
        if (rec) return rec;
      }
    }
    return null;
  }

  function getCurrentPageId(stores) {
    var ds = stores && stores.DesignerStore && stores.DesignerStore.state;
    return ds && ds.get ? ds.get('currentPageId') : null;
  }

  // ============================================================
  // SwitchPage cooldown enforcement
  // ============================================================
  //
  // Webflow Designer needs ~2s for stores+tree to converge after a page switch.
  // Calling switchPage repeatedly < 2000ms apart causes queryElements to return
  // STALE data from the previous page (the tree cache is pre-switch).
  //
  // Pattern observed empirically: an audit batch of 13 pages with wait_ms 600
  // returned inconsistent anchors (e.g. Mariage anchor=brunch instead of mariage).
  //
  // Hard reject — no keyword bypass. Re-entrant sub-calls bypass automatically
  // via _inFlightDepth (internal sub-call already in a controlled queue).
  //
  // Caller responsibility: `await new Promise(r => setTimeout(r, 2000))` between
  // two consecutive switchPage calls. No silent batching.
  // ============================================================
  var _lastSwitchAt = 0;
  var SWITCH_COOLDOWN_MS = 2000;

  /**
   * Switch the Designer to another static page using the canvas window's
   * `PageActionCreators.switchPage` thunk, then poll `DesignerStore.currentPageId`
   * until convergence. Workaround for MCP `de_page_tool.switch_page` which times
   * out ~70% of the time empirically.
   *
   * Cooldown : 2s between two top-level calls (re-entrant sub-calls bypass).
   *
   * @param {object} args
   * @param {string} args.page_id
   * @param {number} [args.wait_ms=3000]  Maximum polling duration.
   * @param {boolean} [args.strict=true]  Currently informational only.
   * @returns {Promise<object>} `{ ok, before, after, switched, duration_ms }` on
   *   success ; `{ ok: false, error, ... }` otherwise.
   */
  p._localCmd.switchPage = async function(args) {
    var startTs = Date.now();
    args = args || {};
    var pageId = args.page_id;
    var waitMs = typeof args.wait_ms === 'number' ? args.wait_ms : 3000;
    var strict = args.strict !== false;

    // Cooldown enforcement (top-level calls only — re-entrant sub-calls bypass).
    var inFlightDepth = (p._internal && p._internal.inFlightDepth) || 0;
    if (inFlightDepth === 0 && _lastSwitchAt > 0) {
      var elapsed = Date.now() - _lastSwitchAt;
      if (elapsed < SWITCH_COOLDOWN_MS) {
        var remaining = SWITCH_COOLDOWN_MS - elapsed;
        return {
          ok: false,
          error: errors.SWITCH_COOLDOWN_ACTIVE,
          error_detail: 'Cooldown active: ' + elapsed + 'ms since last switchPage, min ' + SWITCH_COOLDOWN_MS + 'ms required for stores+tree convergence. Add `await new Promise(r => setTimeout(r, ' + remaining + '))` before retry.',
          cooldown_remaining_ms: remaining,
          last_switch_at: _lastSwitchAt,
          mutation_attempted: false
        };
      }
    }

    // Argument validation
    if (!pageId || typeof pageId !== 'string') {
      return {
        ok: false,
        error: errors.INVALID_ARGS,
        message: 'page_id (string) required',
        mutation_attempted: false
      };
    }

    var stores = helpers.getStores();
    if (!stores) {
      return { ok: false, error: errors.NO_STORES, message: 'helpers.getStores() returned null' };
    }

    var before = getCurrentPageId(stores);

    // PRE-WRITE strict checks.
    var pageRecord = findPageRecord(stores, pageId);
    if (!pageRecord) {
      var available = [];
      ['staticPages', 'dynamicPages'].forEach(function(src) {
        var coll = stores.PageStore.state.get(src);
        if (coll) coll.forEach(function(p) {
          if (p && p.get) available.push({ id: p.get('id'), name: p.get('name'), kind: src === 'dynamicPages' ? 'collection' : 'static' });
        });
      });
      return {
        ok: false,
        error: errors.PAGE_NOT_FOUND,
        message: 'page_id "' + pageId + '" not found in PageStore.staticPages|dynamicPages|componentPages',
        available_pages: available.slice(0, 30),
        mutation_attempted: false
      };
    }

    if (before === pageId) {
      return {
        ok: true,
        before: before,
        after: before,
        switched: false,
        message: 'already on target page (no-op)',
        duration_ms: Date.now() - startTs
      };
    }

    // Get the canvas window to access creators.
    var iwin = getCanvasWindow();
    if (!iwin || !iwin._webflow || !iwin._webflow.creators) {
      return {
        ok: false,
        error: errors.NO_CREATORS,
        message: 'iwin._webflow.creators not accessible (Designer not fully loaded)'
      };
    }

    var creators = iwin._webflow.creators.PageActionCreators;
    if (!creators || typeof creators.switchPage !== 'function') {
      return {
        ok: false,
        error: errors.NO_SWITCHPAGE_CREATOR,
        message: 'PageActionCreators.switchPage not found'
      };
    }

    // Call switchPage thunk + await Promise.
    try {
      var promise = creators.switchPage(pageRecord);
      if (promise && typeof promise.then === 'function') {
        await promise;
      }
    } catch (e) {
      return {
        ok: false,
        error: errors.THUNK_REJECTED,
        message: e.message || String(e),
        before: before,
        duration_ms: Date.now() - startTs
      };
    }

    // Polling: confirm that DesignerStore.currentPageId === pageId.
    var pollStart = Date.now();
    var pollInterval = 100;
    var after = before;
    while (Date.now() - pollStart < waitMs) {
      after = getCurrentPageId(stores);
      if (after === pageId) break;
      await new Promise(function(r) { setTimeout(r, pollInterval); });
    }

    var success = after === pageId;
    var result = {
      ok: success,
      before: before,
      after: after,
      switched: before !== after,
      duration_ms: Date.now() - startTs
    };

    if (!success) {
      result.error = 'strict_switch_not_converged';
      result.message = 'After ' + waitMs + 'ms wait, currentPageId=' + after + ' (expected ' + pageId + '). Possible queue conflict or async race.';
    } else {
      // Stamp last successful switch for cooldown enforcement.
      _lastSwitchAt = Date.now();
    }

    return result;
  };

  console.log('[PageSwitch] 1 command registered: switchPage (cooldown 2000ms enforced)');
})();

/**
 * PageInfo — `getCurrentPage` (internal) + `getCurrentPageInfo` (public).
 *
 * Reads page-level state from SiteDataStore + DesignerStore + PageStore plus
 * the DOM `top-bar-page-name` for 3-source concordance check (DOM / URL / Redux).
 * Used by /webflow-preflight Phase 4 as final guard before any build/edit.
 *
 * Why kept in the helper :
 *   - MCP `de_page_tool.get_current_page` returns only the Redux pageId,
 *     not the 3-source check. Plus 76% empirical timeout in the MCP path.
 *   - `getCurrentPageInfo.source.concordant === true` proves Designer DOM
 *     and Redux agree on the visible page before any mutation.
 */
(function() {
  'use strict';

  if (!window.__webflowHelper || !window.__webflowHelper._localCmd) {
    console.log('[PageInfo] __webflowHelper not initialized — module skipped');
    return;
  }

  var p = window.__webflowHelper;
  var helpers = p._internal && p._internal.helpers;
  if (!helpers) {
    console.log('[PageInfo] core-helpers not loaded — module skipped');
    return;
  }

  // Local helpers (not exposed via _internal.helpers — only used here).

  function safeCall(fn, fallback, errLabel) {
    try { return fn(); }
    catch (e) {
      if (errLabel) console.warn('[PageInfo ' + errLabel + '] ' + (e && e.message || e));
      return fallback;
    }
  }

  function getBody() {
    var root = helpers.getRoot();
    if (!root) return null;
    var children = root.get('children');
    if (children && children.first) return children.first();
    return null;
  }

  // Look up a page by id in PageStore.staticPages | dynamicPages | componentPages.
  function lookupPageInPageStore(pageId) {
    if (!pageId) return null;
    var state = helpers.getReduxState();
    var ps = state && state.PageStore;
    if (!ps || !ps.get) return null;
    var sources = ['staticPages', 'dynamicPages', 'componentPages'];
    for (var i = 0; i < sources.length; i++) {
      var collection = ps.get(sources[i]);
      if (!collection) continue;
      var arr;
      if (collection.toJS) {
        var j = collection.toJS();
        arr = Array.isArray(j) ? j : Object.values(j);
      } else if (Array.isArray(collection)) {
        arr = collection;
      } else {
        arr = Object.values(collection);
      }
      for (var k = 0; k < arr.length; k++) {
        var page = arr[k];
        if (page && page.id === pageId) return { page: page, source: sources[i] };
      }
    }
    return null;
  }

  // 3-source page detection (DOM authority over Redux/URL).
  // Webflow Designer is an SPA — Redux SiteDataStore.pageId can be stale after
  // a switch_page internal nav. The DOM `top-bar-page-name` always reflects the
  // visible page. URL pageId is usually fresh but no guarantee.
  function readPageSource(page) {
    var dom_pageName = null;
    try {
      var el = document.querySelector('[data-automation-id="top-bar-page-name"]');
      dom_pageName = el ? (el.dataset.pageName || (el.textContent || '').trim() || null) : null;
    } catch (e) { /* ignore */ }

    var url_pageId = null;
    try {
      var search = (window.location && window.location.search) || '';
      var match = search.match(/[?&]pageId=([a-f0-9]+)/i);
      url_pageId = match ? match[1] : null;
    } catch (e) { /* ignore */ }

    var redux_pageId = page ? page.id : null;
    var redux_pageName = page ? page.pageName : null;

    var domMatchesRedux = (dom_pageName == null || redux_pageName == null) ? null : (dom_pageName === redux_pageName);
    var urlMatchesRedux = (url_pageId == null || redux_pageId == null) ? null : (url_pageId === redux_pageId);

    var concordant, authority;
    if (domMatchesRedux === null && urlMatchesRedux === null) {
      concordant = null; authority = 'unknown';
    } else if (domMatchesRedux === false && urlMatchesRedux === false) {
      concordant = false; authority = 'all_dissent';
    } else if (domMatchesRedux === false) {
      concordant = false; authority = 'dom_dissents';
    } else if (urlMatchesRedux === false) {
      concordant = false; authority = 'url_dissents';
    } else {
      concordant = true; authority = 'concordant';
    }

    return {
      dom_pageName: dom_pageName,
      url_pageId: url_pageId,
      redux_pageId: redux_pageId,
      concordant: concordant,
      authority: authority
    };
  }

  function computePageWarning(source, page) {
    if (source.concordant === true) return null;
    if (source.concordant === null) {
      return 'Cannot validate page source: DOM top-bar element or URL pageId missing (Designer not fully loaded?).';
    }
    var pageName = (page && page.pageName) || '<unknown>';
    if (source.authority === 'dom_dissents') {
      return 'Redux SiteDataStore stale: Redux says "' + pageName + '" (id ' + source.redux_pageId + '), but DOM top-bar says "' + source.dom_pageName + '". Likely cause: post-switch_page internal nav (UI moved, Redux did not follow). Use de_page_tool.switch_page to resync, or trust DOM as authoritative for visible-page identification.';
    }
    if (source.authority === 'url_dissents') {
      return 'URL pageId stale: "' + source.url_pageId + '" but Redux+DOM agree on "' + pageName + '" (id ' + source.redux_pageId + '). Likely cause: SPA nav without pushState. Non-critical (Redux+DOM authoritative).';
    }
    if (source.authority === 'all_dissent') {
      return 'All 3 sources discordant: DOM="' + source.dom_pageName + '", URL=' + source.url_pageId + ', Redux="' + pageName + '" (id ' + source.redux_pageId + '). Reload Designer required.';
    }
    return null;
  }

  // Internal cmd — used by getCurrentPageInfo. Not in the public whitelist.
  // Reads DesignerStore.currentPageId first (synced by switchPage thunk), falls
  // back to SiteDataStore.pageId (initial load before any switch).
  p._localCmd.getCurrentPage = function() {
    return safeCall(function() {
      var stores = helpers.getStores();
      var pageId = null;
      var ds = stores.DesignerStore;
      if (ds && ds.state && typeof ds.state.get === 'function') {
        pageId = ds.state.get('currentPageId');
      }
      if (!pageId) {
        var sds = stores.SiteDataStore;
        if (!sds || !sds.state) return null;
        pageId = sds.state.pageId;
      }
      if (!pageId) return null;
      var info = lookupPageInPageStore(pageId);
      if (!info) return null;
      var pageData = info.page;
      var pageType = info.source === 'dynamicPages' ? 'DynamicPage' :
                     info.source === 'componentPages' ? 'ComponentPage' : 'Page';
      var parentId = pageData.parentId || null;
      if (parentId === '__ROOT__') parentId = null;
      var parentName = null, parentSlug = null;
      if (parentId) {
        var parentInfo = lookupPageInPageStore(parentId);
        if (parentInfo && parentInfo.page) {
          parentName = parentInfo.page.name || null;
          parentSlug = parentInfo.page.slug || null;
        }
      }
      return {
        id: pageId,
        pageName: pageData.name || null,
        slug: pageData.slug || '',
        pageParentId: parentId,
        pageParentName: parentName,
        pageParentSlug: parentSlug,
        description: pageData.description || '',
        title: pageData.seoTitle || '',
        pageKind: pageData.pageKind || 'static',
        isHomepage: !!pageData.isHome,
        pageType: pageType,
        isDraft: !!pageData.draft
      };
    }, null, 'getCurrentPage');
  };

  // Public cmd — page meta + counts in 1 call + 3-source concordance check.
  p._localCmd.getCurrentPageInfo = function() {
    return safeCall(function() {
      var page = p._localCmd.getCurrentPage();
      var counts = {
        total_elements: 0,
        sections: 0,
        embeds: 0,
        symbols: 0,
        images: 0,
        headings: 0,
        links: 0
      };
      var bodyId = null;
      // DOM-based counts (s623 — Designer "next" removed AbstractNodeStore; the
      // old getBody()/walkTree path returned null). Counts are informational.
      try {
        var cvs = document.getElementById('site-iframe-next') || document.getElementById('site-iframe');
        var cdoc = cvs && cvs.contentDocument;
        if (cdoc && cdoc.body) {
          bodyId = cdoc.body.getAttribute('data-w-id') || null;
          counts.total_elements = cdoc.querySelectorAll('[data-w-id]').length;
          counts.sections = cdoc.querySelectorAll('section').length;
          counts.embeds = cdoc.querySelectorAll('.w-embed').length;
          counts.images = cdoc.querySelectorAll('img').length;
          counts.headings = cdoc.querySelectorAll('h1,h2,h3,h4,h5,h6').length;
          counts.links = cdoc.querySelectorAll('a').length;
          // symbols ≈ component instances: count "instance roots" = elements whose
          // data-wf-id path is DEEPER than the parent's (entering a component
          // context). data-wf-id is an element-id PATH (not [el, instanceId]), so
          // distinct-id counting over-counts wildly; the depth transition is the
          // reliable proxy for "how many component instances on the page".
          var wfDepth = function(el) {
            if (!el) return 0;
            try { var a = JSON.parse(el.getAttribute('data-wf-id') || '[]'); return Array.isArray(a) ? a.length : 0; } catch (e) { return 0; }
          };
          var symbolRoots = 0;
          var wf = cdoc.querySelectorAll('[data-wf-id]');
          for (var wi = 0; wi < wf.length; wi++) {
            if (wfDepth(wf[wi]) > wfDepth(wf[wi].parentElement)) symbolRoots++;
          }
          counts.symbols = symbolRoots;
        }
      } catch (e) { /* DOM unavailable — counts stay 0 */ }
      var source = readPageSource(page);
      var warning = computePageWarning(source, page);
      return { page: page, bodyId: bodyId, counts: counts, source: source, warning: warning };
    }, null, 'getCurrentPageInfo');
  };

  console.log('[PageInfo] 1 public command registered: getCurrentPageInfo (+ getCurrentPage internal)');
})();

/**
 * TreeDump — `dumpTree` returns the full Designer Navigator tree as a flat array
 * with depth + type + tag + id + resolved class names, mirroring what the user
 * sees in the Navigator panel of Webflow Designer.
 *
 * Use case: rapid full-page structure inspection without N MCP query_elements
 * round-trips (which often timeout or BETA-fail). Resolves styleBlockIds → class
 * names via StyleBlockStore (cached TTL 1s by core-helpers).
 *
 * Performance: Redux walk is synchronous, ~50-100ms on a 200-node page. No WS,
 * no Bridge round-trip.
 */
(function() {
  'use strict';

  if (!window.__webflowHelper || !window.__webflowHelper._localCmd) {
    console.log('[TreeDump] __webflowHelper not initialized — skipped');
    return;
  }

  var p = window.__webflowHelper;
  var helpers = p._internal && p._internal.helpers;
  if (!helpers) {
    console.log('[TreeDump] core-helpers not loaded — skipped');
    return;
  }

  // Types whose textContent is meaningful (gather from String descendants).
  var TEXT_BEARING_TYPES = {
    Heading: true, Paragraph: true, TextLink: true, FormButton: true,
    Button: true, Span: true, Link: true, NavbarLink: true, DropdownLink: true,
    NavbarBrand: true, FormBlockLabel: true, Blockquote: true
  };

  // Extract the plain text content of a text-bearing node by walking its
  // descendants and concatenating String values + LineBreak as " ".
  function extractText(node, maxLen) {
    maxLen = maxLen || 200;
    var parts = [];
    function walk(n) {
      if (!n || !n.get) return;
      var t = n.get('type');
      if (t === 'LineBreak') { parts.push(' '); return; }
      // String nodes have type undefined and data.value
      if (!t) {
        var data = n.get('data');
        var val = data && data.get && data.get('value');
        if (typeof val === 'string') { parts.push(val); return; }
      }
      var children = n.get('children');
      if (children && children.forEach) children.forEach(walk);
    }
    walk(node);
    var text = parts.join('').replace(/\s+/g, ' ').trim();
    if (text.length > maxLen) text = text.substring(0, maxLen - 1) + '…';
    return text;
  }

  /**
   * Build a tree entry from a node + depth + context (sbs, opts, parentIndex).
   * Pure function — no side effects.
   *
   * v3.9.0 (s551) — if opts.resolveCombo, also builds `classesResolved` array
   * of `{id, name, isCombo, parentName}` enriched entries alongside the plain
   * `classes` (preserved for back-compat). isCombo derived from parentIndex
   * presence (combo classes have an entry mapping their styleBlockId → parent
   * styleBlockId in StyleBlockStore.parentIndex).
   */
  function buildEntry(node, depth, sbs, opts, parentIndex) {
    var type = node.get && node.get('type');
    var id = node.get && node.get('id');
    var data = node.get && node.get('data');
    var tag = (data && data.get) ? (data.get('tag') || null) : null;

    // classes (plain names) — preserved for back-compat
    var classes = [];
    var classesResolved = null;
    try {
      var sbIds = data && data.get && data.get('styleBlockIds');
      var arr = sbIds && sbIds.toJS ? sbIds.toJS() : (Array.isArray(sbIds) ? sbIds : []);
      classes = arr.map(function(s) { return (sbs && sbs[s] && sbs[s].name) || s; });
      // v3.9.0 — resolveCombo enrichment
      if (opts.resolveCombo) {
        classesResolved = arr.map(function(s) {
          var block = sbs && sbs[s];
          var entry = { id: s, name: (block && block.name) || s };
          var parentId = parentIndex && parentIndex[s];
          if (parentId) {
            entry.isCombo = true;
            entry.parentId = parentId;
            var parentBlock = sbs && sbs[parentId];
            if (parentBlock) entry.parentName = parentBlock.name;
          } else {
            entry.isCombo = false;
          }
          return entry;
        });
      }
    } catch (e) { classes = []; classesResolved = null; }

    // attr
    var attr = null;
    if (opts.includeAttr && data && data.get) {
      try {
        var rawAttr = data.get('attr');
        var attrObj = rawAttr && rawAttr.toJS ? rawAttr.toJS() : (rawAttr || {});
        var cleanAttr = {};
        var hasAttr = false;
        Object.keys(attrObj).forEach(function(k) {
          var v = attrObj[k];
          if (v === '' || v === null || v === undefined) return;
          if (k === 'width' && v === 'auto') return;
          if (k === 'height' && v === 'auto') return;
          if (k === 'alt' && v === '__wf_reserved_inherit') { cleanAttr[k] = '<inherit>'; hasAttr = true; return; }
          cleanAttr[k] = v;
          hasAttr = true;
        });
        if (hasAttr) attr = cleanAttr;
      } catch (e) { attr = null; }
    }

    // xattr
    var xattr = null;
    if (opts.includeXattr && data && data.get) {
      try {
        var rawXattr = data.get('xattr');
        var xattrArr = rawXattr && rawXattr.toJS ? rawXattr.toJS() : (Array.isArray(rawXattr) ? rawXattr : []);
        if (xattrArr && xattrArr.length > 0) xattr = xattrArr;
      } catch (e) { xattr = null; }
    }

    // text
    var text = null;
    if (opts.includeText && type && TEXT_BEARING_TYPES[type]) {
      try { var t = extractText(node, 200); if (t) text = t; }
      catch (e) { text = null; }
    }

    // sym info — Symbol instance OR template root
    var symInfo = null;
    if (data && data.get) {
      try {
        var sym = data.get('sym');
        if (sym) {
          var symObj = sym.toJS ? sym.toJS() : sym;
          if (symObj && (symObj.inst || symObj.root || symObj.name)) symInfo = symObj;
        }
      } catch (e) {}
    }

    var entry;
    if (opts.compact) {
      entry = { d: depth, type: type, classes: classes };
      if (classesResolved) entry.classesResolved = classesResolved;
      // v3.16.0 fix : si text extrait (forcé par filterText), le rendre visible
      // dans l'entry compact aussi — permet d'identifier le match sans deuxième call.
      if (text) entry.text = text;
    } else {
      entry = { depth: depth, type: type, tag: tag, id: id, classes: classes };
      if (classesResolved) entry.classesResolved = classesResolved;
      if (attr) entry.attr = attr;
      if (xattr) entry.xattr = xattr;
      if (text) entry.text = text;
      if (symInfo) {
        if (symInfo.inst) entry.componentInstance = symInfo.inst;
        if (symInfo.root === true) {
          entry.componentRoot = true;
          if (symInfo.name) entry.componentName = symInfo.name;
        }
      }
    }
    return { entry: entry, type: type, classes: classes, text: text, symInfo: symInfo };
  }

  /**
   * Dump the Navigator tree.
   * @param {object} [args]
   * @param {number}  [args.maxDepth=50]      Max depth to walk
   * @param {string}  [args.filterType]       Filter to a specific type (e.g. 'Section', 'Block', 'HtmlEmbed', 'Heading')
   * @param {string}  [args.filterClass]      Filter to elements with at least 1 class containing this substring (case-insensitive)
   * @param {string}  [args.filterText]       Filter to text-bearing elements whose text contains this substring (case-insensitive)
   * @param {boolean} [args.includeEmpty=true] Include nodes with no class (e.g. raw containers, body)
   * @param {boolean} [args.compact=false]    Return compact format (depth + type + classes only, no id/tag/attr/text)
   * @param {boolean} [args.includeText=true] Include text content for Heading/Paragraph/TextLink/Button (truncated 200 chars)
   * @param {boolean} [args.includeAttr=true] Include data.attr (HTML id, alt, src, href, width, height, loading) — only non-default values
   * @param {boolean} [args.includeXattr=true] Include data.xattr (custom attributes data-*, role, aria-*) — only if non-empty
   * @param {boolean} [args.expandComponents=false] When a Symbol is found, lookup its template via data.sym.inst and walk it inline as virtual children (depth offset). Each expanded node gets `fromTemplate: <inst-id>`. Template roots (data.sym.root=true) at depth 1 of root tree are NOT skipped from main walk by default (cf hideTemplateRoots).
   * @param {boolean} [args.hideTemplateRoots=false] When expandComponents=true, set this to true to filter out the original template root nodes (depth 1 with sym.root=true) from the main output to avoid duplication. Default false (templates appear both as their root + inline under Symbol instances).
   * @param {boolean} [args.expandSlotOverrides=false] v3.3.0 — Reveal ComponentInstance children nested in slot overrides. When a Symbol instance has `data.sym.overrides[slotPropId]` = array of nodes (typical for slots like `faq_list` in a Section FAQ component), walks those nodes as virtual children with `fromSlotOverride: true`, `slotPropId`, `slotIndex`. Extracts each child's own prop overrides into a `propOverrides: {propId: value}` map (text format `[{data:{value}}]` flattened to string; link/bool kept raw). Read-only. Result includes `slot_overrides: <count>`.
   * @param {string}  [args.rootId]            v1.6.0 — Scope walk to subtree rooted at this node ID (default: body root). Reduces payload 5-10× when working in a known subsection. Returns error if ID not found.
   * @param {boolean} [args.includeParent=true] v3.6.0 — Default true (était false v1.6.0). Adds `parent_id` field to each entry (computed via depth-based stack during walk). Replaces the JS-side `findIndex + walk back` pattern. Only set when not compact. Skipped on virtual nodes from expandComponents. Universal usage: walker générique pour identifier section + variant d'une Image en remontant la chaîne d'ancêtres (au lieu de slice-par-depth qui est cassé par les Symbol expand).
   * @param {boolean} [args.resolveCombo=false] v3.9.0 (s551) — Enrich each entry with `classesResolved: [{id, name, isCombo, parentId?, parentName?}]` alongside the plain `classes` array. Resolves combo classes (10% of names are homonyms in template Phasya, but styleBlockIds are unique). Uses StyleBlockStore.parentIndex (~221 mappings) for O(1) lookup per class. Eliminates the need for MCP `query_elements` style_ids round-trip. ~1ms overhead per node.
   * @returns {{ ok: boolean, count: number, total_walked: number, expanded?: number, direct_children: Array<{id, type, tag, classes, hidden_on_canvas}>, direct_children_count: number, tree: Array, hint?: string, scoped_to?: string, dom_audit?: object, error?: string }}
   *
   * v3.22.0 (s571) `direct_children` + `direct_children_count` : enfants directs du root (depth=1, hors fromTemplate/fromSlotOverride) en tête de retour. Chaque item = {id, type, tag, classes, hidden_on_canvas (display:none inline OR w-condition-invisible OR null si pas dans iframe DOM)}. Skip le pattern caller `tree.filter(parent_id===rootId)` + signale les "hidden on builder" Designer.
   *
   * v1.6.0 hint heuristics: when count===0, the response includes a `hint` field describing the most likely cause (low maxDepth, page not loaded, class spelling, text on non-text-bearing nodes). Empty hint = filter just doesn't match anything.
   */
  // v3.3.0 — walker pour les slot overrides d'une Symbol instance.
  // Webflow stocke les children d'un slot dans `data.sym.overrides[slotPropId]` =
  // array d'objets plain JS (pas Immutable), chacun avec son propre `data.sym.overrides`
  // pour les prop values (text format : `[{data:{value:"..."}}]`).
  // Lecture seule — aucun write/dispatch. Aligné stratégie s548.
  function expandSlotOverridesAt(node, parentDepth, outArr, opts) {
    try {
      var data = node.get && node.get('data');
      if (!data) return 0;
      var sym = data.get && data.get('sym');
      if (!sym) return 0;
      var overrides = sym.get && sym.get('overrides');
      if (!overrides) return 0;
      var overridesJS = overrides.toJS ? overrides.toJS() : overrides;
      if (!overridesJS || typeof overridesJS !== 'object') return 0;

      var count = 0;
      Object.keys(overridesJS).forEach(function(propId) {
        var val = overridesJS[propId];
        // Heuristique slot children : array de nodes plain JS avec data.sym (= ComponentInstance dans le slot).
        if (Array.isArray(val) && val.length > 0 && val[0] && val[0].data && val[0].data.sym) {
          val.forEach(function(childObj, idx) {
            count++;
            var childSym = (childObj.data && childObj.data.sym) || {};
            var childOverrides = childSym.overrides || {};

            // Extraire les prop overrides en map propId → valeur lisible (text/link/bool).
            var propOverridesExtracted = {};
            Object.keys(childOverrides).forEach(function(pid) {
              var pv = childOverrides[pid];
              if (Array.isArray(pv) && pv.length > 0 && pv[0] && pv[0].data && typeof pv[0].data.value === 'string') {
                // Text override format : [{ data: { value: "..." } }]
                propOverridesExtracted[pid] = pv[0].data.value;
              } else {
                // Link/Bool/autre : structure brute conservée pour debug/audit.
                propOverridesExtracted[pid] = pv;
              }
            });

            var virtualEntry;
            if (opts.compact) {
              virtualEntry = { d: parentDepth + 1, type: 'Symbol', classes: [] };
            } else {
              virtualEntry = {
                depth: parentDepth + 1,
                type: 'Symbol',
                tag: null,
                id: childObj.id,
                classes: [],
                componentInstance: childSym.inst,
                fromSlotOverride: true,
                slotPropId: propId,
                slotIndex: idx
              };
              if (Object.keys(propOverridesExtracted).length > 0) {
                virtualEntry.propOverrides = propOverridesExtracted;
              }
            }
            outArr.push(virtualEntry);
          });
        }
      });
      return count;
    } catch (e) {
      return 0;
    }
  }

  // ==========================================================================
  // walkDOMFallback — v3.17.0 (s565)
  // ==========================================================================
  // Fallback walk du DOM iframe canvas quand le Redux walk retourne 0 match.
  // Couvre les cas où l'élément est visible à l'écran mais absent du Redux store :
  //   - Inner text d'un Symbol (ex: liens du Navbar, "Nos prestations")
  //   - CMS binding rendu dynamiquement
  //   - Content injecté par script embed
  //
  // Le walk DOM trouve l'élément + remap au `data-w-id` ancêtre Webflow le plus
  // proche → utilisable pour scrollToElement, select_element, etc.
  //
  // Garde-fous :
  //   - require filterText OU filterClass non-vide (sinon return error)
  //   - limit: 10 par défaut (hard cap pour éviter explosion sur grosses pages)
  //   - text tronqué à 200 chars
  //   - skip child match deeper (on garde le node le plus précis)
  //   - skip whitespace-only matches sur filterText
  //
  // Performance : 1-2ms typique (faster que Redux walk grâce à querySelectorAll)
  // ==========================================================================
  function walkDOMFallback(args, limit) {
    args = args || {};
    var filterTextLower = args.filterText ? String(args.filterText).toLowerCase() : null;
    var filterClassLower = args.filterClass ? String(args.filterClass).toLowerCase() : null;
    limit = typeof limit === 'number' ? limit : 10;

    // Require valid non-empty filter
    var hasValidFilter = (filterTextLower && filterTextLower.length > 0) ||
                         (filterClassLower && filterClassLower.length > 0);
    if (!hasValidFilter) {
      return { ok: false, error: 'fallback_requires_filter',
               message: 'DOM fallback requires non-empty filterText or filterClass' };
    }

    var iframe = document.querySelector('#site-iframe-next');
    if (!iframe) return { ok: false, error: 'canvas_iframe_not_found' };
    var doc;
    try { doc = iframe.contentDocument; }
    catch (e) { return { ok: false, error: 'cross_origin_blocked', message: e.message }; }
    if (!doc || !doc.body) return { ok: false, error: 'iframe_document_unavailable' };

    var t0 = (window.performance && window.performance.now) ? window.performance.now() : Date.now();
    var all = doc.querySelectorAll('body *');
    var walked = 0;
    var matches = [];

    for (var i = 0; i < all.length && matches.length < limit; i++) {
      walked++;
      var el = all[i];
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'NOSCRIPT') continue;

      // filterText : match + skip-child-deeper pour précision
      if (filterTextLower) {
        var txt = (el.textContent || '').toLowerCase();
        if (txt.indexOf(filterTextLower) === -1) continue;
        var childMatchesDeeper = false;
        for (var c = 0; c < el.children.length; c++) {
          if ((el.children[c].textContent || '').toLowerCase().indexOf(filterTextLower) !== -1) {
            childMatchesDeeper = true;
            break;
          }
        }
        if (childMatchesDeeper) continue;
      }

      // filterClass
      if (filterClassLower) {
        var cls = (el.className || '').toString().toLowerCase();
        if (cls.indexOf(filterClassLower) === -1) continue;
      }

      var textPreview = (el.textContent || '').trim().slice(0, 200);
      if (filterTextLower && !textPreview) continue;

      // Find nearest ancestor with data-w-id (Webflow node ID utilisable)
      var ancestor = el;
      var ancestorDataWId = null, ancestorTag = null, ancestorClasses = null;
      while (ancestor && ancestor !== doc.body) {
        var dwid = ancestor.getAttribute('data-w-id');
        if (dwid) {
          ancestorDataWId = dwid;
          ancestorTag = ancestor.tagName;
          ancestorClasses = (ancestor.className || '').toString().slice(0, 80);
          break;
        }
        ancestor = ancestor.parentElement;
      }

      // DOM depth (max 30 pour éviter infinite loop sur cycle improbable)
      var depth = 0, p = el;
      while (p && p !== doc.body && depth < 30) { depth++; p = p.parentElement; }

      matches.push({
        type: 'DOM',
        tag: el.tagName,
        text: textPreview,
        classes: (el.className || '').toString().slice(0, 100).split(/\s+/).filter(Boolean),
        data_w_id: el.getAttribute('data-w-id') || null,
        ancestor_data_w_id: ancestorDataWId,
        ancestor_tag: ancestorTag,
        ancestor_classes: ancestorClasses,
        dom_depth: depth
      });
    }

    var endT = (window.performance && window.performance.now) ? window.performance.now() : Date.now();
    return {
      ok: true,
      source: 'dom_canvas',
      count: matches.length,
      total_walked: walked,
      duration_ms: Math.round(endT - t0),
      tree: matches
    };
  }

  // dumpTree — DOM-canvas tree dump (rewritten s623 for the Designer "next" arch).
  //
  // Webflow's "next" Designer moved the node document OUT of the Redux
  // AbstractNodeStore (now removed) into an internal sync/CRDT + Apollo + React
  // structure that is not cleanly readable from the page. The rendered canvas DOM
  // (#site-iframe-next.contentDocument) remains the stable contract: every design
  // node carries data-w-id + resolved class names + tag + text + DOM hierarchy =
  // exactly what the Navigator shows. This walk reproduces the previous Redux
  // output shape (depth/type/tag/id/classes/text/attr/parent_id/breadcrumb +
  // direct_children/count) from the DOM. Works on BOTH old and new Designer
  // (the canvas DOM exists in both). Class names come pre-resolved (no
  // StyleBlockStore lookup needed) and component instances render inline.
  //
  // Honored params: maxDepth, filterType, filterClass, filterText, includeEmpty,
  // compact, includeText, includeAttr, includeXattr, rootId, includeParent,
  // includeBreadcrumb, resolveCombo (best-effort via the surviving StyleBlockStore).
  // No-op params (kept for back-compat): expandComponents, expandSlotOverrides,
  // hideTemplateRoots — the DOM already contains expanded component internals.
  p._localCmd.dumpTree = function(args) {
    args = args || {};
    var maxDepth = typeof args.maxDepth === 'number' ? args.maxDepth : 50;
    var filterType = args.filterType || null;
    var filterClassLower = args.filterClass ? String(args.filterClass).toLowerCase() : null;
    var filterTextLower = args.filterText ? String(args.filterText).toLowerCase() : null;
    var includeEmpty = args.includeEmpty !== false;
    var compact = args.compact === true;
    var rootIdScope = args.rootId || null;
    var includeParent = args.includeParent !== false;
    var includeBreadcrumb = args.includeBreadcrumb === true;
    var resolveCombo = args.resolveCombo === true;
    var includeText = (args.includeText !== false && !compact) || !!filterTextLower;
    var includeAttr = args.includeAttr !== false && !compact;
    var includeXattr = args.includeXattr !== false && !compact;

    // Canvas DOM = source of truth (see header).
    var canvas = document.getElementById('site-iframe-next') || document.getElementById('site-iframe');
    var doc = null;
    try { doc = canvas && canvas.contentDocument; } catch (e) { doc = null; }
    if (!doc || !doc.body) {
      return { ok: false, error: 'No canvas DOM — Designer not loaded? (#site-iframe-next contentDocument unavailable)' };
    }

    // Root element: rootId-scoped node, else the canvas <body>.
    var rootEl;
    if (rootIdScope) {
      rootEl = doc.querySelector('[data-w-id="' + rootIdScope + '"]');
      if (!rootEl) return { ok: false, error: 'Node not found by id: ' + rootIdScope };
    } else {
      rootEl = doc.body;
    }

    // Optional combo resolution: className -> parentClassName via the surviving
    // StyleBlockStore (getReduxState is canvas-iframe-aware since s623).
    var nameParent = null;
    if (resolveCombo) {
      try {
        var state = helpers.getReduxState();
        var sbStore = state && state.StyleBlockStore;
        if (sbStore && sbStore.get) {
          var blocks = sbStore.get('styleBlocks'); blocks = blocks && blocks.toJS ? blocks.toJS() : blocks;
          var pi = sbStore.get('parentIndex'); pi = pi && pi.toJS ? pi.toJS() : pi;
          if (blocks && pi) {
            nameParent = {};
            Object.keys(pi).forEach(function(childId) {
              var childBlock = blocks[childId];
              var parentBlock = blocks[pi[childId]];
              if (childBlock && childBlock.name) nameParent[childBlock.name] = (parentBlock && parentBlock.name) || true;
            });
          }
        }
      } catch (e) { nameParent = null; }
    }

    var TEXT_BEARING = {
      Heading: true, Paragraph: true, TextLink: true, Link: true, NavbarLink: true,
      Button: true, Span: true, Blockquote: true, ListItem: true, FormBlockLabel: true
    };

    function wfType(el) {
      var tag = el.tagName;
      var rawCls = (el.className && el.className.baseVal != null) ? el.className.baseVal : (el.className || '');
      var cls = ' ' + String(rawCls).toLowerCase() + ' ';
      switch (tag) {
        case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return 'Heading';
        case 'P': return 'Paragraph';
        case 'A':
          if (cls.indexOf(' w-button ') !== -1 || cls.indexOf(' button ') !== -1) return 'Button';
          if (cls.indexOf(' w-nav-link ') !== -1) return 'NavbarLink';
          return 'Link';
        case 'IMG': return 'Image';
        case 'SECTION': return 'Section';
        case 'NAV': return 'Navbar';
        case 'FORM': return 'FormWrapper';
        case 'INPUT': return 'FormTextInput';
        case 'TEXTAREA': return 'FormTextarea';
        case 'SELECT': return 'FormSelect';
        case 'BUTTON': return 'Button';
        case 'UL': case 'OL': return 'List';
        case 'LI': return 'ListItem';
        case 'SPAN': return 'Span';
        case 'BLOCKQUOTE': return 'Blockquote';
        case 'LABEL': return 'FormBlockLabel';
        case 'BODY': return 'Body';
        case 'IFRAME': return 'HtmlEmbed';
        case 'STRONG': return 'Strong';
        case 'EM': return 'Emphasis';
      }
      if (cls.indexOf(' w-dyn-list ') !== -1) return 'CollectionList';
      if (cls.indexOf(' w-dyn-items ') !== -1) return 'CollectionListWrapper';
      if (cls.indexOf(' w-dyn-item ') !== -1) return 'CollectionItem';
      if (cls.indexOf(' w-richtext ') !== -1) return 'RichText';
      if (cls.indexOf(' w-embed ') !== -1) return 'HtmlEmbed';
      if (tag === 'DIV') return 'Block';
      return tag.charAt(0) + tag.slice(1).toLowerCase();
    }

    function classesOf(el) {
      var c = el.className;
      if (c && c.baseVal != null) c = c.baseVal; // SVG elements
      return String(c || '').split(/\s+/).filter(Boolean);
    }

    function componentInstanceOf(el) {
      var raw = el.getAttribute('data-wf-id');
      if (!raw) return null;
      try {
        var arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length > 1) return arr[arr.length - 1];
      } catch (e) {}
      return null;
    }

    var ATTR_KEYS = ['id', 'alt', 'src', 'href', 'width', 'height', 'loading'];
    var out = [];
    var totalWalked = 0;

    // Build + filter one node. Returns {type, classes, emitted} so the walker can
    // track ancestors even for filtered-out nodes (tree shape ≠ output set).
    function pushEntry(el, depth, parentId, ancestors) {
      var wid = el.getAttribute('data-w-id');
      var type = wfType(el);
      var classes = classesOf(el);
      var text = null;
      if (includeText && TEXT_BEARING[type]) {
        var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length > 200) t = t.substring(0, 199) + '…';
        if (t) text = t;
      }

      var entry;
      if (compact) {
        entry = { d: depth, type: type, classes: classes };
        if (text) entry.text = text;
      } else {
        entry = { depth: depth, type: type, tag: el.tagName.toLowerCase(), id: wid, classes: classes };
      }

      if (resolveCombo) {
        entry.classesResolved = classes.map(function(name, i) {
          var r = { name: name };
          if (nameParent && nameParent[name]) {
            r.isCombo = true;
            r.parentName = (nameParent[name] === true ? null : nameParent[name]);
          } else {
            r.isCombo = (i > 0);
          }
          return r;
        });
      }

      if (!compact) {
        if (text) entry.text = text;
        if (includeAttr) {
          var attr = {}, hasAttr = false;
          for (var ai = 0; ai < ATTR_KEYS.length; ai++) {
            var k = ATTR_KEYS[ai], v = el.getAttribute(k);
            if (v == null || v === '') continue;
            if ((k === 'width' || k === 'height') && v === 'auto') continue;
            attr[k] = v; hasAttr = true;
          }
          if (hasAttr) entry.attr = attr;
        }
        if (includeXattr) {
          var xattr = {}, hasX = false, atts = el.attributes;
          for (var xi = 0; xi < atts.length; xi++) {
            var an = atts[xi].name;
            if (an.indexOf('aria-') === 0 || an === 'role' ||
                (an.indexOf('data-') === 0 && an.indexOf('data-w-') !== 0 && an !== 'data-wf-id')) {
              xattr[an] = atts[xi].value; hasX = true;
            }
          }
          if (hasX) entry.xattr = xattr;
        }
        var compInst = componentInstanceOf(el);
        if (compInst) entry.componentInstance = compInst;
        if (includeParent && parentId) entry.parent_id = parentId;
        if (includeBreadcrumb && ancestors.length) {
          entry.breadcrumb = ancestors.map(function(a) {
            return a.classFirst ? a.type + '.' + a.classFirst : a.type;
          }).join(' > ');
        }
      }

      // filters (control output inclusion only, not traversal)
      var pass = true;
      if (filterType && type !== filterType) pass = false;
      else if (filterClassLower && !classes.some(function(c) { return c.toLowerCase().indexOf(filterClassLower) !== -1; })) pass = false;
      else if (filterTextLower && (!text || text.toLowerCase().indexOf(filterTextLower) === -1)) pass = false;
      else if (!includeEmpty && classes.length === 0 && type !== 'Section' && type !== 'Body') pass = false;
      if (pass) out.push(entry);
      return { type: type, classes: classes };
    }

    // DFS. Only elements with data-w-id are emitted (real Webflow nodes); wrapper
    // elements without an id are traversed transparently (depth unchanged) so the
    // emitted depth equals the Navigator depth.
    function walk(el, depth, parentId, ancestors) {
      if (!el || el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'NOSCRIPT') return;
      if (depth > maxDepth) return;
      var wid = el.getAttribute('data-w-id');
      var childDepth = depth, childParent = parentId, childAncestors = ancestors;
      if (wid) {
        totalWalked++;
        var info = pushEntry(el, depth, parentId, ancestors);
        childDepth = depth + 1;
        childParent = wid;
        childAncestors = ancestors.concat([{ type: info.type, classFirst: (info.classes && info.classes[0]) || null }]);
      }
      var kids = el.children;
      for (var i = 0; i < kids.length; i++) walk(kids[i], childDepth, childParent, childAncestors);
    }

    walk(rootEl, 0, null, []);

    var result = { ok: true, count: out.length, total_walked: totalWalked, source: 'dom_canvas', tree: out };
    if (rootIdScope) result.scoped_to = rootIdScope;

    // direct_children: depth-1 nodes (children of root) + hidden_on_canvas flag.
    var depthKey = compact ? 'd' : 'depth';
    var win = doc.defaultView;
    result.direct_children = out.filter(function(e) { return e[depthKey] === 1; }).map(function(e) {
      var id = compact ? null : e.id;
      var item = { id: id, type: e.type, tag: e.tag || null, classes: Array.isArray(e.classes) ? e.classes.join(' ') : '' };
      if (id) {
        try {
          var elx = doc.querySelector('[data-w-id="' + id + '"]');
          if (elx) {
            var cs = win ? win.getComputedStyle(elx) : null;
            item.hidden_on_canvas = (cs && cs.display === 'none') || elx.classList.contains('w-condition-invisible') || false;
          } else {
            item.hidden_on_canvas = null;
          }
        } catch (e2) { item.hidden_on_canvas = null; }
      }
      return item;
    });
    result.direct_children_count = result.direct_children.length;

    // hint for empty results.
    if (out.length === 0) {
      var hasFilter = !!(filterClassLower || filterTextLower || filterType);
      if (hasFilter) {
        result.hint = 'No match (DOM canvas walk · ' + totalWalked + ' nodes) — check spelling/type, '
          + 'or the element may be CMS-empty / hidden / outside the scoped root.';
      } else if (totalWalked < 5) {
        result.hint = 'Canvas nearly empty (' + totalWalked + ' nodes) — Designer may still be loading · bring the Designer tab to front + retry.';
      }
    }

    return result;
  };

  console.log('[TreeDump] 1 command registered: dumpTree');
})();

/**
 * ComboDisambiguation — resolve homonymous combos via Redux parentIndex local walk.
 *
 * Cmds: queryStyleByCombo, dumpComboIndex.
 *
 * Fix gotcha #41 s572 : MCP `style_tool.update_style`/`remove_style` ignore silently
 * `parent_style_names` filter when combo homonyme exists ≥2 occurrences at registry
 * (validé empirique blog filter bar AVG : `update_style is-active parent=blog_radio-filter`
 * → MCP hit `menu_nav-sublink.is-active` (navbar) au lieu de `blog_radio-filter.is-active`).
 *
 * Workflow safe canonique : queryStyleByCombo(chain) → expected_id · MCP update_style ·
 * VERIFY returned_id === expected_id · ROLLBACK si mismatch.
 *
 * @see docs/lessons/webflow-mcp-canon.md §gotchas-table #41
 * @see docs/lessons/webflow-mcp.md §combo-disambiguation-safe-pattern
 * @see COMBO-DISAMBIGUATION-ROADMAP.md
 */
(function() {
  'use strict';

  if (!window.__webflowHelper || !window.__webflowHelper._localCmd) {
    console.log('[ComboDisambiguation] __webflowHelper not initialized — module skipped');
    return;
  }

  var p = window.__webflowHelper;
  var helpers = p._internal && p._internal.helpers;
  if (!helpers) {
    console.log('[ComboDisambiguation] core-helpers not loaded — cmds disabled');
    return;
  }

  // ============================================================
  // Helpers — Immutable.Map OR plain object access (defensive)
  // ============================================================

  function getStyleBlocksAndParentIndex() {
    try {
      var state = helpers.getReduxState();
      var sbStore = state && state.StyleBlockStore;
      if (!sbStore || !sbStore.get) return null;
      var blocks = sbStore.get('styleBlocks');
      var pi = sbStore.get('parentIndex');
      if (!blocks || !pi) return null;
      return { styleBlocks: blocks, parentIndex: pi };
    } catch (e) {
      return null;
    }
  }

  function getName(sb) {
    if (!sb) return null;
    if (typeof sb.get === 'function') return sb.get('name');
    return sb.name || null;
  }

  function getIsCombo(sb) {
    if (!sb) return false;
    if (typeof sb.get === 'function') return !!sb.get('isCombo');
    return !!sb.isCombo;
  }

  function piGet(pi, id) {
    if (!pi) return null;
    if (typeof pi.get === 'function') return pi.get(id);
    return pi[id] || null;
  }

  function sbGet(blocks, id) {
    if (!blocks) return null;
    if (typeof blocks.get === 'function') return blocks.get(id);
    return blocks[id] || null;
  }

  function sbForEach(blocks, fn) {
    if (!blocks) return;
    if (typeof blocks.forEach === 'function') {
      blocks.forEach(function(sb, id) { fn(sb, id); });
    } else {
      Object.keys(blocks).forEach(function(id) { fn(blocks[id], id); });
    }
  }

  function piSize(pi) {
    if (!pi) return 0;
    if (typeof pi.size === 'number') return pi.size;
    return Object.keys(pi).length;
  }

  // ============================================================
  // Helper — resolve full parent chain (innermost first, anti-loop safety)
  // ============================================================

  function resolveParentChain(id, styleBlocks, parentIndex) {
    var chain = [];
    var currentId = id;
    var safety = 10; // combo depth ≥10 = abuse
    while (safety-- > 0) {
      var parentId = piGet(parentIndex, currentId);
      if (!parentId) break;
      var parentBlock = sbGet(styleBlocks, parentId);
      var parentName = getName(parentBlock);
      if (!parentName) break;
      chain.push({ style_id: parentId, name: parentName });
      currentId = parentId;
    }
    return chain;
  }

  // ============================================================
  // Helper — verify a chain matches a given style_id (terminal)
  // chain = [parent_name(s)..., combo_name] (outermost → innermost)
  // ============================================================

  function chainMatches(id, chain, styleBlocks, parentIndex) {
    var targetName = chain[chain.length - 1];
    var sb = sbGet(styleBlocks, id);
    if (getName(sb) !== targetName) return null;

    var parentNames = chain.slice(0, -1).reverse(); // innermost first
    var currentId = id;
    var resolvedParents = [];

    for (var i = 0; i < parentNames.length; i++) {
      var expectedParent = parentNames[i];
      var parentId = piGet(parentIndex, currentId);
      if (!parentId) return null;
      var parentBlock = sbGet(styleBlocks, parentId);
      var parentName = getName(parentBlock);
      if (parentName !== expectedParent) return null;
      resolvedParents.push({ style_id: parentId, name: parentName });
      currentId = parentId;
    }

    return {
      style_id: id,
      name: targetName,
      isCombo: getIsCombo(sb),
      parent_chain: resolvedParents
    };
  }

  // ============================================================
  // CMD: queryStyleByCombo({chain})
  // ============================================================
  // chain = ['parent-name', 'combo-name'] OR ['grandparent', 'parent', 'combo']
  // (outermost → innermost · terminal = the combo to resolve)
  // Returns {ok, chain, found_count, matches, unique_id, ambiguous}
  // ============================================================

  p._localCmd.queryStyleByCombo = function(args) {
    args = args || {};
    var chain = args.chain;
    if (!Array.isArray(chain) || chain.length === 0) {
      return {
        ok: false,
        error: 'invalid_chain',
        message: 'args.chain must be a non-empty array of names (e.g. ["blog_radio-filter", "is-active"])'
      };
    }

    // Sanity: every chain element must be a non-empty string
    for (var i = 0; i < chain.length; i++) {
      if (typeof chain[i] !== 'string' || chain[i].length === 0) {
        return {
          ok: false,
          error: 'invalid_chain_element',
          message: 'chain[' + i + '] must be a non-empty string (got: ' + JSON.stringify(chain[i]) + ')'
        };
      }
    }

    var data = getStyleBlocksAndParentIndex();
    if (!data) {
      return {
        ok: false,
        error: 'redux_unavailable',
        message: 'StyleBlockStore not loaded — Designer not ready or Bridge not active?'
      };
    }

    var styleBlocks = data.styleBlocks;
    var parentIndex = data.parentIndex;
    var targetName = chain[chain.length - 1];
    var matches = [];

    // Walk only style blocks whose name matches the terminal — skip parent-chain check
    // for blocks that can't possibly match (perf win on large registry).
    sbForEach(styleBlocks, function(sb, id) {
      if (getName(sb) !== targetName) return;
      var match = chainMatches(id, chain, styleBlocks, parentIndex);
      if (match) matches.push(match);
    });

    return {
      ok: true,
      chain: chain,
      found_count: matches.length,
      matches: matches,
      unique_id: matches.length === 1 ? matches[0].style_id : null,
      ambiguous: matches.length > 1
    };
  };

  // ============================================================
  // CMD: dumpComboIndex()
  // ============================================================
  // Snapshot Redux : iterate styleBlocks, group by name, keep only
  // names with ≥2 occurrences (= homonymous combos at risk for #41).
  // For each homonymous combo, expose parent chain.
  // Returns {ok, site_id, generated_at, helper_version, total_styles,
  //          combo_names_count, parent_index_size, registry}.
  // ============================================================

  p._localCmd.dumpComboIndex = function() {
    var data = getStyleBlocksAndParentIndex();
    if (!data) {
      return {
        ok: false,
        error: 'redux_unavailable',
        message: 'StyleBlockStore not loaded — Designer not ready or Bridge not active?'
      };
    }

    var styleBlocks = data.styleBlocks;
    var parentIndex = data.parentIndex;

    // Step 1: build name → [entries]
    var byName = {};
    var totalStyles = 0;

    sbForEach(styleBlocks, function(sb, id) {
      totalStyles++;
      var name = getName(sb);
      if (!name) return;
      if (!byName[name]) byName[name] = [];

      var parentChain = resolveParentChain(id, styleBlocks, parentIndex);

      byName[name].push({
        style_id: id,
        name: name,
        isCombo: getIsCombo(sb),
        parent_id: parentChain.length > 0 ? parentChain[0].style_id : null,
        parent_name: parentChain.length > 0 ? parentChain[0].name : null,
        parent_chain: parentChain
      });
    });

    // Step 2: filter to ≥2 occurrences (homonymous = at risk for #41)
    var registry = {};
    var comboNamesCount = 0;
    Object.keys(byName).forEach(function(name) {
      if (byName[name].length >= 2) {
        registry[name] = byName[name];
        comboNamesCount++;
      }
    });

    // Step 3: detect siteId from SiteDataStore (best-effort)
    var siteId = null;
    try {
      var stores = helpers.getStores();
      var sds = stores && stores.SiteDataStore;
      if (sds && sds.state) {
        siteId = sds.state.siteId ||
                 sds.state.site_id ||
                 (sds.state.site && sds.state.site.id) ||
                 null;
      }
    } catch (e) { /* fail-soft, siteId may be null */ }

    return {
      ok: true,
      site_id: siteId,
      generated_at: new Date().toISOString(),
      helper_version: '3.23.0',
      total_styles: totalStyles,
      combo_names_count: comboNamesCount,
      parent_index_size: piSize(parentIndex),
      registry: registry
    };
  };

  console.log('[ComboDisambiguation] 2 commands registered: queryStyleByCombo, dumpComboIndex');
})();

/**
 * Launch Bridge — `__webflowHelper.launchBridgeApp` mounts the Webflow MCP
 * Bridge App via direct dispatch of `EXTENSION_OPEN`. Auto-resolves the appId
 * from `AppsStore.installedApps[*]` so no hard-coded hash needed.
 */
(function() {
  'use strict';

  if (!window.__webflowHelper || !window.__webflowHelper._localCmd) {
    console.log('[LaunchBridge] __webflowHelper not initialized — module skipped');
    return;
  }

  var p = window.__webflowHelper;
  var helpers = p._internal && p._internal.helpers;
  var errors = helpers.errors;

  // Helpers

  function getTopWindow() {
    // Bridge App lives in the TOP window (Designer parent), not the canvas iframe.
    return window;
  }

  function getWfFromTop() {
    var w = getTopWindow();
    return w && w._webflow ? w._webflow : null;
  }

  function isBridgeIframePresent() {
    try {
      var iframes = document.querySelectorAll('iframe');
      for (var i = 0; i < iframes.length; i++) {
        var src = iframes[i].src || '';
        if (src.indexOf('webflow-ext') !== -1) return true;
      }
    } catch (e) {}
    return false;
  }

  // Generic: list installed apps from AppsStore (Immutable-safe).
  function listInstalledApps() {
    var wf = getWfFromTop();
    if (!wf || !wf.stores || !wf.stores.AppsStore) return null;
    var state = wf.stores.AppsStore.state;
    if (!state) return null;
    var apps = null;
    try {
      apps = state.get ? state.get('installedApps') : state.installedApps;
      if (apps && typeof apps.toJS === 'function') apps = apps.toJS();
    } catch (e) { return null; }
    return Array.isArray(apps) ? apps : null;
  }

  // Resolve an installed app by id (exact) or by name (case-insensitive substring,
  // accepts a string or an array of candidate substrings).
  function findApp(matcher) {
    var apps = listInstalledApps();
    if (!apps) return null;
    if (matcher && matcher.appId) {
      return apps.find(function(a) { return a && a.id === matcher.appId; }) || null;
    }
    var names = matcher && matcher.appName;
    if (typeof names === 'string') names = [names];
    if (!Array.isArray(names) || !names.length) return null;
    names = names.map(function(n) { return String(n).toLowerCase(); });
    return apps.find(function(a) {
      var name = (a && (a.name || a.appName || a.displayName) || '').toLowerCase();
      return names.some(function(n) { return name.indexOf(n) !== -1; });
    }) || null;
  }

  // MCP Bridge App (unchanged contract — used by launchBridgeApp).
  function findBridgeApp() {
    return findApp({ appName: ['mcp bridge', 'webflow mcp'] });
  }

  // appId of the currently-mounted Designer Extension iframe (parse `{appId}.webflow-ext.com`),
  // or null if no extension is open. Lets us tell WHICH app is active (isBridgeIframePresent
  // only says "some extension is open").
  function extAppId() {
    try {
      var iframes = document.querySelectorAll('iframe');
      for (var i = 0; i < iframes.length; i++) {
        var m = (iframes[i].src || '').match(/https:\/\/([a-f0-9]+)\.webflow-ext\.com/);
        if (m) return m[1];
      }
    } catch (e) {}
    return null;
  }

  function dispatchExtensionAction(type, payload) {
    var wf = getWfFromTop();
    if (!wf || !wf._dispatch) throw new Error('webflow_dispatch_unavailable');
    return wf._dispatch({ type: type, payload: payload });
  }

  function pollUntil(checkFn, timeoutMs) {
    timeoutMs = typeof timeoutMs === 'number' ? timeoutMs : 3000;
    var start = Date.now();
    return new Promise(function(resolve) {
      function tick() {
        try {
          if (checkFn()) return resolve(true);
        } catch (e) {}
        if (Date.now() - start >= timeoutMs) return resolve(false);
        setTimeout(tick, 100);
      }
      tick();
    });
  }

  /**
   * Reposition the Bridge App floating window via React state dispatch.
   * Works by walking the React fiber tree to find FloatingWindowInner's
   * useState hook for {x, y} and calling its dispatch directly.
   *
   * @param {string|object} position - 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | {x, y}
   * @param {number} [margin=0] - Pixels from the corner (ignored when position is {x, y})
   * @returns {object} {ok, before?, target?, bounds?, error?}
   * @private
   */
  function setBridgeWindowPosition(position, margin) {
    margin = typeof margin === 'number' ? margin : 0;
    var iframe = document.querySelector('iframe[src*="webflow-ext.com"]');
    if (!iframe) return { ok: false, error: 'iframe_not_found' };

    var dragContainer = iframe.parentElement && iframe.parentElement.parentElement;
    if (!dragContainer || !dragContainer.classList || !dragContainer.classList.contains('react-draggable')) {
      return { ok: false, error: 'drag_container_not_found' };
    }

    var fiberKey = Object.keys(dragContainer).find(function(k) {
      return k.indexOf('__reactFiber') === 0 || k.indexOf('__reactInternalInstance') === 0;
    });
    if (!fiberKey) return { ok: false, error: 'react_fiber_not_found' };

    // Walk up to FloatingWindowInner
    var fiber = dragContainer[fiberKey];
    var inner = null;
    var depth = 0;
    while (fiber && depth < 25) {
      var name = fiber.type && (fiber.type.displayName || fiber.type.name);
      if (name === 'FloatingWindowInner') { inner = fiber; break; }
      fiber = fiber.return;
      depth++;
    }
    if (!inner) return { ok: false, error: 'FloatingWindowInner_not_found' };

    // Find position hook (useState containing {x, y})
    var h = inner.memoizedState;
    var positionHook = null;
    while (h) {
      var ms = h.memoizedState;
      if (ms && typeof ms === 'object' && typeof ms.x === 'number' && typeof ms.y === 'number' && !ms.current) {
        positionHook = h;
        break;
      }
      h = h.next;
    }
    if (!positionHook) return { ok: false, error: 'position_hook_not_found' };
    if (!positionHook.queue || !positionHook.queue.dispatch) {
      return { ok: false, error: 'no_dispatch_on_hook' };
    }

    // Bounds: walk fiber to find Draggable (class component with state.x/y)
    var bounds = null;
    var f2 = dragContainer[fiberKey];
    var d2 = 0;
    while (f2 && d2 < 10) {
      if (f2.stateNode && f2.stateNode.state && typeof f2.stateNode.state.x === 'number') {
        bounds = f2.memoizedProps && f2.memoizedProps.bounds;
        break;
      }
      f2 = f2.return;
      d2++;
    }
    if (!bounds) return { ok: false, error: 'bounds_not_found' };

    var before = { x: positionHook.memoizedState.x, y: positionHook.memoizedState.y };
    var target;
    if (typeof position === 'object' && position !== null) {
      target = { x: position.x, y: position.y };
    } else {
      switch (position) {
        case 'bottom-right': target = { x: bounds.right - margin, y: bounds.bottom - margin }; break;
        case 'bottom-left':  target = { x: bounds.left + margin, y: bounds.bottom - margin }; break;
        case 'top-right':    target = { x: bounds.right - margin, y: bounds.top + margin }; break;
        case 'top-left':     target = { x: bounds.left + margin, y: bounds.top + margin }; break;
        default: return { ok: false, error: 'invalid_position', position: position };
      }
    }
    target.x = Math.max(bounds.left, Math.min(bounds.right, target.x));
    target.y = Math.max(bounds.top, Math.min(bounds.bottom, target.y));

    positionHook.queue.dispatch(target);
    return { ok: true, before: before, target: target, bounds: bounds };
  }

  /**
   * Mount the Webflow MCP Bridge App by dispatching `EXTENSION_OPEN` directly.
   * Auto-resolves the appId from `AppsStore.installedApps[*]` so no hard-coded hash
   * is needed. Idempotent : if the iframe is already mounted, returns immediately.
   *
   * @param {object} [args]
   * @param {number}  [args.wait_ms=3000]   Maximum wait for the iframe to appear.
   * @param {boolean} [args.strict=true]    Return `ok:false` if not converged.
   * @param {boolean} [args.minimized=true] Auto-minimize after mount (the open Bridge
   *   window covers the canvas).
   * @param {string|object} [args.position='bottom-left'] Repositioning after mount.
   *   Accepts: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | {x, y}.
   *   **Default 'bottom-left' (v3.28.0)** — l'app couvre le centre du canvas par défaut sinon.
   *   Passer `null` ou `false` pour désactiver (conserve la position React-Draggable courante).
   * @param {number}  [args.position_margin=0] Pixels from corner when position is a string.
   * @returns {Promise<object>}
   */
  p._localCmd.launchBridgeApp = async function(args) {
    var startTs = Date.now();
    args = args || {};
    var waitMs = typeof args.wait_ms === 'number' ? args.wait_ms : 3000;
    var strict = args.strict !== false;
    // Default minimized = true (the open Bridge App window covers the canvas).
    var minimized = args.minimized !== false;
    // Default position = 'bottom-left' (v3.28.0). Pass null/false to disable.
    var requestedPosition = args.position === undefined ? 'bottom-left' : args.position;
    var positionMargin = typeof args.position_margin === 'number' ? args.position_margin : 0;

    // Idempotent: if Bridge is already active, return immediately (option: minimize anyway).
    if (isBridgeIframePresent()) {
      if (minimized) {
        try {
          dispatchExtensionAction('EXTENSION_WINDOW_MODE_TOGGLE', { minimized: true });
        } catch (e) {}
      }
      var posReused = null;
      if (requestedPosition) {
        try { posReused = setBridgeWindowPosition(requestedPosition, positionMargin); } catch (e) { posReused = { ok: false, error: e.message }; }
      }
      return {
        ok: true,
        already_active: true,
        minimized_applied: minimized,
        position_applied: posReused,
        duration_ms: Date.now() - startTs
      };
    }

    // Look up the Bridge App in AppsStore.
    var bridge = findBridgeApp();
    if (!bridge) {
      return {
        ok: false,
        error: errors.NOT_FOUND,
        message: 'Webflow MCP Bridge App not installed on this site (check AppsStore.installedApps)',
        mutation_attempted: false
      };
    }

    if (!bridge.id) {
      return {
        ok: false,
        error: errors.INVALID_ARGS,
        message: 'Bridge App found but no id field',
        bridge_record_keys: Object.keys(bridge),
        mutation_attempted: false
      };
    }

    // Dispatch EXTENSION_OPEN.
    try {
      dispatchExtensionAction('EXTENSION_OPEN', {
        appId: bridge.id,
        dev: false,
        location: 'app panel'
      });
    } catch (e) {
      return {
        ok: false,
        error: errors.DISPATCH_REJECTED,
        message: e.message,
        mutation_attempted: true
      };
    }

    // Polling to confirm the iframe was mounted.
    var converged = await pollUntil(function() {
      return isBridgeIframePresent();
    }, waitMs);

    if (!converged && strict) {
      return {
        ok: false,
        error: errors.NOT_CONVERGED,
        message: 'Bridge iframe not mounted after ' + waitMs + 'ms',
        bridge_app_id: bridge.id,
        mutation_attempted: true
      };
    }

    // Extra ~500ms wait for the auth handshake (idToken fetch + postMessage exchange).
    await new Promise(function(r) { setTimeout(r, 500); });

    // Auto-minimize if requested (default true — the Bridge window covers the canvas).
    var minimize_applied = false;
    if (minimized && converged) {
      try {
        dispatchExtensionAction('EXTENSION_WINDOW_MODE_TOGGLE', { minimized: true });
        minimize_applied = true;
      } catch (e) {}
    }

    // Optional repositioning after mount (uses React fiber + useState hook dispatch).
    // Best-effort: failures here never block the launch result.
    var position_applied = null;
    if (requestedPosition && converged) {
      try {
        position_applied = setBridgeWindowPosition(requestedPosition, positionMargin);
      } catch (e) {
        position_applied = { ok: false, error: 'exception', message: e.message };
      }
    }

    return {
      ok: converged,
      bridge_app_id: bridge.id,
      bridge_app_name: bridge.name,
      iframe_mounted_after_ms: converged ? Date.now() - startTs - 500 : null,
      minimized_applied: minimize_applied,
      position_applied: position_applied,
      duration_ms: Date.now() - startTs,
      note: 'Bridge mounted + handshake assumed complete after 500ms wait'
    };
  };

  /**
   * Mount ANY installed Designer Extension by name or id (generic sibling of
   * launchBridgeApp). Since `EXTENSION_OPEN` is a no-op while another extension is
   * already open, this CLOSES the active one first when it differs from the target.
   * Identifies the active app by parsing the ext iframe src (`{appId}.webflow-ext.com`),
   * so it can tell which app is mounted (not just "some extension").
   *
   * 🚨 Only ONE Designer Extension can be active at a time — opening the target closes
   * whatever was open (e.g. switching to Phasya Style Bridge closes the MCP Bridge).
   *
   * @param {object} args
   * @param {string} [args.appId]    Target app id (exact). Takes precedence over appName.
   * @param {string|string[]} [args.appName] Case-insensitive substring(s) of the app name.
   * @param {number} [args.wait_ms=4000] Max wait for the target iframe to mount.
   * @param {boolean} [args.strict=true] Return ok:false if not converged.
   * @param {string|object} [args.position='bottom-left'] Repositioning after mount: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | {x, y}. **Default 'bottom-left'** (v3.28.0 · l'app couvre le centre par défaut sinon). Passer `null` ou `false` pour désactiver. Best-effort, failures never block the launch result.
   * @param {number} [args.position_margin=0] Pixels from the corner (ignored when position is {x, y}). Default 0 = collé au bord.
   * @returns {Promise<object>}
   */
  p._localCmd.launchApp = async function(args) {
    var startTs = Date.now();
    args = args || {};
    var waitMs = typeof args.wait_ms === 'number' ? args.wait_ms : 4000;
    var strict = args.strict !== false;
    // Default position = 'bottom-left' (v3.28.0). Pass null/false to disable.
    var requestedPosition = args.position === undefined ? 'bottom-left' : args.position;
    var positionMargin = typeof args.position_margin === 'number' ? args.position_margin : 0;
    if (!args.appId && !args.appName) {
      return { ok: false, error: errors.INVALID_ARGS, message: 'launchApp requires { appId } or { appName }' };
    }

    var app = findApp({ appId: args.appId, appName: args.appName });
    if (!app || !app.id) {
      return {
        ok: false,
        error: errors.NOT_FOUND,
        message: 'App not found in AppsStore.installedApps',
        target: { appId: args.appId, appName: args.appName },
        installed: (listInstalledApps() || []).map(function(a) { return { id: a.id, name: a.name || a.appName || a.displayName }; })
      };
    }

    var current = extAppId();
    // Already the right app mounted → idempotent (still try to reposition if requested).
    if (current === app.id) {
      var posReused = null;
      if (requestedPosition) {
        try { posReused = setBridgeWindowPosition(requestedPosition, positionMargin); } catch (e) { posReused = { ok: false, error: 'exception', message: e.message }; }
      }
      return { ok: true, already_active: true, app_id: app.id, app_name: app.name, position_applied: posReused, duration_ms: Date.now() - startTs };
    }

    // A DIFFERENT extension is open → close it first (EXTENSION_OPEN is a no-op otherwise).
    var switchedFrom = current;
    if (current) {
      try { dispatchExtensionAction('EXTENSION_CLOSE', {}); } catch (e) {
        return { ok: false, error: errors.DISPATCH_REJECTED, message: 'EXTENSION_CLOSE failed: ' + e.message, mutation_attempted: true };
      }
      await pollUntil(function() { return extAppId() === null; }, 3000);
    }

    // Open the target.
    try {
      dispatchExtensionAction('EXTENSION_OPEN', { appId: app.id, dev: false, location: 'app panel' });
    } catch (e) {
      return { ok: false, error: errors.DISPATCH_REJECTED, message: 'EXTENSION_OPEN failed: ' + e.message, mutation_attempted: true };
    }

    var converged = await pollUntil(function() { return extAppId() === app.id; }, waitMs);
    if (!converged && strict) {
      return {
        ok: false,
        error: errors.NOT_CONVERGED,
        message: 'Target ext iframe not mounted after ' + waitMs + 'ms',
        app_id: app.id, app_name: app.name, switched_from: switchedFrom, mutation_attempted: true
      };
    }

    // Optional repositioning after mount — uses React fiber + useState hook dispatch.
    // Best-effort: failures here never block the launch result. The selector
    // `iframe[src*="webflow-ext.com"]` matches the newly mounted app iframe whichever
    // app it is (Bridge App, Phasya Style Bridge, or other custom Designer Extension).
    var position_applied = null;
    if (requestedPosition && converged) {
      try {
        position_applied = setBridgeWindowPosition(requestedPosition, positionMargin);
      } catch (e) {
        position_applied = { ok: false, error: 'exception', message: e.message };
      }
    }

    return {
      ok: converged,
      app_id: app.id,
      app_name: app.name,
      switched_from: switchedFrom,
      iframe_mounted_after_ms: converged ? Date.now() - startTs : null,
      position_applied: position_applied,
      duration_ms: Date.now() - startTs,
      note: 'Extension iframe mounted. The app JS may need ~1-2s more to boot before it answers postMessage — retry the first call.'
    };
  };

})();

// ============================================================================
// Filter exposed cmds to whitelist — source of truth = ALLOWED_CMDS array below (28 cmds)
// ============================================================================
// The bundle above registers more cmds in `_localCmd` than the public surface
// (some are internal helpers used between modules above). This filter wraps `run()` so that
// only the whitelisted cmds (ALLOWED_CMDS) are callable via `__webflowHelper.run(name)`.
//
// Whitelisted cmds (9):
// 1. switchPage - MCP de_page_tool.switch_page 70% timeout
// 2. launchBridgeApp - not in MCP
// 3. appendHtmlEmbedViaUI - MCP gap (HtmlEmbed creation via UI automation — v3.0.0 remplace appendHtmlEmbedWS obsolète)
// 4. updateEmbedViaUI - MCP gap (embed content update via UI automation — v2.0.0 remplace updateEmbed obsolète)
// 5. renameNode - MCP gap (node rename via 3 Redux dispatches — v3.1.0)
// 6. listEmbeds - MCP gap (embed list + contents)
// 7. getEmbedContent - MCP gap (single embed content read)
// 8. getCurrentPageInfo - 3-source page concordance check (MCP de_page_tool.get_current_page has 76% timeout + no DOM/URL cross-check)
// 9. dumpTree - full Navigator tree dump with resolved class names (MCP query_elements BETA broken)
// + (v3.25.0 s573) selectNode, openComponentView, closeComponentView — Navigator
//   selection + component-view enter/exit via Redux dispatch (NODE_CLICKED /
//   SYMBOL_NODE_FOCUSED / SYMBOL_NODE_UNFOCUSED). MCP gap: no way to select an
//   arbitrary node (esp. collapsed/intra-component) nor enter a component view.
//   (List above is historical; full set lives in ALLOWED_CMDS array below.)
//
// NOTE v3.0.0 : setEmbedHasScript retirée (redundant — Webflow auto-pose le flag w-script
// au Save UI quand le content contient `<script>`).
//
// Bypass: `window.__webflowHelper._localCmd.X(args)` is still callable for
// debugging or one-off direct access (manual audit trail). The wrapper only
// gates `__webflowHelper.run('X', args)`.
// ============================================================================

/**
 * ComponentProps — UI automation pour overrides de properties sur ComponentInstance.
 *
 * Cmd: setComponentPropsViaUI({nodeId, props, waitMs?})
 *
 * Workflow (v3.4.0 — Vague 1 text-only) :
 * 1. Sélection MCP-equivalent : trouver le node natif dans le DOM canvas via data-w-id,
 *    cliquer pour ouvrir le panel Properties à droite (TOP window).
 * 2. Pour chaque prop dans `props` map :
 *    - Lookup l'input via `[data-automation-id="Type--Plugin_List_<propName>"]`
 *    - Selon `type` : text → React nativeInputValueSetter + input event + blur
 *    - (Vague 2 ajoutera : link, visibility, image, etc.)
 * 3. Retour `{ok, applied: [propName], failed: [{propName, reason}], durationMs}`
 *
 * Notes empiriques s548 :
 * - Le pattern `MouseEvent` direct sur le canvas iframe ne déclenche pas la sélection
 *   Webflow (overlay React intercepte). Workaround : utiliser MCP `element_tool.select_element`
 *   AVANT cette cmd, OU laisser le user pré-sélectionner manuellement.
 * - Le `nativeInputValueSetter` bypass React controlled inputs (validé empirique).
 * - Le commit Redux + WebSocket se fait au `blur` event (pas besoin de Save click).
 *
 * Compatibilité s548 : aucun dispatch Redux write — uniquement events DOM
 * (focus/input/change/blur). Webflow React handler capture et dispatch en interne.
 */
(function() {
  'use strict';

  if (!window.__webflowHelper) return;
  var p = window.__webflowHelper;
  if (!p._localCmd) p._localCmd = {};

  // Sélecteur générique pour les inputs de prop dans le panel Properties.
  // Pattern Webflow Designer : `data-automation-id="Type--Plugin_List_<propName>"`
  // où <propName> est le nom humain de la prop (ex: "Question", "Réponse", "CTA Text").
  function findPropInput(propName) {
    var selector = '[data-automation-id="Type--Plugin_List_' + propName + '"]';
    return document.querySelector(selector);
  }

  // React-compatible input value setter — bypass React controlled inputs.
  // Sans ce pattern, `input.value = "..."` est ignoré silencieusement par React.
  function setReactInputValue(input, value) {
    var proto = input.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    var nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    nativeSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Apply 1 prop override via UI. Returns null on success, error string on failure.
  function applyTextProp(propName, value) {
    var input = findPropInput(propName);
    if (!input) {
      return 'input_not_found (selector: [data-automation-id="Type--Plugin_List_' + propName + '"]) — vérifier que panel Properties est ouvert sur la bonne instance';
    }
    if (input.tagName !== 'INPUT' && input.tagName !== 'TEXTAREA') {
      return 'unexpected_tag: ' + input.tagName + ' (attendu INPUT/TEXTAREA pour type=text)';
    }
    try {
      input.focus();
      setReactInputValue(input, value);
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.blur();
      return null; // success
    } catch (e) {
      return 'error: ' + e.message;
    }
  }

  // v3.5.0 — Link prop : mode=page (via page picker) ou mode=url (input external URL).
  // Le wrapper est scopé à `[data-automation-id="ExpressionEditor-fieldWrapper-<propName>"]`
  // pour éviter ambiguïté avec d'autres props.
  async function applyLinkProp(propName, spec) {
    var wrapper = document.querySelector('[data-automation-id="ExpressionEditor-fieldWrapper-' + propName + '"]');
    if (!wrapper) return 'wrapper_not_found pour prop link "' + propName + '"';

    var mode = spec.mode;
    if (mode !== 'page' && mode !== 'url' && mode !== 'phone' && mode !== 'email') {
      return 'link_mode_not_supported: "' + mode + '" (v3.12.0 supporte mode=page/url/phone/email · section/file à venir)';
    }

    // 1. S'assurer que le Type est correct (click radio si pas déjà actif).
    var typeButtonMap = {
      'page': 'Type--Plugin_Enum_Type_button-page',
      'url': 'Type--Plugin_Enum_Type_button-external',
      'phone': 'Type--Plugin_Enum_Type_button-tel',
      'email': 'Type--Plugin_Enum_Type_button-email'
    };
    var typeButtonId = typeButtonMap[mode];
    var typeBtn = wrapper.querySelector('[data-automation-id="' + typeButtonId + '"]');
    if (!typeBtn) return 'type_button_not_found: ' + typeButtonId;
    if (typeBtn.getAttribute('aria-checked') !== 'true') {
      typeBtn.click();
      await new Promise(function(r) { setTimeout(r, 300); });
    }

    if (mode === 'page') {
      if (!spec.pageSlug || typeof spec.pageSlug !== 'string') {
        return 'invalid_pageSlug (requis pour mode=page, ex: "contact" ou "plateaux-repas" — correspond au data-automation-id "{slug}-page")';
      }
      // 2a. Click sur page-selector-button pour ouvrir le popover
      var selectorBtn = wrapper.querySelector('[data-automation-id="page-selector-button"]');
      if (!selectorBtn) return 'page-selector-button_not_found dans wrapper';
      selectorBtn.click();

      // 3a. Polling jusqu'à 2s pour que le popover affiche l'option (timing peut varier
      // selon la taille du store + re-render React). v3.5.1 patch.
      var pageOption = null;
      var attempts = 0;
      while (!pageOption && attempts < 14) {
        await new Promise(function(r) { setTimeout(r, 150); });
        pageOption = document.querySelector('[data-automation-id="' + spec.pageSlug + '-page"]');
        attempts++;
      }
      if (!pageOption) {
        // Fermer le popover ouvert avant retour erreur
        document.body.click();
        return 'page_option_not_found après ' + (attempts * 150) + 'ms: [data-automation-id="' + spec.pageSlug + '-page"] — vérifier le slug exact du popover (ex: "contact", "plateau-repas", "bar-à-salades" — peut différer du slug retourné par data_pages_tool.list_pages, et préserve les accents Français)';
      }
      pageOption.click();
      await new Promise(function(r) { setTimeout(r, 300); });
      return null; // success
    }

    if (mode === 'url') {
      if (typeof spec.url !== 'string') return 'invalid_url (requis pour mode=url)';
      // 2b. v3.5.2 : sélecteur précis identifié empiriquement.
      var urlInput = wrapper.querySelector('[data-automation-id="Type--Plugin_Text_URL"]');
      if (!urlInput) return 'url_input_not_found (selector: [data-automation-id="Type--Plugin_Text_URL"])';
      urlInput.focus();
      setReactInputValue(urlInput, spec.url);
      urlInput.dispatchEvent(new Event('change', { bubbles: true }));
      urlInput.blur();
      return null;
    }

    if (mode === 'phone' || mode === 'email') {
      // v3.12.0 — Phone/Email link : input + Tab keydown pour commit Redux (validé empirique s552ter sur 8 zones).
      // Sans Tab keydown : Redux stocke {mode:"phone"} sans `to` value (input visible mais pas committé).
      var fieldKey = mode === 'phone' ? 'phone' : 'email';
      var specKey = mode === 'phone' ? 'phone' : 'email';
      var inputSelector = mode === 'phone' ? 'Type--Plugin_Text_Phone' : 'Type--Plugin_Text_Email';
      var valueProvided = spec[specKey];
      // Fallback : accepter aussi `spec.value` ou `spec.to` pour ergonomie
      if (typeof valueProvided !== 'string') valueProvided = spec.value;
      if (typeof valueProvided !== 'string') valueProvided = spec.to;
      if (typeof valueProvided !== 'string') {
        return 'invalid_' + fieldKey + ' (requis pour mode=' + mode + ' : spec.' + specKey + ' ou spec.value ou spec.to · string ' + (mode === 'phone' ? '"+33232540191" format E.164' : '"contact@example.com"') + ')';
      }
      var inp = wrapper.querySelector('[data-automation-id="' + inputSelector + '"]');
      if (!inp) return inputSelector + '_input_not_found';
      inp.focus();
      // Clear any existing value avant set (évite concat)
      setReactInputValue(inp, '');
      await new Promise(function(r) { setTimeout(r, 100); });
      setReactInputValue(inp, valueProvided);
      // Le Tab keydown est essentiel pour commit Redux côté Webflow (validé s552ter).
      // change + blur seul stocke {mode:"phone"} sans `to` value.
      ['keydown', 'keyup'].forEach(function(t) {
        inp.dispatchEvent(new KeyboardEvent(t, {
          key: 'Tab', code: 'Tab', keyCode: 9, which: 9,
          bubbles: true, cancelable: true
        }));
      });
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      inp.blur();
      await new Promise(function(r) { setTimeout(r, 300); });
      return null;
    }

    return 'link_mode_unhandled';
  }

  // v3.12.0 — Variant prop : dropdown select pour Color/Size/etc. (validé empirique s552ter
  // sur 8 zones + 12 services pour Master Button Color Ivoire vs Cardinal).
  // Pattern : click trigger → dropdown s'ouvre → click option [data-automation-id="Type--Plugin_StyleVariant_{propName}-option-{variantId}"]
  //
  // Stratégie click multi-niveau (le click JS natif peut être ignoré par React) :
  //   1. focus option + dispatch keyboard Enter (le pattern qui marche pour radio Webflow)
  //   2. fallback : dispatch click natif avec composedPath
  //   3. fallback : direct option.click()
  //
  // spec.variant peut être :
  //   - 'ivoire' / 'cardinal' / 'grenat' (label human → résolution par textContent)
  //   - 'b387bcc0-2496-4d39-7a0a-daf6a4981c98' (variant ID directe · plus fiable)
  //   - 'base' (default variant)
  async function applyVariantProp(propName, spec) {
    var triggerSelector = '[data-automation-id="Type--Plugin_StyleVariant_' + propName + '"]';
    var trigger = document.querySelector(triggerSelector);
    if (!trigger) return 'trigger_not_found: ' + triggerSelector;

    var requested = spec.variant;
    // Fallback : accepter aussi spec.value pour ergonomie
    if (typeof requested !== 'string') requested = spec.value;
    if (typeof requested !== 'string') return 'invalid_variant (requis : spec.variant ou spec.value · string · label "ivoire" ou variant ID UUID)';

    // 1. Open dropdown
    trigger.click();
    await new Promise(function(r) { setTimeout(r, 400); });

    // 2. Find option — try direct ID match first, fallback to label match
    var allOptions = Array.from(document.querySelectorAll('[data-automation-id^="Type--Plugin_StyleVariant_' + propName + '-option-"]'));
    var option = null;
    var reqLower = requested.toLowerCase();
    for (var i = 0; i < allOptions.length; i++) {
      var opt = allOptions[i];
      var autoId = opt.getAttribute('data-automation-id') || '';
      var label = (opt.textContent || '').trim().toLowerCase();
      // Match by suffix (variant ID) OR by label text
      if (autoId.endsWith('-option-' + requested) || label === reqLower) {
        option = opt;
        break;
      }
    }
    if (!option) {
      // Close dropdown
      document.body.click();
      return 'variant_option_not_found: "' + requested + '" — disponibles: [' + allOptions.map(function(o) { return (o.textContent||'').trim(); }).join(', ') + ']';
    }

    // 3. Try multiple click strategies (React-compatible)
    var initialState = trigger.textContent.trim();
    // Strategy 1: keyboard Enter on focused option (pattern visibility radio)
    try {
      option.focus();
      ['keydown', 'keypress', 'keyup'].forEach(function(t) {
        option.dispatchEvent(new KeyboardEvent(t, {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
          bubbles: true, cancelable: true
        }));
      });
      await new Promise(function(r) { setTimeout(r, 400); });
      if (trigger.textContent.trim() !== initialState) return null;
    } catch (e) { /* fallback */ }

    // Strategy 2: dispatched MouseEvents with composedPath
    try {
      var rect = option.getBoundingClientRect();
      var x = rect.left + rect.width / 2;
      var y = rect.top + rect.height / 2;
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function(t) {
        var Ctor = t.startsWith('pointer') ? PointerEvent : MouseEvent;
        option.dispatchEvent(new Ctor(t, {
          bubbles: true, cancelable: true, view: window,
          clientX: x, clientY: y, button: 0,
          pointerType: t.startsWith('pointer') ? 'mouse' : undefined,
          composed: true
        }));
      });
      await new Promise(function(r) { setTimeout(r, 400); });
      if (trigger.textContent.trim() !== initialState) return null;
    } catch (e) { /* fallback */ }

    // Strategy 3: simple .click()
    try {
      option.click();
      await new Promise(function(r) { setTimeout(r, 400); });
      if (trigger.textContent.trim() !== initialState) return null;
    } catch (e) { /* fallback */ }

    // All strategies failed
    document.body.click(); // close dropdown
    return 'variant_click_failed_react_dropdown — fallback: utiliser mcp__chrome-devtools__click avec uid de take_snapshot · option visible était [data-automation-id="' + option.getAttribute('data-automation-id') + '"]';
  }

  // v3.5.0 — Visibility (boolean) : 2 buttons Visible/Hidden dans le wrapper.
  // v3.5.3 — `btn.click()` natif ignoré par les radio Webflow (validé empirique s549 :
  // Section FAQ Visibility Body, click natif → ok return mais aucune mutation Redux ni DOM).
  // Fix : focus + KeyboardEvent Space (le pattern qui marche).
  function applyVisibilityProp(propName, visible) {
    var wrapper = document.querySelector('[data-automation-id="ExpressionEditor-fieldWrapper-' + propName + '"]');
    if (!wrapper) return 'wrapper_not_found pour prop visibility "' + propName + '"';
    if (typeof visible !== 'boolean') return 'invalid_value (type=visibility requiert boolean)';

    var targetId = visible ? 'visual-radio-button-True' : 'visual-radio-button-False';
    var btn = wrapper.querySelector('[data-automation-id="' + targetId + '"]');
    if (!btn) return 'button_not_found: ' + targetId;
    if (btn.getAttribute('aria-checked') === 'true') {
      // Déjà dans l'état désiré — no-op (mais pas une erreur)
      return null;
    }
    // Pattern keyboard Space (validé empirique s549) :
    // les radio buttons Webflow n'écoutent pas le click natif programmatique,
    // mais réagissent au keyboard Space sur l'élément focused.
    try {
      btn.focus();
      ['keydown', 'keypress', 'keyup'].forEach(function(type) {
        btn.dispatchEvent(new KeyboardEvent(type, {
          key: ' ', code: 'Space', keyCode: 32, which: 32,
          bubbles: true, cancelable: true
        }));
      });
      return null;
    } catch (e) {
      return 'keyboard_dispatch_error: ' + e.message;
    }
  }

  // v3.5.3 — Reset override : revient au default value du component template.
  // Pattern UI : click sur le label de la prop → menu "Reset to default property value"
  // apparaît avec `data-automation-id="component-property-reset"` → click dessus.
  // Le label doit avoir `data-resettable="true"` + `data-origin="local"` (= override actif).
  // Si pas de override actif → no-op (pas une erreur).
  async function applyResetProp(propName) {
    var label = document.querySelector('[data-automation-id="Type--Label_' + propName + '"]');
    if (!label) return 'label_not_found pour prop "' + propName + '" — vérifier que panel Properties est ouvert sur la bonne instance';

    // Si pas de `data-resettable=true` ou `data-origin=local`, pas d'override à reset
    var origin = label.getAttribute('data-origin');
    if (origin !== 'local') {
      return null; // no-op : pas d'override (origin=template/default), pas une erreur
    }

    // Step 1: click sur le label pour ouvrir le menu reset
    label.click();
    await new Promise(function(r) { setTimeout(r, 300); });

    // Step 2: click sur l'item menu reset
    var resetItem = document.querySelector('[data-automation-id="component-property-reset"]');
    if (!resetItem) {
      // Fermer le menu ouvert au cas où
      document.body.click();
      return 'reset_menu_item_not_found après click label';
    }
    resetItem.click();
    await new Promise(function(r) { setTimeout(r, 400); });
    return null;
  }

  p._localCmd.setComponentPropsViaUI = async function(args) {
    args = args || {};
    var startMs = Date.now();
    var props = args.props || {};
    var waitMs = typeof args.waitMs === 'number' ? args.waitMs : 200;

    var applied = [];
    var failed = [];

    // Validation initiale : panel Properties doit être ouvert (instance sélectionnée préalable).
    // v3.25.2 : gate robuste — Webflow a retiré 'componentInstanceProperties' (drift UI s574).
    // Le panel Settings utilise 'propertiesTab-<defId>-settings' ; les props 'ExpressionEditor-fieldWrapper-<name>'.
    // On accepte les 3 (ancien + nouveaux) — le dernier est ce que la cmd manipule réellement.
    var panel = document.querySelector('[data-automation-id="componentInstanceProperties"]')
             || document.querySelector('[data-automation-id^="propertiesTab-"][data-automation-id$="-settings"]')
             || document.querySelector('[data-automation-id^="ExpressionEditor-fieldWrapper-"]');
    if (!panel) {
      return {
        ok: false,
        error: 'panel_not_open',
        message: 'Le panel Properties n\'est pas ouvert. Sélectionner l\'instance via mcp__webflow__element_tool.select_element AVANT cet appel.',
        durationMs: Date.now() - startMs
      };
    }

    // Boucle sur les props demandées
    var propNames = Object.keys(props);
    for (var i = 0; i < propNames.length; i++) {
      var name = propNames[i];
      var spec = props[name];
      if (!spec || typeof spec !== 'object') {
        failed.push({ propName: name, reason: 'invalid_spec (attendu objet {type, value})' });
        continue;
      }

      var type = spec.type;
      var value = spec.value;

      if (type === 'text') {
        if (typeof value !== 'string') {
          failed.push({ propName: name, reason: 'invalid_value (type=text requiert string)' });
          continue;
        }
        var errT = applyTextProp(name, value);
        if (errT) failed.push({ propName: name, reason: errT });
        else applied.push(name);
      } else if (type === 'link') {
        var errL = await applyLinkProp(name, spec);
        if (errL) failed.push({ propName: name, reason: errL });
        else applied.push(name);
      } else if (type === 'visibility') {
        var errV = applyVisibilityProp(name, spec.visible);
        if (errV) failed.push({ propName: name, reason: errV });
        else applied.push(name);
      } else if (type === 'reset') {
        var errR = await applyResetProp(name);
        if (errR) failed.push({ propName: name, reason: errR });
        else applied.push(name);
      } else if (type === 'variant') {
        var errVar = await applyVariantProp(name, spec);
        if (errVar) failed.push({ propName: name, reason: errVar });
        else applied.push(name);
      } else {
        // À venir : image, number, richText, link mode={section|file}
        failed.push({ propName: name, reason: 'type_not_yet_supported: "' + type + '" (v3.12.0 supporte text/link(page,url,phone,email)/visibility/reset/variant · à venir : image/number/richText/link(section,file))' });
      }

      // Petit délai entre props pour éviter race condition React renders
      await new Promise(function(r) { setTimeout(r, waitMs); });
    }

    return {
      ok: failed.length === 0,
      applied: applied,
      failed: failed,
      durationMs: Date.now() - startMs
    };
  };

  console.log('[ComponentProps] 1 command registered: setComponentPropsViaUI (types: text · link[page,url,phone,email] · visibility · reset · variant — v3.12.0)');
})();

/* =========================================================================
 * Cmd: setImageSettings({nodeId, alt?, altCustomText?, loading?, waitMs?})  v3.7.0
 *
 * Workaround structurel pour le gotcha #34 (canon webflow-mcp-canon.md) :
 *   altText "Custom description" sur Image existant = NON-RESET via MCP
 *   (6 routes testées s538 toutes silent-fail).
 *
 * Cette cmd contourne via UI automation pure DOM (sélecteurs data-automation-id
 * stables identifiés empirique s551 sur AVG) :
 *   1. Deselect canvas (body.click)
 *   2. Select image via canvas data-w-id click
 *   3. Open right-sidebar Settings tab
 *   4. Si `alt` : AltTextPluginDropdown → select-option-__wf_reserved_{inherit|decorative}|custom
 *       (+ AltTextPluginInput nativeSetter si alt='custom' avec altCustomText)
 *   5. Si `loading` : Type--Plugin_Enum_Type_menu → menu-option-{lazy|eager|auto}
 *
 * Modes alt :
 *   - 'inherit'     → "Use alt text from asset"   (lit asset.altText configuré au upload)
 *   - 'decorative'  → "Decorative"                (alt="" rendu HTML · pour images décoratives)
 *   - 'custom'      → "Custom description"        (texte custom · requiert altCustomText)
 *
 * Modes loading :
 *   - 'eager'       → loading="eager" rendu HTML  (recommandé pour hero / above-the-fold)
 *   - 'lazy'        → loading="lazy"              (défaut Webflow · images below-the-fold)
 *   - 'auto'        → pas de loading attr         (défaut navigateur)
 *
 * Limites empirique v3.7.0 :
 *   - Images NATIVES uniquement (data-w-id direct). Component instance support : à venir.
 *   - Pas de validation post-save (settings panel update Redux instantanément).
 *
 * Performance attendue : ~2-3s par image (sélection + open settings + 1-2 dropdowns).
 *
 * @see docs/lessons/webflow-helper.md §setimagesettings-workflow (workflow 4 steps · v3.13.0 Enter-key fix)
 * @see docs/lessons/webflow-helper-canon.md §cmds-whitelist (cheat compact 1-line)
 * @see docs/lessons/webflow-mcp-canon.md §cluster-image-asset (gotcha #34 contourné)
 * ========================================================================= */
(function setImageSettingsCmd() {
  if (!window.__webflowHelper || !window.__webflowHelper._localCmd) {
    console.warn('[ImageSettings] __webflowHelper not ready — registration skipped');
    return;
  }
  var p = window.__webflowHelper;

  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  // Apply alt mode (+ optional custom text if mode='custom')
  async function applyAlt(altMode, customText, waitMs) {
    var dd = document.querySelector('[data-automation-id="AltTextPluginDropdown"]');
    if (!dd) return 'AltTextPluginDropdown not found (image settings panel did not render?)';

    var targetOpts = {
      'inherit':    'select-option-__wf_reserved_inherit',
      'decorative': 'select-option-__wf_reserved_decorative',
      'custom':     'select-option-custom'
    };
    var optId = targetOpts[altMode];
    if (!optId) return 'invalid_alt_mode (expected inherit/decorative/custom, got "' + altMode + '")';

    var labels = {
      'inherit':    'Use alt text from asset',
      'decorative': 'Decorative',
      'custom':     'Custom description'
    };
    var alreadySet = (dd.textContent || '').indexOf(labels[altMode]) !== -1;
    if (!alreadySet) {
      dd.click();
      await wait(waitMs);
      var opt = document.querySelector('[data-automation-id="' + optId + '"]');
      if (!opt) return 'option not found: ' + optId;
      opt.click();
      await wait(waitMs);
    }

    // Custom mode + text → set value via React nativeInputValueSetter + Enter commit (v3.13.0 fix)
    // v3.7.0 disposait setter + input + change + blur → texte visible UI mais Redux NON-COMMITÉ.
    // Pattern Enter key séquence repris de helpEditImagesAltInComponent v3.11.0 (validé s552).
    if (altMode === 'custom' && typeof customText === 'string') {
      var input = document.querySelector('[data-automation-id="AltTextPluginInput"]');
      if (!input) return 'AltTextPluginInput not found (custom mode requires input present)';
      input.focus();
      await wait(200);
      var proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(input, customText);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(300);
      // Enter key sequence — required to commit Redux (v3.13.0 fix · v3.7.0 blur seul insuffisant)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      await wait(500);
      input.blur();
      await wait(waitMs);
    }
    return null;
  }

  // Apply loading type (lazy/eager/auto)
  async function applyLoading(loadingMode, waitMs) {
    var menu = document.querySelector('[data-automation-id="Type--Plugin_Enum_Type_menu"]');
    if (!menu) return 'Type--Plugin_Enum_Type_menu not found';
    var labels = { 'lazy': 'Lazy', 'eager': 'Eager', 'auto': 'Auto' };
    var label = labels[loadingMode];
    if (!label) return 'invalid_loading_mode (expected lazy/eager/auto, got "' + loadingMode + '")';

    if ((menu.textContent || '').indexOf(label) !== -1) return null; // already set
    menu.click();
    await wait(waitMs);
    var opt = document.querySelector('[data-automation-id="Type--Plugin_Enum_Type_menu-option-' + loadingMode + '"]');
    if (!opt) return 'loading option not found: ' + loadingMode;
    opt.click();
    await wait(waitMs);
    return null;
  }

  p._localCmd.setImageSettings = async function(args) {
    args = args || {};
    var nodeId = args.nodeId;
    var alt = args.alt;
    var altCustomText = args.altCustomText;
    var loading = args.loading;
    var waitMs = typeof args.waitMs === 'number' ? args.waitMs : 500;

    if (!nodeId) return { ok: false, error: 'nodeId required' };
    if (!alt && !loading) return { ok: false, error: 'no_action (provide alt and/or loading)' };

    var start = Date.now();
    var applied = [];
    var failed = [];

    // 1. Locate canvas iframe
    var canvas = document.getElementById('site-iframe-next') || document.getElementById('site-iframe');
    if (!canvas) return { ok: false, error: 'canvas iframe not found' };
    var canvasDoc = canvas.contentDocument;
    if (!canvasDoc) return { ok: false, error: 'canvas iframe contentDocument not accessible' };

    // 2. Find image element (native page only — Component instance support à venir)
    var imgEl = canvasDoc.querySelector('[data-w-id="' + nodeId + '"]');
    if (!imgEl) {
      return {
        ok: false,
        error: 'image not found in canvas DOM (Component instance support pending v3.8)',
        nodeId: nodeId,
        durationMs: Date.now() - start
      };
    }

    // 3. Deselect + click image
    canvasDoc.body.click();
    await wait(300);
    imgEl.click();
    await wait(600);

    // 4. Open Settings tab
    var settingsTab = document.querySelector('[data-automation-id="right-sidebar-settings-tab-link"]');
    if (!settingsTab) return { ok: false, error: 'Settings tab not found', durationMs: Date.now() - start };
    settingsTab.click();
    await wait(600);

    // 5. Apply alt mode
    if (alt) {
      var altErr = await applyAlt(alt, altCustomText, waitMs);
      if (altErr) failed.push({ action: 'alt', reason: altErr });
      else applied.push('alt:' + alt + (alt === 'custom' && altCustomText ? ' (custom text set)' : ''));
    }

    // 6. Apply loading mode
    if (loading) {
      var loadErr = await applyLoading(loading, waitMs);
      if (loadErr) failed.push({ action: 'loading', reason: loadErr });
      else applied.push('loading:' + loading);
    }

    return {
      ok: failed.length === 0,
      nodeId: nodeId,
      applied: applied,
      failed: failed,
      durationMs: Date.now() - start
    };
  };

  console.log('[ImageSettings] 1 command registered: setImageSettings (alt[inherit/decorative/custom] · loading[lazy/eager/auto] — v3.7.0)');
})();

/**
 * findNodeContext — résolveur structurel pour n'importe quel nodeId Webflow.
 *
 * Cmd: findNodeContext({nodeId})
 *
 * Élimine la friction du gotcha #31 (canon webflow-mcp-canon §cluster-component-instance) :
 * "Element not found" quand un node est dans une ComponentInstance et qu'on essaie un
 * set_style/set_image_asset/etc avec format {component: pageId, element: nodeId}.
 *
 * Retourne pour TOUT nodeId :
 *   - isInComponent          : bool, true si le node est ENFANT d'une ComponentInstance
 *   - isComponentInstance    : bool, true si le node EST lui-même une ComponentInstance (Symbol)
 *   - templateId             : id du Component template (null si native page node)
 *   - instanceId             : id de la Symbol instance sur la page (null si native ou si l'on demande la Symbol elle-même → instanceId = nodeId)
 *   - pageId                 : id de la page courante
 *   - mcpIdFormat            : {component, element} prêt à passer à set_style/set_image_asset/etc.
 *   - openInstanceFormat     : {component, element} prêt à passer à open_component_view (null si pas dans Component)
 *   - note                   : workflow recommandé en 1 phrase
 *
 * Workflow type pour modifier un enfant d'une instance Component :
 *   1. ctx = findNodeContext({nodeId: <child native id>})
 *   2. open_component_view({component_instance_id: ctx.openInstanceFormat})
 *   3. set_image_asset/set_style/etc({id: ctx.mcpIdFormat, ...})
 *   4. close_component_view
 *
 * Performance : ~100ms (1 dumpTree expandComponents + 1 getCurrentPageInfo séquentiels).
 * v3.8.0 (s551).
 */
(function() {
  'use strict';

  if (!window.__webflowHelper) return;
  var p = window.__webflowHelper;
  if (!p._localCmd) p._localCmd = {};

  p._localCmd.findNodeContext = async function(args) {
    args = args || {};
    var nodeId = args.nodeId;
    if (!nodeId || typeof nodeId !== 'string') {
      return { ok: false, error: 'missing_or_invalid_nodeId', got: typeof nodeId };
    }

    // 1. dumpTree avec expandComponents (révèle les enfants des Symbol templates)
    var dump;
    try {
      dump = await p._localCmd.dumpTree({
        maxDepth: 30,
        expandComponents: true,
        compact: false
      });
    } catch (e) {
      return { ok: false, error: 'dumpTree_threw', message: String(e && e.message || e) };
    }
    if (!dump || !dump.ok) {
      return { ok: false, error: 'dumpTree_failed', dump: dump };
    }

    // 2. Page courante
    var pageInfo;
    try {
      pageInfo = await p._localCmd.getCurrentPageInfo();
    } catch (e) {
      pageInfo = null;
    }
    var pageId = pageInfo && pageInfo.page && pageInfo.page.id;

    // 3. Trouve toutes les entries qui matchent le nodeId
    var entries = dump.tree.filter(function(n) { return n.id === nodeId; });
    if (entries.length === 0) {
      return {
        ok: true, found: false, nodeId: nodeId, pageId: pageId,
        message: 'Node not found in dumpTree · check nodeId or wrong page (current: ' + pageId + ')'
      };
    }

    // 4. Cas A : Le node EST une Symbol instance (ComponentInstance)
    var symbolEntry = entries.find(function(n) {
      return n.type === 'Symbol' && n.componentInstance;
    });
    if (symbolEntry) {
      return {
        ok: true,
        found: true,
        nodeId: nodeId,
        isInComponent: false,
        isComponentInstance: true,
        templateId: symbolEntry.componentInstance,
        instanceId: nodeId,
        pageId: pageId,
        mcpIdFormat: { component: pageId, element: nodeId },
        openInstanceFormat: { component: pageId, element: nodeId },
        note: 'Node IS a Symbol instance · open_component_view({component: pageId, element: nodeId}) puis edit children avec {component: templateId, element: childId}'
      };
    }

    // 5. Cas B : Le node est ENFANT d'un Component template (rendered inline via expandComponents)
    var fromTplEntry = entries.find(function(n) { return n.fromTemplate; });
    if (fromTplEntry) {
      var templateId = fromTplEntry.fromTemplate;
      // Cherche la Symbol instance sur la page qui pointe vers ce template
      var instance = dump.tree.find(function(n) {
        return n.type === 'Symbol' && n.componentInstance === templateId;
      });
      var instanceId = instance ? instance.id : null;
      return {
        ok: true,
        found: true,
        nodeId: nodeId,
        isInComponent: true,
        isComponentInstance: false,
        templateId: templateId,
        instanceId: instanceId,
        pageId: pageId,
        mcpIdFormat: { component: templateId, element: nodeId },
        openInstanceFormat: instanceId ? { component: pageId, element: instanceId } : null,
        note: 'Node INSIDE Component template · workflow: open_component_view(openInstanceFormat) → set_X(mcpIdFormat) → close_component_view'
      };
    }

    // 6. Cas C : Native page node (rien de spécial)
    return {
      ok: true,
      found: true,
      nodeId: nodeId,
      isInComponent: false,
      isComponentInstance: false,
      templateId: null,
      instanceId: null,
      pageId: pageId,
      mcpIdFormat: { component: pageId, element: nodeId },
      openInstanceFormat: null,
      note: 'Native page node · use {component: pageId, element: nodeId} directly with set_X / element_tool MCP'
    };
  };

  console.log('[FindNodeContext] 1 command registered: findNodeContext (resolves Component context for any nodeId — v3.8.0)');
})();

/* ===========================================================================
 * Cmd: helpEditImagesAltInComponent({items, waitMs?})  v3.11.0
 *
 * Workflow mecanise pour modifier alt mode de N images DANS un Component template
 * deja ouvert via MCP `de_component_tool.open_component_view`.
 *
 * Cmd a creer pour eliminer la friction identifiee en session s552 :
 *   setImageSettings v3.10.0 echoue sur images de Component instance car son
 *   body.click() initial sort de Component view (silent loss du contexte
 *   data-w-id). Cette cmd skip body.click + skip imgEl.click pre-setup et
 *   suppose le contexte Component view actif (caller responsibility).
 *
 * Workflow caller :
 *   1. mcp__webflow__de_component_tool.open_component_view({...})  ← MCP
 *   2. helper.run('helpEditImagesAltInComponent', {items: [...]})  ← cette cmd
 *   3. mcp__webflow__de_component_tool.close_component_view        ← MCP
 *
 * Items: [{nodeId, altMode: 'inherit'|'decorative'|'custom', altCustomText?}]
 *
 * Differences vs setImageSettings v3.10 :
 * - PAS de body.click au debut (qui fermerait Component view)
 * - Batch de N items (1 call = N images, ~2-3s par image)
 * - Press Enter key apres altCustomText pour commit Redux (validated s552)
 * - Idempotent : si dropdown deja en altMode demande, skip et marque applied
 *
 * Performance attendue : ~2-3s par image (selection + Settings tab + dropdown).
 * ========================================================================= */

(function helpEditImagesAltInComponentCmd() {
  if (!window.__webflowHelper || !window.__webflowHelper._localCmd) {
    console.warn('[HelpEditImagesAltInComponent] __webflowHelper not ready — registration skipped');
    return;
  }
  var p = window.__webflowHelper;

  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  async function applyOne(item, waitMs) {
    var canvas = document.getElementById('site-iframe-next') || document.getElementById('site-iframe');
    if (!canvas) return 'canvas iframe not found';
    var doc = canvas.contentDocument;
    if (!doc) return 'canvas contentDocument not accessible';

    // 1. Locate image — strategie hybride (s552 v3.11.1) :
    //    a) tenter data-w-id direct (rapide MAIS souvent absent tant que l'image n'a pas
    //       ete clickee une fois dans le canvas Designer — pattern Webflow Component view)
    //    b) fallback srcKey si fourni : doc.querySelectorAll('img[src*="srcKey"]')[srcIndex]
    //    Args attendus : {nodeId?, srcKey?, srcIndex?, altMode, altCustomText?}
    var imgEl = item.nodeId ? doc.querySelector('[data-w-id="' + item.nodeId + '"]') : null;
    if (!imgEl && item.srcKey) {
      var allMatches = doc.querySelectorAll('img[src*="' + item.srcKey + '"]');
      var idx = typeof item.srcIndex === 'number' ? item.srcIndex : 0;
      imgEl = allMatches[idx] || null;
    }
    if (!imgEl) {
      return 'image not found (data-w-id "' + (item.nodeId || 'absent') + '" + srcKey "' + (item.srcKey || 'absent') + '" unmatched · Component view open ?)';
    }

    // 2. Click image (NO body.click — stay in Component view)
    var rect = imgEl.getBoundingClientRect();
    imgEl.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true,
      clientX: rect.left + 5, clientY: rect.top + 5, button: 0
    }));
    await wait(waitMs);

    // 3. Open Settings tab (idempotent)
    var settingsTab = document.querySelector('[data-automation-id="right-sidebar-settings-tab-link"]');
    if (settingsTab) {
      settingsTab.click();
      await wait(400);
    }

    // 4. Open AltText dropdown
    var dd = document.querySelector('[data-automation-id="AltTextPluginDropdown"]');
    if (!dd) return 'AltTextPluginDropdown not found (Settings panel not for Image type ?)';

    var altLabels = {
      inherit: 'Use alt text from asset',
      decorative: 'Decorative',
      custom: 'Custom description'
    };
    var altOpts = {
      inherit: 'select-option-__wf_reserved_inherit',
      decorative: 'select-option-__wf_reserved_decorative',
      custom: 'select-option-custom'
    };

    var mode = item.altMode || 'inherit';
    if (!altLabels[mode]) return 'invalid altMode: ' + mode + ' (expected inherit/decorative/custom)';

    var alreadySet = (dd.textContent || '').indexOf(altLabels[mode]) !== -1;
    if (!alreadySet) {
      dd.click();
      await wait(500);
      var opt = document.querySelector('[data-automation-id="' + altOpts[mode] + '"]');
      if (!opt) return 'option not found: ' + altOpts[mode];
      opt.click();
      await wait(900);
    }

    // 5. If custom + text → set input + Enter (validated commit pattern s552)
    if (mode === 'custom' && typeof item.altCustomText === 'string') {
      var input = document.querySelector('[data-automation-id="AltTextPluginInput"]');
      if (!input) return 'AltTextPluginInput not found (custom mode requires input present)';
      input.focus();
      await wait(200);
      var proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(input, item.altCustomText);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(300);
      // Enter key sequence — required to commit Redux (blur seul ne suffit pas pour Component instance children)
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
      }));
      input.dispatchEvent(new KeyboardEvent('keypress', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
      }));
      input.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
      }));
      await wait(500);
      input.blur();
      await wait(waitMs);
    }

    return null; // success
  }

  p._localCmd.helpEditImagesAltInComponent = async function(args) {
    args = args || {};
    var items = args.items || [];
    var waitMs = typeof args.waitMs === 'number' ? args.waitMs : 600;

    if (!Array.isArray(items) || items.length === 0) {
      return { ok: false, error: 'items array required (non-empty)' };
    }

    var start = Date.now();
    var applied = [];
    var failed = [];

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item.nodeId && !item.srcKey) {
        failed.push({ index: i, reason: 'nodeId or srcKey required' });
        continue;
      }
      var err = await applyOne(item, waitMs);
      if (err) {
        failed.push({ index: i, nodeId: item.nodeId, reason: err });
      } else {
        applied.push({
          nodeId: item.nodeId,
          altMode: item.altMode || 'inherit',
          altCustomText: item.altCustomText || null
        });
      }
    }

    return {
      ok: failed.length === 0,
      total: items.length,
      applied_count: applied.length,
      failed_count: failed.length,
      applied: applied,
      failed: failed,
      durationMs: Date.now() - start
    };
  };

  console.log('[HelpEditImagesAltInComponent] 1 command registered: helpEditImagesAltInComponent (batch alt edit inside Component view — v3.11.0)');
})();

// ============================================================================
// Canvas scroll — v3.15.0 (s565)
// ============================================================================
// Cmd: scrollToElement({selector?, data_w_id?, behavior?, block?, wait_ms?})
//
// Scroll the Webflow Designer canvas iframe (#site-iframe-next) to bring a target
// element into view. The canvas iframe is same-origin with the Designer (Webflow
// uses document.domain trick), so direct DOM access works without React fiber.
//
// Webflow's CanvasScrollStore syncs automatically via the iframe's scroll event
// listener — no Redux dispatch needed.
//
// Validated empirically (s565) : scroll 0 → 17873px in ~250ms with `block: 'center'`.
// ============================================================================
(function() {
  'use strict';
  if (!window.__webflowHelper) return;
  var p = window.__webflowHelper;
  if (!p._localCmd) p._localCmd = {};

  p._localCmd.scrollToElement = async function(args) {
    args = args || {};

    var iframe = document.querySelector('#site-iframe-next');
    if (!iframe) {
      return { ok: false, error: 'canvas_iframe_not_found',
               message: 'Selector #site-iframe-next absent — canvas non monté ou Designer pas chargé' };
    }

    var doc;
    try { doc = iframe.contentDocument; }
    catch (e) { return { ok: false, error: 'cross_origin_blocked', message: e.message }; }
    if (!doc) return { ok: false, error: 'iframe_document_unavailable' };

    // Resolve selector — accepte `selector` raw OU `data_w_id` shortcut
    var selector = args.selector;
    if (!selector && args.data_w_id) {
      selector = '[data-w-id="' + String(args.data_w_id).replace(/"/g, '\\"') + '"]';
    }
    if (!selector) {
      return { ok: false, error: 'missing_selector_or_data_w_id',
               message: 'Provide {selector: "h2"} OR {data_w_id: "abc-def-..."}' };
    }

    var target;
    try { target = doc.querySelector(selector); }
    catch (e) { return { ok: false, error: 'invalid_selector', message: e.message, selector: selector }; }
    if (!target) return { ok: false, error: 'element_not_found', selector: selector };

    var cw = iframe.contentWindow;
    var behavior = args.behavior === 'instant' ? 'instant' : 'smooth';
    var validBlocks = { start: 1, center: 1, end: 1, nearest: 1 };
    var block = validBlocks[args.block] ? args.block : 'center';
    var waitMs = typeof args.wait_ms === 'number' ? args.wait_ms : (behavior === 'smooth' ? 600 : 250);

    var before = cw.scrollY;
    try { target.scrollIntoView({ behavior: behavior, block: block }); }
    catch (e) { return { ok: false, error: 'scrollIntoView_failed', message: e.message }; }

    await new Promise(function(r) { setTimeout(r, waitMs); });

    var after = cw.scrollY;
    var rect = target.getBoundingClientRect();

    return {
      ok: true,
      scrolled_from: before,
      scrolled_to: after,
      delta: after - before,
      target_visible_top: Math.round(rect.top),
      target_info: {
        tag: target.tagName,
        data_w_id: target.getAttribute('data-w-id') || null,
        id: target.id || null,
        classes: (target.className || '').toString().slice(0, 100)
      }
    };
  };

  console.log('[ScrollToElement] 1 command registered: scrollToElement (canvas iframe scroll — v3.15.0)');
})();

/**
 * Style Selector UI actions — 4 cmds : add / removeLast / removeFromElement / rename (s568 v3.18.0)
 *
 * Voie d'action programmatique sur le Style Selector Webflow Designer (panel droit) pour
 * bypass 5 gotchas style_tool MCP (#5/#15/#20/#22/#23).
 *
 * REQUIS : un élément doit être sélectionné dans le Designer (via mcp__webflow__element_tool
 * select_element). Les cmds opèrent sur le state du Style panel pour cet élément actif.
 *
 * GOTCHA dispatchEvent : sur INPUT (css-token-input) → KeyboardEvent synthétique fonctionne.
 *                       sur SPAN contentEditable (chip editable) → KeyboardEvent IGNORÉ par
 *                       React → renameClassViaUI use execCommand insertText + InputEvent fallback.
 *
 * GOTCHA menu chip indicator : dispatchEvent click intercepté par overlays Relume/autres.
 *                              Use element.click() NATIF après React onMouseEnter (mount conditionnel).
 *
 * Detail complet : docs/lessons/webflow-helper.md §cluster-style-selector-ui
 */
(function() {
  'use strict';

  if (!window.__webflowHelper) return;
  var p = window.__webflowHelper;
  if (!p._localCmd) p._localCmd = {};

  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  // Helper: trigger chip hover via React onMouseEnter OU fallback DOM hover cascade (v3.20.7).
  // FIX empirique : sur certains chip state (combo chain), Object.keys() liste onMouseEnter
  // MAIS sa valeur est `undefined` → react_props_inaccessible. Fallback : dispatch hover events
  // sur le chip + 3 ancestors (validé empirique session s568 — indicator se mount).
  async function triggerChipHover(chip) {
    var reactKey = Object.keys(chip).find(function(k) { return k.indexOf('__reactProps$') === 0; });
    var props = reactKey ? chip[reactKey] : null;
    // Try React onMouseEnter first
    if (props && typeof props.onMouseEnter === 'function') {
      try { props.onMouseEnter({ bubbles: true }); return 'react'; } catch (e) {}
    }
    // Fallback: DOM hover cascade up ancestors
    var rect = chip.getBoundingClientRect();
    var evtOpts = { bubbles: true, view: window, clientX: rect.left + 5, clientY: rect.top + 5 };
    var el = chip;
    for (var i = 0; i < 4 && el; i++) {
      el.dispatchEvent(new PointerEvent('pointerover', Object.assign({}, evtOpts, {pointerType: 'mouse', isPrimary: true})));
      el.dispatchEvent(new MouseEvent('mouseover', evtOpts));
      el.dispatchEvent(new MouseEvent('mouseenter', evtOpts));
      el = el.parentElement;
    }
    return 'dom_fallback';
  }

  // Helper: close chip menu (Rename/Duplicate/Remove options) SANS désélectionner l'élément.
  // FIX v3.20.8 : ESC, re-click indicator, click chip, click canvas body — TOUS ne marchent PAS
  // pour fermer proprement le menu. Solution validée empirique : click sur zone neutre du
  // StylePanel (bas du panel, hors widgets interactifs) via elementFromPoint.
  async function closeChipMenu() {
    var stylePanel = document.querySelector('[data-automation-id="StylePanel"]');
    if (!stylePanel) return;
    var r = stylePanel.getBoundingClientRect();
    var elAtPoint = document.elementFromPoint(r.left + r.width / 2, r.bottom - 50);
    if (elAtPoint && typeof elAtPoint.click === 'function') {
      elAtPoint.click();
    }
  }

  // Helper: capture les chips de classes actuellement attachées (exclut le chip BP-icon vide)
  function getCurrentChips() {
    var wrappers = Array.from(document.querySelectorAll('[data-automation-id="selector-widget"] [data-automation-id="style-rule-token-wrapper"]'));
    return wrappers.map(function(w) {
      var textEl = w.querySelector('[data-automation-id="style-rule-token-text"], [data-automation-id="style-rule-token-text-editable"]');
      return textEl ? textEl.textContent.trim() : '';
    }).filter(function(t) { return t.length > 0; });
  }

  // v3.20.10 — Read selected element's class names from Redux store (ground truth, no DOM race).
  // Used by addClassViaUI as fallback when chips DOM check fails after Enter (chips lag behind Redux).
  function getSelectedNodeClasses() {
    try {
      var stores = window._webflow && window._webflow.stores;
      var selectedId = stores && stores.UiNodeStore && stores.UiNodeStore.state && stores.UiNodeStore.state.selectedNodeNativeId;
      if (!selectedId) return null;
      var node = helpers.findNodeById(selectedId);
      if (!node) return null;
      var data = node.get && node.get('data');
      var sbIds = data && data.get && data.get('styleBlockIds');
      var arr = sbIds && sbIds.toJS ? sbIds.toJS() : (Array.isArray(sbIds) ? sbIds : []);
      var state = helpers.getReduxState();
      var sbStore = state && state.StyleBlockStore;
      var blocks = sbStore && sbStore.get && sbStore.get('styleBlocks');
      var sbs = blocks && blocks.toJS ? blocks.toJS() : blocks;
      return arr.map(function(s) { return (sbs && sbs[s] && sbs[s].name) || s; });
    } catch (e) { return null; }
  }

  // Helper: find chip wrapper containing exact class name (passive state)
  function findChipByName(name) {
    var wrappers = Array.from(document.querySelectorAll('[data-automation-id="selector-widget"] [data-automation-id="style-rule-token-wrapper"]'));
    return wrappers.find(function(w) {
      var t = w.querySelector('[data-automation-id="style-rule-token-text"]');
      return t && t.textContent.trim() === name;
    });
  }

  // Helper: React props accessor (works with React 18 fiber internals)
  function getReactProps(el) {
    var key = Object.keys(el).find(function(k) { return k.indexOf('__reactProps$') === 0; });
    return key ? el[key] : null;
  }

  // Helper: full mouse sequence click sur menu indicator (validated empirique v3.19.1 s568).
  // `.click()` natif seul NE SUFFIT PAS — le menu chip ne s'ouvre pas (intercepté ou state React incomplet).
  // Séquence requise : pointerdown + mousedown + (gap 50ms) + pointerup + mouseup + click natif.
  function clickMenuIndicator(indicator) {
    var ir = indicator.getBoundingClientRect();
    var evtBase = { bubbles: true, cancelable: true, view: window, button: 0,
                    clientX: ir.left + ir.width/2, clientY: ir.top + ir.height/2 };
    indicator.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, evtBase, {pointerType: 'mouse', isPrimary: true, buttons: 1})));
    indicator.dispatchEvent(new MouseEvent('mousedown', Object.assign({}, evtBase, {buttons: 1})));
    return new Promise(function(resolve) {
      setTimeout(function() {
        indicator.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, evtBase, {pointerType: 'mouse', isPrimary: true, buttons: 0})));
        indicator.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, evtBase, {buttons: 0})));
        indicator.dispatchEvent(new MouseEvent('click', Object.assign({}, evtBase, {buttons: 0})));
        resolve();
      }, 50);
    });
  }

  // Helper: cleanup edit mode WITHOUT deselecting current element.
  // FIX v3.18.1 : canvas body click était utilisé v3.18.0 mais DÉSÉLECTIONNAIT l'élément
  // → bug "chip_not_found" car le selector-widget se vidait. Use ESC + blur active editable.
  function cleanupEditMode() {
    // 1. ESC to close any open dropdown/menu
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    // 2. Blur active editable span (chip in rename mode) — sans changer la sélection canvas
    var editSpan = document.querySelector('[data-automation-id="style-rule-token-text-editable"]');
    if (editSpan && typeof editSpan.blur === 'function') {
      editSpan.blur();
    }
    // 3. Blur css-token-input if focused
    var activeEl = document.activeElement;
    if (activeEl && activeEl.tagName === 'INPUT' && activeEl.getAttribute('data-automation-id') === 'css-token-input') {
      activeEl.blur();
    }
  }

  /**
   * addClassViaUI({className, waitMs?})
   *
   * Add a class to the currently selected element via the css-token-input.
   * Creates a combo if element already has classes, or standalone if first class.
   */
  p._localCmd.addClassViaUI = async function(args) {
    args = args || {};
    var className = args.className;
    var waitMs = typeof args.waitMs === 'number' ? args.waitMs : 400;

    if (!className || typeof className !== 'string') {
      return { ok: false, error: 'className_required', got: typeof className };
    }
    // v3.20.11 : regex permissive par défaut (majuscules OK — nommenclature legacy/projets multiples).
    // Flag `allowLegacyUppercase` reste accepté mais no-op (deprecated rétrocompat).
    var classNameRegex = /^[a-zA-Z0-9_-]+$/;
    if (!classNameRegex.test(className)) {
      return { ok: false, error: 'invalid_class_name',
               message: 'className must match /^[a-zA-Z0-9_-]+$/. Pas d\'espaces, accents, chars spéciaux.',
               className: className };
    }

    var start = Date.now();
    var chipsBefore = getCurrentChips();

    var input = document.querySelector('[data-automation-id="css-token-input"]');
    if (!input) return { ok: false, error: 'css_token_input_not_found',
                         message: 'No element selected in Designer ? Style panel must be visible.' };

    input.focus();
    await wait(100);

    // Set value via native setter (bypass React shadow setter)
    var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(input, className);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(250);

    // v3.20.11 : Click exact match option AU LIEU d'Enter (Webflow autocomplete focus
    // interne ne pointe pas toujours sur exact match — Enter pouvait sélectionner une
    // classe préfixée différente comme BodyMJ-M-500 au lieu de BodyM-500).
    var options = document.querySelectorAll('[role="option"]');
    var exactOption = null;
    for (var i = 0; i < options.length; i++) {
      if ((options[i].textContent || '').trim() === className) {
        exactOption = options[i];
        break;
      }
    }
    var validationPath;
    if (exactOption) {
      exactOption.click();
      validationPath = 'exact_option_click';
    } else {
      // Fallback Enter : aucune option exacte → nouvelle classe (création registry)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      validationPath = 'enter_fallback_create';
    }
    await wait(waitMs);

    var chipsAfter = getCurrentChips();
    var domSuccess = chipsAfter.indexOf(className) !== -1 && chipsAfter.length > chipsBefore.length;

    // v3.20.10 — Fallback Redux verify when chips DOM read fails (race condition s569)
    var reduxClasses = null;
    var reduxSuccess = false;
    if (!domSuccess) {
      reduxClasses = getSelectedNodeClasses();
      if (reduxClasses && reduxClasses.indexOf(className) !== -1) {
        reduxSuccess = true;
      }
    }
    var success = domSuccess || reduxSuccess;
    var effectiveClasses = reduxSuccess ? reduxClasses : chipsAfter;

    return {
      ok: success,
      className: className,
      chips_before: chipsBefore,
      chips_after: chipsAfter,
      is_combo: effectiveClasses.length >= 2,
      durationMs: Date.now() - start,
      validation_path: validationPath,
      redux_fallback_used: !domSuccess && reduxSuccess,
      redux_classes: reduxSuccess ? reduxClasses : undefined
    };
  };

  /**
   * removeLastClassViaUI({waitMs?})
   *
   * Remove the LAST class attached to the currently selected element via input + Backspace.
   * Equivalent UI to focusing the css-token-input (empty) and pressing Backspace.
   */
  p._localCmd.removeLastClassViaUI = async function(args) {
    args = args || {};
    var waitMs = typeof args.waitMs === 'number' ? args.waitMs : 600;

    var start = Date.now();
    var chipsBefore = getCurrentChips();
    if (chipsBefore.length === 0) {
      return { ok: false, error: 'no_chips_to_remove',
               message: 'Selected element has no classes attached' };
    }

    var input = document.querySelector('[data-automation-id="css-token-input"]');
    if (!input) return { ok: false, error: 'css_token_input_not_found' };

    input.focus();
    await wait(200);

    // Ensure input is empty before Backspace
    var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(200);

    // Press Backspace
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8, bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8, bubbles: true }));
    await wait(waitMs);

    var chipsAfter = getCurrentChips();
    var removed = chipsBefore[chipsBefore.length - 1];
    var success = chipsAfter.length < chipsBefore.length;

    return {
      ok: success,
      removed: success ? removed : null,
      chips_before: chipsBefore,
      chips_after: chipsAfter,
      durationMs: Date.now() - start
    };
  };

  /**
   * removeClassFromElementViaUI({className, waitMs?})
   *
   * Detach a specific class from the selected element via chip menu → Remove class.
   * Bypass gotcha #15 (set_style enrichit silencieusement avec parent).
   * The class remains in the registry and on other elements — only this element's binding is removed.
   */
  p._localCmd.removeClassFromElementViaUI = async function(args) {
    args = args || {};
    var className = args.className;
    var waitMs = typeof args.waitMs === 'number' ? args.waitMs : 600;

    if (!className) return { ok: false, error: 'className_required' };

    var start = Date.now();
    var chipsBefore = getCurrentChips();
    if (chipsBefore.indexOf(className) === -1) {
      return { ok: false, error: 'class_not_attached_to_element',
               className: className, chips: chipsBefore };
    }

    // Ensure out of edit mode
    cleanupEditMode();
    await wait(300);

    // 1. Find chip
    var chip = findChipByName(className);
    if (!chip) return { ok: false, error: 'chip_not_found_after_cleanup', className: className };

    // 2. Trigger chip hover via React onMouseEnter (preferred) OR DOM cascade fallback (v3.20.7).
    var hoverMethod = await triggerChipHover(chip);
    await wait(500);

    // 3. Click menu indicator (.click() NATIF — dispatchEvent click est intercepté par overlays)
    var indicator = chip.querySelector('[data-automation-id="style-rule-token-menu-indicator"]');
    if (!indicator) {
      return { ok: false, error: 'menu_indicator_not_mounted',
               message: 'Hover React n\'a pas mounté l\'indicator — chip peut-être en mode édit ?' };
    }
    await clickMenuIndicator(indicator);
    await wait(700);

    // 4. Click Remove option
    var removeOpt = document.querySelector('[data-automation-id="css-tokens-remove-class"]');
    if (!removeOpt) {
      return { ok: false, error: 'remove_option_not_visible',
               message: 'Menu chip ne s\'est pas ouvert après click indicator' };
    }

    // FIX v3.20.6 : Detect disabled state (Webflow refuse remove parent d'un combo chain).
    // Si chip a un combo enfant derrière (ex: _t1-base-x suivi de _t1-shared), Remove est grisé.
    // Marqueurs disabled : hasAttribute('disabled') · pointer-events:none · opacity:0.6.
    if (removeOpt.hasAttribute('disabled') || getComputedStyle(removeOpt).pointerEvents === 'none') {
      // Close menu via StylePanel neutral zone click (preserves selection)
      await closeChipMenu();
      await wait(300);
      return {
        ok: false,
        error: 'remove_option_disabled',
        message: 'Webflow refuse remove de cette class — elle est parent d\'un combo chain. Remove le combo enfant d\'abord, puis re-essaie.',
        className: className,
        chips_chain: chipsBefore,
        hint: 'Combo chain : un chip parent ne peut être supprimé tant qu\'un chip enfant le suit. Utiliser removeLastClassViaUI pour partir du bout de la chain, ou inverser l\'ordre des classes.'
      };
    }

    removeOpt.click();
    await wait(waitMs);

    var chipsAfter = getCurrentChips();
    var removed = chipsAfter.indexOf(className) === -1;

    return {
      ok: removed,
      className: className,
      chips_before: chipsBefore,
      chips_after: chipsAfter,
      durationMs: Date.now() - start
    };
  };

  /**
   * renameClassViaUI({oldName, newName, waitMs?})
   *
   * Rename a class via chip menu → Rename → execCommand insertText + Enter.
   * Validated empirique session s568 (4 cas).
   *
   * 🚨 COMPORTEMENT AMBIGU SELON CONTEXTE (canon §rename-behavior-empirique) :
   *   - Si chip = STANDALONE seul → rename GLOBAL throughout site (tous éléments renamed,
   *     props préservées, même style_id conservé).
   *   - Si chip = COMBO virtuel dans une chain `parent.combo` → rename LOCAL à l'élément
   *     sélectionné uniquement (autres usages de la même class sur d'autres parents intacts).
   *     Props virtuelles préservées dans les 2 cas (même style_id).
   *
   * Webflow traite chaque paire `(parent_class, child_class)` comme une entité distincte
   * au registry. Pour rename "throughout site" une combo class utilisée sur N parents,
   * il faut rename chaque instance individuellement OU passer par le Class Manager (Q shortcut).
   *
   * FLICKER VISUEL POST-RENAME : pendant ~1-2s, le canvas peut afficher un état où le CSS
   * n'est pas encore rebuilt → background/border peuvent disparaître temporairement. C'est
   * comportement Webflow natif (pas une vraie perte définitive). Webflow rebuild le CSS et
   * le rendu revient. Vérifier via dumpTree/query_styles pour ground truth.
   *
   * GOTCHA contentEditable : dispatchEvent KeyboardEvent ignoré par React → use
   * document.execCommand('insertText') + InputEvent fallback. Validé empirique s568.
   */
  p._localCmd.renameClassViaUI = async function(args) {
    args = args || {};
    var oldName = args.oldName;
    var newName = args.newName;
    var waitMs = typeof args.waitMs === 'number' ? args.waitMs : 800;

    if (!oldName || !newName) return { ok: false, error: 'oldName_and_newName_required' };
    // v3.20.11 : regex permissive majuscules par défaut (cf addClassViaUI). Flag legacy no-op.
    var newNameRegex = /^[a-zA-Z0-9_-]+$/;
    if (!newNameRegex.test(newName)) {
      return { ok: false, error: 'invalid_new_name',
               message: 'newName must match /^[a-zA-Z0-9_-]+$/. Pas d\'espaces, accents, chars spéciaux.',
               newName: newName };
    }
    if (oldName === newName) return { ok: false, error: 'no_op_same_name' };

    var start = Date.now();

    cleanupEditMode();
    await wait(300);

    // 1. Find chip with oldName
    var chip = findChipByName(oldName);
    if (!chip) return { ok: false, error: 'chip_not_found', oldName: oldName };

    // 2. Hover via React or DOM cascade fallback (v3.20.7)
    await triggerChipHover(chip);
    await wait(500);

    var indicator = chip.querySelector('[data-automation-id="style-rule-token-menu-indicator"]');
    if (!indicator) return { ok: false, error: 'menu_indicator_not_mounted' };
    await clickMenuIndicator(indicator);
    await wait(700);

    // 3. Click Rename option (this should activate edit mode on the chip text)
    var renameOpt = document.querySelector('[data-automation-id="css-tokens-rename-class"]');
    if (!renameOpt) return { ok: false, error: 'rename_option_not_visible' };
    renameOpt.click();
    await wait(500);

    // 4. Find editable span — should be the chip text now in edit mode
    var editSpan = document.querySelector('[data-automation-id="style-rule-token-text-editable"]');
    if (!editSpan || editSpan.contentEditable !== 'true') {
      return { ok: false, error: 'edit_mode_not_active_after_rename_click',
               message: 'Rename option click did not enter edit mode on chip text' };
    }

    editSpan.focus();
    await wait(200);

    // 5. Select all + insert new text — execCommand path (deprecated mais marche encore)
    var execCommandOk = false;
    try {
      var range = document.createRange();
      range.selectNodeContents(editSpan);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      execCommandOk = document.execCommand('insertText', false, newName);
    } catch (e) { execCommandOk = false; }

    // 6. Fallback if execCommand failed : direct textContent + InputEvent
    if (!execCommandOk) {
      editSpan.textContent = newName;
      try {
        editSpan.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: newName
        }));
      } catch (e) { /* InputEvent unsupported on older browsers */ }
    }
    await wait(300);

    // 7. Press Enter to commit + blur as backup
    editSpan.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    await wait(200);
    editSpan.blur();
    await wait(waitMs);

    // 8. Verify rename via chips state
    var chipsAfter = getCurrentChips();
    var renamed = chipsAfter.indexOf(newName) !== -1 && chipsAfter.indexOf(oldName) === -1;

    return {
      ok: renamed,
      oldName: oldName,
      newName: newName,
      chips_after: chipsAfter,
      exec_command_used: execCommandOk,
      durationMs: Date.now() - start,
      warning: !renamed ? 'Rename may have partially failed — verify visually in Designer' : null
    };
  };

  /**
   * duplicateClassViaUI({className, waitMs?}) — validated empirique s568
   *
   * Duplicate a class via chip menu → Duplicate class.
   * Validé empirique session s568 sur Sandbox AVG (1 test isolated, props 100% copiées).
   *
   * COMPORTEMENT WEBFLOW (validé empirique) :
   * - Suffix auto-généré : "<className> Copy" (avec un espace · validé)
   * - **SWAP, pas add** : l'élément perd la classe source et reçoit la copie À LA PLACE.
   *   Ex: élément `[_dup-source]` après duplicate → `[_dup-source Copy]` (_dup-source détaché).
   *   La source class reste au registry (intacte), juste plus attachée à cet élément.
   * - Toutes les props CSS de la source sont copiées dans la nouvelle classe.
   * - Webflow laisse le chip dupliqué en MODE ÉDIT (contentEditable focused) pour permettre
   *   rename immédiat. La cmd v3.20.1 ESC + blur pour cleanup → état propre post-call.
   *
   * Workflow : chip menu hover → click indicator → click css-tokens-duplicate-class → ESC cleanup.
   */
  p._localCmd.duplicateClassViaUI = async function(args) {
    args = args || {};
    var className = args.className;
    var waitMs = typeof args.waitMs === 'number' ? args.waitMs : 600;

    if (!className) return { ok: false, error: 'className_required' };

    var start = Date.now();
    var chipsBefore = getCurrentChips();
    if (chipsBefore.indexOf(className) === -1) {
      return { ok: false, error: 'class_not_attached_to_element',
               className: className, chips: chipsBefore };
    }

    cleanupEditMode();
    await wait(300);

    // 1. Find chip
    var chip = findChipByName(className);
    if (!chip) return { ok: false, error: 'chip_not_found_after_cleanup', className: className };

    // 2. Hover via React or DOM cascade fallback (v3.20.7)
    await triggerChipHover(chip);
    await wait(500);

    // 3. Click indicator
    var indicator = chip.querySelector('[data-automation-id="style-rule-token-menu-indicator"]');
    if (!indicator) return { ok: false, error: 'menu_indicator_not_mounted' };
    await clickMenuIndicator(indicator);
    await wait(700);

    // 4. Click Duplicate option
    var dupOpt = document.querySelector('[data-automation-id="css-tokens-duplicate-class"]');
    if (!dupOpt) return { ok: false, error: 'duplicate_option_not_visible' };
    dupOpt.click();
    await wait(waitMs);

    // FIX v3.20.3 : Webflow laisse le chip dupliqué en mode édit (contentEditable focused)
    // pour permettre rename immédiat. v3.20.1 utilisait ESC mais empiriquement ESC ne quitte
    // pas vraiment le mode édit + bloque le sidebar click suivant. Use Enter (commit) au lieu.
    var editSpanAfter = document.querySelector('[data-automation-id="style-rule-token-text-editable"]');
    if (editSpanAfter) {
      editSpanAfter.focus();
      await wait(100);
      editSpanAfter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      await wait(400);
    }

    var chipsAfter = getCurrentChips();
    // Webflow génère un nom auto pour le duplicate avec suffix " Copy" (validé empirique s568)
    // On détecte le nouveau chip = chip qui n'était pas dans chipsBefore
    var newChips = chipsAfter.filter(function(c) { return chipsBefore.indexOf(c) === -1; });
    var success = newChips.length > 0;

    return {
      ok: success,
      source_class: className,
      new_class_name: newChips[0] || null,
      chips_before: chipsBefore,
      chips_after: chipsAfter,
      durationMs: Date.now() - start
    };
  };

  /**
   * cleanupUnusedStylesViaUI({dryRun?, waitMs?}) — v3.20.0 (s568)
   *
   * Bulk delete TOUTES les classes orphelines (0 usage DOM) du registry via Style Manager UI.
   * Trigger : raccourci `G` ouvre Style Manager → click "Clean up styles" → modal → click "Delete".
   *
   * BYPASS gotchas style_tool MCP :
   * - #22 (remove_style refuse classe attachée) — N/A car ne touche QUE les non-attachées
   * - #23 (parent_style_names cassé) — N/A car bulk auto-détecté par Webflow
   *
   * SI dryRun=true : parse le modal "The following styles are not associated..." pour preview
   * la liste classes à supprimer SANS cliquer Delete. Retourne la liste + ferme le modal (ESC).
   *
   * SI 0 orphelines : le bouton "Clean up styles" peut ne pas être présent OU le modal vide.
   * La cmd retourne {ok: true, classes_about_to_delete: []} sans rien faire.
   *
   * Pré-requis : pas d'input/contentEditable focused (sinon G typé dedans), pas de modal ouvert.
   * La cmd enchaîne tree-view-container.click() puis dispatch G keydown pour garantir focus.
   */
  p._localCmd.cleanupUnusedStylesViaUI = async function(args) {
    args = args || {};
    var dryRun = args.dryRun === true;
    var waitMs = typeof args.waitMs === 'number' ? args.waitMs : 800;
    var start = Date.now();

    // FIX v3.20.3 : pas d'ESC initial — empiriquement il bloque le sidebar click suivant
    // (validé session s568 : sans ESC le sidebar.click() ouvre Style Manager, avec ESC il ne fait rien).
    // Pré-requis : caller doit s'assurer qu'aucun mode édit chip actif n'est en cours.
    // Pour cela, `duplicateClassViaUI` v3.20.3 fait Enter (commit) automatique post-duplicate.

    // Pré-check : si mode édit chip détecté → Enter pour commit + sortir proprement
    var editSpanCheck = document.querySelector('[data-automation-id="style-rule-token-text-editable"]');
    if (editSpanCheck && document.activeElement === editSpanCheck) {
      editSpanCheck.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      await wait(400);
    }

    // 1. Track initial state pour hygiène fermeture à la fin (FIX v3.20.5).
    var stylesPanelCheck = document.querySelector('[data-automation-id="styles"]');
    var wasInitiallyOpen = !!(stylesPanelCheck && stylesPanelCheck.offsetWidth > 0);

    // 2. Open Style Manager si pas déjà ouvert (TOGGLE — click ferme si déjà ouvert).
    if (!wasInitiallyOpen) {
      var stylesSidebarBtn = document.querySelector('[data-automation-id="left-sidebar-styles-button"]');
      if (!stylesSidebarBtn) {
        return { ok: false, error: 'styles_sidebar_button_not_found',
                 message: 'left-sidebar-styles-button absent — Webflow UI may have changed' };
      }
      stylesSidebarBtn.click();
      await wait(700);
    }

    // 3. Vérifier que le Style Manager est bien ouvert
    var stylesPanel = document.querySelector('[data-automation-id="styles"]');
    if (!stylesPanel) {
      return { ok: false, error: 'style_manager_did_not_open',
               message: 'Style Manager not visible after sidebar click — modal blocking or UI changed' };
    }

    // Helper: close Style Manager via sidebar toggle (uniquement si on l'a ouvert).
    // FIX v3.20.5 : hygiène — laisser l'état Designer comme on l'a trouvé.
    async function closeIfWeOpened() {
      if (wasInitiallyOpen) return; // Caller had it open, leave it open
      var btn = document.querySelector('[data-automation-id="left-sidebar-styles-button"]');
      var stillOpen = document.querySelector('[data-automation-id="styles"]');
      if (btn && stillOpen && stillOpen.offsetWidth > 0) {
        btn.click();
        await wait(400);
      }
    }

    // 4. Click "Clean up styles" button
    var cleanBtn = document.querySelector('[data-automation-id="clean-up-styles-button"]');
    if (!cleanBtn) {
      // Pas de bouton = 0 orphelines (Webflow masque le bouton si rien à cleanup)
      await closeIfWeOpened();
      return { ok: true, classes_about_to_delete: [], count: 0,
               message: 'clean_up_styles_button not present — 0 orphan classes',
               durationMs: Date.now() - start };
    }
    cleanBtn.click();
    await wait(700);

    // 5. Parse le modal "Clean up unused styles" pour la liste classes orphelines
    var modal = Array.from(document.querySelectorAll('[data-automation-id="overlay"]'))
      .find(function(el) { return el.offsetWidth > 0 && /The following styles/.test(el.textContent || ''); });

    var classesAboutToDelete = [];
    if (modal) {
      var modalText = modal.textContent || '';
      var afterColon = modalText.split('elements:')[1];
      if (afterColon) {
        var listPart = afterColon.split(/\bDelete\b|\bCancel\b|\bKeep\b/)[0];
        var chipsInModal = modal.querySelectorAll('[data-automation-id="style-rule-token-wrapper"]');
        classesAboutToDelete = Array.from(chipsInModal)
          .map(function(c) {
            var t = c.querySelector('[data-automation-id="style-rule-token-text"]');
            return t ? t.textContent.trim() : null;
          })
          .filter(Boolean);
        if (classesAboutToDelete.length === 0 && listPart) {
          classesAboutToDelete = [listPart.trim().slice(0, 500)];
        }
      }
    }

    // 6. Si dryRun : close modal + Style Manager (si on l'a ouvert) + return preview
    if (dryRun) {
      // Cancel modal via ESC (annule le clean up sans supprimer)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(400);
      await closeIfWeOpened();
      return {
        ok: true,
        dryRun: true,
        classes_about_to_delete: classesAboutToDelete,
        count: classesAboutToDelete.length,
        durationMs: Date.now() - start
      };
    }

    // 7. Click "Delete" pour confirmer le bulk
    var deleteBtn = document.querySelector('[data-automation-id="remove-styles-button"]');
    if (!deleteBtn) {
      await closeIfWeOpened();
      return { ok: false, error: 'remove_styles_button_not_visible',
               message: 'Modal opened but Delete button absent — 0 orphans confirmed',
               classes_about_to_delete: classesAboutToDelete };
    }
    deleteBtn.click();
    await wait(waitMs);

    // 8. Close Style Manager (si on l'a ouvert)
    await closeIfWeOpened();

    return {
      ok: true,
      deleted_count: classesAboutToDelete.length,
      classes_deleted: classesAboutToDelete,
      durationMs: Date.now() - start
    };
  };

  console.log('[StyleSelectorUI] 6 commands registered: addClassViaUI · removeLastClassViaUI · removeClassFromElementViaUI · renameClassViaUI · duplicateClassViaUI · cleanupUnusedStylesViaUI (v3.20.0 s568)');
})();

/**
 * Navigator Selection & Component View — 3 cmds via Redux dispatch (v3.25.0 s573).
 *
 * Reverse-eng'd via dispatch interception (capture of native Webflow actions, no
 * fabricated payloads — the payloads mirror exactly what Webflow emits on click) :
 * - selectNode         → NODE_CLICKED         (selection + auto-expand/scroll Navigator)
 * - openComponentView  → SYMBOL_NODE_FOCUSED   (enter component edit view; "Symbol" = component)
 * - closeComponentView → SYMBOL_NODE_UNFOCUSED (exit component edit view; no payload)
 *
 * These are NAVIGATION/SELECTION actions (ephemeral UI state), NOT document
 * mutations — categorically distinct from EXPRESSION_ACTION (which corrupted the
 * mariage page s549). Whitelisted by exact action type in
 * `.claude/hooks/_webflow-redux-whitelist.json`. Validated empirically s573 :
 * styleBlocks count unchanged (992→992), invalid id fails gracefully ("None
 * selected"), full open→select-child→close cycle OK on Footer component.
 *
 * Intra-component selection requires being INSIDE the component view first:
 *   openComponentView({instanceNativeId}) → selectNode({nodeId, componentInstanceId}) → closeComponentView()
 */
(function() {
  'use strict';

  if (!window.__webflowHelper || !window.__webflowHelper._localCmd) {
    console.log('[NavSelect] __webflowHelper not initialized — module skipped');
    return;
  }
  var p = window.__webflowHelper;

  function selectedTitle() {
    var t = document.querySelector('[data-automation-id="selected-node-title-label"]');
    return t ? t.textContent.trim() : null;
  }
  function inComponentView() {
    var b = document.querySelector('[data-automation-id="unfocus-component-button"]');
    return !!b && b.getBoundingClientRect().width > 0;
  }
  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  // selectNode({nodeId, componentInstanceId?, waitMs?})
  // Page node → nativeIdPath:[nodeId] (auto-expands the Navigator to reveal it).
  // Intra-component node → pass componentInstanceId: the cmd tries a direct select
  // (works if already inside that component view) and, on failure, AUTO-calls
  // openComponentView then retries. No need to remember to open the component first —
  // the gotcha is mechanized. (closeComponentView stays manual: the cmd can't know
  // when you're done editing. Check `auto_opened_component` in the return.)
  p._localCmd.selectNode = async function(args) {
    args = args || {};
    var nodeId = args.nodeId;
    var componentInstanceId = args.componentInstanceId || null;
    var waitMs = (args.waitMs && args.waitMs.afterSelect) || 500;
    if (!nodeId) return { ok: false, error: 'nodeId required' };
    var wf = window._webflow;
    if (!wf || !wf.dispatch) return { ok: false, error: 'Webflow store/dispatch not accessible' };
    var start = Date.now();
    var uiNode = wf.stores && wf.stores.UiNodeStore;

    function doSelect() {
      var path = componentInstanceId ? [componentInstanceId, nodeId] : [nodeId];
      wf.dispatch({ type: 'NODE_CLICKED', payload: { nativeIdPath: path, isMultiSelectModifierKeyActive: false, source: 'navigator', nativeIdInCurrentComponent: nodeId } });
    }
    function checkSel() {
      var selId = uiNode && uiNode.state ? uiNode.state.selectedNodeNativeId : null;
      var title = selectedTitle();
      // Valid = store holds our id AND a real title is shown.
      // (selectedNodeNativeId alone accepts any string — an invalid id yields "None selected".)
      return { ok: selId === nodeId && !!title && title !== 'None selected', selId: selId, title: title };
    }

    // Page node — single dispatch.
    if (!componentInstanceId) {
      doSelect();
      await wait(waitMs);
      var v = checkSel();
      return { ok: v.ok, nodeId: nodeId, selected: v.selId, title: v.title, durationMs: Date.now() - start,
               error: v.ok ? undefined : (v.selId === nodeId ? 'node does not exist (title=None selected)' : 'selection did not land') };
    }

    // Intra-component node — try direct first (cheap if already inside the component
    // view), else AUTO-open the component then retry (mechanizes the gotcha).
    var autoOpened = false;
    doSelect();
    await wait(waitMs);
    var v1 = checkSel();
    if (!v1.ok) {
      var openRes = await p._localCmd.openComponentView({ instanceNativeId: componentInstanceId });
      if (!openRes.ok) {
        return { ok: false, nodeId: nodeId, componentInstanceId: componentInstanceId, auto_opened_component: false,
                 durationMs: Date.now() - start, error: 'auto-openComponentView failed: ' + openRes.error };
      }
      autoOpened = true;
      doSelect();
      await wait(waitMs);
    }
    var v2 = checkSel();
    return { ok: v2.ok, nodeId: nodeId, componentInstanceId: componentInstanceId, auto_opened_component: autoOpened,
             selected: v2.selId, title: v2.title, durationMs: Date.now() - start,
             error: v2.ok ? undefined : 'selection did not land even after auto-openComponentView (node may not exist in this component)' };
  };

  // openComponentView({instanceNativeId, symbolId?, waitMs?})
  // Enters the component edit view. Derives symbolId from the Symbol node's
  // `.componentInstance` field (via dumpTree) when not supplied.
  p._localCmd.openComponentView = async function(args) {
    args = args || {};
    var instanceNativeId = args.instanceNativeId;
    var symbolId = args.symbolId || null;
    var waitMs = (args.waitMs && args.waitMs.afterOpen) || 700;
    if (!instanceNativeId) return { ok: false, error: 'instanceNativeId required' };
    var wf = window._webflow;
    if (!wf || !wf.dispatch) return { ok: false, error: 'Webflow store/dispatch not accessible' };
    if (!symbolId) {
      try {
        var tree = await p._localCmd.dumpTree({ expandComponents: true });
        var sym = (tree.tree || []).find(function(n) { return n.id === instanceNativeId && n.type === 'Symbol'; });
        if (sym && sym.componentInstance) symbolId = sym.componentInstance;
      } catch (e) { /* fall through to error below */ }
      if (!symbolId) return { ok: false, error: 'could not derive symbolId — ' + instanceNativeId + ' is not a Symbol instance in the tree (pass symbolId explicitly)' };
    }
    var start = Date.now();
    wf.dispatch({ type: 'SYMBOL_NODE_FOCUSED', payload: { id: symbolId, instanceNativeId: instanceNativeId, analytics: { source: 'props panel', trigger: 'click', symbolId: symbolId } } });
    await wait(waitMs);
    var entered = inComponentView();
    return { ok: entered, instanceNativeId: instanceNativeId, symbolId: symbolId, durationMs: Date.now() - start, error: entered ? undefined : 'failed to enter component view' };
  };

  // closeComponentView({waitMs?}) — exits the component edit view (no payload).
  p._localCmd.closeComponentView = async function(args) {
    args = args || {};
    var waitMs = (args.waitMs && args.waitMs.afterClose) || 600;
    var wf = window._webflow;
    if (!wf || !wf.dispatch) return { ok: false, error: 'Webflow store/dispatch not accessible' };
    var start = Date.now();
    wf.dispatch({ type: 'SYMBOL_NODE_UNFOCUSED' });
    await wait(waitMs);
    var stillIn = inComponentView();
    return { ok: !stillIn, durationMs: Date.now() - start, error: stillIn ? 'still in component view after unfocus' : undefined };
  };

  console.log('[NavSelect] 3 commands registered: selectNode, openComponentView, closeComponentView (v3.25.0 s573)');
})();

/**
 * PageCode — read/write per-page Schema markup & Custom code via Page Settings UI automation.
 *
 * Couvre les 3 champs CodeMirror du panneau Page Settings :
 *   - 'schema' → "Schema markup → JSON-LD schema" (champ dédié JSON-LD · défaut)
 *   - 'head'   → "Custom code → Inside <head> tag"
 *   - 'body'   → "Custom code → Before </body> tag"
 *
 * MCP gap : la Designer API n'expose PAS le schema/custom code de page (settings hors
 * canvas). REST `/scripts` retiré (404). Seule voie d'automatisation = UI Page Settings.
 *
 * Workflow (reverse-engineered s590 via event recorder sur AVG · MAJ s591 Collection Pages) :
 *   1. Ouvrir Page Settings : click [top-bar-page-name] OU [page-dynamic-item-select-trigger]
 *      (Collection Pages) → click [page-selected-settings-button]
 *   2. Scroller le label "JSON-LD schema" (lazy-mount du CM sur pages longues · s591)
 *   3. Classer les .cm-editor : head/body par label adjacent ; schema = le restant
 *   4. EditorView CM6 via cmContent.cmTile.view (fallback scan props)
 *      Lire   : view.state.doc.toString() (bypass virtualisation DOM)
 *      Écrire : view.dispatch({changes}) — validé empirique s590 sur Page Settings
 *               (déclenche le onChange Webflow → bouton Save activé → persistance OK)
 *               Sur champ CMS-bindé (templates detail_*) : passer le format token
 *               `{{wf {...}\} }}` byte-exact → re-tokenise en chips (validé s591).
 *   5. Save  : click [save-page-button] (save+close) · Close : [close-page-settings-button]
 *
 * Prérequis : être sur la BONNE page (le code est scopé par page → appeler switchPage
 * AVANT si besoin · switchPage v3.30.0 supporte les Collection Pages). Pas de switchPage
 * intégré (single responsibility · cooldown 2000ms).
 *
 * @see docs/lessons/webflow-helper.md §pagecode-workflow
 */
(function() {
  'use strict';
  if (!window.__webflowHelper) return;
  var p = window.__webflowHelper;
  if (!p._localCmd) p._localCmd = {};

  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  var FIELD_RX = {
    head: /inside\s*<?\s*head/i,
    body: /before\s*<?\s*\/?\s*body/i
  };
  var VALID_FIELDS = ['schema', 'head', 'body'];

  // Ouvre le panneau Page Settings (idempotent : skip si déjà ouvert).
  // v3.30.0 (s591) : supporte les Collection Pages (templates detail_*) dont le bouton
  // du nom de page = [page-dynamic-item-select-trigger] (≠ [top-bar-page-name] des pages
  // statiques). Le trigger ouvre un popover contenant le MÊME [page-selected-settings-button].
  async function openPageSettings(D) {
    if (document.querySelector('[data-automation-id="page-settings-panel"]')) {
      return { ok: true, already: true };
    }
    var nameBtn = document.querySelector('[data-automation-id="top-bar-page-name"]')
               || document.querySelector('[data-automation-id="page-dynamic-item-select-trigger"]');
    if (!nameBtn) return { ok: false, error: 'top-bar-page-name / page-dynamic-item-select-trigger introuvable (pas sur le canvas Designer ?)' };
    var setBtn = document.querySelector('[data-automation-id="page-selected-settings-button"]');
    if (!setBtn) { nameBtn.click(); await wait(D.afterOpenMenu); setBtn = document.querySelector('[data-automation-id="page-selected-settings-button"]'); }
    // Collection pages : le popover peut se toggle (1er click) — retry une fois.
    if (!setBtn) { nameBtn.click(); await wait(D.afterOpenMenu); setBtn = document.querySelector('[data-automation-id="page-selected-settings-button"]'); }
    if (!setBtn) return { ok: false, error: 'page-selected-settings-button introuvable apres ouverture du menu page' };
    setBtn.click();
    await wait(D.afterOpenSettings);
    if (!document.querySelector('[data-automation-id="page-settings-panel"]')) {
      return { ok: false, error: 'page-settings-panel non monte apres ouverture' };
    }
    return { ok: true, already: false };
  }

  // v3.30.0 (s591) : le CodeMirror du champ schema est lazy-mounté (rendu au scroll)
  // sur les pages à long Page Settings (faq, Collection Pages). Scroller le label
  // "JSON-LD schema" dans la vue force son montage AVANT classifyEditors.
  async function ensureSchemaMounted(D) {
    var els = document.querySelectorAll('span, div');
    for (var i = 0; i < els.length; i++) {
      if (els[i].children.length === 0 && (els[i].textContent || '').trim() === 'JSON-LD schema') {
        els[i].scrollIntoView({ block: 'center' });
        await wait(D.afterScroll || 800);
        return true;
      }
    }
    return false;
  }

  async function closePageSettings(D) {
    var btn = document.querySelector('[data-automation-id="close-page-settings-button"]');
    if (btn) { btn.click(); await wait(D.afterClose); return true; }
    return false;
  }

  // EditorView CM6 d'un .cm-editor : API officielle cmTile.view, fallback scan props.
  function getView(cmEditor) {
    if (!cmEditor) return null;
    var cmContent = cmEditor.querySelector('.cm-content');
    if (cmContent && cmContent.cmTile && cmContent.cmTile.view && cmContent.cmTile.view.state) {
      return cmContent.cmTile.view;
    }
    var cands = [cmEditor, cmContent, cmEditor.querySelector('.cm-scroller')];
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i];
      if (!el) continue;
      var keys = Object.keys(el);
      for (var j = 0; j < keys.length; j++) {
        try {
          var v = el[keys[j]];
          if (v && v.state && v.state.doc) return v;
          if (v && v.view && v.view.state && v.view.state.doc) return v.view;
        } catch (e) {}
      }
    }
    return null;
  }

  // Classe les .cm-editor du panneau en {schema, head, body}.
  // head/body : label adjacent au-dessus ; schema : le 1er éditeur restant (section
  // Schema markup toujours au-dessus de Custom code dans Page Settings).
  function classifyEditors() {
    // [class*="label" i] : flag i OBLIGATOIRE — les labels Webflow sont des
    // <div class="bem-Label bem-Field_Label"> (CamelCase "Label"). Sans i → 0 match (validé s590).
    var labels = Array.prototype.slice.call(document.querySelectorAll('label, [class*="label" i]'))
      .map(function(el) { return { txt: (el.textContent || '').trim(), top: el.getBoundingClientRect().top }; })
      .filter(function(l) { return l.txt && l.txt.length < 40 && (FIELD_RX.head.test(l.txt) || FIELD_RX.body.test(l.txt)); });
    var editors = Array.prototype.slice.call(document.querySelectorAll('.cm-editor'));
    var map = { schema: null, head: null, body: null };
    editors.forEach(function(ed) {
      var top = ed.getBoundingClientRect().top;
      var above = labels.filter(function(l) { return l.top < top; }).sort(function(a, b) { return b.top - a.top; })[0];
      if (above && FIELD_RX.head.test(above.txt) && !map.head) map.head = ed;
      else if (above && FIELD_RX.body.test(above.txt) && !map.body) map.body = ed;
    });
    editors.forEach(function(ed) {
      if (ed !== map.head && ed !== map.body && !map.schema) map.schema = ed;
    });
    return { map: map, editorCount: editors.length };
  }

  /**
   * Lit un champ de code de la page courante.
   * @param {object} args
   * @param {string}  [args.field='schema']   'schema' | 'head' | 'body'
   * @param {boolean} [args.keepOpen=false]   garder Page Settings ouvert après lecture
   * @param {object}  [args.waitMs]
   * @returns {Promise<object>} { ok, field, content, length, editorCount, durationMs, error? }
   */
  p._localCmd.getPageCode = async function(args) {
    args = args || {};
    var field = args.field || 'schema';
    if (VALID_FIELDS.indexOf(field) === -1) return { ok: false, error: 'field invalide: ' + field + ' (schema|head|body)' };
    var wm = args.waitMs || {};
    var D = { afterOpenMenu: wm.afterOpenMenu || 700, afterOpenSettings: wm.afterOpenSettings || 1600, afterClose: wm.afterClose || 300, afterScroll: wm.afterScroll || 800 };
    var start = Date.now();

    var opened = await openPageSettings(D);
    if (!opened.ok) return { ok: false, error: opened.error, durationMs: Date.now() - start };

    if (field === 'schema') await ensureSchemaMounted(D);
    var c = classifyEditors();
    var editor = c.map[field];
    if (!editor) {
      if (!args.keepOpen) await closePageSettings(D);
      return { ok: false, error: 'champ "' + field + '" introuvable (section repliée ?)', editorCount: c.editorCount, durationMs: Date.now() - start };
    }
    var view = getView(editor);
    if (!view) {
      if (!args.keepOpen) await closePageSettings(D);
      return { ok: false, error: 'EditorView inaccessible pour "' + field + '"', durationMs: Date.now() - start };
    }

    var content = view.state.doc.toString();
    if (!args.keepOpen) await closePageSettings(D);
    return { ok: true, field: field, content: content, length: content.length, editorCount: c.editorCount, durationMs: Date.now() - start };
  };

  /**
   * Écrit un champ de code de la page courante (remplace tout le contenu) puis Save.
   * @param {object}  args
   * @param {string}  [args.field='schema']   'schema' | 'head' | 'body'
   * @param {string}  args.content            contenu à écrire (remplace l'existant)
   * @param {boolean} [args.save=true]        true → Save (save+close) · false → laisse ouvert NON sauvegardé (inspection)
   * @param {object}  [args.waitMs]
   * @returns {Promise<object>} { ok, success, field, expectedLength, cmVerifiedLength, delta, saved, panelClosed, durationMs, error? }
   */
  p._localCmd.setPageCode = async function(args) {
    args = args || {};
    var field = args.field || 'schema';
    if (VALID_FIELDS.indexOf(field) === -1) return { ok: false, error: 'field invalide: ' + field + ' (schema|head|body)' };
    if (typeof args.content !== 'string') return { ok: false, error: 'content (string) requis' };
    var content = args.content;
    var save = args.save !== false; // défaut true
    var wm = args.waitMs || {};
    var D = {
      afterOpenMenu: wm.afterOpenMenu || 700, afterOpenSettings: wm.afterOpenSettings || 1600,
      afterWrite: wm.afterWrite || 400, afterSave: wm.afterSave || 2500, afterClose: wm.afterClose || 300,
      afterScroll: wm.afterScroll || 800
    };
    var start = Date.now();

    var opened = await openPageSettings(D);
    if (!opened.ok) return { ok: false, error: opened.error, durationMs: Date.now() - start };

    if (field === 'schema') await ensureSchemaMounted(D);
    var c = classifyEditors();
    var editor = c.map[field];
    if (!editor) return { ok: false, error: 'champ "' + field + '" introuvable (section repliée ?)', editorCount: c.editorCount, durationMs: Date.now() - start };
    var view = getView(editor);
    if (!view) return { ok: false, error: 'EditorView inaccessible pour "' + field + '"', durationMs: Date.now() - start };

    // Écriture via EditorView.dispatch (CM6) — déclenche le onChange Webflow (Save activé).
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
    await wait(D.afterWrite);

    // Vérif pre-save (ground truth CM6 · tolérance ±2 pour trailing newline).
    var after = view.state.doc.toString();
    var verifyOk = (after.length === content.length) || (Math.abs(after.length - content.length) <= 2);
    if (!verifyOk) {
      return {
        ok: false, success: false, field: field, expectedLength: content.length, cmVerifiedLength: after.length,
        delta: content.length - after.length, saved: false,
        error: 'verification echec : attendu ' + content.length + ' chars, obtenu ' + after.length,
        durationMs: Date.now() - start
      };
    }

    if (!save) {
      return {
        ok: true, success: true, field: field, expectedLength: content.length, cmVerifiedLength: after.length,
        delta: content.length - after.length, saved: false,
        note: 'panneau laissé ouvert, NON sauvegardé (save:false) — inspecter puis Save manuel ou re-appeler avec save:true',
        durationMs: Date.now() - start
      };
    }

    var saveBtn = document.querySelector('[data-automation-id="save-page-button"]');
    if (!saveBtn) return { ok: false, error: 'save-page-button introuvable', cmVerifiedLength: after.length, durationMs: Date.now() - start };
    saveBtn.click();
    await wait(D.afterSave);
    var panelClosed = !document.querySelector('[data-automation-id="page-settings-panel"]');

    return {
      ok: true, success: true, field: field, expectedLength: content.length, cmVerifiedLength: after.length,
      delta: content.length - after.length, saved: true, panelClosed: panelClosed, durationMs: Date.now() - start
    };
  };

  console.log('[PageCode] 2 commands registered: getPageCode, setPageCode (v3.30.0 s591 · Collection Pages support)');
})();

(function filterExposedCmds() {
  if (!window.__webflowHelper) {
    console.warn('[helper filter] __webflowHelper not initialized - skip filter');
    return;
  }

  var ALLOWED_CMDS = [
    'switchPage',
    'launchBridgeApp',
    'launchApp',
    'appendHtmlEmbedViaUI',
    'updateEmbedViaUI',
    'renameNode',
    'setComponentPropsViaUI',
    'setImageSettings',
    'helpEditImagesAltInComponent',
    'findNodeContext',
    'listEmbeds',
    'getEmbedContentViaUI',
    'getCurrentPageInfo',
    'dumpTree',
    'scrollToElement',
    'addClassViaUI',
    'removeLastClassViaUI',
    'removeClassFromElementViaUI',
    'renameClassViaUI',
    'duplicateClassViaUI',
    'cleanupUnusedStylesViaUI',
    'queryStyleByCombo',
    'dumpComboIndex',
    'selectNode',
    'openComponentView',
    'closeComponentView',
    'getPageCode',
    'setPageCode'
  ];

  // Wrap original run() - reject explicitly if cmd is not in whitelist
  var originalRun = window.__webflowHelper.run;
  if (typeof originalRun !== 'function') {
    console.warn('[helper filter] __webflowHelper.run not found - skip wrap');
    return;
  }

  window.__webflowHelper.run = function(cmdName, args) {
    // Reject if not whitelisted OR whitelisted-but-no-impl (drift) — both return
    // a clean CMD_NOT_EXPOSED instead of leaking the inner "Unknown command" reject.
    if (ALLOWED_CMDS.indexOf(cmdName) === -1 ||
        typeof window.__webflowHelper._localCmd[cmdName] !== 'function') {
      var msg = 'Command "' + cmdName + '" is not exposed in __webflowHelper. ' +
                'Whitelist: ' + ALLOWED_CMDS.join(', ') + '. ' +
                'Use the official Webflow MCP tool instead (or window.__webflowHelper._localCmd.' + cmdName + ' for direct access - manual audit trail).';
      console.error('[helper filter] ' + msg);
      return Promise.resolve({ ok: false, error: 'CMD_NOT_EXPOSED', message: msg });
    }
    return originalRun.call(window.__webflowHelper, cmdName, args);
  };

  // Convenience direct accessors: __webflowHelper.switchPage(args), etc.
  ALLOWED_CMDS.forEach(function(name) {
    if (typeof window.__webflowHelper._localCmd[name] !== 'function') {
      console.warn('[helper filter] _localCmd.' + name + ' not registered yet (module did not run ?)');
      return;
    }
    window.__webflowHelper[name] = function(args) {
      return window.__webflowHelper.run(name, args || {});
    };
  });

  // Integrity check — every whitelisted cmd must have a registered _localCmd impl.
  // Catches drift like a whitelist entry whose impl was removed (e.g. getEmbedContent
  // in v3.24.0): without this it would pass the whitelist gate then fail with a
  // confusing inner "Unknown command". Surfaces loudly at load instead.
  var _missingImpls = ALLOWED_CMDS.filter(function(name) {
    return typeof window.__webflowHelper._localCmd[name] !== 'function';
  });
  if (_missingImpls.length) {
    console.error('[helper filter] INTEGRITY: ' + _missingImpls.length +
      ' whitelisted cmd(s) without a _localCmd impl (drift): ' + _missingImpls.join(', ') +
      ' — they return CMD_NOT_EXPOSED. Remove from ALLOWED_CMDS or restore the impl.');
  }

  console.log('[helper filter] Exposed ' + ALLOWED_CMDS.length + ' cmds: ' + ALLOWED_CMDS.join(', '));
})();
