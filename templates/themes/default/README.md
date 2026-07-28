# Writing a Career Kit theme

A theme is one directory under `templates/themes/`:

```
templates/themes/<name>/
  theme.css     required. The look.
  cv.html       optional. Falls back to the default shell if absent.
  README.md     optional. Say what the theme is for.
```

Select one by putting its name in `$CAREER_HOME/cv/theme`, or pass
`{"theme": "<name>"}` to `POST /api/render`.

There are two themes in the box, `default` and `compact`, and the second one
exists to prove the first one is not the only shape that fits. They share this
class vocabulary and the same HTML shell. If your theme needs different markup,
the vocabulary should grow rather than the shell forking.

---

## The class vocabulary a theme must style

The renderer emits all of it, so a theme that skips a row gets browser defaults
in that spot.

| Selector | What it is |
|---|---|
| `:root` | The seven custom properties. Most of a theme lives here. |
| `html, body` | Page background, base type, base leading. |
| `.page` | The sheet. Owns `--maxw` and the outer padding. |
| `.hint` / `.hint b` | The screen-only guidance bar. See below. |
| `header` | Identity block wrapper. |
| `h1` | Name. |
| `.title` | Headline under the name. |
| `.contact` / `.contact a` | Contact line and its links. |
| `.sep` | The separator glyph between contact items. |
| `section` | One CV section. |
| `h2` / `h2::after` | Section heading. `::after` is the rule beside it in `default`; `compact` sets `content: none` and underlines the heading instead. |
| `.summary` | Summary section body. |
| `.job` | One role. Must set `page-break-inside: avoid`. |
| `.job-head` | Title row. `default` puts dates beside the role; `compact` stacks them. |
| `.role` / `.role .co` | Role title, company name inside it. |
| `.dates` | Date range. |
| `.ctx` | The one line of context under a role. |
| `ul` / `li` / `li::marker` | Bullets. |
| `b, strong` | Emphasis inside bullets. |
| `.earlier` / `.earlier b` / `.earlier .co` | Condensed older roles. Rendered as `<div class="job earlier">`. |
| `.edu-item` / `.edu-item .sub` | Education entry and its second line. |
| `.skills p` / `.skills b` | Skills paragraphs and their area labels. |
| `a` (print) | Link colour in the print block. |
| `table.cv-table` | A table from the knowledge base. **Renderer-owned:** `render.mjs` ships base styles for it so a table is never unstyled. A theme may override; neither shipped theme does. |
| `.group` | A structural wrapper around a heading and the block under it, carrying the `data-anno-item` hook the previewer anchors to. Deliberately unstyled: it exists to be selected, not to be seen. Style it only if the layout needs it. |

The seven custom properties: `--ink`, `--muted`, `--accent`, `--accent-soft`,
`--rule`, `--bg`, `--maxw`.

---

## The print block is load-bearing

Keep `@page { size: A4; margin: 10mm 12mm }` and keep a print block that shrinks
type and spacing. The render tests assert a one-page fit by measuring the
document in a 703px container with the print rules flattened and requiring a
height at or under 1047px. A theme with no print block will render fine on
screen and produce a two-page PDF.

`page-break-inside: avoid` on `.job` matters more than it looks. Without it a
role splits across the fold and leaves a two-line orphan at the top of page two,
which is the usual reason a CV that technically fits still reads as though it
does not.

---

## Nothing in a theme may hide text

The renderer lints every generated artifact and **refuses to emit** one that
hides text. It fails with the offending selector named, and `POST /api/render`
returns 422.

Refused:

- `display: none`
- `visibility: hidden`
- opacity 0 (`opacity: 0`, `opacity: 0.0`, `opacity: 0%`)
- `font-size: 0`
- off-screen positioning: `left: -9999px`, `text-indent: -9999px`, and the same
  shape at other large negative values
- `clip: rect(0, 0, 0, 0)` and zero-height `overflow: hidden` blocks
- foreground equal to background, which is the white-on-white keyword-stuffing
  trick aimed at an automated screener

This is a policy, not a preference, and it is in code because a preference does
not survive a fork. It exists because someone was once asked, in a real
application, to embed hidden white text aimed at an LLM screener. That request
was declined as a judgement call. A judgement call is not enough for a tool that
other people run: the same request will be made again, to an agent that does not
remember the first time.

The cost is real and worth naming: a theme that uses `display: none` for a
perfectly honest reason, like collapsing an empty section, will fail the lint.
The lint cannot distinguish an honest hide from a dishonest one, so it refuses
both.

### The supported alternative

Use a data attribute and let the renderer remove the node.

| Attribute | Kept in | Removed from |
|---|---|---|
| `data-screen-only` | HTML preview | print, PDF |
| `data-print-only` | print, PDF | HTML preview |

The renderer deletes those nodes from the DOM before the lint runs. The text is
**absent** from the file rather than present and invisible, which is the whole
difference: a reader who opens the file, or a screener that reads the text
layer, sees exactly what a human sees.

The `.hint` bar in `cv.html` is the worked example. The original this theme came
from hid it with `.hint { display: none }` inside `@media print`. That is an
entirely honest use, and it still had to go, because a lint that allows the
honest case allows the dishonest one written the same way.

For a genuinely empty section, do not hide it. Have the renderer not emit it.

---

## Adding a theme

1. Copy `templates/themes/default/` to `templates/themes/<name>/`.
2. Change `:root` first. Seven values gets you most of a new look.
3. Adjust the rules that matter for your layout, keeping every selector in the
   vocabulary table styled.
4. Keep the print block, including `@page`.
5. Run the template tests. `test/templates.test.mjs` asserts that your theme
   defines every selector the default theme defines, and that no theme contains
   a hidden-text rule. That test is the reason the vocabulary above stays true.
