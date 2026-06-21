# Chapter 11 — `fork`, `wait`, `exit`, and `kill`

> The scheduler from Chapter 10 can run processes; now we let processes *create
> and destroy each other*. `fork` clones a process, `exit` ends one, `wait` lets a
> parent collect a finished child, and `kill` asks a process to stop. Together
> with `exec` (Chapter 8) these are the entire Unix process model — and enough to
> run a shell.
>
> Milestone: `fork`/`exec`/`wait` working end to end.

---

## 11.1 The process lifecycle

A Unix process is born by `fork` (a copy of its parent), usually replaces itself
via `exec` (Chapter 8), runs, and ends with `exit`. Its parent calls `wait` to
learn it finished and to free its last resources. Mapped onto the states from
Chapter 10:

```
allocproc ─► USED ─► RUNNABLE ⇄ RUNNING ─► ZOMBIE ─► UNUSED
                          ▲   │              (exit)    (wait reaps it)
                          └───┘
                       (sleep/wakeup,
                        yield)
```

The `ZOMBIE` state is the subtle one: an exited process can't free *everything*
itself (it's still running on its kernel stack as it exits), and its exit status
must survive until the parent asks for it. So `exit` does most of the teardown but
leaves a husk; `wait` finishes the job.

---

## 11.2 `allocproc`: the common birth

Both `userInit` (Chapter 8) and `fork` start by grabbing a free table slot and
setting up the minimum a process needs to be scheduled:

```go
// proc.go
func allocproc() *proc {
	for i := range procs {
		p := &procs[i]
		acquire(&p.lock)
		if p.state == UNUSED {
			p.pid = allocPid()
			p.state = USED

			// A trapframe page (Chapter 7) and an empty user page table.
			p.trapframe = (*trapframe)(unsafe.Pointer(kalloc()))
			p.pagetable = procPagetable(p)

			// Set up the kernel context so the first swtch lands in forkret,
			// which returns to user space via the trap path.
			memclear(&p.context)
			p.context.ra = forkretPC()
			p.context.sp = p.kstack + PGSIZE
			return p // returned holding p.lock
		}
		release(&p.lock)
	}
	return nil // process table full
}
```

The trick from Chapter 10 reappears: a new process has never run, so it has no
saved context to return into. We fake one whose `ra` is `forkret`, so its first
`swtch` "returns" into setup code that then drops to user mode.

---

## 11.3 `fork`: cloning a process

`fork` creates a child that is a near-exact copy of the parent: same memory
contents (copied with `uvmCopy` from Chapter 6), same open files (with bumped
reference counts), same current directory. The one difference is the return
value, which is how a program tells parent from child:

```go
// proc.go
func fork() int {
	p := myproc()
	np := allocproc()
	if np == nil {
		return -1
	}

	// Copy the parent's address space into the child.
	if uvmCopy(p.pagetable, np.pagetable, p.sz) < 0 {
		freeproc(np)
		release(&np.lock)
		return -1
	}
	np.sz = p.sz

	// Copy the saved user registers, then make the child return 0.
	*np.trapframe = *p.trapframe
	np.trapframe.a0 = 0 // child sees fork() == 0

	// Duplicate open file descriptors and the cwd.
	for fd := range p.ofile {
		if p.ofile[fd] != nil {
			np.ofile[fd] = filedup(p.ofile[fd])
		}
	}
	np.cwd = idup(p.cwd)
	np.name = p.name
	pid := np.pid
	release(&np.lock)

	// Record the parent link under wait_lock (protects the family tree).
	acquire(&waitLock)
	np.parent = p
	release(&waitLock)

	// Make the child runnable.
	acquire(&np.lock)
	np.state = RUNNABLE
	release(&np.lock)

	return pid // parent sees the child's pid
}
```

The asymmetry in `a0` is the famous "`fork` returns twice": once in the parent
with the child's pid, once in the child with `0`. Both then continue from the same
instruction (the trap return restores `epc` identically) — the program branches on
the return value. Copied file descriptors share the underlying open file (Chapter
17), which is why a shell can set up pipes and redirection before `exec`.

---

## 11.4 `exit`: becoming a zombie

`exit` closes the process's files, gives up its directory, reparents any children
to `init`, records its status, becomes a `ZOMBIE`, wakes its parent, and switches
to the scheduler forever:

```go
// proc.go
func exit(status int) {
	p := myproc()
	if p == initproc {
		panic("init exiting")
	}

	for fd := range p.ofile { // close all open files
		if p.ofile[fd] != nil {
			fileclose(p.ofile[fd])
			p.ofile[fd] = nil
		}
	}
	iput(p.cwd) // release the current directory

	acquire(&waitLock)
	reparent(p)        // give p's children to init
	wakeup(unsafe.Pointer(p.parent)) // a parent may be waiting
	acquire(&p.lock)
	p.xstate = status
	p.state = ZOMBIE
	release(&waitLock)

	sched() // into the scheduler; never returns
	panic("zombie exit")
}
```

Two details matter. **Reparenting**: a process must not orphan its children, so
they're handed to `init`, which `wait`s in a loop and reaps anything that lands on
it. **The wakeup**: the parent might be blocked in `wait`; we wake it so it can
collect us. We can't free our own kernel stack or page table here — we're still
using them — so we stop at `ZOMBIE` and let the parent finish.

---

## 11.5 `wait`: reaping a child

`wait` scans for a `ZOMBIE` child; if it finds one, it copies out the exit status,
frees the child's remaining resources, and returns its pid. If there are children
but none have exited, it sleeps until one does:

```go
// proc.go
func wait(addr uintptr) int { // addr: user pointer for the status (may be 0)
	p := myproc()
	acquire(&waitLock)
	for {
		havekids := false
		for i := range procs {
			pp := &procs[i]
			if pp.parent == p {
				acquire(&pp.lock)
				havekids = true
				if pp.state == ZOMBIE {
					pid := pp.pid
					if addr != 0 &&
						copyout(p.pagetable, addr, ptrTo(&pp.xstate), 4) < 0 {
						release(&pp.lock)
						release(&waitLock)
						return -1
					}
					freeproc(pp) // finally free stack, trapframe, page table
					release(&pp.lock)
					release(&waitLock)
					return pid
				}
				release(&pp.lock)
			}
		}
		if !havekids || killed(p) {
			release(&waitLock)
			return -1
		}
		sleep(unsafe.Pointer(p), &waitLock) // wait for a child to exit
	}
}
```

This is the matching half of `exit`'s zombie: `exit` leaves the husk and signals;
`wait` does the final `freeproc`. The `sleep`/`wakeup` channel is the parent's own
address `p` — `exit` woke `p.parent`, and here the parent sleeps on itself. The
`waitLock` serializes the whole family-tree manipulation so a child can't exit
"between" the parent's scan and its sleep (the lost-wakeup discipline from Chapter
10).

