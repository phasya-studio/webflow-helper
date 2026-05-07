# webflow-helper

Webflow Designer helper — minimal surface exposing 8 commands via `__webflowHelper.run()`:

| Cmd | Purpose | MCP gap |
|---|---|---|
| `launchBridgeApp` | Mount the Webflow MCP Bridge App via direct dispatch | Not in MCP |
| `switchPage` | Switch Designer to another static page | MCP `de_page_tool.switch_page` ~70% timeout |
| `getCurrentPageInfo` | 3-source page concordance (DOM/URL/Redux) | MCP `de_page_tool.get_current_page` 76% timeout + no DOM check |
| `appendHtmlEmbedWS` | Create a native HtmlEmbed via WebSocket | No MCP tool covers this |
| `updateEmbed` | Write content to existing HtmlEmbed | No MCP tool |
| `listEmbeds` | List embeds + their contents | No MCP tool |
| `getEmbedContent` | Read a single embed's content | No MCP tool |
| `setEmbedHasScript` | Set the `w-script` flag retroactively | No MCP tool |

Any other cmd via `__webflowHelper.run('X')` returns `{ ok: false, error: 'CMD_NOT_EXPOSED' }`. Everything else uses the official MCP server.

## Usage

Load via [jsDelivr](https://www.jsdelivr.com/) in the Webflow Designer browser context (Chrome DevTools, MCP Bridge, etc.) :

```html
<script src="https://cdn.jsdelivr.net/gh/phasya-studio/webflow-helper@v1.2.0/webflow-helper.js"></script>
```

Or via dynamic injection :

```js
const s = document.createElement('script');
s.src = 'https://cdn.jsdelivr.net/gh/phasya-studio/webflow-helper@v1.2.0/webflow-helper.js';
document.head.appendChild(s);
// Wait for window.__webflowHelper to be defined
```

Always **pin to an exact version tag** (`@v1.2.0`) — never `@latest` (silent breakage risk).

## Versioning

Semantic versioning. Tags `vMAJOR.MINOR.PATCH`. jsDelivr cache invalidates automatically on new tag.

## License

[MIT](./LICENSE)
