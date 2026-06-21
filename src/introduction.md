# Building an Operating System in Go: xv6 on RISC-V

> A hands-on book that teaches operating-system fundamentals by building a
> complete Unix-like kernel — xv6 — in Go, on the RISC-V architecture. Each
> chapter ends with a working, bootable milestone you can run under QEMU.

---

## About This Book

### Who this is for
Programmers comfortable with Go who want to understand how an operating system
actually works — boot, virtual memory, traps, scheduling, file systems — by
building one rather than reading about one.

### What we're building
**xv6** is a small Unix-like operating system: a kernel that boots on real
hardware (here, the emulated RISC-V `virt` machine), manages memory and
processes, provides a file system, and runs an interactive shell with the
familiar utilities — `cat`, `ls`, `grep`, and friends. It is small enough to
understand in full, yet complete enough to be a real system. Over this book you
will build all of it, from the first instruction the CPU executes to the shell.

### Why Go
Go gives us a real type system, slices and strings, `defer`, clear error
handling, and a pleasant toolchain — without the manual memory bookkeeping and
header juggling that usually make kernel code hard to read. But a kernel breaks
several assumptions the Go *runtime* normally relies on, and the book is honest
about that tension throughout:
- **No runtime, at first.** The standard Go runtime expects an operating system
  beneath it — for memory, threads, and signals. In a kernel, *we are that
  thing*. Early chapters run on a freestanding/TinyGo-style toolchain and
  provide the few runtime symbols ourselves.
- **Garbage collection in a kernel.** We discuss when the GC may run, why
  interrupt handlers, the scheduler, and DMA paths must be allocation-free, and
  how to pin memory.
- **`unsafe` and the compiler pragmas.** `unsafe.Pointer`, `//go:nosplit`,
  `//go:noescape`, and `//go:linkname` are what make low-level Go possible; we
  cover the rules for using them safely.
- **Goroutines are not our processes.** We deliberately build our own context
  switch instead of leaning on goroutines, and we explain why a kernel scheduler
  needs that control.

### How to read it
Every chapter follows the same arc: concept → design → implementation → run it
under QEMU → exercises. Code is built incrementally in a single git repository;
each chapter is a tag you can check out and run.

### Prerequisites & toolchain (Chapter 0 covers setup)
RISC-V GNU toolchain, QEMU (`qemu-system-riscv64`), Go (freestanding build path /
TinyGo), `make`, and a debugger (`gdb`/`lldb` with RISC-V support).

---

## Part I — Foundations

### Chapter 1: What an Operating System Does
- The kernel/user split; privilege, isolation, multiplexing, abstraction.
- A tour of the finished product: what we'll have built by the last page.
- The layout of our Go kernel repository.
- RISC-V in thirty minutes: registers, the three privilege modes (M/S/U),
  CSRs, the calling convention, the trap mechanism.

### Chapter 2: From Power-On to `main`
- The QEMU `virt` machine and its memory map.
- Machine mode, the boot ROM, and the linker script that places our kernel.
- The first assembly stub and `start`: set up a stack, drop from machine mode
  to supervisor mode.
- **The Go problem, up front:** booting *without* the Go runtime — disabling the
  GC and goroutine scheduler, supplying the runtime symbols ourselves.
- Milestone: print "hello" over the UART from a Go kernel on bare QEMU.

### Chapter 3: Talking to Hardware — the Console
- Memory-mapped I/O; the UART (16550) device.
- A Go UART driver using `volatile`-style access via `unsafe`.
- A minimal `printk`: formatting without `fmt`, without allocation.
- Spinlocks preview: why even `printk` needs a lock.
- Milestone: a polling console you can `printk` to.

---

## Part II — Memory

### Chapter 4: Physical Memory Allocation
- The free-list allocator: physical memory as a linked list of free page frames.
- Designing a page allocator in Go that the garbage collector must never touch —
  backing it with a fixed physical region, `unsafe.Pointer` arithmetic, alignment.
- Milestone: `kalloc`/`kfree` with a test that exhausts and recovers memory.

### Chapter 5: Virtual Memory and Page Tables
- RISC-V Sv39 paging: three-level page tables, PTEs, permission bits.
- `walk`, `mappages`, and building the kernel page table.
- Go design: representing PTEs and page tables as typed `unsafe` views over
  physical pages.
- Turning on paging (`satp`, `sfence.vma`) — the moment addresses change meaning
  beneath your feet.
- Milestone: the kernel runs with paging on; map RAM, UART, PLIC, and the disk.

### Chapter 6: Per-Process Address Spaces
- User vs. kernel mappings; the trampoline and guard pages.
- Creating, growing, and copying user address spaces; copying data safely across
  the user/kernel boundary (`copyin`/`copyout`).
- Milestone: build and switch into a user address space.

---

## Part III — Processes, Traps, and Concurrency

### Chapter 7: Traps, Interrupts, and System Calls
- The RISC-V trap mechanism: `stvec`, `scause`, `sepc`, `sscratch`.
- The user and kernel trap paths; the trampoline.
- Writing trap entry/exit in assembly and saving/restoring the trapframe.
- The system-call dispatch table and argument fetching.
- Milestone: a user program that makes a system call and returns.

