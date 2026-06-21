# Chapter 2 — From Power-On to `main`

> This is the first chapter with real code. We'll write the very first
> instructions the CPU runs, give each CPU a stack, do the minimal machine-mode
> setup, drop from machine mode to supervisor mode, and reach a Go `main` that
> prints a line over the UART. By the end you'll have a kernel image that boots
> under QEMU and says hello.
>
> Milestone: `make qemu` boots and prints a greeting from a Go kernel running on
> bare RISC-V — no operating system underneath it.

---

## 2.1 What "boot" means on the `virt` machine

When you run QEMU with `-kernel kernel.elf`, three things happen before any of our
code runs:

1. QEMU loads our kernel into RAM at physical address **`0x80000000`** (the start
   of RAM on the `virt` machine — see Chapter 1, §1.8).
2. It puts every CPU — every **hart**, in RISC-V terms — into **machine mode**
   (M-mode), the most privileged level.
3. It makes every hart jump to `0x80000000` and start executing.

So whatever sits at `0x80000000` is the first thing that runs, on *every* CPU, in
the most privileged mode, with **no stack, no runtime, nothing**. Our entire job
in this chapter is to go from that bare state to a normal Go function running in
supervisor mode.

The path is short and worth memorizing:

```
1. power-on     — every hart starts in M-mode; QEMU jumps to 0x80000000
2. _entry  (asm)— give this hart a stack, then call start
3. start   (Go) — M-mode setup; point mepc at main; execute mret
4. main    (Go) — now in S-mode; print the first line over the UART
```

Two of these four steps are assembly (`_entry`) and CSR pokes (`start`); the rest
is ordinary Go. Let's build them bottom to top.

---

## 2.2 The linker script: putting `_entry` at `0x80000000`

QEMU jumps to `0x80000000` unconditionally, so the very first byte of our kernel
*must* be our entry code. The compiler and linker don't know that — we tell them
with a **linker script**, `kernel.ld`:

```ld
OUTPUT_ARCH( "riscv" )
ENTRY( _entry )

SECTIONS
{
  /* QEMU's -kernel jumps here, so _entry must land exactly at 0x80000000. */
  . = 0x80000000;

  .text : {
    *(.text._entry)     /* our entry stub, first */
    *(.text .text.*)    /* then the rest of the code */
    . = ALIGN(0x1000);
    PROVIDE(etext = .);
  }

  .rodata : { . = ALIGN(16); *(.rodata .rodata.*) }
  .data   : { . = ALIGN(16); *(.data .data.*) *(.sdata .sdata.*) }
  .bss    : { . = ALIGN(16); *(.bss .bss.*) *(.sbss .sbss.*) }

  PROVIDE(end = .);   /* first free address after the kernel — used in Ch. 4 */
}
```

Three things to notice:

- `ENTRY(_entry)` and `. = 0x80000000` together guarantee our `_entry` symbol is
  the first instruction at the address QEMU jumps to.
- `PROVIDE(end = .)` exposes a symbol marking the first free byte *after* the
  kernel. The physical page allocator in Chapter 4 starts handing out memory from
  there.
- The build must use the **medany** code model (`-mcmodel=medany`) so that code
  linked at `0x8000_0000` can address symbols with PC-relative instructions. With
  TinyGo this is set in the target description (Appendix B).

---

## 2.3 `entry.s`: a stack for each hart

Go cannot run without a stack — even the first function call pushes a return
address. But at power-on there is no stack pointer set up. So the one thing our
assembly entry *must* do before calling any Go is to point `sp` at some memory.

We reserve a block of memory, one fixed-size stack per CPU, and compute this
hart's slice of it from its hart id:

```asm
# entry.s — the first code that runs, placed at 0x80000000 by kernel.ld
.section .text._entry
.global _entry
_entry:
        # sp = stack0 + (hartid + 1) * STACKSIZE
        la   sp, stack0
        li   a0, 4096            # STACKSIZE: 4096 bytes per hart
        csrr a1, mhartid         # which CPU am I?
        addi a1, a1, 1
        mul  a0, a0, a1
        add  sp, sp, a0
        call start               # into Go (start.go)
spin:
        j spin                   # start() never returns; loop just in case
```

`stack0` is a single contiguous array; hart 0 gets bytes `[0, 4096)`, hart 1 gets
`[4096, 8192)`, and so on. We add `(hartid+1)*STACKSIZE` because the stack grows
*downward* — `sp` must start at the *top* of this hart's slice.

