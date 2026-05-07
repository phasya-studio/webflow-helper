/* Webflow Helper v1.3.0 - 2026-05-08 */

/**
 * Webflow Helper — minimal surface, exposes 8 cmds via `__webflowHelper.run()`:
 *
 * 1. switchPage — workaround MCP de_page_tool.switch_page (~70% timeout empirically)
 * 2. launchBridgeApp — mount the Webflow MCP Bridge App via direct dispatch
 * 3. appendHtmlEmbedWS — create a native HtmlEmbed (no MCP tool covers this)
 * 4. updateEmbed — write content to an existing embed (no MCP tool)
 * 5. listEmbeds — list embeds + their contents (no MCP tool)
 * 6. getEmbedContent — read a single embed's content (no MCP tool)
 * 7. setEmbedHasScript — set the w-script flag retroactively (no MCP tool)
 * 8. getCurrentPageInfo — 3-source page concordance (DOM/URL/Redux) — MCP de_page_tool.get_current_page has 76% timeout + no DOM check
 *
 * Any other cmd called via `__webflowHelper.run('X')` returns
 * `{ ok: false, error: 'CMD_NOT_EXPOSED' }`. Everything else uses the official MCP server.
 *
 * Source: extracted from a Webflow Designer "deck" toolkit (full bundle archived
 * at `tools/_archive/webflow-deck-v9.6.0.js`). Modules retained:
 * Bridge init + run() + write queue, Core Helpers (Redux+DOM), CodeEmbed,
 * appendHtmlEmbedWS, switchPage, launchBridgeApp helpers, whitelist filter.
 */

