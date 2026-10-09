// Store views share the archive console's palette, type and controls.
const params = new URLSearchParams(location.search);
const app = document.getElementById("app");
const make = (tag, text, cls) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
const style = make("style");
style.textContent = `
#evidence-feed{overflow:auto;padding:20px;background:var(--stage)}
.evidence-filters{display:flex;gap:8px;flex-wrap:wrap;padding:12px;background:var(--panel);border:1px solid var(--edge)}
.evidence-filters input{width:150px}.evidence-row{display:flex;width:100%;text-align:left;gap:18px;padding:16px;margin-bottom:8px;align-items:center;min-height:85px;background:var(--panel)}
.evidence-row img{width:110px;height:65px;object-fit:contain}.evidence-row .caption{font-size:14px;margin-bottom:7px}.failed{border-color:var(--danger);color:var(--danger)}
#evidence-item{position:fixed;inset:0;background:var(--stage);z-index:10;display:grid;grid-template-rows:auto minmax(0,1fr);padding:16px;gap:12px}
.item-layout{display:grid;grid-template-columns:minmax(0,1fr) 300px;min-height:0;gap:16px}.item-stage{overflow:auto;display:grid;align-items:center;justify-items:center;min-height:0;background:#080b0d}
.item-stage img,.item-stage video{max-width:100%;max-height:100%;object-fit:contain}.item-stage pre,.json-tree{justify-self:stretch;align-self:stretch;padding:20px;white-space:pre-wrap;overflow-wrap:anywhere}
.item-meta{overflow:auto;overflow-wrap:anywhere}.item-meta pre{white-space:pre-wrap;overflow-wrap:anywhere}.item-meta p{margin:0 0 18px}.item-bar{display:flex;gap:12px;align-items:center}.item-bar strong{flex:1}.json-tree details{margin-left:16px}.json-tree summary{cursor:pointer;color:var(--accent)}
@media(max-width:700px){.item-layout{grid-template-columns:1fr;grid-template-rows:minmax(160px,1fr) 220px}.evidence-row img{width:70px}.evidence-filters input{width:130px}#evidence-item{padding:8px}.item-meta p{margin-bottom:8px}}
`;
document.head.append(style);
const nav = make("a", "Recent evidence");
nav.href = "/?recent";
document.querySelector("header").append(nav);
async function json(url) {
  const r = await fetch(url);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
let activeQuery = "",
  loading = false;
let records = [],
  selected = -1,
  cursor,
  generation = 0,
  itemGeneration = 0,
  objectUrl;
let feed, filters, status, more, dialog, restoreFocus;
async function start() {
  app.replaceChildren();
  app.style.gridTemplateRows = "auto auto minmax(0,1fr)";
  const header = make("header");
  const title = make("div");
  title.append(
    make("p", "Evidence", "label"),
    make("h1", params.has("issue") ? params.get("issue") : "Everything proven recently"),
    make("span", "J/K or arrows · Enter to open · Esc to return · / to filter", "subtle"),
  );
  const archive = make("a", "Archive");
  archive.href = "/";
  header.append(title, archive);
  app.append(header);
  filters = make("form", undefined, "evidence-filters");
  for (const [key, label] of params.has("issue")
    ? []
    : [
        ["project", "Project"],
        ["repo", "Repo"],
        ["issue", "Issue"],
        ["actorKind", "Actor kind"],
        ["actorName", "Actor name"],
        ["mediaType", "Media type"],
        ["since", "Since"],
        ["until", "Until"],
      ]) {
    const input = make("input");
    input.name = key;
    input.placeholder = label;
    input.setAttribute("aria-label", label);
    input.value = params.get(key) || "";
    if (key === "since" || key === "until") input.type = "datetime-local";
    if (key === "since" || key === "until") {
      const dateLabel = make("label");
      dateLabel.append(make("span", label, "label"), make("br"), input);
      filters.append(dateLabel);
    } else filters.append(input);
  }
  const apply = make("button", params.has("issue") ? "Recent evidence" : "Filter");
  apply.type = "submit";
  filters.append(apply);
  status = make("span", "", "subtle");
  status.role = "status";
  filters.append(status);
  app.append(filters);
  feed = make("section");
  feed.id = "evidence-feed";
  feed.setAttribute("aria-label", "Recent evidence");
  app.append(feed);
  filters.addEventListener("submit", (e) => {
    e.preventDefault();
    if (params.has("issue")) location.href = "/?recent";
    else load(true);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dialog) {
      closeItem();
      e.preventDefault();
      return;
    }
    if (e.key === "Tab" && dialog) {
      const controls = [...dialog.querySelectorAll("button:not(:disabled),a[href],summary,video")];
      const first = controls[0],
        last = controls.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
      return;
    }
    if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === "/") {
      e.preventDefault();
      filters.querySelector("input")?.focus();
      return;
    }
    const direction = ["j", "ArrowRight", "ArrowDown"].includes(e.key)
      ? 1
      : ["k", "ArrowLeft", "ArrowUp"].includes(e.key)
        ? -1
        : 0;
    if (direction) {
      e.preventDefault();
      selected = Math.max(0, Math.min(records.length - 1, selected + direction));
      if (dialog) openItem(selected);
      else feed.querySelectorAll(".evidence-row")[selected]?.focus();
    }
    if (e.key === "Enter" && !dialog && selected >= 0) {
      e.preventDefault();
      openIssueItem(selected);
    }
  });
  await load(true);
  if (params.has("issue") && records.length)
    await openItem(
      Math.max(
        0,
        records.findIndex((r) => r.id === params.get("item")),
      ),
    );
}
function query() {
  const q = new URLSearchParams();
  for (const input of filters.querySelectorAll("input"))
    if (input.value)
      q.set(input.name, input.type === "datetime-local" ? new Date(input.value).toISOString() : input.value);
  return q;
}
async function load(reset) {
  if (!reset && loading) return;
  loading = true;
  if (reset) activeQuery = query().toString();
  const token = reset ? ++generation : generation;
  status.textContent = "Loading…";
  if (reset) {
    records = [];
    cursor = undefined;
    feed.replaceChildren();
    selected = -1;
  }
  try {
    const q = new URLSearchParams(activeQuery);
    if (cursor) q.set("cursor", cursor);
    const result = params.has("issue")
      ? await json(`/__evidence/records?issue=${encodeURIComponent(params.get("issue"))}`)
      : await json(`/__evidence/recent?${q}`);
    if (token !== generation) return;
    records.push(
      ...result.records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)),
    );
    cursor = result.nextCursor;
    loading = false;
    render();
    status.textContent = records.length ? `${records.length} records` : "No matching evidence";
  } catch (error) {
    if (token === generation) {
      loading = false;
      status.textContent = error.message;
      status.className = "failed";
    }
  }
}
function render() {
  feed.replaceChildren();
  let day;
  records.forEach((record, index) => {
    const next = record.createdAt.slice(0, 10);
    if (next !== day) {
      feed.append(make("h2", next));
      day = next;
    }
    const row = make("button", undefined, `evidence-row ${record.outcome === "failed" ? "failed" : ""}`);
    row.type = "button";
    const media = make("span", record.contentType.split("/")[0], "subtle");
    row.append(media);
    if (record.contentType.startsWith("image/"))
      json(`/__evidence/preview/${record.sha256}`)
        .then((preview) => {
          if (preview.available) {
            const img = make("img");
            img.alt = record.caption || record.fileName;
            img.src = `data:${preview.contentType};base64,${preview.data}`;
            media.replaceWith(img);
          }
        })
        .catch(() => {});
    const copy = make("div");
    copy.append(
      make(
        "div",
        `${record.outcome === "failed" ? "FAILED · " : ""}${record.caption || record.fileName}`,
        "caption",
      ),
    );
    const by = make(
      "span",
      `${record.actor.name || record.actor.id} · ${record.issueKey || "No issue"} · ${record.project || record.repo || "Project unknown"} · ${new Date(record.createdAt).toLocaleTimeString()}`,
    );
    let hash = 0;
    for (const c of record.actor.id) hash = (hash * 31 + c.charCodeAt(0)) | 0;
    by.style.color = `hsl(${Math.abs(hash) % 360} 55% 72%)`;
    copy.append(by);
    row.append(copy);
    row.addEventListener("focus", () => (selected = index));
    row.addEventListener("click", () => openIssueItem(index));
    feed.append(row);
  });
  if (cursor) {
    more = make("button", "Load older evidence");
    more.onclick = () => load(false);
    feed.append(more);
  }
}
async function openIssueItem(index) {
  const record = records[index];
  if (!record) return;
  if (record.issueKey && !params.has("issue")) {
    location.href = `/?issue=${encodeURIComponent(record.issueKey)}&item=${record.id}`;
    return;
  }
  await openItem(index);
}
function tree(value, key = "JSON") {
  if (value === null || typeof value !== "object") return make("div", `${key}: ${JSON.stringify(value)}`);
  const node = make("details");
  node.open = key === "JSON";
  node.append(
    make(
      "summary",
      `${key} · ${Array.isArray(value) ? `${value.length} items` : `${Object.keys(value).length} keys`}`,
    ),
  );
  for (const [k, v] of Object.entries(value)) node.append(tree(v, k));
  return node;
}
async function openItem(index) {
  const record = records[index];
  if (!record) return;
  selected = index;
  const token = ++itemGeneration;
  if (!dialog) {
    restoreFocus = document.activeElement;
    dialog = make("section");
    dialog.id = "evidence-item";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "Issue evidence");
    document.body.append(dialog);
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = undefined;
  }
  dialog.replaceChildren();
  const bar = make("div", undefined, "item-bar");
  const back = make("button", "Esc · Close");
  back.onclick = closeItem;
  bar.append(back, make("strong", `${record.issueKey || "Evidence"} · ${index + 1}/${records.length}`));
  for (const [label, delta] of [
    ["←", -1],
    ["→", 1],
  ]) {
    const b = make("button", label);
    b.setAttribute("aria-label", delta < 0 ? "Previous item" : "Next item");
    b.disabled = index + delta < 0 || index + delta >= records.length;
    b.onclick = () => openItem(index + delta);
    bar.append(b);
  }
  dialog.append(bar);
  back.focus();
  const layout = make("div", undefined, "item-layout"),
    stage = make("div", "Loading item…", "item-stage"),
    meta = make("aside", undefined, "item-meta");
  layout.append(stage, meta);
  dialog.append(layout);
  for (const [label, value] of [
    ["Caption", record.caption || record.fileName],
    ["Actor", `${record.actor.kind} · ${record.actor.name || record.actor.id}`],
    ["Model", record.model || "Unknown"],
    ["Commit", record.commit || "Unknown"],
    ["Time", record.createdAt],
    ["Size", `${record.size.toLocaleString()} bytes`],
    ["SHA256", record.sha256],
    ["Outcome", record.outcome || "Not recorded"],
  ]) {
    const p = make("p");
    p.append(make("span", label, "label"), make("br"), make("span", value));
    meta.append(p);
  }
  if (record.issueKey) {
    const a = make("a", "Open issue ↗");
    a.href = `https://linear.app/vuhlp/issue/${encodeURIComponent(record.issueKey)}`;
    a.target = "_blank";
    a.rel = "noopener";
    meta.append(a);
  }
  const copy = make("button", "Copy evidence link");
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(record.url);
      copy.textContent = "Copied";
    } catch {
      copy.textContent = record.url;
    }
  };
  meta.append(make("br"), copy, make("h3", "Listed gaps"));
  // Gaps are source conclusions, not invented from missing optional metadata.
  if (record.issueKey)
    json(`/__evidence/gaps?issue=${encodeURIComponent(record.issueKey)}`)
      .then(({ gaps }) => {
        if (token !== itemGeneration) return;
        if (!gaps.length) meta.append(make("p", "No gaps listed in the local issue evidence folders."));
        for (const gap of gaps) {
          meta.append(make("p", gap.source, "subtle"), make("pre", gap.text));
        }
      })
      .catch(() => meta.append(make("p", "Listed gaps unavailable", "failed")));
  else meta.append(make("p", "No issue assigned."));

  let x;
  stage.addEventListener("touchstart", (e) => (x = e.changedTouches[0].clientX), { passive: true });
  stage.addEventListener(
    "touchend",
    (e) => {
      const dx = e.changedTouches[0].clientX - x;
      if (Math.abs(dx) > 50) openItem(Math.max(0, Math.min(records.length - 1, index + (dx < 0 ? 1 : -1))));
    },
    { passive: true },
  );
  try {
    const response = await fetch(`/__evidence/blob/${record.sha256}`);
    if (!response.ok) throw new Error(`Item unavailable: HTTP ${response.status}`);
    const blob = await response.blob();
    if (token !== itemGeneration) return;
    stage.replaceChildren();
    if (record.contentType.startsWith("image/") || record.contentType.startsWith("video/")) {
      const media = make(record.contentType.startsWith("image/") ? "img" : "video");
      media.alt = record.caption || record.fileName;
      media.controls = true;
      objectUrl = URL.createObjectURL(new Blob([blob], { type: record.contentType }));
      media.src = objectUrl;
      stage.append(media);
    } else if (record.contentType === "application/json") {
      const wrapper = make("div", undefined, "json-tree");
      wrapper.append(tree(JSON.parse(await blob.text())));
      stage.append(wrapper);
    } else stage.append(make("pre", await blob.text()));
  } catch (error) {
    if (token === itemGeneration) stage.replaceChildren(make("p", error.message, "failed"));
  }
}
function closeItem() {
  ++itemGeneration;
  dialog?.remove();
  dialog = undefined;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  restoreFocus?.focus();
}

if (params.has("recent") || params.has("issue")) start();
