// The landing page: DOM glue over demo/site/triage.ts. Every answer on the page comes from the
// fixture, which runs the library in src/. A start-up failure renders a visible error line.

import {
  ENGINEER_CLAIM,
  MAPPER_CLAIMS,
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
  | "report-view"
  | "report-claims";

const $ = (id: Id): HTMLElement => {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`the page has no element #${id}`);
  return node;
};

const short = (id: string): string => `${id.slice(4, 16)}…`;

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
  $("gate-answer").textContent = g.answer === undefined ? "(no answer)" : String(g.answer);
  $("gate-decided").textContent =
    g.decidedBy === undefined
      ? ""
      : `decided by: ${g.decidedBy.who}, claim ${short(g.decidedBy.id)}`;
  $("gate-claims").replaceChildren(
    el("div", "panel-title", `in the HyperView under "decision": ${g.inView.length} claim(s)`),
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
  $("report-meta").textContent =
    `built from the pack alone: ${r.packedClaims} signed claims, ${r.packBytes} bytes, ` +
    `pack ${short(r.packId)} · ${r.signers.length} signer(s)`;
  $("report-view").textContent =
    r.claims.length < 2
      ? `${JSON.stringify(r.view)}  no conflict: the report matches ${r.claims.length} claim`
      : JSON.stringify(r.view);
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
    `Sam's claims: a slot declaration and two mappings ("status" and "verdict" name one ` +
    `release decision): ${MAPPER_CLAIMS.map((d) => short(d.id)).join(", ")}`;
  $("gate-schema").textContent = JSON.stringify(recallBody("status"), null, 1);

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
