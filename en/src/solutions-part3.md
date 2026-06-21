# Solutions — Part III (Processes, Traps, and Concurrency)

> Answers to the exercises in Chapters 7–11.

---

## Chapter 7 — Traps, Interrupts, and System Calls

**1. Off-by-four.** Without `epc += 4`, the saved PC still points at the `ecall`
instruction. After `sret`, the program re-executes `ecall`, traps again,
re-executes it… an infinite syscall loop. The `+4` steps past the (4-byte) `ecall`
so the program resumes at the instruction after it.

**2. Why two vectors.** `stvec` points at `uservec` while a process runs so a trap
from user mode lands in the trampoline (which saves user state and switches page
tables). While the kernel runs it points at `kernelvec`, which assumes the kernel
page table and stack. The `w_stvec(kernelvec)` at the top of `usertrap` prevents
the disaster of a kernel-mode trap (e.g. a timer interrupt) being dispatched
through `uservec`, which would try to switch page tables and re-save state that's
already kernel state — corruption.

**3. The trampoline's address.** It must be at the same virtual address in both
tables because the `csrw satp` that switches tables is *in the trampoline*; the
very next instruction is fetched via the new table. If the trampoline weren't
mapped at that same address in the new table, the post-switch fetch would land on
unmapped memory and fault.

**4. Untrusted pointer.** Dereferencing `userPtr` directly is a bug because the
user virtual address isn't valid in the kernel page table (wrong or unmapped), and
a malicious process can point it at kernel memory. It "sometimes works" only when
the address happens to be benign. It should use `copyin` (Chapter 6), which
translates through the process's page table and checks permissions/bounds.

**5. Interrupts during syscalls.** Syscalls can be long (disk I/O), so running
them with interrupts **on** keeps the system responsive and lets device
completions wake sleepers. The return path disables interrupts before switching
`stvec` back to `uservec` and arming the trapframe, because that window must be
atomic — an interrupt mid-switch could trap through the wrong vector or with
half-set state.

---

## Chapter 8 — The First Process and `exec`

**1. Magic number.** Checking `elf.magic` first rejects non-ELF/corrupt files
before trusting any other header field. Without it, a crafted file with a huge
`phnum` or wild `phoff`/`vaddr` could make `exec` read arbitrary offsets, map
absurd ranges, or loop — a parsing exploit. The magic check is the cheap gate.

**2. bss.** `exec` reads only the **4 KB** of initialized data from disk
(`filesz`). The 1 MB zeroed array (`memsz − filesz`) is never read; `uvmAlloc`
allocates zeroed pages for the whole `memsz`, so the `.bss` is zero-filled for
free.

**3. The swap ordering.** `exec` builds the entire new address space first so that
any failure (bad ELF, OOM) can return −1 with the **old** program intact. If it
swapped `p.pagetable` first and a later segment load failed, the process would be
left running a half-built address space with no clean way back — corruption or a
crash in a process that asked for nothing wrong.

**4. Alignment.** With args `"ls"` and `"-l"`: push `"-l\0"` (3 bytes), then
align `sp` down to a multiple of 16; push `"ls\0"` (3 bytes), align again; then
push the `argv` pointer array (`(argc+1)*8` bytes) and align. Each `sp -= sp % 16`
ensures every `copyout` target is 16-byte aligned, as RISC-V requires.

**5. Chicken and egg.** At `userInit` time there is no process to *call* `kexec`
from, and `kexec` runs in the context of a process (it uses `myproc()`, the file
system, traps). initcode is a tiny user program the kernel can drop into a fresh
address space and "return" to; once running as a real user process, it can issue
the first `exec("/init")` through the normal trap path. A direct call can't,
because the machinery `kexec` relies on isn't reachable from bare `userInit`.

---

## Chapter 9 — Locking and Multicore

**1. The lost page.** CPU A reads `r = freelist` (page X); before A writes
`freelist = r.next`, CPU B reads `r = freelist` (also X) and writes
`freelist = X.next`; A then also writes `freelist = X.next`. Both return X. The
race window is between the read of `freelist` and its update — a non-atomic
read-modify-write.

**2. Why disable interrupts in `acquire`.** Self-deadlock: a CPU holds `kmem.lock`;
a timer interrupt fires on that CPU; the handler calls `kalloc` → `acquire(kmem.lock)`,
which spins forever because the holder (now paused in the handler) can't release.
It would **not** appear on a single core *if* the lock holder never enabled
interrupts — it's specifically the interrupt-while-holding case. Disabling
interrupts in `acquire` closes it.

**3. Nesting.** Acquire A: `noff 0→1`, save `intena` = (interrupts were on),
interrupts off. Acquire B: `noff 1→2`. Release B: `noff 2→1`, interrupts stay off.
Release A: `noff 1→0`, and because `intena` was set, interrupts turn **back on**.
It must be the outermost release, because re-enabling earlier would let an
interrupt run while lock A is still held — the deadlock case again.