We declare the backing memory in Go so the size tracks `NCPU` in one place:

```go
// start.go
package kernel

import "unsafe"

const STACKSIZE = 4096

// One stack per CPU. entry.s sets sp into this array before any Go runs.
// Exposed to assembly under the linker symbol "stack0".
//
//go:export stack0
var stack0 [STACKSIZE * NCPU]byte
```

> **Why assembly at all?** This is the only function that runs *without* a usable
> stack, so it can't be Go — the compiler assumes `sp` is valid on entry to every
> function. Eleven instructions of assembly buy us a stack; everything after this
> is Go.

---

## 2.4 The Go runtime problem, made concrete

Here is where Chapter 1's warning (§1.6) becomes real. A normal Go program never
starts at *your* `main`. It starts in the runtime, which asks the OS for memory,
starts threads, installs signal handlers, and *then* calls your `main`. We have no
OS to ask. If we let the standard runtime start, it crashes instantly.

So we compile with **TinyGo** and turn the runtime off:

```jsonc
// riscv-virt.json — a custom TinyGo target (full version in Appendix B)
{
  "llvm-target":  "riscv64-unknown-elf",
  "cpu":          "generic-rv64",
  "features":     "+m,+a,+c",
  "build-tags":   ["xv6", "baremetal"],
  "gc":           "none",          // no garbage collector
  "scheduler":    "none",          // no goroutine scheduler
  "linker":       "ld.lld",
  "ldflags":      ["-T", "kernel.ld"],
  "code-model":   "medany"
}
```

`gc: none` and `scheduler: none` are the important lines: they tell TinyGo to
emit code that never allocates on a managed heap and never tries to schedule
goroutines — neither of which exists yet. (We build both, by hand, in later
chapters: the allocator in Chapter 4, our own context switch in Chapter 10.)

TinyGo still emits a tiny runtime shim that wants to call a function named
`main`. We satisfy it ourselves: our `_entry` calls `start`, and `start` hands
control to our `main`. We never use TinyGo's startup path.

---

## 2.5 `start()`: machine-mode setup, in Go

`_entry` calls `start` while still in **machine mode**. M-mode can touch
everything, but we want to spend as little time here as possible — the kernel
proper runs in supervisor mode. `start` configures the few machine-level things
that *can only* be set from M-mode, then performs the drop to S-mode.

First, the CSR accessors. Go can't emit a `csrr`/`csrw` on its own, so each is a
one-line assembly stub called like a normal function:

```go
// riscv.go — Control/Status Register access (bodies in riscv_asm.s)
func r_mstatus() uint64
func w_mstatus(x uint64)
func w_mepc(x uint64)
func w_satp(x uint64)
func w_medeleg(x uint64)
func w_mideleg(x uint64)
func r_sie() uint64
func w_sie(x uint64)
func w_pmpaddr0(x uint64)
func w_pmpcfg0(x uint64)
func r_mhartid() uint64
func w_tp(x uint64)
```

```asm
# riscv_asm.s — one stub per accessor; arg/return in a0
.global r_mstatus
r_mstatus:  csrr a0, mstatus
            ret
.global w_mstatus
w_mstatus:  csrw mstatus, a0
            ret
.global w_mepc
w_mepc:     csrw mepc, a0
            ret
# … one matching pair for each CSR above …
```

Now `start` itself. It mirrors a real kernel's machine-mode bring-up step for
step:

```go
// start.go
package kernel

// Bits of mstatus that select the privilege mret returns to.
const (
	mstatusMPPMask = 3 << 11 // "previous privilege" field
	mstatusMPPS    = 1 << 11 // = Supervisor
	sieSEIE        = 1 << 9  // supervisor external interrupts
	sieSTIE        = 1 << 5  // supervisor timer interrupts
	sieSSIE        = 1 << 1  // supervisor software interrupts
)

//go:export start
func start() {
	// 1. Tell mret to return into supervisor mode.
	x := r_mstatus()
	x &^= mstatusMPPMask
	x |= mstatusMPPS
	w_mstatus(x)

	// 2. Tell mret which instruction to "return" to: our main.
	w_mepc(mainPC())

	// 3. Paging is off for now; main turns it on in Chapter 5.
	w_satp(0)

	// 4. Route all traps to supervisor mode instead of machine mode.
	w_medeleg(0xffff)
	w_mideleg(0xffff)
	w_sie(r_sie() | sieSEIE | sieSTIE | sieSSIE)

	// 5. Physical Memory Protection: let S-mode reach all of RAM.
	w_pmpaddr0(0x3fffffffffffff)
	w_pmpcfg0(0xf)

	// 6. Set up timer interrupts (details below).
	timerInit()

	// 7. Stash this hart's id in tp so cpuid() can read it later.
	w_tp(r_mhartid())

	// 8. "Return" into supervisor mode at main. Does not come back.
	mret()
}
```

