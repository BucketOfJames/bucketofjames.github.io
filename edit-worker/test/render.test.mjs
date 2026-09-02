// Engine tests for shared/render.js — run with: node edit-worker/test/render.test.mjs
import { readFileSync } from "node:fs";
import { renderMarkdown, htmlToMarkdown } from "../../shared/render.js";

let failures = 0;
function assertEq(actual, expected, label) {
  if (actual === expected) { console.log("ok  -", label); return; }
  failures++;
  console.error("FAIL -", label);
  console.error("  expected:", JSON.stringify(expected));
  console.error("  actual:  ", JSON.stringify(actual));
}

// --- block syntax ---
assertEq(renderMarkdown("a"), "<p>a</p>", "single line -> p");
assertEq(renderMarkdown("a\n\nb"), "<p>a</p>\n<p></p>\n<p>b</p>", "blank line -> empty p");
assertEq(renderMarkdown("# H"), "<h1>H</h1>", "h1");
assertEq(renderMarkdown("###### H"), "<h6>H</h6>", "h6");
assertEq(renderMarkdown("---"), "", "standalone --- dropped");
assertEq(renderMarkdown("***"), "<hr>", "*** -> hr");
assertEq(renderMarkdown("___"), "<hr>", "___ -> hr");
assertEq(renderMarkdown("- a\n- b"), "<ul><li>a</li><li>b</li></ul>", "ul");
assertEq(renderMarkdown("1. a\n2. b"), "<ol><li>a</li><li>b</li></ol>", "ol");
assertEq(renderMarkdown("> q"), "<blockquote><p>q</p></blockquote>", "blockquote");
assertEq(renderMarkdown("> [!NOTE]\n> x"), '<blockquote class="note note-note"><p class="note-title">Note</p><p>x</p></blockquote>', "note box");
assertEq(renderMarkdown("```\n<hi> & x\n```"), "<pre><code>&lt;hi&gt; &amp; x</code></pre>", "fence escapes content");

// --- inline ---
assertEq(renderMarkdown("**b**"), "<p><strong>b</strong></p>", "strong");
assertEq(renderMarkdown("*i*"), "<p><em>i</em></p>", "em");
assertEq(renderMarkdown("~~d~~"), "<p><del>d</del></p>", "del");
assertEq(renderMarkdown("++u++"), "<p><u>u</u></p>", "underline");
assertEq(renderMarkdown("==m=="), "<p><mark>m</mark></p>", "mark");
assertEq(renderMarkdown("H~2~O"), "<p>H<sub>2</sub>O</p>", "sub");
assertEq(renderMarkdown("x^2^"), "<p>x<sup>2</sup></p>", "sup");
assertEq(renderMarkdown("`c`"), "<p><code>c</code></p>", "code");
assertEq(renderMarkdown("\\*x\\*"), "<p>*x*</p>", "escape");
assertEq(renderMarkdown("[t](https://x)"), '<p><a href="https://x">t</a></p>', "link");
assertEq(renderMarkdown("![a](https://x/i.png)"), '<p><img src="https://x/i.png" alt="a"></p>', "img");
assertEq(renderMarkdown("a & <b> b"), "<p>a &amp; &lt;b&gt; b</p>", "raw html escaped (no whitelist)");
assertEq(renderMarkdown("~ lone"), "<p>~ lone</p>", "lone tilde literal");

