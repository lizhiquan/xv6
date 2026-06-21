# Chapter 9 — Locking and Multicore

> We've been writing `acquire` and `release` since Chapter 3 and treating them as
> magic. This chapter makes them real. We build spinlocks and sleep locks on top
> of RISC-V atomic instructions, explain why interrupt handling and locking are
> entangled, confront Go's memory model in a setting where the runtime can't help
> us, and finally bring the other harts online — so all those locks start
> protecting something.
>
> Milestone: SMP boot with every CPU entering the scheduler, sharing kernel data
> structures safely.

---

## 9.1 Why locks, concretely

Recall `kalloc` from Chapter 4:

```go
r := kmem.freelist
kmem.freelist = r.next
```

On one CPU, fine. On two CPUs at once, disaster: both read the same `freelist`
head, both advance past the same node, and both return the *same page* to two
callers. Now two processes share physical memory — isolation gone. The window is
tiny, which makes the bug rare, intermittent, and maddening.

A lock makes a sequence of operations **atomic** with respect to other CPUs: while
one holds `kmem.lock`, no other CPU can be inside a `kmem`-protected region. The
rule of thumb: **any data structure touched by more than one CPU needs a lock**,
and you must hold it for the whole read-modify-write, not just part.

---

## 9.2 The atomic primitive

You can't build a lock out of ordinary loads and stores — that's a chicken-and-egg
race. Hardware provides an indivisible read-modify-write. On RISC-V, `amoswap`
atomically swaps a register with a memory word. To take a lock, repeatedly swap
`1` into `lk.locked`; if the value you got back was `0`, the lock was free and is
now yours:

```go
// spinlock.go
type spinlock struct {
	locked uint32 // 0 = free, 1 = held
	name   string
	cpu    *cpu   // which CPU holds it (for debugging)
}

// amoSwap is a one-instruction asm stub: amoswap.w.aq a0, a1, (a0)
func amoSwap(addr *uint32, val uint32) uint32
```

The `.aq` ("acquire") suffix is a **memory barrier**: it tells the CPU that no
loads or stores after the swap may be reordered before it. Without it, the
compiler or the hardware could move a read of the protected data *above* the lock
acquisition — reading it before you actually hold the lock. Barriers are how a
lock actually fences off the critical section.

---

## 9.3 `acquire` and `release`

```go
// spinlock.go
func acquire(lk *spinlock) {
	pushOff() // disable interrupts on this CPU (see §9.4)
	if holding(lk) {
		panic("acquire") // re-acquiring a held lock = deadlock
	}
	for amoSwap(&lk.locked, 1) != 0 {
		// spin: keep trying until we see it was free
	}
	// .aq barrier above ensures the critical section's reads/writes
	// happen strictly after we hold the lock.
	lk.cpu = mycpu()
}

func release(lk *spinlock) {
	if !holding(lk) {
		panic("release")
	}
	lk.cpu = nil
	// .rl ("release") barrier: all writes in the critical section are
	// visible to other CPUs before we mark the lock free.
	amoSwapRelease(&lk.locked, 0)
	popOff()
}

func holding(lk *spinlock) bool {
	return lk.locked != 0 && lk.cpu == mycpu()
}
```

A spinlock **busy-waits** — it burns CPU while spinning. That's the right choice
only for locks held *briefly* and never across a sleep: the allocator, the
scheduler's own lock, device registers. For anything held a long time (a disk
block in flight), we need a different tool (§9.6).

---

## 9.4 Locks and interrupts: the deadlock trap

Here's a subtle, essential rule: **`acquire` disables interrupts on the current
CPU**, and `release` re-enables them (if they were on). Why?

Suppose a CPU holds `kmem.lock`, and a timer interrupt fires. The interrupt
handler runs `kalloc`, which tries to `acquire(kmem.lock)` — but *this same CPU*
already holds it. The lock will never be released (its holder is paused, waiting
for the handler to finish), so the handler spins forever. Self-deadlock.

Disabling interrupts while holding a spinlock closes that window. The bookkeeping
is in `pushOff`/`popOff`, which *nest*: two `pushOff`s require two `popOff`s, and
the interrupt state is only restored when the outermost lock is released:

```go
// spinlock.go
func pushOff() {
	old := intrGet()
	intrOff()
	c := mycpu()
	if c.noff == 0 {
		c.intena = old // remember whether interrupts were on originally
	}
	c.noff++
}

func popOff() {
	c := mycpu()
	if intrGet() {
		panic("popOff - interruptible")
	}
	if c.noff < 1 {
		panic("popOff")
	}
	c.noff--
	if c.noff == 0 && c.intena {
		intrOn() // restore only at the outermost release
	}
}
```

The nesting matters because the kernel routinely holds two locks at once; we must
not re-enable interrupts until the *last* one is dropped.

---

## 9.5 Go's memory model, without a runtime

In ordinary Go, you'd reach for `sync.Mutex` or `sync/atomic` and trust the
runtime to insert the right barriers. We can't: there's no runtime scheduler, and
our "threads" are kernel processes on bare harts. So we own the memory model
ourselves.

Two consequences:

- **We use explicit atomic operations and barriers** (`amoswap.w.aq`,
  `amoswap.w.rl`, `fence`) rather than `sync.Mutex`. The `sync` package assumes
  goroutines and a scheduler; ours don't exist here.
