# Building an Operating System in Go: xv6 on RISC-V

A hands-on book that teaches operating-system fundamentals by building a complete
Unix-like kernel — xv6 — in Go, on the RISC-V architecture.

📖 **Read it online:** <https://lizhiquan.github.io/xv6/>

## Local development

The book is built with [mdBook](https://rust-lang.github.io/mdBook/).

```sh
cargo install mdbook        # or: brew install mdbook
mdbook serve --open         # live-reloading preview at http://localhost:3000
mdbook build                # output in ./book
```

## Layout

```
book.toml              mdBook configuration
src/SUMMARY.md         table of contents (add new chapters here)
src/introduction.md    overview & full outline
src/ch01-*.md          chapters
.github/workflows/     builds and deploys to GitHub Pages on push to main
```

## Publishing

Pushing to `main` triggers the GitHub Actions workflow, which builds the book and
deploys it to GitHub Pages. One-time setup in the repo: **Settings → Pages →
Build and deployment → Source: GitHub Actions**.
