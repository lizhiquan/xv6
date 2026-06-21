# Building an Operating System in Go: xv6 on RISC-V

A hands-on book that teaches operating-system fundamentals by building a complete
Unix-like kernel — xv6 — in Go, on the RISC-V architecture.

📖 **Read it online:** <https://lizhiquan.github.io/xv6/>
&nbsp; · &nbsp; 🇬🇧 [English](https://lizhiquan.github.io/xv6/en/)
&nbsp; · &nbsp; 🇻🇳 [Tiếng Việt](https://lizhiquan.github.io/xv6/vi/)

## Layout

The book is bilingual — each language is a self-contained mdBook:

```
en/                    English edition
  book.toml            mdBook config (site-url = /xv6/en/)
  src/SUMMARY.md       table of contents
  src/*.md             chapters
  lang-switch.js       adds the EN ⇄ VI toggle to the menu bar
vi/                    Vietnamese edition (same structure)
index.html            landing page; redirects by browser language
.github/workflows/    builds both editions and deploys to GitHub Pages
```

The site is laid out as:

```
/xv6/        → index.html (auto-redirect)
/xv6/en/     → English edition
/xv6/vi/     → Vietnamese edition
```

A language toggle in the top-right of the menu bar switches between the two while
keeping you on the same chapter (both editions use identical file names).

## Local development

Built with [mdBook](https://rust-lang.github.io/mdBook/).

```sh
cargo install mdbook        # or: brew install mdbook
mdbook serve en --open      # preview the English edition
mdbook serve vi --open      # preview the Vietnamese edition
```

## Adding a chapter

1. Add `en/src/<chapter>.md` and `vi/src/<chapter>.md` (keep the **same file
   name** in both so the language toggle works).
2. Link it in both `en/src/SUMMARY.md` and `vi/src/SUMMARY.md`.
3. Commit and push to `main` — GitHub Actions rebuilds and redeploys.

## Publishing

Pushing to `main` triggers the workflow, which builds both editions and deploys
to GitHub Pages. One-time repo setup: **Settings → Pages → Source: GitHub
Actions**.