(function() {
  'use strict';

  var VERSION = '1.3.0';

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
    appendHtmlEmbedWS: true,
    updateEmbed: true,
    setEmbedHasScript: true,
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
 * Cmds: listEmbeds, getEmbedContent, updateEmbed, setEmbedHasScript.
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
  // core-helpers check below so the appendHtmlEmbedWS module (later in this file)
  // gets them even if core-helpers fails to load (degraded environment).
  // Functions are hoisted and depend only on `store` (validated above).
  p._internal = p._internal || {};
  p._internal.consumeMessageId = consumeMessageId;
  p._internal.getAckDispatcher = getAckDispatcher;
  // embedsRegistry — shared between appendHtmlEmbedWS (write) and updateEmbed/
  // setEmbedHasScript (read fallback) so updateEmbed works immediately after a
  // creation without waiting for Redux dispatch. Cap LRU 200 + TTL 30 min to avoid
  // memory leak in long sessions. Key = embedId, value = {value, hasScript, parentId,
  // createdAt, updatedAt}.
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

  // Validate core-helpers loaded — commands below disabled if absent, but
  // _internal helpers above stay exposed for the appendHtmlEmbedWS module below.
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
   * Write content to an existing HtmlEmbed via WebSocket `siteData:update`.
   *
   * Algorithm (reverse-engineered from the UI save), in exact order :
   *   1. embed.meta.html (Text, oldValue → newValue)
   *   2. embed.meta.script (Boolean) — inserted between 1 and 3 only when scriptFlagChanged
   *   3. content.Distinct (Text, oldValue → "") — REQUIRED even when Redux says
   *      the content is not "compiled". Without this diff, the server ACKs success
   *      but ignores the mutation (100% reproducible silent reject).
   *   4. value (Text, oldValue → newValue)
   *
   * @param {object} args
   * @param {string} args.embedId
   * @param {string} args.content
   * @param {string}  [args.forceOldValue]      Override the oldValue read from Redux
   *   when local Redux drifted from the server (e.g. after a previous push that did
   *   not dispatch Redux).
   * @param {boolean} [args.forceOldHasScript]  Override the script flag read from Redux.
   * @returns {Promise<object>} `{ ok, serverConfirmed, id, messageId, oldLength, newLength,
   *   diffCount, scriptFlagChanged, wasCompiled, sourceOldValue, durationMs }` on success ;
   *   `{ ok: false, error, ... }` otherwise.
   *
   * @see docs/lessons/webflow-mcp.md §updateembed-v87-fix
   */
  p._localCmd.updateEmbed = function(args) {
    var embedId = args.embedId;
    var content = args.content;
    var forceOldValue = args.forceOldValue;
    var forceOldHasScript = args.forceOldHasScript;

    if (!embedId) return Promise.resolve({ ok: false, error: 'embedId required' });
    if (typeof content !== 'string') return Promise.resolve({ ok: false, error: 'content (string) required' });
    if (content.length > 50000) {
      return Promise.resolve({ ok: false, error: 'Content exceeds 50,000 character limit (' + content.length + ' chars)' });
    }

    // Registry fallback when the node is not in Redux. appendHtmlEmbedWS populates
    // _internal.embedsRegistry after creation so updateEmbed works immediately
    // without waiting for a Redux dispatch (which never comes after a WS create).
    var root = getRoot();
    var node = helpers.findNodeByIdInTree(root, embedId, { maxDepth: 30 });
    var registry = (p._internal && p._internal.embedsRegistry) || {};
    var cached = registry[embedId];

    var oldValue, oldLength, oldHasScript, wasCompiled, sourceRedux;
    if (node) {
      if (node.get('type') !== 'HtmlEmbed') return Promise.resolve({ ok: false, error: 'Node is not an HtmlEmbed: ' + node.get('type') });
      var data = node.get('data');
      var actualOld = data ? (data.get('value') || '') : '';
      oldValue = typeof forceOldValue === 'string' ? forceOldValue : actualOld;
      oldHasScript = typeof forceOldHasScript === 'boolean' ? forceOldHasScript : readMetaScript(node);
      wasCompiled = readHasCompiledDistinct(node);
      sourceRedux = 'redux';
    } else if (cached) {
      // Node not in Redux but we have a trace in the registry.
      oldValue = typeof forceOldValue === 'string' ? forceOldValue : (cached.value || '');
      oldHasScript = typeof forceOldHasScript === 'boolean' ? forceOldHasScript : !!cached.hasScript;
      wasCompiled = false; // best-effort; the content.Distinct diff is always sent anyway
      sourceRedux = 'registry';
    } else if (typeof forceOldValue === 'string') {
      // Last resort: caller provides oldValue explicitly.
      oldValue = forceOldValue;
      oldHasScript = typeof forceOldHasScript === 'boolean' ? forceOldHasScript : false;
      wasCompiled = false;
      sourceRedux = 'forced';
    } else {
      return Promise.resolve({ ok: false, error: 'Node not found in Redux nor in registry: ' + embedId + ' (passez forceOldValue si embed externe)' });
    }
    oldLength = oldValue.length;
    var newHasScript = detectScript(content);
    var scriptFlagChanged = oldHasScript !== newHasScript;

    // Skip if nothing to do (uses resolved oldValue, not actualOld).
    if (oldValue === content && !scriptFlagChanged) {
      return Promise.resolve({ ok: true, id: embedId, oldLength: oldLength, newLength: content.length, match: true, skipped: true });
    }

    // Socket + pageId + localeId
    var mp = store.stores ? store.stores.MultiplayerStore : null;
    var socket = mp && mp.state ? mp.state.socket : null;
    if (!socket || !socket.send) {
      return Promise.resolve({ ok: false, error: 'MultiplayerStore socket not available' });
    }

    var state = store.getState();
    var pageId = null;
    var pageStore = state.PageStore;
    if (pageStore && pageStore.get) pageId = pageStore.get('id') || null;
    if (!pageId && state.SiteDataStore) pageId = state.SiteDataStore.pageId || null;
    if (!pageId) return Promise.resolve({ ok: false, error: 'Cannot resolve pageId' });

    var localeId = null;
    var localizationStore = store.stores.LocalizationStore;
    if (localizationStore && localizationStore.state) {
      var current = localizationStore.state.currentLocale;
      var primary = localizationStore.state.primaryLocale;
      localeId = (current && current._id) || (primary && primary._id) || null;
    }

    // Consume messageId (advances the counter as the UI does).
    var messageId;
    try { messageId = consumeMessageId(); }
    catch (e) { return Promise.resolve({ ok: false, error: 'Cannot consume messageId: ' + e.message }); }

    // Build expressionDiff in the exact order captured from the UI save:
    //   1. embed.meta.html
    //   2. embed.meta.script (if scriptFlagChanged)
    //   3. content.Distinct → "" (ALWAYS — without this diff the server
    //      ACKs but does not apply, 100% silent reject)
    //   4. value
    var expressionDiff = [];
    expressionDiff.push({
      type: 'update',
      path: [{ in: 'Record', at: 'embed' }, { in: 'Record', at: 'meta' }, { in: 'Record', at: 'html' }],
      oldValue: helpers.wrap.text(oldValue),
      newValue: helpers.wrap.text(content),
      elementId: embedId
    });
    if (scriptFlagChanged) {
      expressionDiff.push({
        type: 'update',
        path: [{ in: 'Record', at: 'embed' }, { in: 'Record', at: 'meta' }, { in: 'Record', at: 'script' }],
        oldValue: helpers.wrap.boolean(oldHasScript),
        newValue: helpers.wrap.boolean(newHasScript),
        elementId: embedId
      });
    }
    expressionDiff.push({
      type: 'update',
      path: [{ in: 'Record', at: 'content' }, { in: 'Distinct' }],
      oldValue: helpers.wrap.text(oldValue),
      newValue: helpers.wrap.text(''),
      elementId: embedId
    });
    expressionDiff.push({
      type: 'update',
      path: [{ in: 'Record', at: 'value' }],
      oldValue: helpers.wrap.text(oldValue),
      newValue: helpers.wrap.text(content),
      elementId: embedId
    });

    var wsMessage = {
      type: 'siteData:update',
      payload: {
        messageId: messageId,
        pageId: pageId,
        localeId: localeId,
        actionType: 'HTML_EMBED_TEXT_SAVED',
        operations: {
          components: [{
            type: 'expressionChanged',
            componentName: ['__SitePlugin', 'page'],
            expressionDiff: expressionDiff
          }]
        }
      }
    };

    // Register ACK handler via singleton dispatcher, then fire-and-forget send.
    // socket.send returns a Promise that rejects with "Cannot read properties
    // of undefined (reading slice)" for some payloads — we ignore it.
    return new Promise(function(resolve) {
      var dispatcher;
      try { dispatcher = getAckDispatcher(); }
      catch (e) { return resolve({ ok: false, error: 'Dispatcher init failed: ' + e.message }); }

      var t0 = Date.now();
      var timeout = setTimeout(function() {
        if (dispatcher.handlers[messageId]) {
          delete dispatcher.handlers[messageId];
          resolve({
            ok: false,
            error: 'Timeout 10s (no server ACK)',
            messageId: messageId,
            diffCount: expressionDiff.length,
            scriptFlagChanged: scriptFlagChanged,
            wasCompiled: wasCompiled
          });
        }
      }, 10000);

      dispatcher.handlers[messageId] = {
        onSuccess: function(_d) {
          clearTimeout(timeout);
          // Sync internal registry for future updates (LRU+TTL purge applied).
          try {
            var existing = p._internal.embedsRegistry[embedId] || {};
            p._internal.embedsRegistrySet(embedId, {
              value: content,
              hasScript: newHasScript,
              parentId: existing.parentId,
              createdAt: existing.createdAt || Date.now(),
              updatedAt: Date.now()
            });
          } catch (e) { console.warn('[CodeEmbed] registry sync skip:', e.message); }
          resolve({
            ok: true,
            serverConfirmed: true,
            id: embedId,
            messageId: messageId,
            oldLength: oldLength,
            newLength: content.length,
            diffCount: expressionDiff.length,
            scriptFlagChanged: scriptFlagChanged,
            wasCompiled: wasCompiled,
            sourceOldValue: sourceRedux,
            durationMs: Date.now() - t0
          });
        },
        onError: function(d) {
          clearTimeout(timeout);
          resolve({
            ok: false,
            serverRejected: true,
            messageId: messageId,
            error: (d && d.error && d.error.message) || 'server error',
            full: d
          });
        }
      };

      try {
        var sendResult = socket.send([wsMessage]);
        // Ignore rejected Promise (timeout wrapper bug for some payloads).
        if (sendResult && typeof sendResult.then === 'function') {
          sendResult.catch(function() {});
        } else if (Array.isArray(sendResult)) {
          sendResult.forEach(function(r) { if (r && r.catch) r.catch(function() {}); });
        }
      } catch (e) {
        // Synchronous throw — clean up handler + reject.
        delete dispatcher.handlers[messageId];
        clearTimeout(timeout);
        resolve({ ok: false, error: 'socket.send threw: ' + e.message, messageId: messageId });
      }
    });
  };

  /**
   * Retroactively fix the `meta.script` flag on an existing HtmlEmbed (controls the
   * `w-script` class added at render time). Same mechanism as updateEmbed (singleton
   * dispatcher + consumeMessageId).
   *
   * @param {object} args
   * @param {string}  args.embedId
   * @param {boolean} [args.hasScript]          Target value. If undefined, auto-detected
   *   from the embed's current content.
   * @param {boolean} [args.forceOldHasScript]  Override the flag read from Redux for
   *   comparison. Useful when local Redux drifted from the server (e.g. after a previous
   *   push that did not dispatch Redux).
   * @returns {Promise<object>} `{ ok, serverConfirmed, id, messageId, oldHasScript,
   *   newHasScript, autoDetected }` on success ; `{ ok: false, error, ... }` otherwise.
   */
  p._localCmd.setEmbedHasScript = function(args) {
    var embedId = args.embedId;
    var forcedValue = args.hasScript;
    var forceOldHasScript = args.forceOldHasScript;

    if (!embedId) return Promise.resolve({ ok: false, error: 'embedId required' });

    var root = getRoot();
    var node = helpers.findNodeByIdInTree(root, embedId, { maxDepth: 30 });
    if (!node) return Promise.resolve({ ok: false, error: 'Node not found: ' + embedId });
    if (node.get('type') !== 'HtmlEmbed') return Promise.resolve({ ok: false, error: 'Node is not an HtmlEmbed: ' + node.get('type') });

    var data = node.get('data');
    var content = data ? (data.get('value') || '') : '';
    var oldHasScript = typeof forceOldHasScript === 'boolean' ? forceOldHasScript : readMetaScript(node);
    var newHasScript = (typeof forcedValue === 'boolean') ? forcedValue : detectScript(content);

    if (oldHasScript === newHasScript) {
      return Promise.resolve({ ok: true, id: embedId, hasScript: newHasScript, skipped: true, reason: 'already set' });
    }

    var mp = store.stores ? store.stores.MultiplayerStore : null;
    var socket = mp && mp.state ? mp.state.socket : null;
    if (!socket || !socket.send) return Promise.resolve({ ok: false, error: 'Socket not available' });

    var state = store.getState();
    var pageId = null;
    var pageStore = state.PageStore;
    if (pageStore && pageStore.get) pageId = pageStore.get('id') || null;
    if (!pageId && state.SiteDataStore) pageId = state.SiteDataStore.pageId || null;
    if (!pageId) return Promise.resolve({ ok: false, error: 'Cannot resolve pageId' });

    var localeId = null;
    var localizationStore = store.stores.LocalizationStore;
    if (localizationStore && localizationStore.state) {
      var current = localizationStore.state.currentLocale;
      var primary = localizationStore.state.primaryLocale;
      localeId = (current && current._id) || (primary && primary._id) || null;
    }

    var messageId;
    try { messageId = consumeMessageId(); }
    catch (e) { return Promise.resolve({ ok: false, error: 'Cannot consume messageId: ' + e.message }); }

    var wsMessage = {
      type: 'siteData:update',
      payload: {
        messageId: messageId,
        pageId: pageId,
        localeId: localeId,
        actionType: 'HTML_EMBED_TEXT_SAVED',
        operations: {
          components: [{
            type: 'expressionChanged',
            componentName: ['__SitePlugin', 'page'],
            expressionDiff: [{
              type: 'update',
              path: [{ in: 'Record', at: 'embed' }, { in: 'Record', at: 'meta' }, { in: 'Record', at: 'script' }],
              oldValue: helpers.wrap.boolean(oldHasScript),
              newValue: helpers.wrap.boolean(newHasScript),
              elementId: embedId
            }]
          }]
        }
      }
    };

    return new Promise(function(resolve) {
      var dispatcher;
      try { dispatcher = getAckDispatcher(); }
      catch (e) { return resolve({ ok: false, error: 'Dispatcher init failed: ' + e.message }); }

      var timeout = setTimeout(function() {
        if (dispatcher.handlers[messageId]) {
          delete dispatcher.handlers[messageId];
          resolve({ ok: false, error: 'Timeout 10s', messageId: messageId });
        }
      }, 10000);

      dispatcher.handlers[messageId] = {
        onSuccess: function() {
          clearTimeout(timeout);
          resolve({
            ok: true,
            serverConfirmed: true,
            id: embedId,
            messageId: messageId,
            oldHasScript: oldHasScript,
            newHasScript: newHasScript,
            autoDetected: (typeof forcedValue !== 'boolean')
          });
        },
        onError: function(d) {
          clearTimeout(timeout);
          resolve({
            ok: false,
            serverRejected: true,
            messageId: messageId,
            error: (d && d.error && d.error.message) || 'server error'
          });
        }
      };

      try {
        var sendResult = socket.send([wsMessage]);
        if (sendResult && typeof sendResult.then === 'function') sendResult.catch(function() {});
        else if (Array.isArray(sendResult)) sendResult.forEach(function(r) { if (r && r.catch) r.catch(function() {}); });
      } catch (e) {
        delete dispatcher.handlers[messageId];
        clearTimeout(timeout);
        resolve({ ok: false, error: 'socket.send threw: ' + e.message });
      }
    });
  };

  console.log('[CodeEmbed] 4 commands registered: listEmbeds, getEmbedContent, updateEmbed, setEmbedHasScript.');
})();

