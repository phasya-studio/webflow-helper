/* Webflow Helper v3.20.3 - 2026-05-20 */

/**
 * Webflow Helper — minimal surface, exposes 14 cmds via `__webflowHelper.run()`:
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
 * 11. getEmbedContent — fast Redux read of a single embed's content (no MCP tool · may be stale after writes on inComponent — see getEmbedContentViaUI)
 * 12. getEmbedContentViaUI — ground-truth read via CodeMirror UI scrape (~3-4s · 100% reliable post-write inComponent) (v3.14.3)
 * 13. getCurrentPageInfo — 3-source page concordance (DOM/URL/Redux) — MCP de_page_tool.get_current_page has 76% timeout + no DOM check
 * 14. dumpTree — full Navigator tree dump with resolved class names (MCP query_elements BETA broken)
 *     + v3.3.0 option `expandSlotOverrides` — walks Component instance slot overrides
 *       (e.g. FAQ items nested in Section FAQ's faq_list slot) + extracts prop values
 *       from `data.sym.overrides[propId][0].data.value` (text format). Read-only.
 *
 * PATCH v3.14.3 (s567) : updateEmbedViaUI — verify post-save Redux REMPLACÉE par
 * verify CodeMirror pré-save (ground truth instant). Le Redux store local n'est PAS
 * resync après save UI sur embed inComponent (validé empirique : 3 retries × 6.5s sur
 * services 998737ec retournaient `success:false` faux négatif alors que server avait
 * bien stocké le content — confirmé via curl staging). Le seul mécanisme de resync
 * Redux = reload Designer F5. La verify pré-save lit `.cm-line` walk après paste,
 * AVANT click Save & Close — c'est le content qui sera envoyé au server. Tolérance
 * ±2 chars trailing `\n` strip CodeMirror. + Nouvelle cmd `getEmbedContentViaUI`
 * (~3-4s) ouvre modal Code Editor + lit CodeMirror + ferme → ground truth fiable
 * 100% pour lectures post-write inComponent (alternative à `getEmbedContent` rapide
 * mais stale Redux). + Note JSDoc stale warning sur `listEmbeds` et `getEmbedContent`.
 *
 * PATCH v3.13.0 (s557) : setImageSettings — Enter key sequence ajoutée dans applyAlt
 * pour mode='custom' avec altCustomText. v3.7.0 disposait setter React + input + change
 * + blur → texte visible UI MAIS Redux NON-COMMITÉ (alt restait `<inherit>` ou vide
 * en Redux state, malgré retour cmd `applied: ["alt:custom (custom text set)"]`).
 * Pattern repris de helpEditImagesAltInComponent v3.11.0 (validé s552) :
 *   focus → setter.call → input event → Enter keydown/keypress/keyup → blur
 * Validé empirique s557 : 8 zones AVG carte zone livraison alt custom per-zone
 * (autour de Vernon — service à [Évreux/Rouen/Louviers/...]) → tous propagés Redux
 * + DOM HTML staging post-publish + cache buster. Bug détecté pendant audit content
 * /content-audit louviers item 4 (alt carte zone livraison per-zone).
 *
 * MINOR v3.10.0 (s549) : updateEmbedViaUI — fingerprint fallback resolution.
 * Quand embedId ne trouve aucun match dans le canvas DOM (ID volatile : Webflow
 * regenere les IDs au delete+recreate ou refactor en Component), le helper extrait
 * la 1ère ligne significative du `content` fourni (skip décoratif === / ─, comment
 * delimiters), call listEmbeds, match preview par signature normalisée. Si match
 * unique → résolution auto + update + return enrichi `{resolved_by:'signature',
 * old_id, new_id}` pour que le caller sync son fichier source. Match ambigu (≥2)
 * → fail avec `candidates[]` pour debug. Match 0 → fail explicite avec fingerprint
 * tenté. Validé empirique s549 : embed services accueil avait changé d'ID entre
 * sessions (b73fd0d9 → 998737ec après refactor en Component instance), résolution
 * manuelle via listEmbeds → désormais auto.
 *
 * MINOR v3.7.0 (s551) : setImageSettings — UI automation pour reset alt mode +
 * change loading type sur Image elements. Contournement structurel du gotcha #34
 * (canon webflow-mcp-canon.md §cluster-image-asset) : altText "Custom description"
 * sur Image existant = NON-RESET via MCP (6 routes testées s538 toutes silent-fail).
 * Sélecteurs data-automation-id stables identifiés empirique s551 :
 *   - AltTextPluginDropdown → select-option-__wf_reserved_{inherit|decorative}|custom
 *   - AltTextPluginInput (React nativeInputValueSetter pour custom text)
 *   - Type--Plugin_Enum_Type_menu → menu-option-{lazy|eager|auto}
 * Compatible s548 : aucun dispatch Redux write (only DOM events).
 * Validé empirique : 13 hero images AVG resetées (alt:inherit + loading:eager).
 *
 * PATCH v3.5.3 (s549) : 2 fixes critiques sur setComponentPropsViaUI :
 *   1. applyVisibilityProp — `btn.click()` natif IGNORÉ par les radio Webflow
 *      (validé empirique : cmd return ok mais aucune mutation store/DOM). Fix =
 *      focus + KeyboardEvent Space (le pattern qui marche empirique).
 *   2. Nouveau type `reset` — annule un override pour revenir au default template.
 *      Pattern UI : click sur le label (data-resettable=true + data-origin=local)
 *      → menu apparaît avec data-automation-id="component-property-reset" → click.
 *      Permet de re-mettre une instance à son default sans valeur arbitraire.
 *
 * MINOR v3.9.0 (s551) : dumpTree `resolveCombo` — élimine besoin de
 * `mcp__webflow__element_tool.query_elements` pour résolution des combo classes.
 * Quand `resolveCombo: true`, chaque entry inclut `classesResolved: [{id, name,
 * isCombo, parentId?, parentName?}]` à côté du tableau `classes` (plain names
 * pour back-compat). Résolu via `StyleBlockStore.parentIndex` (221 mappings AVG).
 * Validé empirique : 100% cohérence avec snapshot offline `project/webflow-state/
 * styles.json`. ~1ms overhead par node. Pair avec hook BLOCK `query_elements`
 * qui force dumpTree comme voie par défaut pour toutes inspections runtime.
 *
 * MINOR v3.6.0 (s550) : dumpTree `includeParent` default `true` (était `false`). Le
 * `parent_id` est désormais ajouté à chaque entry par défaut — résout le bug walker
 * "depth non fiable comme borne de subtree" (artefact Symbol expand). Consommateurs
 * peuvent maintenant remonter la chaîne d'ancêtres pour identifier section + variant
 * sémantique de toute Image sans dépendre du `d`. Backwards compat : ajout d'un champ
 * dans les entries non-compact. Pour retomber sur l'ancien comportement passer
 * `includeParent: false` explicitement.
 *
 * MINOR v3.5.0 (s548 · Vague 2 partielle) : setComponentPropsViaUI étendu — supporte
 * désormais `type: 'link'` (mode='page' avec pageSlug, mode='url' avec url) +
 * `type: 'visibility'` (visible boolean). Total : 3 types couverts (text + link + visibility).
 *
 * MINOR v3.4.0 (s548) : setComponentPropsViaUI — UI automation pour overrides primary
 * locale des ComponentInstance (gap MCP Data API documenté Webflow). Vague 1 = text-only
 * (Question/Réponse/CTA Text). Pattern : sélection préalable via mcp__webflow__element_tool.select_element
 * → cmd applique chaque prop via React nativeInputValueSetter + input event + blur commit.
 * Compatible s548 : aucun dispatch Redux write (only DOM events captured by Webflow React handler).
 *
 * MINOR v3.3.0 (s548) : dumpTree `expandSlotOverrides` — révèle les ComponentInstance
 * imbriquées dans des slots avec leurs prop values (Question/Réponse/CTA Text/CTA Lien
 * sur FAQ Items, etc.). Aligné stratégie s548 : lecture Redux OK, writes interdits.
 *
 * CLEANUP v3.2.0 (s547) : retiré le code mort hérité des cmds raw WebSocket retirées
 * en v2.0.0/v3.0.0 — `_internal.consumeMessageId`, `_internal.getAckDispatcher`,
 * `_internal.embedsRegistry` (+ son LRU/TTL infrastructure), helpers internes
 * `detectScript`/`readMetaScript`/`readHasCompiledDistinct`. Total : -204L (~9%).
 * Pas de changement comportemental — uniquement nettoyage interne.
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

  var VERSION = '3.20.4';
  // [v3.20.4 (s568)] Fix cleanupUnusedStylesViaUI : pré-check Style Manager état avant
  // click sidebar button. Le button est un TOGGLE — sans pré-check, 2e call consécutif
  // fermait le Style Manager au lieu de l'ouvrir. Maintenant skip le click si déjà ouvert.
  // [v3.20.3 (s568)] 2 fixes empiriques cleanup/duplicate :
  // (1) cleanupUnusedStylesViaUI : retiré ESC initial — empiriquement il bloquait le sidebar.click()
  //     suivant. Remplacé par pré-check Enter si mode édit chip détecté.
  // (2) duplicateClassViaUI : remplacé ESC par Enter post-duplicate. ESC ne sortait pas vraiment
  //     du mode édit + bloquait les cmds suivantes. Enter commit le nom auto-généré et sort propre.
  // [v3.20.2 (s568)] Fix cleanupUnusedStylesViaUI : remplace keydown G shortcut (Webflow exige
  // trusted event impossible via JS) par click sur left-sidebar-styles-button (DOM cliquable
  // équivalent). Validé empirique : aria-label "Style selectors (G)" = même action. Plus stable.
  // [v3.20.1 (s568)] Fix duplicateClassViaUI : ajout ESC + blur cleanup après click duplicate
  // option car Webflow laisse le chip dupliqué en mode édit (contentEditable focused pour
  // rename immédiat workflow UX). Sans cleanup, état "ouvert" qui interfère avec actions
  // suivantes. JSDoc enrichi avec comportement "swap pas add" et suffix " Copy" validé empirique.
  // [v3.20.0 (s568)] Add cleanupUnusedStylesViaUI — 6e cmd Style Selector UI : bulk delete
  // orphelines via Style Manager (raccourci G + Clean up styles button + Delete). Bypass
  // gotchas #22 + #23 (remove_style refuse attached + parent_style_names cassé). Option
  // dryRun pour preview liste classes avant suppression. Workflow validé empirique s568.
  // [v3.19.2 (s568)] Doc enrichment : JSDoc renameClassViaUI documente le comportement
  // empirique (standalone global vs combo local · flicker rebuild CSS · props préservation).
  // No code change — versioning bump pour aligner avec canon webflow-helper-canon.md
  // section §rename-behavior-empirique nouvellement ajoutée (4 cas validés s568).
  // [v3.19.1 (s568)] Fix critical : `indicator.click()` natif seul N'OUVRE PAS le menu chip
  // (validé empirique session s568 — menu_options_after_click: []). Solution : sequence complète
  // pointerdown + mousedown + 50ms gap + pointerup + mouseup + click. Factorisée dans helper
  // `clickMenuIndicator()`. Patché les 3 cmds menu (remove/rename/duplicate).
  // [v3.19.0 (s568)] (1) Fix cleanupEditMode (v3.18.0 cleanupCanvasFocus déselectionnait l'élément
  // → renameClassViaUI cassait avec chip_not_found). Maintenant ESC + blur active editable
  // sans toucher canvas. (2) Add duplicateClassViaUI (5e cmd Style Selector UI) :
  // workflow chip menu → Duplicate class, détecte le nouveau nom auto-généré par Webflow.
  // [v3.18.0 (s568)] Style Selector UI actions (4 cmds) : addClassViaUI, removeLastClassViaUI,
  // removeClassFromElementViaUI, renameClassViaUI. Bypass 5 gotchas style_tool MCP
  // (#5 style_ids non supporté · #15 set_style enrichit silencieusement · #20 parent_style_names
  // ne disambigue pas combos même nom · #22 remove_style refuse classe attachée · #23 idem).
  // Pattern critique : React props onMouseEnter pour hover synthétique + element.click() natif
  // sur menu indicator (dispatchEvent click est intercepté par overlays). dispatchEvent
  // KeyboardEvent marche sur INPUT (input add/remove) mais PAS sur contentEditable span
  // (rename via execCommand insertText + InputEvent fallback). Workflows complets validés
  // empirique session s568 Sandbox AVG. Detail : webflow-helper-canon.md §style-selector-ui-actions.
  // [v3.14.3 (s567)] CodeMirror v6 EditorView API integration : la lecture du content
  // dans getEmbedContentViaUI + verify pré-save updateEmbedViaUI passe désormais par
  // `cmContent.cmTile.view.state.doc.toString()` (API officielle CM v6) au lieu du
  // .cm-line walk DOM (bug virtualisation : pour embed 17K chars / 472 lignes, le
  // walk ne lit que 66 lignes vs 473 réelles). EditorView API = ground truth instant,
  // 100% complet quelle que soit la taille, no scroll forcing needed.

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
   * Read the full content of an embed (FAST · Redux read).
   *
   * ⚠️ STALE WARNING (v3.14.3) : The returned `value` comes from local
   * AbstractNodeStore Redux which is NOT auto-resynced after a successful
   * `updateEmbedViaUI` on an inComponent embed. The save IS committed server-side
   * (verified empirically via curl staging post-publish) but the local Redux only
   * refreshes on Designer reload F5. For guaranteed-fresh reads (especially after
   * in-session writes on inComponent embeds), use `getEmbedContentViaUI` instead
   * — slower (~3-4s due to UI modal scrape) but 100% reliable.
   *
   * @param {{ embedId: string }} args
   * @returns {{ ok: boolean, id?: string, value?: string, length?: number, source?: string, error?: string }}
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
    return { ok: true, id: embedId, value: value, length: value.length, source: 'redux' };
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
   * Use this instead of `getEmbedContent` when :
   *   - You just called `updateEmbedViaUI` on an inComponent embed and need to
   *     verify the saved value (Redux is stale, see canon §gotcha-redux-stale-inComponent)
   *   - You suspect another client/session has modified the embed
   *   - You need guaranteed-fresh content for critical decisions
   *
   * @param {object} args
   * @param {string} args.embedId
   * @param {object} [args.waitMs] Override per-step delays
   * @returns {Promise<object>} `{ ok, id, value, length, lines_read, inComponent, componentInstanceId, durationMs, source: 'codemirror_ui_scrape', error? }`
   *
   * @see docs/lessons/webflow-helper-canon.md §getembedcontentviaui — empirical workflow
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
   * @see docs/lessons/webflow-helper-canon.md §updateembedviaui — reverse-engineered selectors + edge cases (session s547)
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

  console.log('[CodeEmbed] 6 commands registered: listEmbeds, getEmbedContent, getEmbedContentViaUI, appendHtmlEmbedViaUI, updateEmbedViaUI, renameNode.');
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
   * @returns {{ ok: boolean, count: number, total_walked: number, expanded?: number, tree: Array, hint?: string, scoped_to?: string, error?: string }}
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
    var expandSlotOverrides = args.expandSlotOverrides === true; // v3.3.0
    var rootIdScope = args.rootId || null;          // v1.6.0
    var includeParent = args.includeParent !== false; // v3.6.0 — default true (était === true en v1.6.0)
    var resolveCombo = args.resolveCombo === true;   // v3.9.0 — enrich classesResolved
    var includeBreadcrumb = args.includeBreadcrumb === true; // v3.16.0 — chaîne ancêtres
    var entryOpts = {
      compact: compact,
      // v3.16.0 fix : forcer includeText/Attr si un filter sur ce champ est actif,
      // sinon le filter rejette tout en compact (text=null car non-extracted).
      includeText: (args.includeText !== false && !compact) || !!filterTextLower,
      includeAttr: args.includeAttr !== false && !compact,
      includeXattr: args.includeXattr !== false && !compact,
      resolveCombo: resolveCombo
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
    var parentIndex = null; // v3.9.0
    try {
      var state = helpers.getReduxState();
      var sbStore = state && state.StyleBlockStore;
      if (sbStore && sbStore.get) {
        var blocks = sbStore.get('styleBlocks');
        sbs = blocks && blocks.toJS ? blocks.toJS() : blocks;
        // v3.9.0 — parentIndex pour résolution combo (Map<comboId, parentId>)
        if (resolveCombo) {
          var pi = sbStore.get('parentIndex');
          parentIndex = pi && pi.toJS ? pi.toJS() : pi;
        }
      }
    } catch (e) { sbs = null; parentIndex = null; }

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
    var slotOverridesCount = 0; // v3.3.0
    var parentStack = []; // v1.6.0 — [{ depth, id, type?, classFirst? }] for includeParent + includeBreadcrumb v3.16.0

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

      var built = buildEntry(node, depth, sbs, entryOpts, parentIndex);

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

      // v3.16.0 — breadcrumb computed BEFORE pushing self on stack (= just ancestors)
      if (includeBreadcrumb && parentStack.length > 0) {
        built.entry.breadcrumb = parentStack.map(function(p) {
          return p.classFirst ? p.type + '.' + p.classFirst : (p.type || 'Node');
        }).join(' > ');
      }

      // Push current node on stack BEFORE filters/expand (children of current node need its id as parent)
      var currentId = node.get && node.get('id');
      if (currentId) parentStack.push({
        depth: depth,
        id: currentId,
        type: built.type,
        classFirst: (built.classes && built.classes[0]) || null
      });

      applyFiltersAndPush(built.entry, built.type, built.classes, built.text);

      // v3.3.0 — expandSlotOverrides : for Symbol instances, reveal nested instances stored in
      // data.sym.overrides[slotPropId] (slot children that the standard `children` walker misses).
      if (expandSlotOverrides && built.type === 'Symbol') {
        slotOverridesCount += expandSlotOverridesAt(node, depth, out, { compact: compact });
      }

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
                var tBuilt = buildEntry(tNode, depth + 1 + tDepth, sbs, entryOpts, parentIndex);
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

    var result = { ok: true, count: out.length, total_walked: totalWalked, source: 'redux', tree: out };
    if (expandComponents) result.expanded = expandedCount;
    if (expandSlotOverrides) result.slot_overrides = slotOverridesCount; // v3.3.0
    if (rootIdScope) result.scoped_to = rootIdScope;

    // v3.17.0 — DOM canvas fallback si Redux walk = 0 match + filter (Text|Class) actif
    // Couvre les cas non-Redux : Symbol inner-text, CMS binding, content injecté par script.
    // Skip si rootIdScope (l'utilisateur cible un subtree Redux spécifique).
    var hasFallbackableFilter = !!(filterClassLower || filterTextLower);
    if (out.length === 0 && hasFallbackableFilter && !rootIdScope) {
      var fallback = walkDOMFallback({
        filterText: args.filterText,
        filterClass: args.filterClass
      }, 10);
      if (fallback.ok && fallback.count > 0) {
        result.source = 'dom_canvas';
        result.fallback_reason = 'redux_walk_no_match';
        result.original_redux_count = 0;
        result.count = fallback.count;
        result.tree = fallback.tree;
        result.dom_walk_duration_ms = fallback.duration_ms;
        result.dom_walk_total = fallback.total_walked;
        result.note = 'Match trouvé via DOM canvas walk (pas dans Redux store) — utiliser `ancestor_data_w_id` pour scrollToElement/select_element. Cas typique : Symbol inner-text, CMS binding, script-injected.';
        return result;
      }
    }

    // v1.6.0 — hint heuristics for count===0 (uniquement si fallback DOM aussi vide)
    if (out.length === 0) {
      var hint = null;
      var hasFilter = !!(filterClassLower || filterTextLower || filterType);
      if (hasFilter && totalWalked < 50) {
        hint = 'Tree shallow (' + totalWalked + ' nodes walked) — page may not be fully loaded · check Designer page tab + reload if needed';
      } else if (filterClassLower && maxDepth < 12 && totalWalked < 200) {
        hint = "No match for class '" + args.filterClass + "' at maxDepth=" + maxDepth + " (walked " + totalWalked + ') — Webflow cards typically at depth 8-10, try maxDepth>=12 or remove maxDepth (default 50)';
      } else if (filterClassLower) {
        hint = "No match for class '" + args.filterClass + "' (case-insensitive substring · walked " + totalWalked + ' Redux nodes + DOM fallback aussi vide) — check spelling';
      } else if (filterTextLower) {
        hint = "No match for text '" + args.filterText + "' — text checked on Redux text-bearing types AND DOM canvas fallback (1543 nodes typique). Element probably absent from page or filterText too specific.";
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
   * @param {string|object} [args.position] Optional repositioning after mount.
   *   Accepts: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | {x, y}.
   *   If omitted, keeps React-Draggable's default position.
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
    var requestedPosition = args.position; // undefined = no positioning
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
    var panel = document.querySelector('[data-automation-id="componentInstanceProperties"]');
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
 * @see docs/lessons/webflow-helper-canon.md §setimagesettings (à ajouter)
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
 * Detail complet : docs/lessons/webflow-helper-canon.md §style-selector-ui-actions
 */
