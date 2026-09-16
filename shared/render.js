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
//   - Emphasis ** and * nest and stack (delimiter-run resolution):
//     ***bold italic***, *a **b** c*, **a *b* c**.
//   - A backslash escapes any ASCII punctuation: \* renders a literal *.

import { escapeHtml } from "./http.js";

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
  { type: "del", re: /^(~~)(.+?)\1/ },
  { type: "underline", re: /^(\+\+)(.+?)\1/ },
  { type: "mark", re: /^(==)(.+?)\1/ },
  { type: "sub", re: /^(~)([^~\s](?:[^~]*[^~\s])?)\1/ },
  { type: "sup", re: /^(\^)([^\^\s](?:[^\^]*[^\^\s])?)\1/ },
  { type: "img", re: /^!\[([^\]]*)\]\(([^)]+)\)/ },
  { type: "link", re: /^\[([^\]]+)\]\(([^)]+)\)/ },
];

// ------------------------------------------------------------------
// Bold/italic via delimiter-run resolution (CommonMark-style flanking),
// so emphasis nests and stacks: ***bold italic***, *a **b** c*, ...
// Runs of "*" / "_" are paired on a stack; flanking prevents delimiters
// that merely border whitespace/punctuation from opening or closing.
// ------------------------------------------------------------------
const WS_RE = /[\s\u00a0]/;
const PUNCT_RE = /[!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~]/;

function canOpenEmph(prevCh, nextCh) {
  if (nextCh === null || WS_RE.test(nextCh)) return false;
  if (!PUNCT_RE.test(nextCh)) return true;
  return prevCh === null || WS_RE.test(prevCh) || PUNCT_RE.test(prevCh);
}

function canCloseEmph(prevCh, nextCh) {
  if (prevCh === null || WS_RE.test(prevCh)) return false;
  if (!PUNCT_RE.test(prevCh)) return true;
  return nextCh === null || WS_RE.test(nextCh) || PUNCT_RE.test(nextCh);
}

