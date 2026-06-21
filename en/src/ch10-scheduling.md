# Chapter 10 — Scheduling and Context Switching

> This is the chapter that makes one CPU look like many. We build the context
> switch — a few lines of assembly that swap one execution thread for another —
> the scheduler loop that hands CPUs to runnable processes, and `sleep`/`wakeup`,
> the condition-variable pattern at the heart of every blocking operation in the
> kernel. And we explain, finally, why our processes are *not* goroutines.
>
> Milestone: preemptive multitasking — several processes time-sharing across all
> the CPUs.

---

## 10.1 The process table and process states

A process is a struct in a fixed-size global table (`NPROC` entries). The
scheduler cares mostly about its **state**:

```go
// proc.go
type procState int
const (
	UNUSED procState = iota
	USED              // being set up
	SLEEPING          // blocked on a wait channel
	RUNNABLE          // ready, waiting for a CPU
	RUNNING           // currently on a CPU
	ZOMBIE            // exited, waiting for parent to reap
)

type proc struct {
	lock      spinlock
	state     procState
	chan_     unsafe.Pointer // wait channel when SLEEPING
	pid       int
	kstack    uintptr   // kernel stack
	pagetable pagetable // user address space
	trapframe *trapframe
	context   context   // saved kernel registers for swtch (below)
	// … parent, name, open files, cwd …
}
```

A process moves `RUNNABLE → RUNNING` when a CPU picks it, back to `RUNNABLE` when
preempted, to `SLEEPING` when it blocks, and to `ZOMBIE` when it exits. The
scheduler's whole job is shuffling processes between these states.

---

## 10.2 The context switch

To stop running process A and start running process B, a CPU must save A's
registers somewhere and load B's. But thanks to the calling convention (Chapter 1,
§1.5), we only need to save the **callee-saved** registers — `ra`, `sp`, and
`s0`–`s11`. The caller-saved ones (`a*`, `t*`) were already spilled by whoever
called `swtch`, if they mattered. That's why a `context` is tiny:

```go
// proc.go — exactly the registers swtch saves/restores
type context struct {
	ra            uint64
	sp            uint64
	s0, s1, s2, s3, s4, s5 uint64
	s6, s7, s8, s9, s10, s11 uint64
}

// swtch saves the current registers into old and loads them from new.
// Implemented in switch.s.
func swtch(old, new *context)
```

The assembly is mechanical — store 14 registers, load 14 registers, `ret`:

```asm
# switch.s
.globl swtch
swtch:
        sd ra,  0(a0)        # save current context into *old (a0)
        sd sp,  8(a0)
        sd s0, 16(a0)
        # … s1 … s11 …
        ld ra,  0(a1)        # load new context from *new (a1)
        ld sp,  8(a1)
        ld s0, 16(a1)
        # … s1 … s11 …
        ret                  # returns into the *new* thread
```

The magic is the last `ret`. We saved A's `ra` and loaded B's, so `ret` jumps to
wherever *B* last called `swtch` from. The stack pointer was swapped too, so B is
now running on B's stack. A single function call enters as A and returns as B.
There are no threads in the language sense here — just register sets we trade by
hand.

---

## 10.3 The scheduler loop

Each CPU runs `scheduler` forever. It scans the process table for a `RUNNABLE`
process, switches to it, and — when that process eventually switches back —
resumes scanning:

```go
// proc.go
func scheduler() {
	c := mycpu()
	c.proc = nil
	for {
		intrOn() // ensure devices can wake processes; avoids missed-wakeup deadlock
		for i := range procs {
			p := &procs[i]
			acquire(&p.lock)
			if p.state == RUNNABLE {
				p.state = RUNNING
				c.proc = p
				swtch(&c.context, &p.context) // run the process

				// control returns here when the process yields back
				c.proc = nil
			}
			release(&p.lock)
		}
	}
}
```

Each CPU has its *own* scheduler context (`c.context`). Switching to a process
means `swtch(&c.context, &p.context)`; the process later switches back with
`swtch(&p.context, &c.context)`. The CPU bounces between its scheduler and
whatever process it's running, never holding more than `p.lock`.

---

## 10.4 Yielding and `sched`

A process gives up the CPU by calling `yield`, which marks it `RUNNABLE` and
switches back to the scheduler via `sched`:

```go
// proc.go
func yield() {
	p := myproc()
	acquire(&p.lock)
	p.state = RUNNABLE
	sched()
	release(&p.lock)
}

func sched() {
	p := myproc()
	if !holding(&p.lock) { panic("sched p->lock") }
	if mycpu().noff != 1 { panic("sched locks") } // exactly p.lock held
	if p.state == RUNNING { panic("sched running") }
	if intrGet() { panic("sched interruptible") }

	intena := mycpu().intena
	swtch(&p.context, &mycpu().context) // back to the scheduler loop
	mycpu().intena = intena
}
```

The careful invariants in `sched` — exactly one lock held, interrupts off — are
because we're switching stacks *while holding `p.lock`*. The lock is acquired by
one party (the process) and released by another (the scheduler), bridging the
switch. This split acquire/release across `swtch` is the trickiest handoff in the
kernel; the assertions catch the bugs.