Walking the eight steps:

1. **MPP = Supervisor.** The `mret` instruction returns to whatever privilege
   level the `MPP` field of `mstatus` names. We set it to Supervisor.
2. **mepc = main.** `mret` jumps to the address in `mepc`. We point it at `main`.
   `mainPC()` is a one-line asm helper (`la a0, main; ret`) that yields the code
   address of our `main`, which is awkward to take directly in Go.
3. **satp = 0.** Paging stays off until Chapter 5 builds a page table.
4. **Delegate traps.** By default every trap goes to M-mode. We delegate
   exceptions (`medeleg`) and interrupts (`mideleg`) to S-mode so the kernel
   handles them directly, and enable the supervisor interrupt sources in `sie`.
5. **PMP.** Physical Memory Protection defaults to *denying* S-mode access to
   physical memory. We open a single region covering everything so the kernel can
   run at all.
6. **Timer.** Set up the first clock interrupt — the heartbeat the scheduler will
   later use to preempt processes (Chapter 10).
7. **tp = hartid.** The hart id is only readable in M-mode (`mhartid`). We copy it
   into the `tp` register so S-mode code can ask "which CPU am I?" cheaply. This
   is what `cpuid()` returns.
8. **mret.** The drop. Recall from Chapter 1 (§1.5): there's no instruction to
   *enter* a lower privilege level, so we fake a *return* from a trap that never
   happened. After `mret`, the CPU is in S-mode, executing `main`.

### The timer setup

```go
// start.go — ask this hart to deliver timer interrupts
func timerInit() {
	w_menvcfg(r_menvcfg() | (1 << 63)) // enable the Sstc extension (stimecmp)
	w_mcounteren(r_mcounteren() | 2)   // let S-mode read the time CSR
	w_stimecmp(r_time() + 1_000_000)   // schedule the first tick
}
```

With the **Sstc** extension, supervisor code can arm the next timer interrupt by
writing `stimecmp` directly — no machine-mode trap per tick. We only need M-mode
here to *enable* that capability; from Chapter 10 on, the timer is handled
entirely in S-mode.

---

## 2.6 `main()`: hello from supervisor mode

After `mret`, every hart begins executing `main` in supervisor mode, each on its
own stack. For now `main` does the smallest possible thing — it prints a line —
so we can *see* that the whole boot path works:

```go
// main.go
package kernel

//go:export main
func main() {
	if cpuid() == 0 {
		uartInitBare()
		print("\n")
		print("xv6-go kernel is booting\n")
		print("\n")
	}
	// Every hart ends up here. There's nothing more to do yet.
	for {
	}
}

// cpuid returns the current hart id, stashed in tp by start().
func cpuid() int {
	return int(r_tp())
}
```

