/* Webflow Helper v3.1.0 - 2026-05-11 */

/**
 * Webflow Helper — minimal surface, exposes 9 cmds via `__webflowHelper.run()`:
 *
 * 1. switchPage — workaround MCP de_page_tool.switch_page (~70% timeout empirically)
 * 2. launchBridgeApp — mount the Webflow MCP Bridge App via direct dispatch
 * 3. appendHtmlEmbedViaUI — create a HtmlEmbed via UI automation (Add panel + paste + Save)
 * 4. updateEmbedViaUI — write content via UI automation (CodeMirror paste + Save click)
 * 5. renameNode — rename any node (HtmlEmbed, DIV, Section, etc.) via 3 Redux dispatches (v3.1.0)
 * 6. listEmbeds — list embeds + their contents (no MCP tool)
 * 7. getEmbedContent — read a single embed's content (no MCP tool)
 * 8. getCurrentPageInfo — 3-source page concordance (DOM/URL/Redux) — MCP de_page_tool.get_current_page has 76% timeout + no DOM check
 * 9. dumpTree — full Navigator tree dump with resolved class names (MCP query_elements BETA broken)
 *
 * BREAKING v3.0.0 (s547) : removed `appendHtmlEmbedWS` (silent reject empirique :
 * server ACK received but embed not in AbstractNodeStore after 5000ms) et `setEmbedHasScript`
 * ([Conflict] component map empirique + redondant — Webflow auto-pose le flag w-script au Save UI
 * quand le content contient `<script>`). Toutes les cmds WebSocket directes `siteData:update`
 * migrées vers UI automation — résilient à la spec drift upstream Webflow.
 *
 * BREAKING v2.0.0 (s547) : removed `updateEmbed` (raw WebSocket dispatch) → `updateEmbedViaUI`.
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

  var VERSION = '3.1.0';

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
    switchPage: true
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
      return Promise.reject(new Error('[deck] Unknown command: ' + command));
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
      return Promise.reject(new Error('[deck] CASCADE_LIMIT_EXCEEDED — write #' + exceeded + ' enqueued within ' +
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
    console.log('[deck] refreshMcpBridge — navigating to', url, '(JS context will be destroyed — re-inject __webflowHelper after Designer is ready, ~5-8s)');
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

  function getReduxState() {
    return window._webflow && window._webflow.getState && window._webflow.getState();
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
 * Cmds: listEmbeds, getEmbedContent, appendHtmlEmbedViaUI, updateEmbedViaUI, renameNode.
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

  // Expose `consumeMessageId` and `getAckDispatcher` on `_internal` BEFORE the
  // core-helpers check below (legacy compat — historiquement utilisé par le module
  // appendHtmlEmbedWS retiré v3.0.0 · conservé au cas où un consommateur externe
  // accède à `_internal` directement).
  // Functions are hoisted and depend only on `store` (validated above).
  p._internal = p._internal || {};
  p._internal.consumeMessageId = consumeMessageId;
  p._internal.getAckDispatcher = getAckDispatcher;
  // embedsRegistry — était utilisé par appendHtmlEmbedWS + setEmbedHasScript (cmds
  // raw WebSocket retirées v3.0.0). Conservé pour compat éventuelle mais inutilisé
  // par les cmds UI automation actuelles (appendHtmlEmbedViaUI / updateEmbedViaUI)
  // qui lisent l'état post-Save depuis Redux via getEmbedContent. À retirer en v4.0.0
  // si aucun consommateur n'apparaît.
  if (!p._internal.embedsRegistry) p._internal.embedsRegistry = {};
  p._internal.embedsRegistryCap = 200;
  p._internal.embedsRegistryTtlMs = 30 * 60 * 1000;
  p._internal.embedsRegistrySet = function(embedId, entry) {
    // Atomic phase on snapshot to avoid TOCTOU race between concurrent set() callers.
    // Worst case: last write wins on key collision (acceptable).
    var registry = p._internal.embedsRegistry;
    var cap = p._internal.embedsRegistryCap;
    var ttl = p._internal.embedsRegistryTtlMs;
    var now = Date.now();

    // Snapshot keys before any mutation (reduces the TOCTOU window).
    var keys = Object.keys(registry);
    var toDelete = [];

    // 1. Identify stale entries (TTL exceeded).
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var entry_i = registry[k];
      if (entry_i && (now - (entry_i.updatedAt || 0)) > ttl) {
        toDelete.push(k);
      }
    }

    // 2. If still >= cap after stale purge, identify the oldest entry (LRU).
    var stillRemaining = keys.length - toDelete.length;
    if (stillRemaining >= cap) {
      var oldestKey = null;
      var oldestTs = Infinity;
      for (var j = 0; j < keys.length; j++) {
        if (toDelete.indexOf(keys[j]) !== -1) continue; // already marked for delete
        var ts = (registry[keys[j]] && registry[keys[j]].updatedAt) || 0;
        if (ts < oldestTs) { oldestTs = ts; oldestKey = keys[j]; }
      }
      if (oldestKey) toDelete.push(oldestKey);
    }

    // 3. Atomic phase: delete + set sequentially without yield.
    for (var d = 0; d < toDelete.length; d++) {
      delete registry[toDelete[d]];
    }
    registry[embedId] = entry;
  };

  // ============================================================
  // HELPERS — delegated to __webflowHelper._internal.helpers (core-helpers.js )
  // ============================================================

  // Validate core-helpers loaded — commands below disabled if absent. Le module
  // appendHtmlEmbedWS (qui consommait _internal helpers) a été retiré v3.0.0.
  var helpers = p._internal && p._internal.helpers;
  var errors = helpers.errors;
  if (!helpers) {
    console.log('[CodeEmbed] core-helpers not loaded — embed commands disabled (but _internal helpers exposed)');
    return;
  }

  var toJS = helpers.toJS;
  var getRoot = helpers.getRoot;
  var getStyleBlocksJS = helpers.getStyleBlocks;  // core returns plain JS dict, not Immutable

  // Detect presence of a <script> tag in the HTML content. Webflow sets
  // data.embed.meta.script at UI parse time and uses it to add the `w-script`
  // class at render. Without this flag, Webflow silently strips <script> at publish.
  function detectScript(content) {
    return /<script[\s>]/i.test(content);
  }

  // Read the current meta.script flag of an embed from Redux.
  function readMetaScript(node) {
    var data = node.get('data');
    if (!data) return false;
    var embed = data.get('embed');
    if (!embed) return false;
    var meta = embed.get ? embed.get('meta') : null;
    if (!meta) return false;
    return !!(meta.get ? meta.get('script') : meta.script);
  }

  // Reads the "compiled" flag from data.content for diagnostic purposes only.
  // The diff content.Distinct→"" is sent unconditionally regardless of this
  // value (UI capture showed Webflow always sends it).
  function readHasCompiledDistinct(node) {
    var data = node.get('data');
    if (!data) return false;
    var content = data.get('content');
    if (!content) return false;
    try {
      var val = content.get ? content.get('value') : null;
      if (!val) return false;
      var innerVal = val.get ? val.get('val') : null;
      return !!(innerVal && typeof innerVal === 'string' && innerVal.length > 0);
    } catch (e) { return false; }
  }

  // Webflow messageId format: <4 UUID segments>-<12-char hex counter>.
  // Example: "67a1bf38-7850-c985-9714-6cd93a1221a3" — counter is the 5th segment.
  // The UI consumes + advances the counter before sending; we replicate exactly.
  function consumeMessageId() {
    var mp = store.stores && store.stores.MultiplayerStore;
    if (!mp || !mp.state) throw new Error('MultiplayerStore not available');
    var current = mp.state.nextMessageId;
    if (!current || typeof current !== 'string') throw new Error('Invalid nextMessageId: ' + current);
    var parts = current.split('-');
    if (parts.length !== 5 || parts[4].length !== 12) {
      throw new Error('Unexpected messageId format: ' + current);
    }
    var counter = parseInt(parts[4], 16);
    if (isNaN(counter)) throw new Error('messageId counter not hex: ' + parts[4]);
    var next = (counter + 1).toString(16);
    while (next.length < 12) next = '0' + next;
    var advancedId = parts.slice(0, 4).join('-') + '-' + next;
    // Direct mutation of the Flux state (mp.state is an Immutable Record currently
    // mutable via direct assignment in this Webflow version). If Webflow tightens
    // the structure (strict Immutable), direct assignment becomes a silent no-op,
    // the counter stops advancing, the messageId is reused, and the server
    // silently rejects the second push.
    //
    // Verify post-mutation: if direct assignment was a silent no-op, fall back
    // to .set() or throw.
    try {
      mp.state.nextMessageId = advancedId;
    } catch (e) {
      if (mp.state.set) { mp.state = mp.state.set('nextMessageId', advancedId); }
      else { throw e; }
    }
    // Verify: if direct mutation was silently ignored (strict Immutable),
    // mp.state.nextMessageId is still === current → fall back to .set() or throw.
    if (mp.state.nextMessageId === current) {
      if (mp.state.set) {
        mp.state = mp.state.set('nextMessageId', advancedId);
        if (mp.state.nextMessageId !== advancedId) {
          throw new Error('messageId counter mutation was a silent no-op (strict Immutable?) — current=' + current);
        }
      } else {
        throw new Error('messageId counter mutation failed (no .set fallback) — current=' + current);
      }
    }
    return current;
  }

  // ACK dispatcher — singleton listener registered once per event, dispatching
  // to per-messageId handlers via a shared map. Avoids the broken pattern of
  // attach/restore on every push (a 2nd push's restore would wipe handlers
  // installed by a 1st concurrent push).
  //
  // Invalidation on socket reconnect: if the WebSocket is replaced (reconnect,
  // page navigation), handlers on the old socket never receive ACKs and pending
  // pushes hang. The dispatcher memorizes the socket and resets when it changes,
  // notifying pending handlers via onError (not silently dropped).
  var _ackDispatcher = null;
  var _ackDispatcherSocket = null;
  function getAckDispatcher() {
    var mp = store.stores && store.stores.MultiplayerStore;
    var socket = mp && mp.state && mp.state.socket;
    var innerSocket = socket && socket.socket;
    if (!innerSocket || !innerSocket._callbacks) {
      throw new Error('Inner socket or _callbacks not available');
    }
    // Reset if the socket has changed (reconnect / navigation)
    if (_ackDispatcher && _ackDispatcherSocket !== innerSocket) {
      var pending = Object.keys(_ackDispatcher.handlers);
      console.warn('[CodeEmbed] socket changed — resetting _ackDispatcher (' +
        pending.length + ' pending handlers, calling onError before reset)');
      for (var i = 0; i < pending.length; i++) {
        var msgId = pending[i];
        var h = _ackDispatcher.handlers[msgId];
        if (h && h.onError) {
          try {
            h.onError({ messageId: msgId, error: errors.SOCKET_RECONNECT_DROPPED });
          } catch (e) {
            console.warn('[CodeEmbed] handler.onError threw during reset:', e.message);
          }
        }
        delete _ackDispatcher.handlers[msgId];
      }
      _ackDispatcher = null;
      _ackDispatcherSocket = null;
    }
    if (_ackDispatcher) return _ackDispatcher;

    _ackDispatcher = { handlers: {} };
    _ackDispatcherSocket = innerSocket;

    var onSuccess = function(d) {
      if (!d || !d.messageId) return;
      var h = _ackDispatcher.handlers[d.messageId];
      if (h && h.onSuccess) {
        delete _ackDispatcher.handlers[d.messageId];
        h.onSuccess(d);
      }
    };
    var onError = function(d) {
      if (!d || !d.messageId) return;
      var h = _ackDispatcher.handlers[d.messageId];
      if (h && h.onError) {
        delete _ackDispatcher.handlers[d.messageId];
        h.onError(d);
      }
    };

    // Append (do not replace) to preserve existing Webflow handlers.
    var existingS = innerSocket._callbacks['$siteData:updateSuccess'] || [];
    var existingE = innerSocket._callbacks['$siteData:updateError'] || [];
    innerSocket._callbacks['$siteData:updateSuccess'] = existingS.concat([onSuccess]);
    innerSocket._callbacks['$siteData:updateError'] = existingE.concat([onError]);

    return _ackDispatcher;
  }

  // ============================================================
  // COMMANDS
  // ============================================================

  /**
   * List every HtmlEmbed on the current page.
   * @returns {{ ok: boolean, count: number, embeds: Array<{id: string, classes: string[], length: number, preview: string}> }}
   */
  p._localCmd.listEmbeds = function() {
    var root = getRoot();
    if (!root) return { ok: false, error: 'No root node' };
    var allBlocks = getStyleBlocksJS();
    var embeds = [];

    helpers.walkTree(root, function(node) {
      if (node.get('type') !== 'HtmlEmbed') return;
      var data = node.get('data');
      if (!data) return;
      var value = data.get('value') || '';
      var sbIds = data.get('styleBlockIds');
      var arr = sbIds ? toJS(sbIds) : [];
      var classes = arr.map(function(sid) {
        var b = allBlocks[sid];
        return b ? b.name : sid;
      });
      embeds.push({
        id: node.get('id'),
        classes: classes,
        length: value.length,
        preview: value.substring(0, 120)
      });
    }, 30, 0);

    return { ok: true, count: embeds.length, embeds: embeds };
  };

  /**
   * Read the full content of an embed.
   * @param {{ embedId: string }} args
   * @returns {{ ok: boolean, id?: string, value?: string, length?: number, error?: string }}
   */
  p._localCmd.getEmbedContent = function(args) {
    var embedId = args.embedId;
    if (!embedId) return { ok: false, error: 'embedId required' };

    var root = getRoot();
    var node = helpers.findNodeByIdInTree(root, embedId, { maxDepth: 30 });
    if (!node) return { ok: false, error: 'Node not found: ' + embedId };
    if (node.get('type') !== 'HtmlEmbed') return { ok: false, error: 'Node is not an HtmlEmbed: ' + node.get('type') };

    var data = node.get('data');
    var value = data ? (data.get('value') || '') : '';
    return { ok: true, id: embedId, value: value, length: value.length };
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
   *   7. Click "Save & Close" button
   *   8. (Component only) Exit component view via body.click
   *   9. Validate via getEmbedContent
   *
   * @param {object} args
   * @param {string} args.embedId
   * @param {string} args.content                Max ~50K chars (CodeMirror paste handles large fine, server-side limit applies)
   * @param {object} [args.waitMs]               Override per-step delays (afterDeselect, afterDblClick, afterSelect, afterSettingsTab, afterOpenEditor, afterPaste, afterSave, afterExitComponent)
   * @returns {Promise<object>} `{ ok, success, embedId, expectedLength, actualLength, delta, inComponent, componentInstanceId, durationMs, error? }`
   *
   * @see docs/lessons/webflow-helper-canon.md §updateembedviaui — reverse-engineered selectors + edge cases (session s547)
   */
  p._localCmd.updateEmbedViaUI = async function(args) {
    args = args || {};
    var embedId = args.embedId;
    var content = args.content;
    var waitMs = args.waitMs || {};

    if (!embedId) return { ok: false, error: 'embedId required' };
    if (typeof content !== 'string') return { ok: false, error: 'content (string) required' };

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
      if (!embedEl) return { ok: false, error: 'embed not found in canvas DOM', embedId: embedId };
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

    // STEP 9: Validate via getEmbedContent (synchronous read from Redux post-Save)
    var verify = p._localCmd.getEmbedContent({ embedId: embedId });
    var success = !!(verify && verify.ok && verify.value === content);

    return {
      ok: success,
      success: success,
      embedId: embedId,
      expectedLength: content.length,
      actualLength: verify && verify.length,
      delta: content.length - ((verify && verify.length) || 0),
      inComponent: isInComponent,
      componentInstanceId: componentInstanceId,
      durationMs: Date.now() - start,
      error: success ? undefined : 'content verification mismatch after save (expected ' + content.length + ' chars, got ' + (verify && verify.length) + ')',
      verify_ok: !!(verify && verify.ok)
    };
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
   *   8. Validate via getEmbedContent
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
   * @see docs/lessons/webflow-helper-canon.md §appendhtmlembedviaui
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

    // STEP 8: Validate via getEmbedContent
    var verify = p._localCmd.getEmbedContent({ embedId: newEmbedId });
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
   * @see docs/lessons/webflow-helper-canon.md §renamenode
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

  console.log('[CodeEmbed] 5 commands registered: listEmbeds, getEmbedContent, appendHtmlEmbedViaUI, updateEmbedViaUI, renameNode.');
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
    var ps = stores && stores.PageStore && stores.PageStore.state;
    if (!ps) return null;
    var sps = ps.get && ps.get('staticPages');
    if (!sps || !sps.find) return null;
    return sps.find(function(p) {
      return p && p.get && p.get('id') === pageId;
    }) || null;
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
      var sps = stores.PageStore.state.get('staticPages');
      if (sps) sps.forEach(function(p) {
        if (p && p.get) available.push({ id: p.get('id'), name: p.get('name') });
      });
      return {
        ok: false,
        error: errors.PAGE_NOT_FOUND,
        message: 'page_id "' + pageId + '" not found in PageStore.staticPages',
        available_pages: available.slice(0, 20),
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
      var body = getBody();
      var counts = {
        total_elements: 0,
        sections: 0,
        embeds: 0,
        symbols: 0,
        images: 0,
        headings: 0,
        links: 0
      };
      var bodyId = body ? body.get('id') : null;
      if (body) {
        helpers.walkTree(body, function(node) {
          counts.total_elements++;
          var t = node.get && node.get('type');
          if (t === 'Section') counts.sections++;
          else if (t === 'HtmlEmbed') counts.embeds++;
          else if (t === 'Symbol') counts.symbols++;
          else if (t === 'Image') counts.images++;
          else if (t === 'Heading') counts.headings++;
          else if (t === 'Link' || t === 'TextLink' || t === 'LinkBlock') counts.links++;
        });
      }
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
   * Build a tree entry from a node + depth + context (sbs, opts).
   * Pure function — no side effects.
   */
  function buildEntry(node, depth, sbs, opts) {
    var type = node.get && node.get('type');
    var id = node.get && node.get('id');
    var data = node.get && node.get('data');
    var tag = (data && data.get) ? (data.get('tag') || null) : null;

    // classes
    var classes = [];
    try {
      var sbIds = data && data.get && data.get('styleBlockIds');
      var arr = sbIds && sbIds.toJS ? sbIds.toJS() : (Array.isArray(sbIds) ? sbIds : []);
      classes = arr.map(function(s) { return (sbs && sbs[s] && sbs[s].name) || s; });
    } catch (e) { classes = []; }

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
    } else {
      entry = { depth: depth, type: type, tag: tag, id: id, classes: classes };
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
   * @param {string}  [args.rootId]            v1.6.0 — Scope walk to subtree rooted at this node ID (default: body root). Reduces payload 5-10× when working in a known subsection. Returns error if ID not found.
   * @param {boolean} [args.includeParent=false] v1.6.0 — Add `parent_id` field to each entry (computed via depth-based stack during walk). Replaces the JS-side `findIndex + walk back` pattern. Only set when not compact. Skipped on virtual nodes from expandComponents.
   * @returns {{ ok: boolean, count: number, total_walked: number, expanded?: number, tree: Array, hint?: string, scoped_to?: string, error?: string }}
   *
   * v1.6.0 hint heuristics: when count===0, the response includes a `hint` field describing the most likely cause (low maxDepth, page not loaded, class spelling, text on non-text-bearing nodes). Empty hint = filter just doesn't match anything.
   */
  p._localCmd.dumpTree = function(args) {
    args = args || {};
    var maxDepth = typeof args.maxDepth === 'number' ? args.maxDepth : 50;
    var filterType = args.filterType || null;
    var filterClassLower = args.filterClass ? String(args.filterClass).toLowerCase() : null;
    var filterTextLower = args.filterText ? String(args.filterText).toLowerCase() : null;
    var includeEmpty = args.includeEmpty !== false;
    var compact = args.compact === true;
    var expandComponents = args.expandComponents === true;
    var hideTemplateRoots = args.hideTemplateRoots === true;
    var rootIdScope = args.rootId || null;          // v1.6.0
    var includeParent = args.includeParent === true; // v1.6.0
    var entryOpts = {
      compact: compact,
      includeText: args.includeText !== false && !compact,
      includeAttr: args.includeAttr !== false && !compact,
      includeXattr: args.includeXattr !== false && !compact
    };

    // v1.6.0 — root scoping
    var root;
    if (rootIdScope) {
      root = helpers.findNodeById(rootIdScope);
      if (!root) return { ok: false, error: 'Node not found by id: ' + rootIdScope };
    } else {
      root = helpers.getRoot();
      if (!root) return { ok: false, error: 'No root node — Designer not loaded?' };
    }

    // Resolve styleBlocks once for the entire walk.
    var sbs = null;
    try {
      var state = helpers.getReduxState();
      var sbStore = state && state.StyleBlockStore;
      if (sbStore && sbStore.get) {
        var blocks = sbStore.get('styleBlocks');
        sbs = blocks && blocks.toJS ? blocks.toJS() : blocks;
      }
    } catch (e) { sbs = null; }

    // Pre-walk: index template roots (data.sym.root === true) by node id.
    // Templates live at depth 1 of root in Webflow's flat AbstractNodeStore.
    // Lookup is by data.sym.inst from Symbol instances.
    var templatesById = {};
    if (expandComponents) {
      try {
        helpers.walkTree(root, function(n) {
          var d = n.get && n.get('data');
          var s = d && d.get && d.get('sym');
          if (s && s.get && s.get('root') === true) {
            templatesById[n.get('id')] = n;
          }
        }, { maxDepth: 5 });
      } catch (e) { /* fail silently — feature degrades to non-expand */ }
    }

    var out = [];
    var totalWalked = 0;
    var expandedCount = 0;
    var parentStack = []; // v1.6.0 — [{ depth, id }] for includeParent

    function applyFiltersAndPush(entry, type, classes, text) {
      if (filterType && type !== filterType) return;
      if (filterClassLower) {
        var match = classes.some(function(c) {
          return typeof c === 'string' && c.toLowerCase().indexOf(filterClassLower) !== -1;
        });
        if (!match) return;
      }
      if (filterTextLower) {
        if (!text || text.toLowerCase().indexOf(filterTextLower) === -1) return;
      }
      if (!includeEmpty && classes.length === 0 && type !== 'Section' && type !== 'Body') return;
      out.push(entry);
    }

    helpers.walkTree(root, function(node, depth) {
      totalWalked++;

      // v1.6.0 — maintain parent stack for includeParent
      while (parentStack.length > 0 && parentStack[parentStack.length - 1].depth >= depth) {
        parentStack.pop();
      }

      var built = buildEntry(node, depth, sbs, entryOpts);

      // hideTemplateRoots: skip nodes that are template roots at the natural depth 1
      if (hideTemplateRoots && expandComponents && depth === 1 && built.symInfo && built.symInfo.root === true) {
        // Still update parent stack for descendants
        var skippedId = node.get && node.get('id');
        if (skippedId) parentStack.push({ depth: depth, id: skippedId });
        return;
      }

      // v1.6.0 — set parent_id from stack top if includeParent + not compact
      if (includeParent && !compact && parentStack.length > 0) {
        built.entry.parent_id = parentStack[parentStack.length - 1].id;
      }

      // Push current node on stack BEFORE filters/expand (children of current node need its id as parent)
      var currentId = node.get && node.get('id');
      if (currentId) parentStack.push({ depth: depth, id: currentId });

      applyFiltersAndPush(built.entry, built.type, built.classes, built.text);

      // expandComponents: for Symbol instances, walk their template inline
      if (expandComponents && built.type === 'Symbol' && built.symInfo && built.symInfo.inst) {
        var template = templatesById[built.symInfo.inst];
        if (template) {
          var templateChildren = template.get('children');
          if (templateChildren && templateChildren.forEach) {
            templateChildren.forEach(function(childNode) {
              // Recursive walk of template subtree, with depth offset = symbol.depth + 1
              helpers.walkTree(childNode, function(tNode, tDepth) {
                expandedCount++;
                var tBuilt = buildEntry(tNode, depth + 1 + tDepth, sbs, entryOpts);
                if (!compact) {
                  tBuilt.entry.fromTemplate = built.symInfo.inst;
                  if (built.symInfo.name) tBuilt.entry.fromComponent = built.symInfo.name;
                }
                applyFiltersAndPush(tBuilt.entry, tBuilt.type, tBuilt.classes, tBuilt.text);
              }, { maxDepth: maxDepth });
            });
          }
        }
      }
    }, { maxDepth: maxDepth });

    var result = { ok: true, count: out.length, total_walked: totalWalked, tree: out };
    if (expandComponents) result.expanded = expandedCount;
    if (rootIdScope) result.scoped_to = rootIdScope;

    // v1.6.0 — hint heuristics for count===0
    if (out.length === 0) {
      var hint = null;
      var hasFilter = !!(filterClassLower || filterTextLower || filterType);
      if (hasFilter && totalWalked < 50) {
        hint = 'Tree shallow (' + totalWalked + ' nodes walked) — page may not be fully loaded · check Designer page tab + reload if needed';
      } else if (filterClassLower && maxDepth < 12 && totalWalked < 200) {
        hint = "No match for class '" + args.filterClass + "' at maxDepth=" + maxDepth + " (walked " + totalWalked + ') — Webflow cards typically at depth 8-10, try maxDepth>=12 or remove maxDepth (default 50)';
      } else if (filterClassLower) {
        hint = "No match for class '" + args.filterClass + "' (case-insensitive substring · walked " + totalWalked + ') — check spelling';
      } else if (filterTextLower) {
        hint = "No match for text '" + args.filterText + "' — text only checked on text-bearing types (Heading, Paragraph, TextLink, Button, Span, Link, NavbarLink, DropdownLink, NavbarBrand, FormBlockLabel, Blockquote) · try filterClass instead";
      } else if (filterType) {
        hint = "No node of type '" + args.filterType + "' (walked " + totalWalked + ')';
      }
      if (hint) result.hint = hint;
    }

    return result;
  };

  console.log('[TreeDump] 1 command registered: dumpTree');
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

  function findBridgeApp() {
    var wf = getWfFromTop();
    if (!wf || !wf.stores || !wf.stores.AppsStore) return null;
    var state = wf.stores.AppsStore.state;
    if (!state) return null;
    var apps = null;
    try {
      apps = state.get ? state.get('installedApps') : state.installedApps;
      if (apps && typeof apps.toJS === 'function') apps = apps.toJS();
    } catch (e) { return null; }
    if (!Array.isArray(apps)) return null;
    return apps.find(function(a) {
      var name = (a && (a.name || a.appName || a.displayName) || '').toLowerCase();
      return name.indexOf('mcp bridge') !== -1 || name.indexOf('webflow mcp') !== -1;
    }) || null;
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
   * Mount the Webflow MCP Bridge App by dispatching `EXTENSION_OPEN` directly.
   * Auto-resolves the appId from `AppsStore.installedApps[*]` so no hard-coded hash
   * is needed. Idempotent : if the iframe is already mounted, returns immediately.
   *
   * @param {object} [args]
   * @param {number}  [args.wait_ms=3000]   Maximum wait for the iframe to appear.
   * @param {boolean} [args.strict=true]    Return `ok:false` if not converged.
   * @param {boolean} [args.minimized=true] Auto-minimize after mount (the open Bridge
   *   window covers the canvas).
   * @returns {Promise<object>}
   */
  p._localCmd.launchBridgeApp = async function(args) {
    var startTs = Date.now();
    args = args || {};
    var waitMs = typeof args.wait_ms === 'number' ? args.wait_ms : 3000;
    var strict = args.strict !== false;
    // Default minimized = true (the open Bridge App window covers the canvas).
    var minimized = args.minimized !== false;

    // Idempotent: if Bridge is already active, return immediately (option: minimize anyway).
    if (isBridgeIframePresent()) {
      if (minimized) {
        try {
          dispatchExtensionAction('EXTENSION_WINDOW_MODE_TOGGLE', { minimized: true });
        } catch (e) {}
      }
      return {
        ok: true,
        already_active: true,
        minimized_applied: minimized,
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

    return {
      ok: converged,
      bridge_app_id: bridge.id,
      bridge_app_name: bridge.name,
      iframe_mounted_after_ms: converged ? Date.now() - startTs - 500 : null,
      minimized_applied: minimize_applied,
      duration_ms: Date.now() - startTs,
      note: 'Bridge mounted + handshake assumed complete after 500ms wait'
    };
  };

})();

// ============================================================================
// Filter exposed cmds to whitelist (7 public commands)
// ============================================================================
// The bundle above registers more cmds in `_localCmd` than the public surface
// (some are internal helpers used between modules above). This filter wraps `run()` so that
// only the 7 whitelisted cmds are callable via `__webflowHelper.run(name)`.
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
//
// NOTE v3.0.0 : setEmbedHasScript retirée (redundant — Webflow auto-pose le flag w-script
// au Save UI quand le content contient `<script>`).
//
// Bypass: `window.__webflowHelper._localCmd.X(args)` is still callable for
// debugging or one-off direct access (manual audit trail). The wrapper only
// gates `__webflowHelper.run('X', args)`.
// ============================================================================

(function filterExposedCmds() {
  if (!window.__webflowHelper) {
    console.warn('[helper filter] __webflowHelper not initialized - skip filter');
    return;
  }

  var ALLOWED_CMDS = [
    'switchPage',
    'launchBridgeApp',
    'appendHtmlEmbedViaUI',
    'updateEmbedViaUI',
    'renameNode',
    'listEmbeds',
    'getEmbedContent',
    'getCurrentPageInfo',
    'dumpTree'
  ];

  // Wrap original run() - reject explicitly if cmd is not in whitelist
  var originalRun = window.__webflowHelper.run;
  if (typeof originalRun !== 'function') {
    console.warn('[helper filter] __webflowHelper.run not found - skip wrap');
    return;
  }

  window.__webflowHelper.run = function(cmdName, args) {
    if (ALLOWED_CMDS.indexOf(cmdName) === -1) {
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

  console.log('[helper filter] Exposed ' + ALLOWED_CMDS.length + ' cmds: ' + ALLOWED_CMDS.join(', '));
})();