### Chapter 8: The First Process and `exec`
- ELF loading; building the first user program (`initcode`).
- How the first process is born and how `init` starts.
- Go design: parsing ELF without the standard library.
- Milestone: boot all the way to running a user binary.

### Chapter 9: Locking and Multicore
- Why locks: races, the memory model, RISC-V atomics and fences.
- Spinlocks and sleep locks.
- Go's memory model vs. what a kernel needs; atomics at the kernel level;
  disabling interrupts (`push_off`/`pop_off`).
- Running on multiple harts; per-CPU state.
- Milestone: SMP boot with all CPUs entering the scheduler.

### Chapter 10: Scheduling and Context Switching
- The process table, process states.
- The context switch in assembly: saving and restoring callee-saved registers —
  our own switch, *not* goroutines, and why that choice is deliberate.
- The scheduler loop, `yield`, and timer interrupts.
- `sleep`/`wakeup`: the condition-variable pattern at the heart of the kernel.
- Milestone: preemptive multitasking across processes and CPUs.

### Chapter 11: `fork`, `wait`, `exit`, and `kill`
- The process lifecycle and the parent/child relationship.
- Copying address spaces, reaping zombies, reparenting orphans to `init`.
- Milestone: `fork`/`exec`/`wait` working end to end.

---

## Part IV — File System

### Chapter 12: The Disk Driver
- The virtio block device: virtqueues, descriptors, the notification protocol.
- DMA in a garbage-collected language: keeping buffers physically stable.
- Milestone: read and write raw disk blocks.

### Chapter 13: The Buffer Cache
- Caching blocks, the LRU list, `bread`/`bwrite`/`brelse`.
- Concurrency: per-buffer sleep locks.
- Milestone: a working block cache layered over the disk driver.

### Chapter 14: Crash Recovery — the Logging Layer
- Why write-ahead logging; the transaction model.
- `begin_op`/`end_op`, commit, and recovery on boot.
- Milestone: survive a simulated crash mid-write.

### Chapter 15: Inodes and the On-Disk Layout
- The superblock, the block bitmap, inodes, direct and indirect blocks.
- Allocating inodes, mapping file offsets to blocks, reading and writing file data.
- Milestone: allocate and read/write file data through inodes.

### Chapter 16: Directories and Path Names
- Directory entries, lookup, and path resolution (`namei`).
- `link`, `unlink`, and the reference-counting rules.
- Milestone: create, look up, and remove files by path.

### Chapter 17: The File Descriptor Layer
- The open-file table, `dup`, and file offsets.
- Wiring up `open`, `read`, `write`, `close`.
- Pipes and device files; the console as a file.
- Milestone: redirection and pipes work from the kernel side.

---

## Part V — User Space

### Chapter 18: The User Library
- The user-side runtime: generated syscall stubs and their Go wrappers.
- A small standard library — formatted output, `malloc` — and the user-mode Go
  runtime story.
- Milestone: a user program that links against our user library.

### Chapter 19: The Shell
- Parsing, `fork`/`exec`, redirection, and pipelines.
- Building a shell that runs on our kernel.
- Milestone: an interactive shell.

### Chapter 20: The Userland Utilities
- Building the classics: `cat`, `echo`, `grep`, `ls`, `mkdir`, `rm`, `wc`, `ln`,
  `kill`, and `init`.
- Milestone: a usable single-user system.

### Chapter 21: Testing It All
- A stress-testing suite for concurrency, the file system, and crash recovery.
- Milestone: the test suite passes.

---

## Part VI — Beyond the Kernel

### Chapter 22: Reflections on Go in a Kernel
- A retrospective: the GC, the `unsafe` surface area, binary size, and where the
  abstractions leaked.
- What worked beautifully and what we had to fight.

### Chapter 23: Where to Go Next
- mmap and demand paging; copy-on-write `fork`.
- A network stack; more devices.
- Could a real Go runtime — goroutines, channels — live *inside* the kernel?
- Pointers into the broader OS literature and the MIT 6.1810 labs.

---

## Appendices

- **A. RISC-V Reference** — instructions, CSRs, and a privileged-spec cheat sheet.
- **B. The Go Freestanding Toolchain** — build flags, TinyGo notes, linker
  scripts, and the pragmas (`//go:nosplit`, `//go:noescape`, `//go:linkname`).
- **C. QEMU & Debugging** — running, `gdb`/`lldb` recipes, and inspecting page
  tables and trapframes.
- **D. The Memory Map** — the physical and virtual memory layout, with every
  constant explained.

---

## Suggested Build Order (the dependency spine)

```
boot → console → kalloc → vm → trap/syscall → exec/init
     → locks → scheduler → fork/wait
     → disk → bio → log → inode → dir → file
     → ulib → sh → utils → tests
```

The kernel initializes its subsystems in dependency order at boot — you cannot
have a process table before you can allocate memory, nor allocate memory before
paging. That initialization order *is* the order of this book, so each chapter
unlocks the next and the kernel boots and runs at the end of every chapter.
