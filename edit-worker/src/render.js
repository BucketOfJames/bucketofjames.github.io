// Custom line/paragraph markdown renderer (shared, no dependencies).
//
// Behavior (matches the /edit editor preview and the site render):
//   - Standalone "---" lines are dropped.
//   - A blank line emits an empty <p></p> (which CSS pads to a full line height).
//   - A non-empty line emits <p>…</p>.
//   - Two adjacent non-empty lines get a <br> placed between their <p>s.
//   - "# "…"###### " heading lines render as <h1>…<h6>.
//   - Inline: `code`, **bold**, _italic_, ~~strikethrough~~, [links](url),
//     ![images](url).

export function renderMarkdown(raw) {
  if (typeof raw !== "string") raw = String(raw || "");
  let lines = raw.split(/\r?\n/);
  const clean = [];
  for (const ln of lines) {
    if (/^---+$/.test(ln.trim())) continue;
    clean.push(ln);
  }
  lines = clean;

  const out = [];
  let prevNonEmpty = false;
  for (const ln of lines) {
    if (isBlank(ln)) {
      out.push("<p></p>");
      prevNonEmpty = false;
      continue;
    }
    if (prevNonEmpty) out.push("<br>");
    out.push(renderLine(ln));
    prevNonEmpty = true;
  }
  return out.join("\n");
}

function isBlank(ln) {
  return ln.trim() === "";
}

function renderLine(ln) {
  const trimmed = ln.trim();
  const h = /^(#{1,6})\s+/.exec(trimmed);
  if (h) {
    const level = h[1].length;
    return `<h${level}>${inline(trimmed.slice(h[0].length))}</h${level}>`;
  }
  return `<p>${inline(ln)}</p>`;
}

const INLINE_RULES = [
  { type: "code", re: /^(`+)(.+?)\1/ },
  { type: "strong", re: /^(\*\*|__)(.+?)\1/ },
  { type: "em", re: /^(\*|_)(.+?)\1/ },
  { type: "del", re: /^(~~)(.+?)\1/ },
  { type: "img", re: /^!\[([^\]]*)\]\(([^)]+)\)/ },
  { type: "link", re: /^\[([^\]]+)\]\(([^)]+)\)/ },
];

function inline(text) {
  let i = 0;
  let out = "";
  const stopRe = /[*_~`[!\\]/; // chars that start an inline rule
  while (i < text.length) {
    const rest = text.slice(i);
    let matched = false;
    for (const rule of INLINE_RULES) {
      const m = rule.re.exec(rest);
      if (m) {
        matched = true;
        if (rule.type === "code") {
          out += `<code>${escapeHtml(m[2])}</code>`;
        } else if (rule.type === "strong") {
          out += `<strong>${inline(m[2])}</strong>`;
        } else if (rule.type === "em") {
          out += `<em>${inline(m[2])}</em>`;
        } else if (rule.type === "del") {
          out += `<del>${inline(m[2])}</del>`;
        } else if (rule.type === "img") {
          out += `<img src="${escapeAttr(m[2])}" alt="${escapeAttr(m[1])}">`;
        } else if (rule.type === "link") {
          out += `<a href="${escapeAttr(m[2])}">${inline(m[1])}</a>`;
        }
        i += m[0].length;
        break;
      }
    }
    if (!matched) {
      // Consume a run of plain text so escapeHtml can protect whitelisted
      // inline tags (e.g. <sub> … </sub>) which spans multiple characters.
      const restSlice = text.slice(i);
      const next = restSlice.search(stopRe);
      const chunkEnd = next === -1 ? restSlice.length : next;
      let chunk = restSlice.slice(0, chunkEnd);
      if (chunk.length === 0) chunk = restSlice[0];
      out += escapeHtml(chunk);
      i += chunk.length;
    }
  }
  return out;
}

// Whitelisted inline HTML tags passed through untouched (not escaped).
const SAFE_TAG_RE = /(<\/(?:sub|sup|br|kbd|i|b)>|<(?:sub|sup|br|kbd|i|b)(?:\s[^>]*)?>)/g;

function escapeHtml(s) {
  // Protect whitelisted tags, escape everything else, restore tags.
  const keep = [];
  const protected_ = s.replace(SAFE_TAG_RE, (m) => {
    keep.push(m);
    return `\u0000${keep.length - 1}\u0000`;
  });
  const escaped = protected_.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped.replace(/\u0000(\d+)\u0000/g, (m, i) => keep[Number(i)]);
}
function escapeAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