// Split text into delimiter runs and plain-text tokens. Backslash escapes
// and backtick code spans are kept intact inside text tokens so any
// * / _ they contain stays literal (the recursive inline() pass handles
// them). text.length>0 is guaranteed because callers only try emphasis
// when the string begins with * or _. Returns null when nothing pairs.
function resolveEmphasis(text) {
  const toks = [];
  let buf = "";
  const flush = () => { if (buf) { toks.push({ d: "", s: buf }); buf = ""; } };
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      // Keep the escape + escaped char: inline() unescapes later.
      buf += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "`") {
      // Code span: a backtick run, its content, then the same run again.
      const run = /`+/.exec(text.slice(i))[0];
      const close = text.indexOf(run, i + run.length);
      if (close !== -1) {
        buf += text.slice(i, close + run.length);
        i = close + run.length;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }
    if (ch === "*" || ch === "_") {
      let j = i;
      while (j < text.length && text[j] === ch) j++;
      flush();
      toks.push({
        d: ch, n: j - i,
        prev: i > 0 ? text[i - 1] : null,
        next: j < text.length ? text[j] : null,
        openTags: [], closeTags: [],
      });
      i = j;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();

  const stack = [];
  let paired = false;
  for (const tok of toks) {
    if (!tok.d) continue;
    const isOpen = canOpenEmph(tok.prev, tok.next);
    const isClose = canCloseEmph(tok.prev, tok.next);
    if (isClose) {
      // Pair this run with the nearest still-open run of the same char.
      while (tok.n > 0 && stack.length > 0) {
        const op = stack[stack.length - 1];
        if (op.d !== tok.d) { stack.pop(); continue; }
        const use = op.n >= 2 && tok.n >= 2 ? 2 : 1;
        const tag = use === 2 ? ["<strong>", "</strong>"] : ["<em>", "</em>"];
        // Opens are created inner-first but must render outer-first, so
        // unshift them (closes stay pushed: inner closes first).
        op.openTags.unshift(tag[0]);
        tok.closeTags.push(tag[1]);
        op.n -= use;
        tok.n -= use;
        paired = true;
        if (op.n <= 0) stack.pop();
      }
    }
    if (isOpen && tok.n > 0) stack.push(tok);
  }
  if (!paired) return null;

  let out = "";
  for (const tok of toks) {
    if (!tok.d) {
      out += inline(tok.s);
      continue;
    }
    out += tok.closeTags.join("") + escapeHtml(tok.d.repeat(tok.n)) + tok.openTags.join("");
  }
  return out;
}

function inline(text) {
  let i = 0;
  let out = "";
  const stopRe = /[*_~`[!\\^+=]/; // chars that start an inline rule
  while (i < text.length) {
    const rest = text.slice(i);
    // Emphasis first: the delimiter-run resolver handles the whole rest
    // when it can form any pair (stacked/nested ** and *).
    if (rest[0] === "*" || rest[0] === "_") {
      const resolved = resolveEmphasis(rest);
      if (resolved !== null) {
        out += resolved;
        i += rest.length;
        continue;
      }
    }
    let matched = false;
    for (const rule of INLINE_RULES) {
      const m = rule.re.exec(rest);
      if (m) {
        matched = true;
        if (rule.type === "escape") {
          out += escapeHtml(m[1]);
        } else if (rule.type === "code") {
          out += `<code>${escapeHtml(m[2])}</code>`;
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

// Decode the entities escapeHtml/escapeAttr produce, so rendered HTML
// converts back to the exact markdown text (e.g. "a & b" -> <p>a &amp; b</p> -> "a & b").
// &amp; must be decoded LAST so "&amp;lt;" becomes a literal "&lt;", not "<".
function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
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
  // Blank-line-aware block joining: the renderer joins adjacent blocks with
  // "\n" and encodes a blank line as an empty <p></p>. Reproduce that here so
  // markdown -> HTML -> markdown is byte-identical: adjacent blocks join with
  // a single "\n", and an empty <p></p> marker becomes the "\n\n" blank line.
  let blankBefore = false;
  const block = (text) => {
    if (!text) return;
    out = out.replace(/\s+$/, "");
    out += (out ? (blankBefore ? "\n\n" : "\n") : "") + text;
    blankBefore = false;
  };
  for (const node of nodes) {
    if (typeof node === "string") { out += decodeEntities(node); continue; }
    if (node.close) continue;
    if (node.tag === "p" || node.tag === "div") {
      const inner = treeToMd(node.children).trim();
      if (inner) block(inner);
      else blankBefore = true; // empty <p></p> = blank line between blocks
    } else if (/^h[1-6]$/.test(node.tag)) {
      const lvl = parseInt(node.tag[1]);
      block("#".repeat(lvl) + " " + treeToMd(node.children).trim());
    } else if (node.tag === "ul") {
      block(collectListItems(node.children, false));
    } else if (node.tag === "ol") {
      block(collectListItems(node.children, true));
    } else if (node.tag === "blockquote") {
      block(treeToMd(node.children).trim().split("\n").map((l) => "> " + l).join("\n"));
    } else if (node.tag === "pre") {
      const code = decodeEntities(extractText(node.children));
      block("```\n" + code + "\n```");
    } else if (node.tag === "hr") {
      block("***");
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
      out += "`" + decodeEntities(extractText(node.children)) + "`";
    } else if (node.tag === "a") {
      const href = (node.html || "").match(/href="([^"]*)"/);
      out += "[" + treeToMd(node.children).trim() + "](" + (href ? decodeEntities(href[1]) : "") + ")";
    } else if (node.tag === "img") {
      const src = (node.html || "").match(/src="([^"]*)"/) || "";
      const alt = (node.html || "").match(/alt="([^"]*)"/) || "";
      out += "![" + decodeEntities(alt[1] || "") + "](" + decodeEntities(src[1] || "") + ")";
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
