# Chapter 23 — Where to Go Next

> You've built a working Unix kernel in Go, from the first instruction to an
> interactive shell. This closing chapter points at what comes after: the features
> we deliberately left out, an open question about Go itself, and where to take
> your new understanding. The kernel you have is a foundation, not a ceiling.

---

## 23.1 What we left out, and how to add it

We built a *complete* system but a *minimal* one. The natural next features each
build directly on what you now understand:

- **`mmap` and demand paging.** Right now `exec` loads an entire program eagerly
  (Chapter 8) and `sbrk` allocates immediately (Chapter 6). Real systems map files
  and memory *lazily*: leave the PTE invalid, and let the page-fault handler
  (a case in `usertrap`, Chapter 7) allocate and fill the page on first touch.
  You already have every piece — page tables, the fault path, the file system —
  it's a matter of deferring the work to the fault.

- **Copy-on-write `fork`.** `uvmCopy` (Chapter 6) eagerly duplicates every page,
  most of them wasted when the child immediately `exec`s. COW maps parent and
  child to the *same* physical pages, read-only; the first write faults, and the
  handler makes a private copy. It's demand paging applied to `fork`, and it makes
  `fork` cheap.

- **A larger file system.** Add a double-indirect block to lift the file-size
  limit (Chapter 15's exercise), or larger blocks, or a buffer cache that scales
  past a linear scan.

- **More devices.** A real-time clock, a second disk, a framebuffer. Each is the
  Chapter 12 pattern again: a register map and an interrupt handler plugged into
  `devintr`.

- **A network stack.** The biggest leap: a virtio network device, then ARP, IP,
  UDP, TCP. This is a book of its own, but it starts exactly where Chapter 12 did
  — a virtqueue driver — and ends with sockets as another kind of file (Chapter
  17).

Each of these is a weekend-to-a-month project, and each deepens a specific layer
you've already built.

---

## 23.2 The open question: a real Go runtime inside the kernel?

Throughout the book we *removed* Go's runtime — no GC, no goroutines, no channels.
The provocative question: could a real Go runtime live *inside* the kernel
instead?

Imagine kernel processes as goroutines, scheduled by a Go scheduler we adapt;
blocking syscalls as channel receives; a garbage collector that runs only at safe
points where no lock is held and no DMA is in flight. It's not obviously
impossible — research kernels (Biscuit, from MIT, is a real Go kernel with a GC)
have done versions of this. The hard parts are exactly the ones we dodged:

- A GC that never pauses an interrupt handler or a CPU holding a spinlock.
- Goroutine scheduling that respects the address-space and trapframe switches a
  process needs.
- Bounding GC pause times so real-time-ish guarantees hold.

We chose the freestanding path because it makes the *operating system* concepts
visible without hiding them behind a runtime. But building the runtime-ful version
would teach a different and equally deep lesson: how a managed language's
machinery interacts with the bare metal. If you want a research-grade challenge,
that's it.

---

## 23.3 Where to take this

A few directions, depending on what pulled you in:

- **Go deeper on xv6.** The MIT 6.1810 course labs (which the C xv6 was built for)
  pose exactly the extensions above — COW fork, mmap, a network stack, a copy-on-
  write page allocator — as graded assignments with test suites. Doing them in
  *your* Go kernel is a superb exercise.
- **Read a production kernel.** With this foundation, the equivalent subsystems in
  Linux or the BSDs become legible — you'll recognize the page tables, the trap
  path, the buffer cache, the VFS layer, scaled up and hardened.
- **Read the literature.** The xv6 commentary, the *OSTEP* textbook, and the
  RISC-V privileged spec will each land differently now that you've implemented
  the ideas.
- **Harden what you built.** Real kernels obsess over the boundary (Chapter 6) and
  concurrency (Chapter 9). Fuzz your syscalls, audit every user-pointer use, run
  `grind` (Chapter 21) for hours. The gap between "passes tests" and "is correct"
  is where the craft lives.

---

## 23.4 Closing

Step back and look at what you've built. From a single instruction at
`0x80000000`, you assembled: a memory allocator, virtual memory, a trap mechanism,
processes and a scheduler, a crash-safe file system, and a user space with a shell
— each layer resting on the one below, exactly in the order the kernel boots
itself. You did it in Go, fighting and bending the language where it assumed a
platform that wasn't there, and in doing so you saw the hardware/OS contract that
every operating system is built to honor.

The three jobs from Chapter 1 — **isolation, multiplexing, abstraction** — are no
longer abstract. You know precisely which line of code provides each: the page
tables that isolate, the scheduler that multiplexes, the file descriptors that
abstract. That knowledge is the real artifact of this book. The kernel is just the
proof you earned it.

Now go build something with it.

---

## What you should take away

- The kernel you built is a **foundation**: mmap, copy-on-write `fork`, more
  devices, and a network stack are all natural extensions of layers you already
  have.
- Most extensions reduce to patterns you've seen: **lazy work in the fault
  handler**, **another virtqueue driver**, **another kind of file**.
- Whether a **full Go runtime could live in a kernel** is a genuine open challenge
  — the hard parts are the GC and scheduling concerns we deliberately avoided.
- The lasting artifact isn't the code — it's knowing **exactly where isolation,
  multiplexing, and abstraction come from** in a real system.

---

## Exercises

1. **Demand paging.** Sketch the changes to `usertrap` and `uvmAlloc` to make
   `sbrk` lazy: which fault cause do you handle, and what does the handler do?

2. **COW fork.** Describe the PTE flag bits and the page-fault logic copy-on-write
   needs. What reference-counting problem (think Chapter 4) must you solve for
   shared pages?

3. **A new device.** Outline adding a real-time-clock device: what does `devintr`
   gain, and what's the smallest driver that exposes "what time is it?" to user
   space?

4. **Sockets as files.** Argue how a TCP connection could become an `fdSocket`
   case alongside `fdInode`/`fdPipe` (Chapter 17). What does `fileread` dispatch
   to?

5. **The runtime question.** Pick one of the three hard parts of an in-kernel Go
   runtime (§23.2) and propose a concrete (if imperfect) approach, citing the
   chapter whose mechanism it most threatens.

---

*This is the end of the book — and the beginning of whatever you build next.
Thank you for reading.*