/**
 * appendHtmlEmbedWS — create a native Webflow HtmlEmbed via direct WebSocket.
 *
 * Same WS mechanism (`siteData:update`) as appendElementWS but with the exact
 * structure of a HtmlEmbed (type ["Embed", "HtmlEmbed"] + Distinct CodeProp +
 * Union keepInHtml). 11 fields in `data.val` are commented inline at the build site.
 *
 * @see docs/lessons/webflow-mcp.md §htmlembed-creation-ws — gotchas + silent-reject anti-patterns
 * @see docs/lessons/webflow-mcp.md §htmlembed-w-script-flag — w-script fix
 */

(function() {
  'use strict';

  // Consume _internal.helpers for stack consistency (instead of re-implementing
  // getSocket / getPageInfo locally).
  var helpers = window.__webflowHelper && window.__webflowHelper._internal && window.__webflowHelper._internal.helpers;
  if (!helpers) {
    console.log('[appendHtmlEmbedWS] _internal.helpers not loaded — module skipped');
    return;
  }

  // Silent-reject recovery registry: tracks embeds that returned
  // ackedButNotPersisted: true so that if the server commits them tardively (after
  // the 5s poll timeout), a retry with same (parentId, content) returns the
  // late-persisted embedId instead of creating a duplicate. TTL 30s.
  var SILENT_REJECT_REGISTRY = [];

  function silentRejectRegistryFind(parentId, content) {
    var now = Date.now();
    // Clean up entries older than 30s (in-place reverse iteration).
    for (var i = SILENT_REJECT_REGISTRY.length - 1; i >= 0; i--) {
      if (now - SILENT_REJECT_REGISTRY[i].timeoutAt > 30000) {
        SILENT_REJECT_REGISTRY.splice(i, 1);
      }
    }
    // Look up matching entry.
    for (var j = 0; j < SILENT_REJECT_REGISTRY.length; j++) {
      var e = SILENT_REJECT_REGISTRY[j];
      if (e.parentId === parentId && e.content === content) return { entry: e, index: j };
    }
    return null;
  }

  // Expose for tests / debug.
  if (window.__webflowHelper && window.__webflowHelper._internal) {
    window.__webflowHelper._internal.silentRejectRegistry = SILENT_REJECT_REGISTRY;
  }

  var uuid = helpers.uuid;

  function getSocket() {
    var stores = helpers.getStores();
    return (stores.MultiplayerStore && stores.MultiplayerStore.state && stores.MultiplayerStore.state.socket) || null;
  }

  function getPageInfo() {
    var stores = helpers.getStores();
    var siteData = stores.SiteDataStore && stores.SiteDataStore.state;
    var loc = stores.LocalizationStore && stores.LocalizationStore.state;
    if (!siteData) return null;
    return {
      pageId: siteData.pageId,
      siteId: siteData.siteId,
      localeId: (loc && loc.currentLocale && loc.currentLocale._id) || (loc && loc.primaryLocale && loc.primaryLocale._id) || null
    };
  }

  // Detect presence of a <script> tag in the HTML content. Webflow sets this
  // in data.embed.meta.script at UI parse time and uses it to add the `w-script`
  // class at render. Without this flag, Webflow silently strips <script> at publish.
  function detectScript(content) {
    return /<script[\s>]/i.test(content);
  }

  /**
   * Create a native Webflow HtmlEmbed.
   * @param {{parentId: string, content?: string, index?: number}} options
   * @returns {Promise<{ok: boolean, embedId?: string, messageId?: string, error?: string}>}
   */
  function appendHtmlEmbedWS(options) {
    options = options || {};
    var parentId = options.parentId;
    var content = typeof options.content === 'string' ? options.content : '';
    var index = typeof options.index === 'number' ? options.index : 0;
    var hasScript = detectScript(content);

    return new Promise(function(resolve) {
      // Reject client-side: comment-only / whitespace content is silent-rejected
      // by Webflow. Strip HTML comments + trim — if empty, return error immediately
      // instead of waiting 5s for the Redux poll timeout.
      var stripped = (content || '').replace(/<!--[\s\S]*?-->/g, '').trim();
      if (!stripped) {
        return resolve({
          ok: false,
          error: 'Webflow silent-rejects embeds with empty or comment-only content. Use substantive HTML: <div>, <style>, <script> with content. For invisible markers: <div style="display:none">marker</div>',
          embedId: null,
          contentRejectedClientSide: true
        });
      }

      if (!parentId) {
        return resolve({ ok: false, error: 'parentId required (ID of an existing element)' });
      }

      // Idempotency check: if a silent-reject is pending for this (parentId, content)
      // and it has now been persisted tardively, return that embedId (no retry, no duplicate).
      var pending = silentRejectRegistryFind(parentId, content);
      if (pending) {
        var late = false;
        try { late = helpers.findNodeById(pending.entry.embedId) != null; } catch (e) {}
        if (late) {
          // Late-persisted — return idempotent (LRU+TTL purge applied).
          try {
            var setFn = window.__webflowHelper._internal.embedsRegistrySet;
            if (typeof setFn === 'function') {
              setFn(pending.entry.embedId, {
                value: content,
                hasScript: hasScript,
                parentId: parentId,
                createdAt: pending.entry.timeoutAt,
                updatedAt: Date.now()
              });
            } else {
              // Fallback if setFn unavailable (defensive — CodeEmbed module skipped).
              window.__webflowHelper._internal.embedsRegistry = window.__webflowHelper._internal.embedsRegistry || {};
              window.__webflowHelper._internal.embedsRegistry[pending.entry.embedId] = {
                value: content, hasScript: hasScript, parentId: parentId,
                createdAt: pending.entry.timeoutAt, updatedAt: Date.now()
              };
            }
          } catch (e) { console.warn('[appendHtmlEmbedWS] registry sync skip:', e.message); }
          SILENT_REJECT_REGISTRY.splice(pending.index, 1);
          return resolve({
            ok: true,
            embedId: pending.entry.embedId,
            messageId: pending.entry.messageId,
            recoveredFromSilentRejectId: true,
            confirmedAfterMs: Date.now() - pending.entry.timeoutAt
          });
        }
        // Entry exists but embed truly absent → cleanup stale entry, proceed with normal create
        SILENT_REJECT_REGISTRY.splice(pending.index, 1);
      }

      var socket = getSocket();
      if (!socket || !socket.send) {
        return resolve({ ok: false, error: 'Socket not available' });
      }

      var info = getPageInfo();
      if (!info || !info.pageId) {
        return resolve({ ok: false, error: 'pageId not found' });
      }
      if (!info.localeId) {
        return resolve({ ok: false, error: 'localeId not found (LocalizationStore empty?)' });
      }

      // Consume messageId via shared helper (advances counter). Without this,
      // two consecutive createEmbed calls share the same messageId and the
      // server dedups, silently dropping the 2nd one.
      var internal = window.__webflowHelper && window.__webflowHelper._internal;
      var mp = window._webflow.stores.MultiplayerStore.state;
      var messageId;
      if (internal && typeof internal.consumeMessageId === 'function') {
        try { messageId = internal.consumeMessageId(); }
        catch (e) { return resolve({ ok: false, error: 'consumeMessageId failed: ' + e.message }); }
      } else {
        // Fallback (should not happen if the CodeEmbed module ran first).
        messageId = mp.nextMessageId;
      }
      var embedId = uuid();

      // =================================================================
      // HtmlEmbed payload — full spec reverse-engineered.
      // =================================================================
      // Critical rule: the Webflow server accepts malformed payloads,
      // returning `success: true` while NOT persisting the embed (silent
      // reject). Each field below is REQUIRED with its exact type. Always
      // verify by reading back via listEmbeds after a Designer reload.
      //
      // Minimum validation: 11 fields in data.val (search, embed, insideRTE,
      // value, content, devlink, displayName, attr, xattr, styleBlockIds,
      // visibility).
      var elementValue = {
        type: 'Element',
        val: {
          id: embedId,
          // ⚠️ TUPLE obligatoire ['Embed', 'HtmlEmbed'] — PAS string.
          // `type: "HtmlEmbed"` → server returns success, embed NOT persisted.
          // 1er = catégorie ("Embed"), 2ème = sous-type ("HtmlEmbed").
          type: ['Embed', 'HtmlEmbed'],
          data: {
            type: 'Record',
            val: {
              // 1/ search — HtmlEmbed excluded from Webflow search by default.
              search: { type: 'Record', val: { exclude: { type: 'Boolean', val: true } } },

              // 2/ embed — meta wrapper + HTML parsing flags.
              embed: {
                type: 'Record',
                val: {
                  // type 'Text' with val: 'html' — NOT Enum.
                  // `{type: "Enum", val: "html"}` → silent reject.
                  type: { type: 'Text', val: 'html' },
                  meta: {
                    type: 'Record',
                    val: {
                      html: { type: 'Text', val: content },
                      div: { type: 'Boolean', val: false },
                      // meta.script controls the `w-script` class at render time.
                      // If content contains <script> and script=false, Webflow strips it at publish.
                      script: { type: 'Boolean', val: hasScript },
                      compilable: { type: 'Boolean', val: false },
                      iframe: { type: 'Boolean', val: false }
                    }
                  }
                }
              },

              // 3/ insideRTE — false for any standalone HtmlEmbed.
              insideRTE: { type: 'Boolean', val: false },

              // 4/ value — HTML content (duplicated with embed.meta.html — both required).
              value: { type: 'Text', val: content },

              // 5/ content — type 'Distinct' with name: ['Embed', 'CodeProp'].
              // `{type: "Text", val: ""}` or omitting the field → silent reject.
              content: {
                type: 'Distinct',
                val: { name: ['Embed', 'CodeProp'], value: { type: 'Text', val: content } }
              },

              // 6/ devlink — Webflow runtime placeholders (empty values OK but the structure is required).
              devlink: {
                type: 'Record',
                val: {
                  runtimeProps: { type: 'Literal', val: { name: ['Devlink', 'RuntimeProps'], value: {} } },
                  slot: { type: 'Literal', val: { name: ['Devlink', 'Slot'], value: '' } }
                }
              },

              // 7/ displayName — empty by default (editable later via the Designer).
              displayName: { type: 'Text', val: '' },

              // 8/ attr — optional HTML id (not the Webflow elementId, distinct).
              attr: { type: 'Record', val: { id: { type: 'Text', val: '' } } },

              // 9/ xattr — custom HTML attributes (empty list OK).
              xattr: { type: 'List', val: [] },

              // 10/ styleBlockIds — applied Webflow classes (empty list OK).
              styleBlockIds: { type: 'List', val: [] },

              // 11/ visibility — display conditions + keepInHtml.
              visibility: {
                type: 'Record',
                val: {
                  conditions: { type: 'List', val: [] },
                  // keepInHtml is 'Union' with a tag + an empty value Record.
                  // `{type: "Literal", val: "False"}` → silent reject.
                  // `value: {}` (without the Record wrapper) → silent reject too.
                  keepInHtml: {
                    type: 'Union',
                    val: { tag: 'False', value: { type: 'Record', val: {} } }
                  }
                }
              }
            }
          }
        }
      };

      var message = {
        type: 'siteData:update',
        payload: {
          messageId: messageId,
          pageId: info.pageId,
          localeId: info.localeId,
          operations: {
            components: [{
              type: 'expressionChanged',
              componentName: ['__SitePlugin', 'page'],
              expressionDiff: [{
                type: 'add',
                path: [
                  { in: 'Record', at: 'children' },
                  { in: 'List', index: index }
                ],
                value: elementValue,
                elementId: parentId
              }]
            }]
          },
          actionType: 'ELEMENT_ADDED'
        }
      };

      // Use the singleton dispatcher set up by the CodeEmbed module above.
      // Old per-push attach/restore of innerSocket._callbacks broke concurrent
      // creates (2nd push's handler was wiped by 1st push's restore).
      if (!internal || typeof internal.getAckDispatcher !== 'function') {
        return resolve({ ok: false, error: '__webflowHelper._internal.getAckDispatcher not available (the CodeEmbed module must run before this one)' });
      }
      var dispatcher;
      try { dispatcher = internal.getAckDispatcher(); }
      catch (e) { return resolve({ ok: false, error: 'Dispatcher init failed: ' + e.message }); }

      var timeout = setTimeout(function() {
        if (dispatcher.handlers[messageId]) {
          delete dispatcher.handlers[messageId];
          resolve({ ok: false, error: 'Timeout 10s (no server ACK)', messageId: messageId });
        }
      }, 10000);

      dispatcher.handlers[messageId] = {
        onSuccess: function() {
          clearTimeout(timeout);
          // Post-ACK validation (silent-reject protection). The server can ACK
          // success but not persist (witnessed: success:true but embed never
          // appears in Redux). Polling AbstractNodeStore via findNodeById confirms
          // the embed reached the tree before resolving.
          //   - on success: populate registry + resolve with confirmedAfterMs
          //   - on timeout: resolve { ok: false, ackedButNotPersisted: true } so
          //     the caller can distinguish silent-reject from a server error.
          var POLL_INTERVAL_MS = 200;
          var POLL_TIMEOUT_MS = 5000;
          var startedAt = Date.now();

          function isPersisted() {
            try {
              return helpers.findNodeById(embedId) != null;
            } catch (e) { return false; }
          }

          function pollAndResolve() {
            if (isPersisted()) {
              try {
                var setFn = window.__webflowHelper._internal.embedsRegistrySet;
                var entry = {
                  value: content, hasScript: hasScript, parentId: parentId,
                  createdAt: Date.now(), updatedAt: Date.now()
                };
                if (typeof setFn === 'function') {
                  setFn(embedId, entry);
                } else {
                  window.__webflowHelper._internal.embedsRegistry = window.__webflowHelper._internal.embedsRegistry || {};
                  window.__webflowHelper._internal.embedsRegistry[embedId] = entry;
                }
              } catch (e) { console.warn('[appendHtmlEmbedWS] registry sync skip:', e.message); }
              return resolve({
                ok: true,
                embedId: embedId,
                messageId: messageId,
                confirmedAfterMs: Date.now() - startedAt
              });
            }
            if (Date.now() - startedAt >= POLL_TIMEOUT_MS) {
              // Register silent-reject for late-persist recovery — if the server
              // commits this embed tardively, the next call with same (parentId, content)
              // will return idempotently via silentRejectRegistryFind.
              // If server commits this embed tardively, the next call with same
              // (parentId, content) will find it via silentRejectRegistryFind and
              // return idempotently instead of creating a duplicate.
              SILENT_REJECT_REGISTRY.push({
                embedId: embedId,
                parentId: parentId,
                content: content,
                messageId: messageId,
                timeoutAt: Date.now()
              });
              return resolve({
                ok: false,
                error: 'Silent reject: server ACK received but embed not in AbstractNodeStore after ' + POLL_TIMEOUT_MS + 'ms',
                embedId: embedId,
                messageId: messageId,
                ackedButNotPersisted: true
              });
            }
            setTimeout(pollAndResolve, POLL_INTERVAL_MS);
          }

          pollAndResolve();
        },
        onError: function(d) {
          clearTimeout(timeout);
          resolve({ ok: false, error: (d && d.error && d.error.message) || 'Server error', messageId: messageId, full: d });
        }
      };

      try {
        var sendResult = socket.send([message]);
        // Ignore emitWithAck Promise reject (timeout wrapper bug for some payloads)
        if (sendResult && typeof sendResult.then === 'function') sendResult.catch(function() {});
        else if (Array.isArray(sendResult)) sendResult.forEach(function(r) { if (r && r.catch) r.catch(function() {}); });
      } catch (e) {
        delete dispatcher.handlers[messageId];
        clearTimeout(timeout);
        resolve({ ok: false, error: 'socket.send threw: ' + e.message, messageId: messageId });
      }
    });
  }

  // Expose via __webflowHelperDevkit (direct API).
  window.__webflowHelperDevkit = window.__webflowHelperDevkit || {};
  window.__webflowHelperDevkit.appendHtmlEmbedWS = appendHtmlEmbedWS;

  // Register in __webflowHelper._localCmd (unified API via __webflowHelper.run()).
  if (window.__webflowHelper && window.__webflowHelper._localCmd) {
    window.__webflowHelper._localCmd.appendHtmlEmbedWS = appendHtmlEmbedWS;
  }

  console.log('[appendHtmlEmbedWS] loaded (shares consumeMessageId + singleton ACK dispatcher with the CodeEmbed module · silent-reject recovery active)');
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

  /**
   * Dump the Navigator tree.
   * @param {object} [args]
   * @param {number}  [args.maxDepth=50]      Max depth to walk
   * @param {string}  [args.filterType]       Filter to a specific type (e.g. 'Section', 'Block', 'HtmlEmbed', 'Heading')
   * @param {string}  [args.filterClass]      Filter to elements with at least 1 class containing this substring (case-insensitive)
   * @param {boolean} [args.includeEmpty=true] Include nodes with no class (e.g. raw containers, body)
   * @param {boolean} [args.compact=false]    Return compact format (depth + type + classes only, no id/tag)
   * @returns {{ ok: boolean, count: number, total_walked: number, tree: Array, error?: string }}
   */
  p._localCmd.dumpTree = function(args) {
    args = args || {};
    var maxDepth = typeof args.maxDepth === 'number' ? args.maxDepth : 50;
    var filterType = args.filterType || null;
    var filterClassLower = args.filterClass ? String(args.filterClass).toLowerCase() : null;
    var includeEmpty = args.includeEmpty !== false;
    var compact = args.compact === true;

    var root = helpers.getRoot();
    if (!root) return { ok: false, error: 'No root node — Designer not loaded?' };

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

    var out = [];
    var totalWalked = 0;

    helpers.walkTree(root, function(node, depth) {
      totalWalked++;
      var type = node.get && node.get('type');
      var tag = node.get && node.get('tag');
      var id = node.get && node.get('id');

      // styleBlockIds -> class names
      var classes = [];
      try {
        var data = node.get && node.get('data');
        var sbIds = data && data.get && data.get('styleBlockIds');
        var arr = sbIds && sbIds.toJS ? sbIds.toJS() : (Array.isArray(sbIds) ? sbIds : []);
        classes = arr.map(function(s) { return (sbs && sbs[s] && sbs[s].name) || s; });
      } catch (e) { classes = []; }

      // Filtering
      if (filterType && type !== filterType) return;
      if (filterClassLower) {
        var match = classes.some(function(c) {
          return typeof c === 'string' && c.toLowerCase().indexOf(filterClassLower) !== -1;
        });
        if (!match) return;
      }
      if (!includeEmpty && classes.length === 0 && type !== 'Section' && type !== 'Body') return;

      var entry = compact
        ? { d: depth, type: type, classes: classes }
        : { depth: depth, type: type, tag: tag || null, id: id, classes: classes };
      out.push(entry);
    }, { maxDepth: maxDepth });

    return { ok: true, count: out.length, total_walked: totalWalked, tree: out };
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
// 3. appendHtmlEmbedWS - MCP gap (HtmlEmbed creation)
// 4. updateEmbed - MCP gap (embed content update)
// 5. listEmbeds - MCP gap (embed list + contents)
// 6. getEmbedContent - MCP gap (single embed content read)
// 7. setEmbedHasScript - MCP gap (w-script flag)
// 8. getCurrentPageInfo - 3-source page concordance check (MCP de_page_tool.get_current_page has 76% timeout + no DOM/URL cross-check)
// 9. dumpTree - full Navigator tree dump with resolved class names (MCP query_elements BETA broken)
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
    'appendHtmlEmbedWS',
    'updateEmbed',
    'listEmbeds',
    'getEmbedContent',
    'setEmbedHasScript',
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
