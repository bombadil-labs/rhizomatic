# TODO Skill Title

A Chorus app-skill for <domain>: <one line>.

## Use through Claude

Install the skill (below). Ask Claude something in-domain ("<example prompt>"). The skill introduces a
Chorus session, loads your data, renders the app, and saves what you add.

## Install

Build the package from the repo root, then install the `.skill` through your Claude client:

```
node skills/build-skills.mjs        # writes skills/dist/<name>.skill
```

## Deploy standalone

`app/index.html` is self-contained. To run it outside Claude against a Chorus HTTP node
([apps/chorus/src/mcp-http.ts](../../apps/chorus/src/mcp-http.ts)), set before load:

```html
<script>
  window.CHORUS_ENDPOINT = { url: "https://<node>/mcp/<token>", token: "<token>", session: "<id>" };
</script>
```

Turning free text into structured writes (the LLM step) is yours to wire — the app speaks MCP
JSON-RPC directly for reads/writes once pointed at a node.

## Privacy

<Tier statement — where this domain's data should live and whether it federates.>
