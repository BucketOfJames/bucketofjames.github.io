// Custom block/inline markdown renderer (shared, no dependencies).
//
// Behavior (matches the /edit editor preview and the site render):
//   - Standalone "---" lines are dropped.
//   - A non-empty line emits <p>…</p>.
//   - A single completely empty line (no spaces) emits an empty <p></p>
//     (the site CSS pads it to a full line of height).
//   - "# "…"###### " heading lines render as <h1>…<h6>.
//   - Consecutive "- " / "* " / "+ " lines render as a <ul>;
//     consecutive "1. " / "1) " lines render as an <ol>.
//   - Consecutive "> " lines render as a <blockquote>; when the first
//     quoted line is "[!NOTE]" / "[!TIP]" / "[!IMPORTANT]" / "[!WARNING]"
//     / "[!CAUTION]" (case-insensitive, alone on its line) the quote
//     renders as a styled note box instead.
//   - ``` fenced code blocks render as <pre><code> (content escaped,
//     everything inside is literal; "---" dropping does not apply).
//   - A standalone "***" or "___" line (3+) renders an <hr>.
//   - Inline: `code`, **bold**, _italic_, ~~strikethrough~~,
//     ++underline++, ==highlight==, H~2~O (sub), x^2^ (sup),
//     [links](url), ![images](url).
//   - A backslash escapes any ASCII punctuation: \* renders a literal *.

export function renderMarkdown(raw) {
  if (typeof raw !== "string") raw = String(raw || "");
  return renderBlocks(String(raw).split(/\r?\n/));
}

function renderBlocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    const t = ln.trim();

    // Fenced code block: ``` (optional info string) ... ```
    const fence = /^(`{3,})\s*([^`]*)$/.exec(t);
    if (fence) {
      const closeRe = new RegExp("^`{" + fence[1].length + ",}\\s*$");
      const buf = [];
      i++;
      while (i < lines.length && !closeRe.test(lines[i].trim())) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip the closing fence (or EOF)
      out.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // Standalone --- lines are dropped.
    if (/^-{3,}$/.test(t)) { i++; continue; }

    // Blank line -> empty paragraph (site CSS pads it to a full line).
    if (t === "") { out.push("<p></p>"); i++; continue; }

    // Heading.
    const h = /^(#{1,6})\s+/.exec(t);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inline(t.slice(h[0].length))}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule: standalone *** or ___ (3+).
    if (/^(\*\*\*+|___+)$/.test(t)) { out.push("<hr>"); i++; continue; }

    // Unordered list: consecutive "- " / "* " / "+ " lines.
    if (/^[-*+]\s+/.test(t)) {
      const items = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*+]\s+/, ""));
        i++;
      }
      out.push(`<ul>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</ul>`);
      continue;
    }

    // Ordered list: consecutive "1. " / "1) " lines.
    if (/^\d{1,9}[.)]\s+/.test(t)) {
      const items = [];
      while (i < lines.length && /^\d{1,9}[.)]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d{1,9}[.)]\s+/, ""));
        i++;
      }
      out.push(`<ol>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</ol>`);
      continue;
    }

    // Blockquote (also the base of [!NOTE]-style callouts).
    if (/^>\s?/.test(t)) {
      const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        q.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      const note = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(q[0] || "");
      if (note) {
        const cls = note[1].toLowerCase();
        const label = note[1].charAt(0).toUpperCase() + note[1].slice(1).toLowerCase();
        out.push(`<blockquote class="note note-${cls}"><p class="note-title">${label}</p>${renderBlocks(q.slice(1))}</blockquote>`);
      } else {
        out.push(`<blockquote>${renderBlocks(q)}</blockquote>`);
      }
      continue;
    }

    out.push(`<p>${inline(ln)}</p>`);
    i++;
  }
  return out.join("\n");
}

const INLINE_RULES = [
  { type: "escape", re: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/ },
  { type: "code", re: /^(`+)(.+?)\1/ },
  { type: "strong", re: /^(\*\*|__)(.+?)\1/ },
  { type: "del", re: /^(~~)(.+?)\1/ },
  { type: "underline", re: /^(\+\+)(.+?)\1/ },
  { type: "mark", re: /^(==)(.+?)\1/ },
  { type: "sub", re: /^(~)([^~\s](?:[^~]*[^~\s])?)\1/ },
  { type: "sup", re: /^(\^)([^\^\s](?:[^\^]*[^\^\s])?)\1/ },
  { type: "em", re: /^(\*|_)(.+?)\1/ },
  { type: "img", re: /^!\[([^\]]*)\]\(([^)]+)\)/ },
  { type: "link", re: /^\[([^\]]+)\]\(([^)]+)\)/ },
];

function inline(text) {
  let i = 0;
  let out = "";
  const stopRe = /[*_~`[!\\^+=]/; // chars that start an inline rule
  while (i < text.length) {
    const rest = text.slice(i);
    let matched = false;
    for (const rule of INLINE_RULES) {
      const m = rule.re.exec(rest);
      if (m) {
        matched = true;
        if (rule.type === "escape") {
          out += escapeHtml(m[1]);
        } else if (rule.type === "code") {
          out += `<code>${escapeHtml(m[2])}</code>`;
        } else if (rule.type === "strong") {
          out += `<strong>${inline(m[2])}</strong>`;
        } else if (rule.type === "del") {
          out += `<del>${inline(m[2])}</del>`;
        } else if (rule.type === "underline") {
          out += `<u>${inline(m[2])}</u>`;
        } else if (rule.type === "mark") {
          out += `<mark>${inline(m[2])}</mark>`;
        } else if (rule.type === "sub") {
          out += `<sub>${inline(m[2])}</sub>`;
        } else if (rule.type === "sup") {
          out += `<sup>${inline(m[2])}</sup>`;
        } else if (rule.type === "em") {
          out += `<em>${inline(m[2])}</em>`;
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
const SAFE_TAG_RE = /(<\/(?:sub|sup|kbd|i|b)>|<(?:sub|sup|kbd|i|b)(?:\s[^>]*)?>)/g;

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