Only hart 0 prints, so the greeting appears once rather than `NCPU` times. The
other harts fall straight into the idle loop. (In Chapter 9 we'll bring the other
harts online properly; in Chapter 10 they'll all enter the scheduler.)

---

## 2.7 Just enough UART to print

A full console driver is Chapter 3. Here we need the bare minimum: push one byte
out the UART. On the `virt` machine the 16550 UART lives at `0x10000000`
(Chapter 1, §1.8). Sending a byte is two memory accesses — wait until the
transmit holding register is empty, then store the byte:

```go
// uart.go — minimal polling output; the real driver arrives in Chapter 3
package kernel

import "unsafe"

const uart0 = 0x10000000

// 16550 register offsets we need here.
const (
	uartTHR = 0 // transmit holding register (write a byte to send it)
	uartLSR = 5 // line status register
	lsrTHRE = 1 << 5 // THR empty: ok to send the next byte
)

func uartReg(off uintptr) *uint8 {
	return (*uint8)(unsafe.Pointer(uintptr(uart0) + off))
}

func uartInitBare() {} // nothing to configure for polled output under QEMU

func uartPutc(c byte) {
	for *uartReg(uartLSR)&lsrTHRE == 0 { // spin until the UART can accept a byte
	}
	*uartReg(uartTHR) = c
}

// print writes a string to the UART, one byte at a time.
func print(s string) {
	for i := 0; i < len(s); i++ {
		uartPutc(s[i])
	}
}
```

The whole "device driver" is `uartPutc`: reading the line-status register at
`0x10000005`, spinning on the "transmit empty" bit, then storing a byte to
`0x10000000`. This is the memory-mapped-I/O idea from Chapter 1 made concrete —
**there is no special I/O instruction; a device is just memory at a known
address.** The `unsafe.Pointer` cast is exactly the typed-view-over-a-physical-
address technique we'll lean on for page tables and trapframes later.

---

## 2.8 Build and run

A small `Makefile` ties the pieces together:

```make
kernel.elf: *.go *.s kernel.ld riscv-virt.json
	tinygo build -target=riscv-virt.json -o kernel.elf .

qemu: kernel.elf
	qemu-system-riscv64 -machine virt -bios none -m 128M -smp 3 \
		-nographic -kernel kernel.elf
```

- `-bios none` tells QEMU not to load its default firmware; our kernel *is* the
  first thing that runs.
- `-smp 3` gives us three harts, so we can confirm only hart 0 prints.
- `-nographic` routes the UART to your terminal — no GUI, ever (Chapter 0).

Run it:

```console
$ make qemu

xv6-go kernel is booting

```

That blank-line/greeting/blank-line is the output of `main`. To quit QEMU, press
`Ctrl-A` then `x`.

If you see the greeting, congratulations: you have written code that runs **on the
bare machine**, set up a stack by hand, configured machine-mode CSRs, dropped to
supervisor mode through `mret`, and driven a hardware device — all in Go, with no
operating system underneath.

---

## 2.9 What we glossed over (and where it's handled)

- **The other harts** spin in `main`'s idle loop. Proper multicore bring-up,
  including the synchronization that lets hart 0 finish initialization first, is
  Chapter 9.
- **`print` is not safe to call from two harts at once** — interleaved bytes. We
  only print from hart 0 here; locking the console is Chapter 3, and locks
  themselves are Chapter 9.
- **Paging is off.** Addresses are still physical. Chapter 5 builds the kernel
  page table and turns paging on.
- **No allocator yet.** Everything here uses fixed, statically reserved memory
  (`stack0`). Dynamic allocation starts in Chapter 4.

---

## 2.10 What you should take away

- QEMU drops every hart at `0x80000000` in machine mode with no stack; the linker
  script guarantees our `_entry` is exactly there.
- The one irreducible job of assembly is **setting up a stack** before any Go can
  run.
- A kernel can't use the standard Go runtime; **TinyGo with `gc: none` and
  `scheduler: none`** gives us freestanding Go.
- `start` does only what *must* be done in machine mode, then drops to supervisor
  mode by faking a trap return with **`mret`**.
- **Memory-mapped I/O** means a device driver can be as small as "spin on a status
  bit, then store a byte."

---

## Exercises

1. **Stack arithmetic.** With `STACKSIZE = 4096`, what value does `sp` hold on
   entry to `start` for hart 0? For hart 2? Why does `_entry` add
   `(hartid+1)*STACKSIZE` rather than `hartid*STACKSIZE`?

2. **Remove a step.** Predict what happens if you comment out the PMP setup
   (step 5) in `start`. Then try it. Why does the kernel fail *before* printing
   anything? (Hint: §2.5, step 5.)

3. **Count the harts.** Change `main` so *every* hart prints `hart N booting`
   with its own id. Run with `-smp 4`. Why might the lines come out interleaved or
   garbled, and which later chapter fixes that?

4. **The mret trick.** Set `mstatus.MPP` to *User* mode instead of Supervisor
   before `mret` and predict what happens when `main` tries its first UART store.
   Relate your answer to the three jobs of an OS from Chapter 1 (§1.1).

5. **Bytes on the wire.** Modify `uartPutc` to *not* wait on `lsrTHRE` (drop the
   spin loop). Does the greeting still appear under QEMU? Would you trust this on
   real hardware? Explain what the spin loop protects against.

---

*Next: **Chapter 3 — Talking to Hardware: the Console**, where we turn this
two-line UART hack into a real interrupt-driven driver with input, output
buffering, and a proper `printk` — the kernel's voice for the rest of the book.*
