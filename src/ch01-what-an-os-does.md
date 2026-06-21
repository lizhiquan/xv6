# Chapter 1 — What an Operating System Does

> By the end of this chapter you won't have written a line of code yet — but you
> will know exactly what we're about to build, why the RISC-V hardware is shaped
> the way it is, and how the pieces of the kernel fit together. Treat this
> chapter as the map you'll keep returning to.

---

## 1.1 The problem an OS solves

Run a single program on a bare machine and life is simple: your code owns every
register, all of RAM, and every device. The instant you want a *second* program
— or a program you don't fully trust, or a program that shouldn't be able to
crash the whole machine — you need someone to stand between the hardware and the
programs. That someone is the **kernel**.

A kernel exists to provide three things:

1. **Isolation.** One program's bug or malice must not corrupt another's memory,
   or the kernel's. A runaway loop in one process must not freeze the machine.
2. **Multiplexing.** One CPU has to look like many; finite RAM has to be shared;
   one disk has to hold many files. The kernel time-slices and space-slices the
   hardware so each program gets the illusion of having it to itself.
3. **Abstraction.** Programs shouldn't speak UART-register or virtio-queue. They
   should say `write(fd, buf, n)` and `open("/path")`. The kernel turns messy
   hardware into a small, uniform set of services.

Everything in this book is in service of those three words: **isolation,
multiplexing, abstraction.** When a design decision seems arbitrary, ask which of
the three it buys you. It is almost always one of them.

---

## 1.2 The user/kernel split

The hardware enforces isolation with **privilege levels**. RISC-V has three (more
on them in §1.5), but the essential idea is a two-camp world:

- **User mode** — where ordinary programs run. The shell, `ls`, `cat`, your code.
  Restricted: it cannot touch device memory, cannot edit page tables, cannot
  disable interrupts. If it tries, the hardware traps into the kernel.
- **Supervisor mode** — where the kernel runs. Privileged: it sees all of
  physical memory, programs the page tables, talks to devices, and decides who
  runs next.

The only way for a user program to do something that requires privilege is to
ask the kernel, by executing a special instruction (`ecall` on RISC-V) that
deliberately *traps* into supervisor mode at a fixed, kernel-controlled entry
point. This controlled doorway is the **system call**, and it is the single most
important interface in the whole system. We build it in Chapter 7.

```
        user mode                         supervisor mode
   ┌─────────────────┐   ecall / trap   ┌──────────────────┐
   │  sh, ls, cat …  │ ───────────────▶ │   the kernel     │
   │  (restricted)   │ ◀─────────────── │  (privileged)    │
   └─────────────────┘     sret         └──────────────────┘
            ▲                                     │
            │ the hardware forces this transition │
            └─────────────────────────────────────┘
                    (traps, interrupts, ecall)
```

The hardware — not the kernel — guarantees that user code *cannot* reach
supervisor mode except through the doorways the kernel sets up. That guarantee is
the bedrock of isolation. A huge fraction of kernel code exists to manage these
transitions correctly and safely.

---

## 1.3 A tour of what we'll build

By the last chapter you'll have a Unix-like kernel that boots on the QEMU `virt`
machine and runs an interactive shell. Concretely, it will:

- boot from power-on through machine mode into supervisor mode;
- drive a UART console for input and output;
- manage physical memory and per-process virtual address spaces with Sv39 paging;
- handle traps, interrupts, and system calls;
- create processes and switch between them preemptively, across multiple CPUs;
- implement `fork`, `exec`, `wait`, `exit`, `kill`, pipes, and file descriptors;
- store files on a crash-safe, logged file system on a virtio disk;
- run a shell and the familiar utilities — `cat`, `echo`, `grep`, `ls`, `mkdir`,
  `rm`, `wc` — plus a stress-testing suite.

Here is the system we're aiming at, sketched as layers:

```
   ┌──────────────────────────────────────────────────────────┐
   │ user:  sh   ls   cat   grep   usertests        (Part V)   │
   ├──────────────────────────────────────────────────────────┤
   │ syscalls: fork exec wait open read write pipe   (Part III)│
   ├───────────────┬───────────────┬──────────────────────────┤
   │ processes &   │ file system   │ memory                    │
   │ scheduling    │ (fd→file→inode│ (page allocator, page     │
   │ (proc, switch,│  →log→buffer  │  tables, user/kernel      │
   │  traps)       │  cache→disk)  │  address spaces)          │
   │  Part III     │  Part IV      │  Part II                  │
   ├───────────────┴───────────────┴──────────────────────────┤
   │ boot + console: entry, start, uart, printk     (Part I)   │
   ├──────────────────────────────────────────────────────────┤
   │ hardware: RISC-V CPU, RAM, UART, virtio, PLIC (QEMU virt) │
   └──────────────────────────────────────────────────────────┘
```

We build it bottom-up, which is also the order the kernel initializes itself at
boot (§1.7).

---

## 1.4 The shape of the kernel

Knowing where everything will live now will pay off in every later chapter. The
whole kernel is small — a few thousand lines of Go — so over the course of this
book you will, piece by piece, have written essentially all of it. We'll organize
the repository so each subsystem is one or two clearly named files.

### `kernel/` — boot and low-level setup
| File | Role | Built in |
|------|------|----------|
| `entry.s` | the first instructions after QEMU jumps to the kernel | Ch. 2 |
| `start.go` | machine-mode setup, then drop to supervisor mode | Ch. 2 |
| `main.go` | supervisor-mode `main`; initializes every subsystem | Ch. 2, 1.7 |
| `kernel.ld` | linker script; where the kernel lands in memory | Ch. 2 |
| `memlayout.go` | physical/virtual memory map constants | Ch. 1, 5 |
| `riscv.go` | CSR access, paging bits, privilege definitions | throughout |
| `param.go` | system-wide limits (`NPROC`, `NCPU`, `NBUF`, …) | throughout |

### `kernel/` — console and devices
| File | Role | Built in |
|------|------|----------|
| `uart.go` | 16550 UART driver | Ch. 3 |
| `console.go` | line discipline; the console as a device file | Ch. 3, 17 |
| `printk.go` | the kernel's formatted printer | Ch. 3 |
| `plic.go` | platform-level interrupt controller | Ch. 7, 9 |
| `virtio_disk.go` | virtio block device driver | Ch. 12 |

### `kernel/` — memory
| File | Role | Built in |
|------|------|----------|
| `kalloc.go` | physical page allocator (free list) | Ch. 4 |
| `vm.go` | page tables, kernel & user address spaces | Ch. 5, 6 |

### `kernel/` — processes, traps, concurrency
| File | Role | Built in |
|------|------|----------|
| `proc.go` | process table, scheduler, fork/wait/exit | Ch. 10, 11 |
| `switch.s` | the context switch (save/restore callee regs) | Ch. 10 |
| `trampoline.s` | the user↔kernel trap trampoline | Ch. 7 |
| `trap.go`, `kernelvec.s` | trap handling (user and kernel) | Ch. 7 |
| `syscall.go` | the system-call dispatch table | Ch. 7 |
| `sysproc.go` | process-related syscall implementations | Ch. 11 |
| `spinlock.go`, `sleeplock.go` | the two lock types | Ch. 9 |
| `exec.go`, `elf.go` | ELF loading; turning a file into a process | Ch. 8 |

### `kernel/` — file system (bottom to top)
| File | Role | Built in |
|------|------|----------|
| `bio.go` | buffer cache over the disk | Ch. 13 |
| `log.go` | write-ahead logging for crash safety | Ch. 14 |
| `fs.go` | superblock, inodes, directories | Ch. 15, 16 |
| `file.go` | open-file table, file descriptors | Ch. 17 |
| `pipe.go` | pipes | Ch. 17 |
| `sysfile.go` | file-related syscalls | Ch. 17 |

