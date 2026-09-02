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
      // Consume a run of plain text (escapeHtml escapes any HTML in it).
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

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------
// HTML → Markdown converter (reverses renderMarkdown output).
// Converts known HTML tags back to markdown, strips the rest.
// ---------------------------------------------------------------
export function htmlToMarkdown(html) {
  if (!html || !/<[a-z/]/i.test(html)) return html || "";
  const tree = parseHtmlTree(html);
  return treeToMd(tree).replace(/\n{3,}/g, "\n\n").trim();
}

function parseHtmlTree(html) {
  const root = [];
  const stack = [root];
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\/?>/g;
  const selfClosing = new Set(["br", "hr", "img"]);
  let m, lastIdx = 0;
  while ((m = tagRe.exec(html)) !== null) {
    if (m.index > lastIdx) stack[stack.length - 1].push(html.slice(lastIdx, m.index));
    const raw = m[0];
    const tag = m[1];
    const isClose = raw[1] === "/";
    const isSelf = selfClosing.has(tag) || raw.endsWith("/>");
    if (isClose) {
      if (stack.length > 1) { stack.pop(); stack[stack.length - 1].push({ tag, close: true }); }
      else stack[stack.length - 1].push(raw);
    } else if (isSelf) {
      stack[stack.length - 1].push({ tag, self: true, html: raw });
    } else {
      const children = [];
      stack[stack.length - 1].push({ tag, children, html: raw });
      stack.push(children);
    }
    lastIdx = tagRe.lastIndex;
  }
  if (lastIdx < html.length) stack[stack.length - 1].push(html.slice(lastIdx));
  while (stack.length > 1) {
    const unfinished = stack.pop();
    stack[stack.length - 1].push({ tag: "unknown", children: unfinished });
  }
  return root;
}

function treeToMd(nodes) {
  let out = "";
  for (const node of nodes) {
    if (typeof node === "string") { out += node; continue; }
    if (node.close) continue;
    if (node.tag === "p" || node.tag === "div") {
      const inner = treeToMd(node.children).trim();
      out += inner ? "\n\n" + inner : "";
    } else if (/^h[1-6]$/.test(node.tag)) {
      const lvl = parseInt(node.tag[1]);
      out += "\n\n" + "#".repeat(lvl) + " " + treeToMd(node.children).trim() + "\n\n";
    } else if (node.tag === "ul") {
      out += "\n" + collectListItems(node.children, false) + "\n";
    } else if (node.tag === "ol") {
      out += "\n" + collectListItems(node.children, true) + "\n";
    } else if (node.tag === "blockquote") {
      const inner = treeToMd(node.children).trim();
      out += "\n" + inner.split("\n").map(l => "> " + l).join("\n") + "\n";
    } else if (node.tag === "pre") {
      const code = extractText(node.children);
      out += "\n\n```\n" + code + "\n```\n\n";
    } else if (node.tag === "hr") {
      out += "\n\n***\n\n";
    } else if (node.tag === "em" || node.tag === "i") {
      out += "*" + treeToMd(node.children) + "*";
    } else if (node.tag === "strong" || node.tag === "b") {
      out += "**" + treeToMd(node.children) + "**";
    } else if (node.tag === "del" || node.tag === "s") {
      out += "~~" + treeToMd(node.children) + "~~";
    } else if (node.tag === "u") {
      out += "++" + treeToMd(node.children) + "++";
    } else if (node.tag === "mark") {
      out += "==" + treeToMd(node.children) + "==";
    } else if (node.tag === "sub") {
      out += "~" + treeToMd(node.children) + "~";
    } else if (node.tag === "sup") {
      out += "^" + treeToMd(node.children) + "^";
    } else if (node.tag === "code") {
      out += "`" + extractText(node.children) + "`";
    } else if (node.tag === "a") {
      const href = (node.html || "").match(/href="([^"]*)"/);
      out += "[" + treeToMd(node.children).trim() + "](" + (href ? href[1] : "") + ")";
    } else if (node.tag === "img") {
      const src = (node.html || "").match(/src="([^"]*)"/) || "";
      const alt = (node.html || "").match(/alt="([^"]*)"/) || "";
      out += "![" + (alt[1] || "") + "](" + (src[1] || "") + ")";
    } else if (node.tag === "br") {
      out += "\n";
    } else if (node.children) {
      out += treeToMd(node.children);
    }
  }
  return out;
}

function collectListItems(nodes, ordered) {
  const items = [];
  let num = 1;
  for (const node of nodes) {
    if (typeof node === "string") continue;
    if (node.close) continue;
    if (node.tag === "li") {
      const prefix = ordered ? (num++ + ". ") : "- ";
      items.push(prefix + treeToMd(node.children).trim());
    } else if (node.children) {
      items.push(treeToMd(node.children).trim());
    }
  }
  return items.join("\n");
}

function extractText(nodes) {
  let out = "";
  for (const node of nodes) {
    if (typeof node === "string") { out += node; continue; }
    if (node.children) out += extractText(node.children);
  }
  return out;
}