**4. Spin vs. sleep.** (a) page allocator → **spinlock** (held briefly,
interrupt-sensitive). (b) inode read from disk → **sleep lock** (held across I/O).
(c) console output lock → **spinlock** (short, and used from interrupt context).
(d) pipe buffer with a blocked reader → **sleep lock**/`sleep`-`wakeup` (the reader
must yield the CPU).

**5. Missing barrier.** With a plain (non-`.aq`) swap, the CPU could reorder a load
of the protected data to *before* the lock is actually acquired, so process X
reads the structure while Y is still mid-write — a torn read, even though both
"use the lock." The `.aq` barrier forbids that reordering, fencing the critical
section's accesses after the acquire.

---

## Chapter 10 — Scheduling and Context Switching

**1. One call, two threads.** `swtch(&a, &b)` stores A's `ra`/`sp`/`s*` into `*a`,
then loads B's into the registers and `ret`s. Because `ra` now holds *B's* saved
return address and `sp` holds B's stack, `ret` jumps to wherever B last called
`swtch` from, running on B's stack. The call entered as A and the `ret` emerged as
B.

**2. Lost wakeup.** If `sleep` just set `SLEEPING` and called `sched` without
holding `p.lock`: process checks "buffer ready?" → no; disk interrupt fires and
`wakeup` runs, finds the process not yet `SLEEPING`, does nothing; the process then
sets `SLEEPING` and sleeps forever. Holding `p.lock` across the condition's release
and the state change, with `wakeup` also taking `p.lock`, makes check-and-sleep
atomic w.r.t. the wakeup.

**3. Why a loop?** A wakeup wakes *all* sleepers on a channel, but maybe only one
can proceed (e.g. one byte arrived, two readers wake); or the condition changed
again before the woken process ran. So it must re-check: `for !cond { sleep(...) }`,
not `if`.

**4. Held across the switch.** `yield` holds `p.lock`, `sched` switches stacks to
the scheduler, and the scheduler releases `p.lock`. The lock must stay held across
the switch so that no other CPU sees the process as `RUNNABLE` and tries to run it
*while it's still executing* `swtch` on the old stack — which would run one process
on two CPUs. The lock is released only once the scheduler is safely off that stack.

**5. Goroutine thought experiment.** Two breakages: (a) a timer preemption mid-
critical-section would have the Go scheduler switch goroutines at a point we don't
control, possibly while a spinlock is held with interrupts off — deadlock or
corruption; (b) a process switch must change `satp`, the trapframe, and the kernel
stack, none of which a goroutine switch does, so the "process" would resume with
the wrong address space.

---

## Chapter 11 — `fork`, `wait`, `exit`, and `kill`

**1. Two return values.** `fork` copies the parent's trapframe into the child,
then sets `np.trapframe.a0 = 0`. Both processes return from the trap restoring
`a0` from their own trapframe: parent's `a0` holds the child's pid (the syscall's
return), child's holds 0. Both resume at the same `epc` (the instruction after
`ecall`), so they continue from the same line but branch on the value in `a0`.

**2. Orphans.** Without `reparent`, a child whose parent exits has a dangling
`parent` pointer; when it exits it would `wakeup` a freed/garbage parent, and no
one ever `wait`s for it → it stays a zombie forever (leak). Handing it to `init`,
which `wait`s in a loop, ensures someone reaps it.

**3. Zombie necessity.** `exit` can't free everything because it's still using its
**kernel stack** (it's running on it) and its **page table** (`satp` still points
at it) at the moment it runs; it also must preserve its **exit status** for the
parent. So it stops at `ZOMBIE` and lets `wait` (running in the parent, on the
parent's stack) do the final `freeproc`.

**4. The wait race.** Without `waitLock`: parent scans, sees its child not yet a
zombie; meanwhile the child `exit`s, becomes a zombie, and `wakeup`s the parent —
but the parent isn't sleeping yet; the parent then sleeps and misses the wakeup,
blocking forever. Holding `waitLock` across the scan-and-sleep (and having `exit`
take it before waking) makes the two atomic — the lost-wakeup pattern again.

**5. Uninterruptible kill.** A process blocked in a `sleep` that will never wake
(disk read that never completes) doesn't die when `kill`ed — `kill` sets the flag
and marks it `RUNNABLE`, but it only checks `killed` *after* the sleep returns,
which never happens. This shows cooperative `kill` can't terminate a process stuck
in an uninterruptible wait; real systems mitigate with interruptible sleeps and
timeouts.

---

*Next: [Solutions — Part IV](solutions-part4.md).*