### `user/` — user space
| File | Role | Built in |
|------|------|----------|
| `ulib.go`, `printf.go`, `umalloc.go` | the user library | Ch. 18 |
| `sh.go` | the shell | Ch. 19 |
| `cat.go`, `echo.go`, `grep.go`, `ls.go`, … | utilities | Ch. 20 |
| `usertests.go`, `forktest.go`, … | the test suite | Ch. 21 |

You don't need to understand any of this yet — you need to know the pieces exist
and roughly where each subsystem lives. We'll return to this table constantly.

---

## 1.5 RISC-V in thirty minutes

You don't need to be a RISC-V expert, but the kernel touches the architecture
constantly. Here is the minimum.

### Registers
There are 32 general-purpose 64-bit integer registers, `x0`–`x31`, with
conventional names:

- `x0` / `zero` — hardwired to zero.
- `ra` (`x1`) — return address.
- `sp` (`x2`) — stack pointer.
- `gp`, `tp` — global / thread pointer (`tp` we'll use to hold the CPU id).
- `a0`–`a7` — argument / return registers. **System-call arguments arrive here**,
  and `a7` carries the syscall number.
- `t0`–`t6` — temporaries (caller-saved).
- `s0`–`s11` — saved registers (callee-saved). **The context switch saves exactly
  these** (Ch. 10).

Plus the program counter `pc`. The caller/callee-saved split is not trivia: it's
precisely why the context switch only has to save `s0`–`s11`, `sp`, and `ra`.

### The three privilege modes
RISC-V defines three modes, most to least privileged:

| Mode | Name | Who runs here |
|------|------|---------------|
| **M** | Machine | firmware / earliest boot; full hardware access |
| **S** | Supervisor | our kernel |
| **U** | User | application programs |

We boot in **M-mode** (the most privileged), do the minimum machine-level setup,
and immediately drop to **S-mode** to run the kernel — most of the OS lives in S.
User programs run in **U-mode** and trap up to S when they need the kernel. This
M→S→(U⇄S) flow is the spine of Chapters 2 and 7.

Here's the subtle part of the M→S drop, which we'll implement in Chapter 2. There
is no instruction to *enter* a lower-privilege mode directly. Instead, you set a
field in the machine status register (`mstatus`) that records "the previous mode
was Supervisor," point the machine exception PC (`mepc`) at our `main`, and
execute `mret` — a *return from trap*. The hardware dutifully "returns" into
S-mode at `main`, even though no trap ever happened. We fake a return to enter
the mode we want.

### CSRs — control and status registers
Modes are configured through **CSRs**, special registers read and written with
dedicated instructions (`csrr`/`csrw`). You'll meet a recurring cast:

- `mstatus` / `sstatus` — current status, including the previous-privilege field.
- `mepc` / `sepc` — the PC to resume at when returning from a trap.
- `stvec` — the address of the kernel's trap handler (Ch. 7).
- `scause` / `stval` — why a trap happened and the faulting value (Ch. 7).
- `satp` — the active page table (Ch. 5). Writing it turns paging on.

Because Go can't emit a `csrw` on its own, we wrap each CSR in a tiny assembly
stub and call it like an ordinary function. For example, the accessor that
installs a page table looks like this (the assembly half lives in a `.s` file;
Appendix B explains the mechanism):

```go
// riscv.go
func w_satp(x uint64) // implemented in riscv.s as: csrw satp, a0; ret
```

The point for now: **a CSR write is how the kernel reconfigures the CPU itself**,
and there are only a couple dozen that matter.

### The trap mechanism, in one paragraph
When a system call, exception, or device interrupt occurs, the hardware: saves
the current PC into `sepc`, records the reason in `scause`, switches to S-mode,
and jumps to the address in `stvec`. The kernel's handler saves the rest of the
registers, does its work, then executes `sret`, which restores the PC from `sepc`
and drops back to the previous mode. Every system call, every timer tick, every
disk interrupt flows through this one mechanism. We implement it in Chapter 7;
it's worth re-reading this paragraph then.

---

## 1.6 Why Go — and what it costs

Writing a kernel in Go lets us see operating-system concepts clearly, without the
manual memory bookkeeping and pointer noise that usually clutter low-level code.
We get a real type system, slices and strings, `defer`, and clean error handling.

But a kernel violates almost everything the Go *runtime* assumes. The standard Go
runtime expects an operating system *underneath it*: it asks that OS for memory,
spawns OS threads, installs signal handlers, and runs a garbage collector that
blocks waiting on the OS. In a kernel, **we are the thing underneath** — there is
no OS to call. This tension is a running theme, and we'll be explicit about it
every time it bites. The big ones:

- **No runtime, at first (Ch. 2).** We boot with a freestanding toolchain
  (a TinyGo-style or stripped build), provide the handful of runtime symbols the
  compiler expects ourselves, and disable the garbage collector and goroutine
  scheduler until we've built the primitives they'd need.
- **Garbage collection inside a kernel (Ch. 4, 10, 12).** A collector that can
  pause execution at any allocation is a hazard in interrupt handlers, the
  scheduler, and DMA paths. We keep those paths **allocation-free**, back the
  heap with a fixed physical region we manage by hand, and pin any memory a
  device reads or writes.
- **`unsafe` and the pragmas (Appendix B).** Page tables, trapframes, and device
  registers are just typed views over physical addresses. We'll lean on
  `unsafe.Pointer`, and on compiler pragmas like `//go:nosplit` (skip the
  stack-growth check — vital in trap entry), `//go:noescape`, and `//go:linkname`.
- **Goroutines are *not* our processes (Ch. 10).** It's tempting to map a kernel
  process onto a goroutine. We deliberately don't: we build our own context
  switch in assembly, because a kernel scheduler must control exactly when and
  where a switch happens. The chapter explains the choice in full.

Read this as a feature, not a warning. Each place Go fights us is a place the
hardware/OS contract is showing through — exactly what you're here to learn.

---

## 1.7 The shape of the journey: boot order = build order

Here's the elegant part. A kernel's `main` initializes its subsystems in
dependency order — you can't have a process table before you can allocate memory,
can't allocate kernel memory before paging, and so on. That initialization order
*is* the order we'll build the book. Here is the `main` we're working toward,
sketched in Go:

```go
// kernel/main.go — runs on CPU 0 after the M→S drop
func main() {
    if cpuid() == 0 {
        consoleInit()     // Ch. 3  — UART + console
        printkInit()      // Ch. 3  — kernel printer
        kInit()           // Ch. 4  — physical page allocator
        kvmInit()         // Ch. 5  — create the kernel page table
        kvmInitHart()     // Ch. 5  — turn on paging
        procInit()        // Ch. 10 — process table
        trapInit()        // Ch. 7  — trap vectors
        trapInitHart()    // Ch. 7  — install the kernel trap vector
        plicInit()        // Ch. 7/9 — interrupt controller
        plicInitHart()    // Ch. 7/9 — ask the PLIC for device interrupts
        binit()           // Ch. 13 — buffer cache
        iinit()           // Ch. 15 — inode table
        fileInit()        // Ch. 17 — file table
        virtioDiskInit()  // Ch. 12 — emulated disk
        userInit()        // Ch. 8  — the first user process
    } else {
        // other CPUs wait, then turn on paging and traps for themselves
    }
    scheduler()           // Ch. 10 — never returns
}
```

Each line is, more or less, a chapter. By following the kernel's own bootstrap
sequence we guarantee that everything a chapter needs already exists, and that at
the end of every chapter we have a kernel that *boots and does a little more than
it did before*. That "always runnable" property is the heartbeat of this book.

The dependency spine, from the outline:

```
boot → console → kalloc → vm → trap/syscall → exec/init
     → locks → scheduler → fork/wait
     → disk → bio → log → inode → dir → file
     → ulib → sh → utils → tests
```

---

## 1.8 The memory map you'll live in

One last orientation. The QEMU `virt` machine — our hardware — places devices and
RAM at fixed physical addresses. The whole kernel is written against this map:

```
0x00001000  boot ROM (QEMU)         ← the CPU starts here at power-on
0x02000000  CLINT  (timer, IPIs)
0x0C000000  PLIC   (device interrupts)
0x10000000  UART0  (the console)    ← Ch. 3 writes characters here
0x10001000  virtio disk             ← Ch. 12 reads/writes blocks here
0x80000000  RAM begins; QEMU loads our kernel here and jumps in  ← Ch. 2
   …        kernel code/data, then the page-allocation area
0x88000000  PHYSTOP (RAM start + 128 MiB) — end of RAM we use
```

Two facts to file away now:

- **The CPU begins executing at `0x1000`** in QEMU's boot ROM, which hands off to
  our kernel at **`0x80000000`**. Chapter 2 is the story of those first
  instructions.
- **Device registers are just memory.** Writing a byte to `0x10000000` sends a
  character out the UART. There is no magic "I/O" instruction — *memory-mapped
  I/O* means devices live in the address space, and driving hardware is just
  load/store instructions to the right addresses. That's why Chapter 3 can be a
  real device driver in only a few dozen lines.

The same memory map also defines the *top* of the virtual address space — the
trampoline page, per-process kernel stacks with guard pages between them, and the
trapframe — but those only make sense once we have paging (Ch. 5) and traps
(Ch. 7), so we'll return to them there.

---

## 1.9 What you should take away

- An OS exists to deliver **isolation, multiplexing, and abstraction**; judge
  every design choice by which one it serves.
- The **user/kernel split** is enforced by hardware **privilege modes**, and the
  **system call** is the one sanctioned doorway between them.
- RISC-V gives us three modes (M/S/U); we boot in M, run the kernel in S, run
  programs in U, and move between them via **traps** and **CSRs**.
- We'll build the kernel **bottom-up, in the kernel's own boot order**, so it's
  runnable at every step.
- Writing it in **Go** is illuminating precisely because the kernel breaks the Go
  runtime's assumptions; each conflict teaches the hardware/OS contract.
- Everything is anchored to the **QEMU `virt` memory map**, where even devices
  are just addresses.

---

## Exercises

1. **The three jobs.** For each of the following kernel features, say which of
   isolation / multiplexing / abstraction it primarily serves: (a) page tables,
   (b) the scheduler's timer interrupt, (c) the `read`/`write` system calls,
   (d) the rule that user mode can't disable interrupts. Some serve more than one.

2. **The fake return.** In your own words, explain why entering supervisor mode
   is done as a *return from a trap* (`mret`) rather than a direct jump. What
   would go wrong if the hardware *did* let you jump straight into a less
   privileged mode? (Hint: §1.5, and think about isolation.)

3. **Memory-mapped I/O.** Using the memory map in §1.8, what physical address
   would you store a byte to in order to send a character to the console? What
   would you expect to happen if a *user-mode* program tried to store to that
   address directly, and which of the three OS jobs does preventing it serve?

4. **Caller vs. callee saved.** List the registers the context switch will need
   to save in Chapter 10, using the calling-convention rules in §1.5. Why doesn't
   it need to save `a0`–`a7` or `t0`–`t6`?

5. **The Go tax.** Pick one of the four Go/kernel conflicts in §1.6 and write a
   paragraph predicting *where* in the boot order (§1.7) it will first cause
   trouble. We'll check your prediction in the relevant chapter.

---

*Next: **Chapter 2 — From Power-On to `main`**, where we write the first
instructions the CPU runs, drop from machine to supervisor mode, stand up a Go
kernel with no runtime beneath it, and print our first line over the UART.*
