# Appendix B — The Go Freestanding Toolchain

> How we compile Go to a bare-metal RISC-V kernel: the build flags, the TinyGo
> target, the linker script, and the compiler pragmas that make low-level Go
> possible. Reference for Chapters 2, 3, and anywhere `unsafe` or assembly
> appears.

---

## B.1 Why TinyGo

The standard `go` toolchain links the full runtime and assumes a host OS to
provide threads, memory, and signals. **TinyGo** can compile Go to a freestanding
target with no OS, optionally with no garbage collector and no goroutine
scheduler — exactly what a kernel needs. It bundles LLVM/clang/lld, so it also
assembles our `.s` files and links the final image.

We still don't use TinyGo's own runtime startup; our `_entry` (Chapter 2) takes
over from the first instruction.

---

## B.2 The target file

A custom TinyGo target (`riscv-virt.json`) describes the machine and how to build
for it:

```jsonc
{
  "llvm-target":   "riscv64-unknown-elf",
  "cpu":           "generic-rv64",
  "features":      "+m,+a,+c",     // mul/div, atomics, compressed insns
  "build-tags":    ["xv6", "baremetal", "tinygo.riscv64"],
  "goos":          "linux",        // closest GOOS; we override startup anyway
  "goarch":        "riscv64",
  "gc":            "none",         // no garbage collector
  "scheduler":     "none",         // no goroutine scheduler
  "linker":        "ld.lld",
  "rtlib":         "compiler-rt",
  "ldflags":       ["-T", "kernel.ld", "-nostdlib"],
  "extra-files":   ["entry.s", "riscv_asm.s", "trampoline.s", "switch.s"]
}
```

The two decisive lines are `"gc": "none"` and `"scheduler": "none"` — they keep
the compiler from emitting allocation and goroutine-scheduling code that would
call into a runtime we don't have. `+a` (atomics) is required for the spinlocks in
Chapter 9.

Build and run:

```sh
tinygo build -target=riscv-virt.json -o kernel.elf .
qemu-system-riscv64 -machine virt -bios none -m 128M -smp 3 -nographic -kernel kernel.elf
```

---

## B.3 The linker script

`kernel.ld` places the kernel at `0x80000000` with `_entry` first (Chapter 2):

```ld
OUTPUT_ARCH( "riscv" )
ENTRY( _entry )
SECTIONS {
  . = 0x80000000;
  .text   : { *(.text._entry) *(.text .text.*) . = ALIGN(0x1000); PROVIDE(etext = .); }
  .rodata : { . = ALIGN(16); *(.rodata .rodata.*) }
  .data   : { . = ALIGN(16); *(.data .data.*) *(.sdata .sdata.*) }
  .bss    : { . = ALIGN(16); *(.bss .bss.*) *(.sbss .sbss.*) }
  PROVIDE(end = .);
}
```

The `etext` and `end` symbols are consumed by the kernel: `etext` bounds the
read-only code mapping (Chapter 5), `end` marks where the page allocator's region
begins (Chapter 4). Referencing a linker symbol from Go is done with a tiny asm
helper that does `la a0, end; ret`.

The build must use the **medany** code model so PC-relative addressing reaches
symbols from the high load address.

---

## B.4 Calling assembly from Go (and back)

Three mechanisms recur:

- **Declare, implement in `.s`.** A Go function with no body
  (`func w_satp(x uint64)`) is implemented by a same-named symbol in an assembly
  file. Arguments arrive in `a0`–`a7`, returns in `a0` — the standard convention.
- **`//export name`.** Gives a Go function a fixed C symbol name so assembly can
  `call` it (`//export start` for `start`, called from `entry.s`).
- **`//go:linkname local remote`.** Aliases a Go symbol to another name — used to
  expose package globals (like `stack0`) under a stable linker name, or to reach
  runtime symbols.

Getting a Go function's *code address* (needed for `mepc = main`, Chapter 2) is
done with a one-line asm stub (`la a0, main; ret`) rather than a Go func value,
because Go func values are closures, not raw code pointers.

---

## B.5 The pragmas that matter

| Pragma | Effect | Why the kernel needs it |
|--------|--------|--------------------------|
| `//go:nosplit` | skip the stack-growth prologue check | trap entry and early boot run before/without the runtime that would handle a split; a split there crashes |
| `//go:noescape` | promise a pointer arg doesn't escape | keeps `unsafe`-pointer helpers from forcing heap allocation |
| `//go:linkname` | alias a symbol | expose/reach symbols across the Go/asm boundary |
| `//go:noinline` | don't inline | occasionally needed so an asm stub or address-of works predictably |

These are not stylistic — the kernel fails to boot without `//go:nosplit` in the
right places. Treat them as part of the contract with the metal.

---

## B.6 `unsafe` discipline

The kernel's lowest layers are typed views over physical addresses:

```go
// the recurring pattern: reinterpret an address as a typed structure
p := (*[512]uint64)(unsafe.Pointer(physAddr)) // a page table (Chapter 5)
r := (*run)(unsafe.Pointer(pageAddr))         // a free-list node (Chapter 4)
reg := (*uint8)(unsafe.Pointer(uintptr(uart0) + off)) // a device register (Chapter 3)
```

Rules we follow to keep this sound:

- Confine `unsafe` to the device/VM/allocator layers; everything above uses safe
  Go.
- Memory the hardware DMAs (Chapter 12) or that holds page tables/trapframes comes
  from `kalloc` (stable physical pages), never Go-managed objects.
- Never let a `uintptr` that names physical memory be treated as a GC-visible
  pointer.

---

*See also: Appendix A (the CSRs these stubs poke), Appendix C (debugging the
result).*