// --- htmlToMarkdown ---
assertEq(htmlToMarkdown("<em>just</em>"), "*just*", "em -> *");
assertEq(htmlToMarkdown("<strong>s</strong>"), "**s**", "strong -> **");
assertEq(htmlToMarkdown("<sub>(cachyos)</sub>"), "~(cachyos)~", "sub -> ~");
assertEq(htmlToMarkdown('<a href="https://x">t</a>'), "[t](https://x)", "a -> md link");
assertEq(htmlToMarkdown('<img src="s" alt="a">'), "![a](s)", "img -> md image");
assertEq(htmlToMarkdown("<h1>H</h1>"), "# H", "h1 -> #");
assertEq(htmlToMarkdown("<ul><li>a</li><li>b</li></ul>"), "- a\n- b", "ul -> - list");
assertEq(htmlToMarkdown("<blockquote><p>q</p></blockquote>"), "> q", "blockquote -> >");
assertEq(htmlToMarkdown("<pre><code>x</code></pre>"), "```\nx\n```", "pre -> fence");
assertEq(htmlToMarkdown("<p>a</p><p>b</p>"), "a\n\nb", "paragraphs");
assertEq(htmlToMarkdown("<script>alert(1)</script>hi"), "alert(1)hi", "unknown tags stripped, content kept as escaped text");
assertEq(htmlToMarkdown("<p>a<br>b</p>"), "a\nb", "br -> newline");
assertEq(htmlToMarkdown("<p>a &amp; b</p>"), "a & b", "entities decoded in text");
assertEq(htmlToMarkdown('<a href="https://x?a=1&amp;b=2">t</a>'), "[t](https://x?a=1&b=2)", "entities decoded in href");
assertEq(htmlToMarkdown("<pre><code>a &lt; b</code></pre>"), "```\na < b\n```", "entities decoded in code");

// --- round-trip fixed point: norm(norm(md)) === norm(md) ---
function norm(md) { return htmlToMarkdown(renderMarkdown(md)); }
const corpus = [
  "Hello",
  "Line one\n\nLine two",
  "# Big\n\nSome *text* with **bold** and `code`.",
  "- a\n- b\n- c",
  "1. one\n2. two",
  "> quoted\n> text",
  "> [!TIP]\n> try this",
  "```\ncode\nhere\n```",
  "***",
  "H~2~O and x^2^ and ~~del~~ and ++u++ and ==m==",
  "[link](https://example.com/a?b=1&c=2) and ![img](https://example.com/i.png)",
  "\\*not em\\* and \\[not link\\]",
  "a & b < c > d \"quoted\" 'single'",
];
for (const md of corpus) {
  const n1 = norm(md);
  assertEq(norm(n1), n1, "round-trip fixed point: " + JSON.stringify(md.slice(0, 24)));
}

// --- live-content round trip (index.html markers) ---
// The critical invariant for the new pipeline: reading live content via
// htmlToMarkdown and publishing it again must be a NO-OP (render(md) === html).
const indexHtml = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const aboutHtml = (indexHtml.match(/<!--about-content-->\n([\s\S]*?)\n<!--\/about-content-->/) || [])[1] || "";
const manHtml = (indexHtml.match(/<!--manifestos-content-->\n([\s\S]*?)\n<!--\/manifestos-content-->/) || [])[1] || "";
const articles = [...manHtml.matchAll(/<article class="manifestos-item">([\s\S]*?)<\/article>/g)].map((m) => m[1]);
assertEq(articles.length >= 10, true, "live site has 10+ manifestos");
const aboutMd = htmlToMarkdown(aboutHtml);
assertEq(renderMarkdown(aboutMd), aboutHtml.trim(), "live about: read -> publish is a no-op");
assertEq(renderMarkdown(aboutMd), renderMarkdown(htmlToMarkdown(renderMarkdown(aboutMd))), "live about stable");
for (const art of articles) {
  const md = htmlToMarkdown(art);
  assertEq(renderMarkdown(md), art.trim(), "live manifesto no-op: " + JSON.stringify(md.slice(0, 30)));
  assertEq(renderMarkdown(md), renderMarkdown(htmlToMarkdown(renderMarkdown(md))), "live manifesto stable: " + JSON.stringify(md.slice(0, 30)));
}

// --- editor page uses the shared engine (no duplicated copy, no mirror) ---
const editHtml = readFileSync(new URL("../../edit/index.html", import.meta.url), "utf8");
assertEq(editHtml.includes('import { renderMarkdown } from "../shared/render.js"'), true, "editor imports shared engine");
assertEq(editHtml.includes("function renderMarkdown(raw)"), false, "editor has no inline renderer copy");
assertEq(editHtml.includes("function htmlToMarkdown(html)"), false, "editor has no inline html->md copy");
assertEq(editHtml.includes('id="default-content"'), false, "editor has no embedded defaults mirror");

if (failures) { console.error("\n" + failures + " failure(s)"); process.exit(1); }
console.log("\nAll tests passed.");