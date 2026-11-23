const REPO = "https://github.com/bombadil-labs/rhizomatic/blob/main/";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function inline(src: string): string {
  return esc(src)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, href: string) => {
      const url = /^(?:https?:|#)/.test(href) ? href : REPO + href;
      return `<a href="${url}">${text}</a>`;
    });
}

const LIST_ITEM = /^(-|\d+\.) /;

/** Renders the subset of Markdown that VISION.md uses. Throws on a line it cannot place. */
export function renderVisionBody(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let open = false;
  let i = 0;
  const title = lines[i++] ?? "";
  if (!title.startsWith("# ")) throw new Error("VISION.md must start with a level-1 heading");
  out.push(`<header class="hero prose">`, `  <h1>${inline(title.slice(2))}</h1>`);
  let lead = true;
  let first = true;
  const closeHead = (): void => {
    if (!lead) return;
    lead = false;
    out.push(
      `  <p class="cta"><a href="demo.html">See it run: two tools, a third party's mapping and a policy, live in your tab.</a></p>`,
      `</header>`,
      `<div class="prose">`,
    );
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      closeHead();
      if (open) out.push(`</section>`);
      open = true;
      const text = line.slice(3);
      out.push(`<section id="${slug(text)}">`, `  <h2>${inline(text)}</h2>`);
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) body.push(lines[i++]!);
      i++;
      out.push(`  <pre class="code">${esc(body.join("\n"))}</pre>`);
      continue;
    }
    if (line.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.startsWith("|")) {
        rows.push(
          lines[i++]!.slice(1, -1)
            .split("|")
            .map((c) => c.trim()),
        );
      }
      const [head, , ...body] = rows;
      out.push(
        `  <div class="scroll"><table>`,
        `    <tr>${head!.map((c) => `<th>${inline(c)}</th>`).join("")}</tr>`,
        ...body.map((r) => `    <tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`),
        `  </table></div>`,
      );
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const tag = line.startsWith("-") ? "ul" : "ol";
      const items: string[] = [];
      while (i < lines.length && (LIST_ITEM.test(lines[i]!) || /^ {2,}\S/.test(lines[i]!))) {
        const l = lines[i++]!;
        if (LIST_ITEM.test(l)) items.push(l.replace(LIST_ITEM, ""));
        else items[items.length - 1] += " " + l.trim();
      }
      out.push(`  <${tag}>`, ...items.map((t) => `    <li>${inline(t)}</li>`), `  </${tag}>`);
      continue;
    }
    if (/^[#>]/.test(line)) throw new Error(`VISION.md line ${i + 1}: unsupported block`);
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^(## |```|\||#|>)/.test(lines[i]!) &&
      !LIST_ITEM.test(lines[i]!)
    ) {
      para.push(lines[i++]!.trim());
    }
    out.push(`  <p${first ? ` class="lead"` : ""}>${inline(para.join(" "))}</p>`);
    first = false;
  }
  closeHead();
  if (open) out.push(`</section>`);
  out.push(`</div>`);
  return out.join("\n");
}

const STYLE = `
  :root {
    --bg: #0f0f14;
    --panel: #17171f;
    --border: #2a2a38;
    --text: #d8d8e0;
    --dim: #8a8a9a;
    --accent: #e8b04b;
    --mono: ui-monospace, "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 17px/1.65 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  main { max-width: 792px; margin: 0 auto; padding: 0 16px 4em; }
  header.hero { padding: 1.6em 0 0.2em; }
  h1 { font-size: 2.2em; margin: 0 0 0.35em; letter-spacing: -0.02em; line-height: 1.15; text-wrap: balance; }
  .lead { font-size: 1.05em; line-height: 1.55; margin: 0 0 1em; }
  .cta a {
    display: inline-block; border: 1px solid var(--accent); border-radius: 8px;
    padding: 0.55em 0.9em; font-weight: 600;
  }
  section { margin-top: 2.8em; scroll-margin-top: 1em; }
  h2 { font-size: 1.5em; letter-spacing: -0.01em; margin: 0 0 0.5em; text-wrap: balance; }
  p { margin: 0.8em 0; }
  li { margin: 0.45em 0; }
  code { font-family: var(--mono); font-size: 0.88em; }
  pre.code {
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 0.8em 1em; overflow-x: auto; font-family: var(--mono); font-size: 0.8em; line-height: 1.5;
  }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 0.92em; margin: 1em 0; }
  td, th { border: 1px solid var(--border); padding: 0.5em 0.7em; text-align: left; vertical-align: top; }
  th { color: var(--dim); font-weight: 600; }
  footer { border-top: 1px solid var(--border); color: var(--dim); font-size: 0.88em; padding: 1.2em 16px; text-align: center; }
`;

export function renderVisionPage(markdown: string): string {
  return `<!doctype html>
<!-- Generated from VISION.md by "npm run docs:build". Edit VISION.md, not this file. -->
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Rhizomatic Engineering</title>
<link rel="icon" href="data:," />
<meta name="description" content="Software that exchanges claims in one shared form, so that a third person can connect two tools after both have shipped, and every reader can check who connected them and how." />
<style>${STYLE}</style>
</head>
<body>
<main>
${renderVisionBody(markdown)}
<section>
  <h2>Go further</h2>
  <ul>
    <li><a href="demo.html">The live example: two tools, a mapping and a policy</a></li>
    <li><a href="playground.html">The playground</a></li>
    <li><a href="tour.html">The format tour (older; being rewritten)</a></li>
    <li><a href="${REPO}spec/00-overview.md">The specification</a></li>
    <li><a href="https://www.npmjs.com/package/@bombadil/rhizomatic">npm: <code>@bombadil/rhizomatic</code></a></li>
  </ul>
</section>
</main>
<footer>Mushrooms versus towers, all the way down. · <a href="https://github.com/bombadil-labs/rhizomatic">github.com/bombadil-labs/rhizomatic</a></footer>
</body>
</html>
`;
}