---

## 11.6 `kill`: asking a process to die

You can't safely yank a process out of existence from outside — it might be deep
in the kernel holding locks. So `kill` is *cooperative*: it sets a flag, and the
target checks that flag at safe points (on the way out of a trap, Chapter 7) and
exits itself:

```go
// proc.go
func kill(pid int) int {
	for i := range procs {
		p := &procs[i]
		acquire(&p.lock)
		if p.pid == pid {
			p.killed = true
			if p.state == SLEEPING {
				p.state = RUNNABLE // wake it so it can notice and exit
			}
			release(&p.lock)
			return 0
		}
		release(&p.lock)
	}
	return -1
}
```

If the victim is sleeping, we make it `RUNNABLE` so it runs, returns toward user
space, sees `killed`, and calls `exit` (recall `usertrap` checks `killed(p)` in
Chapter 7). A process never dies in the middle of a critical section — only at a
point where it's safe to. This cooperative model is why a `kill` on a process
stuck in an uninterruptible wait doesn't take effect until that wait ends.

---

## 11.7 The whole model, running

With these four calls plus `exec`, the shell's core loop works:

```
sh: read a command line
    pid = fork()
    if pid == 0:           # child
        exec("/bin/ls", argv)   # becomes ls
    else:                  # parent (the shell)
        wait(&status)           # block until ls finishes
    # loop for the next command
```

`fork` duplicates the shell; the child `exec`s the program; the parent `wait`s.
Every command you run is this dance. We build the shell itself in Chapter 19, but
the machinery it stands on is complete right here.

---

## 11.8 What you should take away

- The lifecycle is `allocproc → RUNNABLE/RUNNING → ZOMBIE → (wait) → UNUSED`; a
  new process fakes a context whose first `swtch` lands in `forkret`.
- `fork` copies memory (`uvmCopy`), file descriptors, and cwd; it **returns twice**
  — child gets `0`, parent gets the child's pid — via a tweaked trapframe `a0`.
- `exit` tears down most state but stops at **`ZOMBIE`**, reparents children to
  `init`, and wakes the parent; it can't free its own stack/page table.
- `wait` finds a zombie child, copies out the status, and does the **final
  `freeproc`**; with no exited child it sleeps on its own address.
- `kill` is **cooperative**: it sets a flag (and wakes a sleeper); the target exits
  itself at the next safe point.

---

## Exercises

1. **Two return values.** Explain exactly how one `fork` call produces a `0` in
   the child and a pid in the parent, tracing `np.trapframe.a0` and the shared
   `epc`.

2. **Orphans.** Comment out `reparent` in `exit`. What happens to a child whose
   parent exits first? Why does handing it to `init` (which `wait`s forever) fix
   it?

3. **Zombie necessity.** Why can't `exit` just free everything and set the slot to
   `UNUSED`? Name two resources it's still using at the moment it runs.

4. **The wait race.** Without `waitLock`, describe an interleaving where a parent
   in `wait` sleeps *after* its only child has already become a zombie and called
   `wakeup`. How does holding `waitLock` across the scan-and-sleep prevent it?

5. **Uninterruptible kill.** A process is blocked in `sleep` waiting for a disk
   read that will never complete. You `kill` it. When (if ever) does it actually
   die? What does this say about the limits of cooperative `kill`?

---

*Next: **Chapter 12 — The Disk Driver**, which opens Part IV. We leave processes
behind and start building persistent storage from the bottom: the virtio block
device, and the challenge of DMA in a garbage-collected language.*
