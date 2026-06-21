# Chapter 0 — Setting Up Your Toolchain

> Before we write any kernel code, let's build a development environment that can
> assemble, link, and **run a RISC-V kernel under QEMU** — and verify every tool
> works. Half an hour here saves a lot of confusion in Chapter 2, when the very
> first thing we do is boot a real image.

You won't run the xv6 kernel itself yet — there's nothing to run until Chapter 2.
The goal of this chapter is narrower and just as important: install the tools,
confirm their versions, and understand what each one is *for*.

---

## 0.1 What you'll need, and why

We're building a kernel that runs on the emulated RISC-V `virt` machine, written
mostly in Go. That dictates four pieces of software:

| Tool | Required? | What it does for us |
|------|-----------|---------------------|
| **QEMU** (`qemu-system-riscv64`) | **Yes** | Emulates the RISC-V `virt` machine we boot on. This *is* our hardware. |
| **Go** (1.22+) | **Yes** | The language the kernel is written in; also runs build scripts and host tools. |
| **TinyGo** (0.31+) | **Yes** | Compiles Go for a *freestanding* target (no OS underneath). It bundles LLVM/clang/lld, so it can also assemble our `.s` files and link the final kernel image. This is how we escape the standard Go runtime (Chapter 2). |
| **RISC-V GNU toolchain** (`riscv64-unknown-elf-*`) | Recommended | `gdb` for source-level debugging under QEMU, plus `objdump`/`objcopy`/`readelf` for inspecting kernel images (Appendix C). |
| **make** + **git** | **Yes** | Drive the build and check out each chapter's code. |

The key idea, expanded in Chapter 1 (§1.6) and Chapter 2: a normal Go program
assumes an operating system beneath it. Our kernel *is* the thing beneath, so we
can't use the ordinary `go build`/standard runtime path. **TinyGo** gives us a
freestanding compile — that's why it's required, not optional.

---

## 0.2 Install — macOS (Homebrew)

```sh
# QEMU + the RISC-V GNU toolchain (gdb, objdump, objcopy…)
brew tap riscv-software-src/riscv
brew install qemu riscv-gnu-toolchain

# Go and TinyGo
brew install go tinygo
```

If `brew install riscv-gnu-toolchain` is slow (it can build from source), you can
defer it — it's only needed for debugging, which we don't reach until later.

---

## 0.3 Install — Linux

**Debian / Ubuntu:**

```sh
sudo apt update
sudo apt install -y git build-essential qemu-system-misc \
                    gcc-riscv64-unknown-elf gdb-multiarch
# Go: install the official tarball (distro packages are often old)
#   https://go.dev/dl/  — then add /usr/local/go/bin to PATH
# TinyGo: grab the .deb from https://github.com/tinygo-org/tinygo/releases
```

**Fedora:**

```sh
sudo dnf install -y git make qemu-system-riscv \
                    binutils-riscv64-linux-gnu gdb
# Go and TinyGo as above (official tarball / release)
```

**Arch:**

```sh
sudo pacman -S --needed git make qemu-system-riscv riscv64-elf-gcc \
                        riscv64-elf-gdb go
# TinyGo: from the AUR (e.g. `yay -S tinygo-bin`)
```

On Linux, `qemu-system-riscv64` ships inside the `qemu-system-misc` /
`qemu-system-riscv` package depending on the distro.

---

## 0.4 A note on Go vs. TinyGo

You will have **both** installed, and they play different roles:

- **`go`** — for host-side helper programs (for example, a tool that builds the
  initial file-system image) and for running tests on your development machine.
- **`tinygo`** — for compiling the kernel and user programs to a RISC-V image
  with no operating system underneath. TinyGo lets us disable the garbage
  collector and scheduler and emit a bare binary, which the standard `go`
  toolchain can't do cleanly.

We won't lean on TinyGo's own runtime either — Chapter 2 strips it down to the
bare minimum. For now, just make sure both commands exist.

---

## 0.5 Getting the code

The book is written so you build the kernel incrementally; each chapter
corresponds to a tagged commit you can check out and run.

```sh
git clone https://github.com/lizhiquan/xv6.git
cd xv6
```

> The book's prose lives in this repository under `en/` and `vi/`. As chapters
> ship code, each will point you to the matching tag (e.g. `git checkout ch02`)
> so you can compare your work against a known-good checkpoint. If you'd rather
> type everything yourself — recommended for learning — start an empty repo and
> follow along; the tags are there as a safety net.

---

## 0.6 Smoke test

Confirm every tool is on your `PATH` and recent enough:

```sh
qemu-system-riscv64 --version     # expect 7.0 or newer
go version                        # expect go1.22 or newer
tinygo version                    # expect 0.31 or newer
riscv64-unknown-elf-gdb --version # (optional) any recent version
make --version
git --version
```

You can also confirm QEMU actually knows the machine we'll target:

```sh
qemu-system-riscv64 -machine help | grep virt
```

You should see a line for `virt` ("RISC-V VirtIO board"). That machine — its UART
at `0x10000000`, its virtio disk at `0x10001000`, RAM at `0x80000000` — is the
hardware described in Chapter 1 (§1.8) and the target for every milestone in this
book.

There's nothing to boot yet: the first bootable image appears at the end of
Chapter 2. If all the commands above print versions, your environment is ready.

---

## 0.7 Editor setup (optional but nice)

- **gopls** (the Go language server) works fine, but be aware that freestanding
  kernel code uses build tags and `unsafe` in ways the editor may flag as
  unusual. That's expected; the code still compiles under TinyGo.
- A RISC-V assembly syntax highlighter helps for the `.s` files.
- Keep a terminal pane open for `tinygo build` + `qemu-system-riscv64` — the
  edit/build/boot loop is the heartbeat of this book.

---

## 0.8 Troubleshooting

| Symptom | Likely fix |
|---------|-----------|
| `qemu-system-riscv64: command not found` | The binary is in `qemu-system-misc`/`qemu-system-riscv`; reinstall that package, or check your `PATH`. |
| `tinygo: command not found` after install | Add TinyGo's `bin` to `PATH` (the `.deb`/release installs under `/usr/local/tinygo/bin`). |
| `riscv-gnu-toolchain` takes forever in Homebrew | It's compiling from source. Let it finish in the background, or skip it until the debugging chapters. |
| Old Go from your distro | Remove it and install the official tarball from <https://go.dev/dl/>. |
| QEMU window/graphics errors | We always run with `-nographic`; you never need a GUI. |

---

## Checklist

Before moving on, you should be able to tick every box:

- [ ] `qemu-system-riscv64 --version` prints 7.0+
- [ ] `qemu-system-riscv64 -machine help` lists `virt`
- [ ] `go version` prints 1.22+
- [ ] `tinygo version` prints 0.31+
- [ ] `make` and `git` are available
- [ ] (optional) a RISC-V `gdb` is installed for later

---

*Next: **Chapter 1 — What an Operating System Does**, the conceptual map of the
whole system. Then **Chapter 2** puts this toolchain to work and boots our first
image.*
