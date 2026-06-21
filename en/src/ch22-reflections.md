# Chapter 22 — Reflections on Go in a Kernel

> We set out to build a Unix kernel in Go, and we did — it boots, schedules,
> isolates, persists, and runs a shell. This chapter steps back to ask the harder
> question: was Go a good choice? Where did it help, where did it fight us, and
> where did the abstractions leak? The honest answer is "both, constantly" — and
> the tension is exactly what made the project illuminating.

---

## 22.1 What Go gave us

Several things genuinely made the kernel clearer than the C original would be:

- **A real type system.** Page table entries, trapframes, and inodes are typed,
  not casts on `void*`. The compiler caught whole classes of "wrong struct"
  mistakes. `pagetable` being a distinct type from `*uint64` documents intent.
- **Slices and strings.** Bounds-checked slices removed a swathe of buffer
  arithmetic, and real strings made path handling and `printk` formats less
  error-prone than C's `char*` and manual lengths.
- **`defer`.** Lock release and cleanup paths — `defer release(&lk)` — are far
  harder to get wrong than C's `goto bad` ladders. The rollback paths in
  `uvmAlloc` and `exec` are clearer for it.
- **Tooling and readability.** One build command, no headers, gofmt. The code is
  simply easier to *read*, which for a teaching kernel is much of the point.

For *understanding* operating systems, these matter: less of your attention goes
to language ceremony, more to the actual ideas.

---

## 22.2 What we had to fight

The recurring theme of the book was the Go *runtime*, which assumes an OS beneath
it. We are that OS, so we spent real effort working around it:

- **The garbage collector had to go.** `gc: none` from Chapter 2 onward. A
  collector that can pause at any allocation is incompatible with interrupt
  handlers, the scheduler, and DMA. The consequence rippled through everything:
  we manage memory by hand (`kalloc`, `malloc`), exactly the work Go usually does
  for you.
- **`unsafe` is everywhere it matters.** Page tables, the trapframe, device
  registers, the free list — all are `unsafe.Pointer` views over physical
  addresses. The safety Go advertises is precisely what a kernel must opt out of
  at its lowest layers. We confined `unsafe` to those layers, but it's load-
  bearing.
- **No goroutines for processes.** We built `swtch` by hand (Chapter 10) because a
  kernel must control switch timing and touch `satp`, the trapframe, and stacks —
  none of which Go's scheduler models. The language's flagship concurrency feature
  was unusable for the one place you'd most expect to want it.
- **Compiler pragmas as load-bearing.** `//go:nosplit` (no stack-growth check in
  trap entry), `//go:noescape`, `//go:linkname` — these aren't decorations; the
  kernel doesn't work without them. They're the seams where Go's model meets the
  metal.

None of this is a defect in Go — it's what happens when you remove the platform a
high-level language stands on.

---

## 22.3 Where the abstractions leaked

A few places where Go's conveniences quietly stopped applying, and we had to
notice:

- **`interface{}` / `any` in `printk`.** It works and doesn't allocate for the
  cases we use, but it's a thin spot — a careless format could reach for runtime
  machinery we don't have.
- **Maps and channels are off-limits** in kernel code: they allocate and assume
  the runtime. We never reach for them, but the temptation is real and the failure
  mode (a runtime call into nothing) is ugly.
- **Stack growth.** Ordinary Go grows goroutine stacks on demand via a runtime
  check. With fixed kernel stacks and `//go:nosplit` in the wrong places, a deep
  call chain could silently overflow — the guard pages (Chapter 6) are our safety
  net, turning a leak into a fault.
- **Binary size and the embedded runtime shim.** Even stripped, TinyGo emits a
  small runtime. We never use its startup path, but it's there, and it's a
  reminder that "freestanding Go" is freestanding by *configuration*, not by
  nature.

The lesson isn't that these are dealbreakers — we shipped a working kernel — but
that **every leak is a place the hardware/OS contract shows through the language**,
which is the thing we came to learn.

---

## 22.4 C vs. Go, in spirit

The original xv6 is in C, a language with no runtime to fight — its `void*`,
manual memory, and headers are *exactly* matched to kernel work. Go trades that
native fit for safety, types, and readability, then makes you claw back the
low-level control with `unsafe` and pragmas.

The honest summary: **Go made the high-level logic clearer and the low-level
plumbing harder.** For a teaching kernel, that's arguably the right trade — the
plumbing is a finite, one-time cost (a few asm stubs, a target file, a discipline
about `unsafe`), while the clarity pays off in every subsystem above it. For a
production kernel chasing every cycle and byte, the calculus would differ.

---

## 22.5 What you should take away

- Go's **types, slices, strings, and `defer`** made the kernel's logic clearer
  than the C equivalent — valuable for understanding.
- The **runtime is the adversary**: no GC, no goroutines-as-processes, `unsafe`
  and pragmas everywhere at the bottom — all because we removed the OS the runtime
  assumes.
- The **leaks** (`any`, no maps/channels, fixed stacks, the runtime shim) are
  instructive: each marks where the language model meets the hardware.
- The trade is **clearer high-level code for harder low-level plumbing** — a good
  bargain for a teaching OS, a closer call for production.

---

## Exercises

1. **Cost/benefit.** Pick one subsystem (say, the file system) and argue concretely
   whether Go or C would produce clearer code for it. Cite specific features.

2. **The unsafe surface.** List every place in the book where `unsafe.Pointer` was
   essential. Could any of them be encapsulated behind a small safe API, and what
   would that API guarantee?

3. **A GC that stayed.** Suppose you kept Go's GC but marked kernel-critical paths
   as no-GC zones. Name three places a surprise GC pause would cause a bug, from
   the chapters.

4. **Pragma audit.** For `//go:nosplit`, `//go:noescape`, and `//go:linkname`,
   give one concrete place each was needed and what breaks without it.

5. **Your verdict.** Having read the whole book, would you build a real OS in Go?
   Write a paragraph defending your answer using evidence from specific chapters.

---

*Next: **Chapter 23 — Where to Go Next**, the closing chapter: the features we
left out (mmap, copy-on-write, networking), whether a real Go runtime could ever
live inside the kernel, and where to take your new understanding.*
