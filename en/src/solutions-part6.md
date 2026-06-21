# Solutions — Part VI (Beyond the Kernel)

> Answers to the exercises in Chapters 22–23. These chapters are reflective and
> open-ended, so the "answers" are guidance and one defensible position among
> several — your reasoning matters more than matching the text.

---

## Chapter 22 — Reflections on Go in a Kernel

**1. Cost/benefit (file system).** A strong case for Go: the file system is mostly
*high-level logic* — directory scans, the inode protocol, transaction bracketing —
where typed structs (`dinode`, `dirent`), slices for block buffers, and `defer`
for `endOp`/`iunlock` reduce bookkeeping errors. C's `void*` and manual `goto bad`
unwinding are exactly the noise Go removes here. (A case for C: the on-disk struct
layouts must match byte-for-byte, where C's explicit layout control is more
direct.)

**2. The unsafe surface.** Essential `unsafe` uses: device registers (Chapter 3),
the free-list `run` overlay (Chapter 4), page tables and PTEs (Chapter 5), the
trapframe (Chapter 7), virtqueue rings (Chapter 12). Several *could* sit behind a
small safe API — e.g. a `Reg(off) uint32`/`SetReg(off, v)` device accessor, or a
`PageTable` type with `Walk`/`Map` methods — guaranteeing alignment and bounds so
callers never touch raw pointers. The MMIO and page-table layers are the best
candidates.

**3. A GC that stayed.** Three places a surprise pause would bite: inside an
**interrupt handler** (Chapter 7/12) — it can't wait for a collector; while holding
a **spinlock** with interrupts off (Chapter 9) — a pause there stalls every CPU
spinning on the lock; during **DMA setup** (Chapter 12) — moving a buffer mid-
transfer corrupts the disk. Each would need GC-safe-point guarantees the design
can't easily give.

**4. Pragma audit.** `//go:nosplit` — trap entry (`usertrap` path) and early boot
run before/without the stack-growth runtime, so a split check there crashes.
`//go:noescape` — `unsafe`-pointer helpers like the CSR/`copyout` shims, so a
pointer arg doesn't get forced onto a (nonexistent managed) heap. `//go:linkname`
— exposing `stack0`/runtime symbols across the Go/asm boundary so `entry.s` can
reference them.

**5. Your verdict.** Either answer is fine if argued. A reasonable "yes, for
teaching/research": the clarity of the upper layers (FS, scheduler logic, syscalls)
outweighs a finite, one-time plumbing cost, and Biscuit shows a GC'd kernel is
feasible. A reasonable "no, for production": the `unsafe`/pragma surface, the
removed-runtime fragility, and binary size argue for C or Rust where the
abstraction fits the metal without fighting it.

---

## Chapter 23 — Where to Go Next

**1. Demand paging.** Make `sbrk` only raise `p.sz` without allocating; mark the
new range with no PTE (or a special "lazy" PTE). In `usertrap`, add a case for a
**page-fault `scause`** (load/store page fault): check the faulting address is in
`[0, p.sz)`, `kalloc` a zeroed page, `mappages` it with user permissions, and
return so the instruction retries. The fault handler does the work `uvmAlloc` used
to do eagerly.

**2. COW fork.** `uvmCopy` maps the child to the **same physical pages** as the
parent, both read-only, and clears the writable bit (using a spare PTE flag, say
`PTE_COW`, to remember "this was writable"). A write faults; the handler `kalloc`s
a private copy, maps it writable, and resumes. The reference-counting problem
(Chapter 4): a physical page now has multiple owners, so the allocator needs a
**per-page refcount** — free it only when the last owner unmaps it.

**3. A new device (RTC).** `devintr` gains nothing if you only *read* the clock
(no interrupt needed); the smallest driver maps the RTC's MMIO registers (like the
UART in Chapter 3) and exposes a function that reads the time register. To give it
to user space, add a syscall (e.g. `time()`), or expose it as a device file via
`devsw` (Chapter 17).

**4. Sockets as files.** Add an `fdSocket` case to `struct file` alongside
`fdInode`/`fdPipe`, pointing at a connection object. `fileread`/`filewrite`
dispatch to `sockread`/`sockwrite`, which move bytes to/from the TCP receive/send
buffers (filled/drained by the network stack and its device interrupt). To user
space it's just another fd — `read`/`write` work unchanged, which is the payoff of
Chapter 17's uniform interface.

**5. The runtime question.** Pick one and propose an approach, e.g. **GC pauses**:
run the collector only at explicit safe points where the current CPU holds no
spinlock and no DMA is outstanding, and make interrupt handlers allocation-free so
they never trigger collection. It's imperfect (long-held references, latency under
load) and most threatens the **interrupt/locking paths of Chapter 9 and 12**, which
is precisely why we sidestepped it.

---

*This completes the solutions. If your reasoning differs but holds up against the
code, you've understood the chapter — that's the goal.*