**Preemption** comes from the timer: a timer interrupt (Chapter 7) calls `yield`,
so a CPU-bound process is forced back to the scheduler every tick. That's what
makes the multitasking *preemptive* rather than cooperative.

A brand-new process (from `fork`, Chapter 11) has a hand-built context whose `ra`
points at `forkret`, so its first `swtch` "returns" into `forkret`, which finishes
setup and drops to user space via the trap-return path (Chapter 7).

---

## 10.5 `sleep` and `wakeup`

Most blocking in the kernel — waiting for a disk block, a pipe byte, a child to
exit — uses one elegant mechanism: **sleep on a channel, wake everyone on that
channel.** A "channel" is just an address used as a name; no allocation, no queue.

```go
// proc.go
func sleep(chan_ unsafe.Pointer, lk *spinlock) {
	p := myproc()
	// Atomically release lk and go to sleep, holding p.lock.
	acquire(&p.lock)
	release(lk)

	p.chan_ = chan_
	p.state = SLEEPING
	sched() // switch away until woken

	// woken: reacquire the original lock and carry on
	p.chan_ = nil
	release(&p.lock)
	acquire(lk)
}

func wakeup(chan_ unsafe.Pointer) {
	for i := range procs {
		p := &procs[i]
		if p != myproc() {
			acquire(&p.lock)
			if p.state == SLEEPING && p.chan_ == chan_ {
				p.state = RUNNABLE
			}
			release(&p.lock)
		}
	}
}
```

The dance with `lk` and `p.lock` solves the **lost-wakeup problem**. Imagine a
process checks "is the buffer ready?", sees no, and is about to sleep — but
between the check and the sleep, the disk interrupt fires and calls `wakeup`. If
the timing were naive, the wakeup would find nobody sleeping yet, and the process
would sleep forever. By holding `p.lock` from before releasing `lk` until after
the state is `SLEEPING`, and by having `wakeup` take `p.lock`, we make the
check-then-sleep atomic with respect to the wakeup. Callers always use it in a
loop:

```go
for !condition {
	sleep(&chan, &lk) // recheck after waking; wakeups can be spurious
}
```

Every blocking primitive in later chapters — sleep locks (Chapter 9), pipes,
`wait`, disk I/O — is just this pattern with a different channel.

---

## 10.6 Why not goroutines?

It's tempting to map each kernel process to a goroutine and let Go's scheduler do
this work. We deliberately don't, for reasons that are worth stating plainly:

- **We need to control *when and where* a switch happens.** The kernel switches at
  precise points (a timer tick, a blocking syscall) and must hold a specific lock
  across the switch. Go's scheduler switches goroutines at its own discretion,
  which we cannot tolerate inside critical sections.
- **A process switch involves the address space (`satp`), the trapframe, and the
  kernel stack** — concepts Go's runtime knows nothing about. A goroutine switch
  doesn't change page tables.
- **There is no Go scheduler here** (`scheduler: none`, Chapter 2). The whole
  point is that *we are the scheduler*. Goroutines would need the runtime we
  deliberately removed.

So our "threads" are register sets we swap with `swtch`, scheduled by code we
wrote, switched at points we chose. This is more work than `go func()` — and it's
exactly the work an operating system exists to do.

---

## 10.7 What you should take away

- A process is a table entry with a **state**; the scheduler shuffles processes
  among `RUNNABLE`/`RUNNING`/`SLEEPING`/`ZOMBIE`.
- The **context switch** saves and restores only the callee-saved registers; the
  trailing `ret` is what makes one call enter as A and leave as B.
- Each CPU bounces between its **scheduler context** and a process; `yield`/`sched`
  hand control back, with `p.lock` held *across* the switch.
- **Preemption** is a timer interrupt calling `yield`.
- **`sleep`/`wakeup`** on an address-as-channel is the universal blocking
  primitive; holding `p.lock` across the release-and-sleep defeats the
  lost-wakeup race; always sleep in a loop.
- Processes are **not goroutines** — we control switch timing, page tables, and
  stacks ourselves, because there is no runtime to do it for us.

---

## Exercises

1. **One call, two threads.** Explain, register by register, how a single
   `swtch(&a, &b)` causes the CPU to start executing `b`'s code on `b`'s stack.
   Where does the `ret` go?

2. **Lost wakeup.** Remove the `p.lock` handling from `sleep` (just set
   `SLEEPING` and call `sched`). Construct the interleaving with a disk interrupt
   that makes a process sleep forever.

3. **Why a loop?** Give a concrete reason a process woken from `sleep` might find
   its condition *still* false, justifying `for !cond { sleep(...) }` instead of
   `if`.

4. **Held across the switch.** `yield` acquires `p.lock`, calls `sched` (which
   `swtch`es away), and the *scheduler* releases `p.lock`. Why must the lock be
   held across the switch rather than released before it?

5. **Goroutine thought experiment.** Suppose you tried to implement a process as a
   goroutine. Name two specific things (from §10.6) that would break the first
   time a timer interrupt tried to preempt a process mid-critical-section.

---

*Next: **Chapter 11 — `fork`, `wait`, `exit`, and `kill`**, where these
scheduling primitives become the process lifecycle: creating children, reaping
zombies, and the parent/child relationships that structure a running system.*
