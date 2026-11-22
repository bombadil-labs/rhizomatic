// The landing page: DOM glue over demo/site/triage.ts. Every answer on the page comes from the
// fixture, which runs the library in src/. A start-up failure renders a visible error line.

import { MAPPING_ADDS, SPELLINGS_LINE, pageText, short } from "./page-text.js";
import {
  ENGINEER_CLAIM,
  GATE_SPELLING,
  POLICIES,
  RELEASE_SCRIPT_RECORD,
  SUPPORT_CLAIM,
  SUPPORT_HELPER_RECORD,
  adaptReleaseScript,
  adaptSupportHelper,
  gate,
  recallBody,
  report,
  type Claim,
  type PolicyName,
} from "./triage.js";

type Id =
  | "strip-error"
  | "rec-a"
  | "adapter-a"
  | "delta-a"
  | "rec-b"
  | "adapter-b"
  | "delta-b"
  | "ctl-mapping"
  | "ctl-policy"
  | "mapper-claims"
  | "gate-schema"
  | "gate-answer"
  | "gate-decided"
  | "gate-claims"
  | "gate-unmatched"
  | "report-meta"
  | "report-spellings"
  | "report-matched"
  | "report-view"
  | "report-claims";

const $ = (id: Id): HTMLElement => {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`the page has no element #${id}`);
  return node;
};

function el(tag: string, cls: string, text: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls !== "") node.className = cls;
  node.textContent = text;
  return node;
}

function claimLine(c: Claim): HTMLElement {
  const row = el("div", "entry", "");
  row.append(
    el("span", "mono val", c.value),
    el("span", "meta", ` — ${c.who}, spelled "${c.spelling}", t=${c.timestamp}, claim `),
    el("span", "mono dim", short(c.id)),
  );
  return row;
}

function render(): void {
  const mapping = ($("ctl-mapping") as HTMLInputElement).checked;
  const policy = ($("ctl-policy") as HTMLSelectElement).value as PolicyName;

  const g = gate({ mapping, policy });
  const t = pageText({ mapping, policy });
  $("gate-answer").textContent = t.gateAnswer;
  $("gate-decided").textContent = t.gateDecided;
  $("gate-claims").replaceChildren(
    el("div", "panel-title", t.gateTitle),
    ...g.inView.map(claimLine),
  );
  $("gate-unmatched").replaceChildren(
    ...(g.notMatched.length === 0
      ? []
      : [
          el("div", "panel-title", "published, but not matched by the gate"),
          ...g.notMatched.map(claimLine),
        ]),
  );

  const r = report({ mapping });
  $("report-meta").textContent = t.reportMeta;
  $("report-view").textContent = t.reportView;
  $("report-matched").textContent = t.reportMatched;
  $("report-claims").replaceChildren(...r.claims.map(claimLine));
}

function start(): void {
  $("rec-a").textContent = JSON.stringify(RELEASE_SCRIPT_RECORD);
  $("adapter-a").textContent = adaptReleaseScript.toString();
  $("delta-a").textContent = `signed delta ${short(ENGINEER_CLAIM.id)}`;
  $("rec-b").textContent = JSON.stringify(SUPPORT_HELPER_RECORD);
  $("adapter-b").textContent = adaptSupportHelper.toString();
  $("delta-b").textContent = `signed delta ${short(SUPPORT_CLAIM.id)}`;
  $("mapper-claims").textContent =
    `a slot declaration and two mappings ("status" and "verdict" name one release decision): ` +
    MAPPING_ADDS;
  $("report-spellings").textContent = SPELLINGS_LINE;
  $("gate-schema").textContent = JSON.stringify(recallBody(GATE_SPELLING), null, 1);

  const select = $("ctl-policy") as HTMLSelectElement;
  select.replaceChildren(
    ...Object.entries(POLICIES).map(([value, p]) => {
      const option = el("option", "", p.label) as HTMLOptionElement;
      option.value = value;
      return option;
    }),
  );
  $("ctl-mapping").addEventListener("change", guarded);
  select.addEventListener("change", guarded);
  render();
  $("strip-error").textContent = "";
}

function fail(e: unknown): void {
  const line = document.getElementById("strip-error");
  const message = `The live example failed: ${e instanceof Error ? e.message : String(e)}`;
  if (line !== null) line.textContent = message;
  else document.body.prepend(el("p", "error", message));
}

function guarded(): void {
  try {
    render();
  } catch (e) {
    fail(e);
  }
}

try {
  start();
} catch (e) {
  fail(e);
}