(function() {
  'use strict';

  if (!window.__webflowHelper) return;
  var p = window.__webflowHelper;
  if (!p._localCmd) p._localCmd = {};

  function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  // Helper: capture les chips de classes actuellement attachées (exclut le chip BP-icon vide)
  function getCurrentChips() {
    var wrappers = Array.from(document.querySelectorAll('[data-automation-id="selector-widget"] [data-automation-id="style-rule-token-wrapper"]'));
    return wrappers.map(function(w) {
      var textEl = w.querySelector('[data-automation-id="style-rule-token-text"], [data-automation-id="style-rule-token-text-editable"]');
      return textEl ? textEl.textContent.trim() : '';
    }).filter(function(t) { return t.length > 0; });
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
    var waitMs = typeof args.waitMs === 'number' ? args.waitMs : 600;

    if (!className || typeof className !== 'string') {
      return { ok: false, error: 'className_required', got: typeof className };
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(className)) {
      return { ok: false, error: 'invalid_class_name',
               message: 'className must match /^[a-zA-Z0-9_-]+$/ (canon §cluster-create-style gotcha #17)',
               className: className };
    }

    var start = Date.now();
    var chipsBefore = getCurrentChips();

    var input = document.querySelector('[data-automation-id="css-token-input"]');
    if (!input) return { ok: false, error: 'css_token_input_not_found',
                         message: 'No element selected in Designer ? Style panel must be visible.' };

    input.focus();
    await wait(200);

    // Set value via native setter (bypass React shadow setter)
    var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(input, className);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(300);

    // Press Enter
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    await wait(waitMs);

    var chipsAfter = getCurrentChips();
    var success = chipsAfter.indexOf(className) !== -1 && chipsAfter.length > chipsBefore.length;

    return {
      ok: success,
      className: className,
      chips_before: chipsBefore,
      chips_after: chipsAfter,
      is_combo: chipsAfter.length >= 2,
      durationMs: Date.now() - start
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

    // 2. Trigger React hover to mount menu indicator (dispatchEvent mouseenter ne marche pas)
    var chipProps = getReactProps(chip);
    if (!chipProps || typeof chipProps.onMouseEnter !== 'function') {
      return { ok: false, error: 'react_props_inaccessible',
               message: 'Webflow React internals may have changed (look for __reactProps$ key)' };
    }
    try { chipProps.onMouseEnter({ bubbles: true }); }
    catch (e) { return { ok: false, error: 'onMouseEnter_threw', message: e.message }; }
    await wait(400);

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
    if (!/^[a-zA-Z0-9_-]+$/.test(newName)) {
      return { ok: false, error: 'invalid_new_name',
               message: 'newName must match /^[a-zA-Z0-9_-]+$/', newName: newName };
    }
    if (oldName === newName) return { ok: false, error: 'no_op_same_name' };

    var start = Date.now();

    cleanupEditMode();
    await wait(300);

    // 1. Find chip with oldName
    var chip = findChipByName(oldName);
    if (!chip) return { ok: false, error: 'chip_not_found', oldName: oldName };

    // 2. React hover + indicator click
    var chipProps = getReactProps(chip);
    if (!chipProps || typeof chipProps.onMouseEnter !== 'function') {
      return { ok: false, error: 'react_props_inaccessible' };
    }
    chipProps.onMouseEnter({ bubbles: true });
    await wait(400);

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

    // 2. React onMouseEnter to mount menu indicator
    var chipProps = getReactProps(chip);
    if (!chipProps || typeof chipProps.onMouseEnter !== 'function') {
      return { ok: false, error: 'react_props_inaccessible' };
    }
    try { chipProps.onMouseEnter({ bubbles: true }); }
    catch (e) { return { ok: false, error: 'onMouseEnter_threw', message: e.message }; }
    await wait(400);

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

    // 1. Click sur left-sidebar-styles-button SEULEMENT si Style Manager pas déjà ouvert.
    // FIX v3.20.4 : le sidebar styles button est un TOGGLE — click ferme si déjà ouvert.
    // Sans pré-check, le 2e call consécutif fermait le Style Manager au lieu de l'ouvrir.
    var stylesPanelCheck = document.querySelector('[data-automation-id="styles"]');
    if (!stylesPanelCheck || stylesPanelCheck.offsetWidth === 0) {
      var stylesSidebarBtn = document.querySelector('[data-automation-id="left-sidebar-styles-button"]');
      if (!stylesSidebarBtn) {
        return { ok: false, error: 'styles_sidebar_button_not_found',
                 message: 'left-sidebar-styles-button absent — Webflow UI may have changed' };
      }
      stylesSidebarBtn.click();
      await wait(700);
    }

    // 2. Vérifier que le Style Manager s'est ouvert
    var stylesPanel = document.querySelector('[data-automation-id="styles"]');
    if (!stylesPanel) {
      return { ok: false, error: 'style_manager_did_not_open',
               message: 'Click sidebar button did not open Style Manager — modal may be blocking' };
    }

    // 4. Click "Clean up styles" button
    var cleanBtn = document.querySelector('[data-automation-id="clean-up-styles-button"]');
    if (!cleanBtn) {
      // Pas de bouton = 0 orphelines OU UI Webflow a changé
      // Close Style Manager + return
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { ok: true, classes_about_to_delete: [],
               message: 'clean_up_styles_button not present — 0 orphan classes likely',
               durationMs: Date.now() - start };
    }
    cleanBtn.click();
    await wait(700);

    // 5. Parse le modal "Clean up unused styles" pour la liste classes orphelines
    var modal = Array.from(document.querySelectorAll('[data-automation-id="overlay"]'))
      .find(function(el) { return el.offsetWidth > 0 && /The following styles/.test(el.textContent || ''); });

    var classesAboutToDelete = [];
    if (modal) {
      // Extract class names from modal content
      // Format: "The following styles are not associated with any page elements:_test-container_test-box..."
      var modalText = modal.textContent || '';
      var afterColon = modalText.split('elements:')[1];
      if (afterColon) {
        // Stop at "Delete" or "Cancel" button text
        var listPart = afterColon.split(/\bDelete\b|\bCancel\b|\bKeep\b/)[0];
        // Split on capital underscore prefix (heuristic for class boundary)
        // Better : parse chip wrappers in modal
        var chipsInModal = modal.querySelectorAll('[data-automation-id="style-rule-token-wrapper"]');
        classesAboutToDelete = Array.from(chipsInModal)
          .map(function(c) {
            var t = c.querySelector('[data-automation-id="style-rule-token-text"]');
            return t ? t.textContent.trim() : null;
          })
          .filter(Boolean);
        if (classesAboutToDelete.length === 0 && listPart) {
          // Fallback : just return raw list text
          classesAboutToDelete = [listPart.trim().slice(0, 500)];
        }
      }
    }

    // 6. Si dryRun : close modal + return preview
    if (dryRun) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(300);
      // ESC again to close Style Manager too
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
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
      return { ok: false, error: 'remove_styles_button_not_visible',
               message: 'Modal opened but Delete button absent — 0 orphans confirmed',
               classes_about_to_delete: classesAboutToDelete };
    }
    deleteBtn.click();
    await wait(waitMs);

    // 8. Close Style Manager (ESC)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(200);

    return {
      ok: true,
      deleted_count: classesAboutToDelete.length,
      classes_deleted: classesAboutToDelete,
      durationMs: Date.now() - start
    };
  };

  console.log('[StyleSelectorUI] 6 commands registered: addClassViaUI · removeLastClassViaUI · removeClassFromElementViaUI · renameClassViaUI · duplicateClassViaUI · cleanupUnusedStylesViaUI (v3.20.0 s568)');
})();

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
    'setComponentPropsViaUI',
    'setImageSettings',
    'helpEditImagesAltInComponent',
    'findNodeContext',
    'listEmbeds',
    'getEmbedContent',
    'getEmbedContentViaUI',
    'getCurrentPageInfo',
    'dumpTree',
    'scrollToElement',
    'addClassViaUI',
    'removeLastClassViaUI',
    'removeClassFromElementViaUI',
    'renameClassViaUI',
    'duplicateClassViaUI',
    'cleanupUnusedStylesViaUI'
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