- **The compiler must not reorder across our locks.** The `.aq`/`.rl` barriers
  and a compiler barrier on the atomic intrinsics prevent the Go compiler from
  hoisting a protected load above `acquire` or sinking a protected store below
  `release`.

This is the deepest place the "no runtime" theme from Chapter 1 bites. Go's
concurrency story is one of its best features — and it's exactly the part we have
to rebuild from the hardware up.

---

## 9.6 Sleep locks: when spinning is wrong

A spinlock held while waiting for the disk would waste millions of cycles and —
worse — it disables interrupts, so the disk-completion interrupt could never
arrive. For long waits we use a **sleep lock**: a lock whose waiters *sleep*
(yield the CPU) instead of spinning.

```go
// sleeplock.go
type sleeplock struct {
	locked bool
	lk     spinlock // protects the fields below
	name   string
	pid    int
}

func acquireSleep(lk *sleeplock) {
	acquire(&lk.lk)
	for lk.locked {
		sleep(unsafe.Pointer(lk), &lk.lk) // give up the CPU until released
	}
	lk.locked = true
	lk.pid = myproc().pid
	release(&lk.lk)
}

func releaseSleep(lk *sleeplock) {
	acquire(&lk.lk)
	lk.locked = false
	lk.pid = 0
	wakeup(unsafe.Pointer(lk)) // wake anyone sleeping on this lock
	release(&lk.lk)
}
```

Notice a sleep lock is *built on* a spinlock: the short spinlock protects the
sleep lock's own fields, while the sleep happens outside it. `sleep`/`wakeup` are
the condition-variable mechanism we build in Chapter 10. Sleep locks guard things
held across blocking operations — disk buffers (Chapter 13), inodes (Chapter 15).
Two tools, two regimes: **spin for short and interrupt-sensitive; sleep for long
and blocking.**

---

## 9.7 Bringing the harts online

Until now only hart 0 has done anything; the others have spun in `main`'s idle
loop since Chapter 2. Now we let them all run. Recall the boot structure
(Chapter 1, §1.7):

```go
// main.go
func main() {
	if cpuid() == 0 {
		// hart 0 does all one-time init: console, kalloc, kvm, procinit, …
		consoleInit()
		kInit()
		kvmInit()
		// … etc …
		started = 1 // a barrier flag the others wait on
	} else {
		for atomicLoad(&started) == 0 {
			// wait until hart 0 finishes shared initialization
		}
		kvmInitHart()  // turn on paging for this hart
		trapInitHart() // install this hart's trap vector
		plicInitHart() // ask the PLIC for interrupts on this hart
	}
	scheduler() // every hart now enters the scheduler — never returns
}
```

The `started` flag is the boot **barrier**: the other harts must not touch
`kmem`, the page table, or the process table until hart 0 has built them.
Per-CPU setup (`kvmInitHart`, `trapInitHart`, `plicInitHart`) then runs on *each*
hart, because `satp`, `stvec`, and PLIC enables are per-hart registers.

Once all harts call `scheduler`, the kernel is genuinely multicore: several CPUs
pulling runnable processes from the shared process table at once — which is
exactly why every shared structure needed a lock. The locks we've been writing
since Chapter 3 finally earn their keep.

---

## 9.8 What you should take away

- A lock makes a read-modify-write **atomic across CPUs**; the rule is *one lock
  per shared structure, held for the whole operation*.
- Locks are built on a **hardware atomic** (`amoswap`) plus **memory barriers**
  (`.aq`/`.rl`) that stop reordering around the critical section.
- `acquire` **disables interrupts** to prevent self-deadlock; `pushOff`/`popOff`
  nest so interrupts return only at the outermost `release`.
- Without the Go runtime we **own the memory model** — explicit atomics and
  barriers replace `sync.Mutex`.
- **Spinlocks** for short, interrupt-sensitive critical sections; **sleep locks**
  (built on spinlocks + `sleep`/`wakeup`) for long, blocking ones.
- A boot **barrier** lets hart 0 finish shared init before the other harts join
  the scheduler.

---

## Exercises

1. **The lost page.** Write out the exact interleaving of two CPUs in `kalloc`
   (without a lock) that returns the same page twice. At which instruction
   boundary does the race occur?

2. **Why disable interrupts in `acquire`?** Construct the self-deadlock scenario
   with `kmem.lock` and a timer interrupt step by step. Would the bug appear on a
   single-core machine? On a machine with interrupts always off?

3. **Nesting.** A function acquires lock A, then lock B, then releases B, then A.
   Trace `noff` and `intena` through all four calls. At which `release` do
   interrupts come back on, and why must it be that one?

4. **Spin vs. sleep.** For each, choose spinlock or sleep lock and justify:
   (a) the physical page allocator, (b) an inode being read from disk, (c) the
   console output lock, (d) a pipe buffer with a blocked reader.

5. **Missing barrier.** Suppose `acquire` used a plain (non-`.aq`) swap. Describe
   a concrete reordering the CPU could perform that lets one process see another's
   half-written data, even though both "use the lock."

---

*Next: **Chapter 10 — Scheduling and Context Switching**, where we build the
context switch in assembly, the scheduler loop, and `sleep`/`wakeup` — turning a
set of processes into preemptive multitasking across all these CPUs.*
