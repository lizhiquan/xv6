# Chapter 7 — Traps, Interrupts, and System Calls

> This is the doorway. Every system call, every timer tick, every device
> interrupt enters the kernel through one carefully choreographed path. We build
> the trampoline that crosses the user/kernel page-table boundary, the trapframe
> that saves a process's registers, the C-level handlers, and the system-call
> dispatch table. After this chapter, a user program can ask the kernel to do
> something and get an answer back.
>
> Milestone: a user program executes `ecall`, the kernel dispatches a system call,
> and control returns to the program with a result.

---

## 7.1 One mechanism, three triggers

Three different events all funnel into the same hardware mechanism:

- A **system call** — the program runs `ecall` to deliberately ask the kernel.
- An **exception** — the program did something illegal (bad address, illegal
  instruction).
- An **interrupt** — a device (timer, UART, disk) needs attention.

All three are *traps*. When one occurs in user mode, the hardware (Chapter 1,
§1.5): saves the PC into `sepc`, records the cause in `scause`, switches to
supervisor mode, and jumps to the address in `stvec`. The kernel handles it and
eventually executes `sret` to resume. Our job is to set `stvec` and write the
code it points at.

The hard part is unique to having separate address spaces: when the trap fires,
`satp` still points at the *user* page table, which doesn't map the kernel. We
need to switch page tables — but the code doing the switch must stay mapped
across it. That's what the trampoline solves.

---

## 7.2 The trapframe

Before the kernel can do anything, it must save the user's 32 registers somewhere
— it's about to clobber them. They go into the **trapframe**, a per-process page
mapped at a fixed virtual address (`TRAPFRAME`, just below the trampoline). It
also pre-stores a few things the trap entry code needs:

```go
// proc.go — laid out to match the assembly offsets in trampoline.s
type trapframe struct {
	kernelSatp   uint64 //   0: kernel page table (for the switch)
	kernelSp     uint64 //   8: top of this process's kernel stack
	kernelTrap   uint64 //  16: address of usertrap()
	epc          uint64 //  24: saved user program counter
	kernelHartid uint64 //  32: saved tp (cpu id)
	ra           uint64 //  40
	sp           uint64 //  48
	// … gp, tp, t0–t6, a0–a7, s0–s11 … all 32 user registers …
}
```

The first five fields are *filled in by the kernel before returning to user space*
so that the trap-entry code — which runs with almost no registers available — can
find the kernel page table, a stack, and the handler's address. The rest are
where the user's registers land on the way in.

---

## 7.3 The trampoline (assembly)

The trampoline is one page of hand-written assembly, mapped at the same virtual
address (`TRAMPOLINE`) in *every* address space, kernel and user alike. Because
it lives at the same place everywhere, the CPU can keep fetching its instructions
even as `satp` changes underneath it. It has two halves.

**`uservec`** runs on trap entry, still on the user page table:

```asm
# trampoline.s (sketch) — entered via stvec when a trap hits in user mode
uservec:
        # swap a0 and the sscratch CSR; sscratch holds TRAPFRAME
        csrrw a0, sscratch, a0
        # a0 now points at the trapframe; save every user register into it
        sd ra,  40(a0)
        sd sp,  48(a0)
        # … save gp, tp, t0–t6, a1–a7, s0–s11 …
        # (a0 itself was saved from sscratch a moment later)

        # load the values the kernel pre-stored for us
        ld sp,  8(a0)          # kernel stack
        ld tp,  32(a0)         # cpu id
        ld t1,  16(a0)         # usertrap address
        ld t0,  0(a0)          # kernel page table
        sfence.vma zero, zero
        csrw satp, t0          # switch to the kernel page table
        sfence.vma zero, zero
        jr t1                  # jump into usertrap() (Go)
```

**`userret`** runs on the way back out, reversing the dance: switch to the user
page table, restore every register from the trapframe, and `sret`.

The choreography of §7.1's hard problem lives in those `csrw satp` lines: the
trampoline is mapped in both tables at the same address, so the instruction after
the switch is still there to execute.

We point `stvec` at `uservec` (offset into the trampoline page) whenever a process
is running, and at `kernelvec` while the kernel runs.

---

## 7.4 `usertrap`: handling a trap from user space

Once `uservec` has switched page tables and jumped, we're in ordinary Go on a
kernel stack. `usertrap` decides what happened and acts:

```go
// trap.go
func usertrap() {
	if r_sstatus()&sstatusSPP != 0 {
		panic("usertrap: not from user mode")
	}
	// While in the kernel, traps go to kerneltrap(), not back here.
	w_stvec(uintptr(unsafe.Pointer(kernelvecPC())))

	p := myproc()
	p.trapframe.epc = r_sepc() // remember where to resume

	switch {
	case r_scause() == 8: // environment call from user (a system call)
		p.trapframe.epc += 4 // step past the ecall instruction
		intrOn()             // syscalls run with interrupts enabled
		syscall()
	default:
		which := devintr() // was it a device/timer interrupt?
		if which == 0 {
			// genuine fault: kill the offending process
			printk("usertrap: scause %p pid=%d\n", uintptr(r_scause()), p.pid)
			setkilled(p)
		}
		if which == 2 { // timer interrupt
			yield() // give up the CPU (Chapter 10)
		}
	}

	if killed(p) {
		exit(-1)
	}
	usertrapret()
}
```

Three cases, in priority order: a **system call** (`scause == 8`) bumps the saved
PC past the 4-byte `ecall` and dispatches; a recognized **device interrupt** is
handled (and a timer tick triggers a reschedule, Chapter 10); anything else is a
**fault**, and the process is killed. Notice the PC adjustment — without it,
`sret` would re-execute `ecall` forever.

---

## 7.5 `usertrapret`: going back

Returning to user space is the reverse setup. The kernel fills in the trapframe's
"how to get back in next time" fields, sets `stvec` back to the trampoline, arms
`sstatus`/`sepc` for a return to user mode, then jumps to `userret`:

```go
// trap.go
func usertrapret() {
	intrOff() // we're about to switch stvec to the user vector

	p := myproc()
	p.trapframe.kernelSatp = r_satp()
	p.trapframe.kernelSp = p.kstack + PGSIZE
	p.trapframe.kernelTrap = uintptr(unsafe.Pointer(usertrapPC()))
	p.trapframe.kernelHartid = r_tp()

	// set sstatus: previous mode = User, enable interrupts after sret
	x := r_sstatus()
	x &^= sstatusSPP   // SPP = 0 -> return to user
	x |= sstatusSPIE   // enable interrupts in user mode
	w_sstatus(x)
	w_sepc(p.trapframe.epc)

	// switch stvec to the trampoline, then jump to userret with the
	// user page table.
	w_stvec(TRAMPOLINE + uservecOffset)
	userret(makeSATP(p.pagetable))
}
```

`sret` (inside `userret`) then drops to user mode at `sepc`, with the user's
registers restored — the program resumes exactly where it left off, none the
wiser that the kernel ran.

---

## 7.6 `kerneltrap`: traps while in the kernel

The kernel itself can take interrupts (a timer tick, a disk completion) while
running. These are simpler — no page-table switch, no trapframe — and go through
`kernelvec` (set in `stvec` during kernel execution) to `kerneltrap`:

```go
// trap.go
func kerneltrap() {
	sepc := r_sepc()
	sstatus := r_sstatus()
	if sstatus&sstatusSPP == 0 {
		panic("kerneltrap: not from supervisor mode")
	}
	if intrGet() {
		panic("kerneltrap: interrupts enabled")
	}
	which := devintr()
	if which == 0 {
		printk("scause %p sepc=%p\n", uintptr(r_scause()), uintptr(sepc))
		panic("kerneltrap")
	}
	if which == 2 && myproc() != nil {
		yield()
	}
	// restore CSRs that yield()/a nested trap may have clobbered
	w_sepc(sepc)
	w_sstatus(sstatus)
}
```

A device interrupt in the kernel is normal; an *exception* in the kernel is a bug,
so it panics. The careful save/restore of `sepc`/`sstatus` is because `yield`
might switch to another process and come back, and a nested trap would overwrite
these CSRs.

---

## 7.7 Device interrupts and the timer

`devintr` reads `scause` to classify the interrupt. The PLIC (Chapter 5 mapped it)
tells us which device fired; the timer is recognized directly:

```go
// trap.go
func devintr() int {
	scause := r_scause()
	switch {
	case isExternalInterrupt(scause): // a device, via the PLIC
		irq := plicClaim()
		switch irq {
		case UART0_IRQ:
			uartIntr()
		case VIRTIO0_IRQ:
			virtioDiskIntr()
		}
		if irq != 0 {
			plicComplete(irq) // tell the PLIC we handled it
		}
		return 1
	case isTimerInterrupt(scause):
		if cpuid() == 0 {
			clockIntr()
		}
		w_stimecmp(r_time() + 1_000_000) // schedule the next tick
		return 2
	default:
		return 0
	}
}
```

The timer is the kernel's heartbeat: every tick increments a global counter (used
by `uptime` and sleep) and, by returning `2`, nudges `usertrap`/`kerneltrap` to
`yield` — the preemption that powers the scheduler in Chapter 10.

---

## 7.8 The system-call dispatch table

When `usertrap` sees `scause == 8`, it calls `syscall`. The convention (Chapter 1,
§1.5): the syscall number is in register `a7`, arguments in `a0`–`a5`, and the
return value goes back in `a0`. Dispatch is a table indexed by number:

```go
// syscall.go
var syscalls = [...]func() uint64{
	SYS_fork:   sysFork,
	SYS_exit:   sysExit,
	SYS_wait:   sysWait,
	SYS_read:   sysRead,
	SYS_write:  sysWrite,
	SYS_exec:   sysExec,
	SYS_getpid: sysGetpid,
	// … one entry per syscall number in syscall.h …
}

func syscall() {
	p := myproc()
	num := p.trapframe.a7
	if num > 0 && int(num) < len(syscalls) && syscalls[num] != nil {
		p.trapframe.a0 = syscalls[num]() // result -> a0
	} else {
		printk("%d: unknown sys call %d\n", p.pid, num)
		p.trapframe.a0 = ^uint64(0) // -1
	}
}
```

Each `sysXxx` reads its arguments from the trapframe and returns a result. Because
arguments arrive as raw register values — and pointers among them are *user*
pointers — we need safe accessors:

```go
// syscall.go
func argint(n int) int { return int(argraw(n)) }          // nth integer arg
func argaddr(n int) uintptr { return uintptr(argraw(n)) }  // nth pointer arg (untrusted!)

// argstr copies a user string argument into a kernel buffer, safely.
func argstr(n int, buf []byte) int {
	addr := argaddr(n)
	return fetchstr(addr, buf) // uses copyinstr under the hood (Chapter 6)
}
```

`argint` is harmless — it's just a number. `argaddr` returns a *user* pointer the
kernel must never dereference directly; the syscall must pass it through
`copyin`/`copyout`/`copyinstr` from Chapter 6. This is exactly the boundary
discipline that makes the whole user/kernel split safe.

---

## 7.9 Putting the path together

Trace a `write(1, "hi", 2)` end to end:

```
user: ecall (a7=SYS_write, a0=1, a1=ptr, a2=2)
  → hardware: save pc→sepc, scause=8, jump to stvec (uservec)
  → uservec: save regs to trapframe, switch to kernel page table, jump usertrap
  → usertrap: scause==8, epc+=4, syscall()
  → syscall: a0 = syscalls[SYS_write]()  →  sysWrite reads args, copies bytes out
  → usertrapret: restore trapframe fields, jump userret
  → userret: switch to user page table, restore regs, sret
user: resumes after ecall, with the byte count in a0
```

Every layer we've built shows up: page tables (5, 6), the trapframe page (6), the
console for output (3). This single path is the spine of the whole OS.

---

## 7.10 What you should take away

- All traps — syscalls, exceptions, interrupts — share **one hardware mechanism**:
  `stvec`, `sepc`, `scause`, `sret`.
- The **trampoline**, mapped at the same address in every space, is what lets the
  kernel switch page tables mid-trap without losing its footing.
- The **trapframe** saves user registers and pre-stores what trap entry needs
  (kernel `satp`, stack, handler).
- `usertrap` classifies into **syscall / interrupt / fault**; a timer interrupt
  drives preemption (Chapter 10); a fault kills the process.
- Syscalls dispatch through a **table indexed by `a7`**, return in `a0`, and read
  arguments with accessors that respect the **user-pointer boundary**.

---

## Exercises

1. **Off-by-four.** What goes wrong if `usertrap` forgets `epc += 4` after a
   syscall? Trace the program's behavior after `sret`.

2. **Why two vectors?** Explain why `stvec` points at `uservec` while a process
   runs but `kernelvec` while the kernel runs. What disaster does §7.4's
   `w_stvec(kernelvec)` at the top of `usertrap` prevent?

3. **The trampoline's address.** Why must the trampoline be mapped at the *same*
   virtual address in the user and kernel page tables? Walk through the
   instruction right after `csrw satp` if it weren't.

4. **Untrusted pointer.** A `sysWrite` implementation does `for i := range buf {
   c := *(*byte)(unsafe.Pointer(userPtr + i)) }`. Why is this a serious bug even
   though it sometimes works? What should it do instead?

5. **Interrupts on during syscalls.** `usertrap` calls `intrOn()` before
   `syscall()` but `usertrapret` calls `intrOff()`. Explain why syscalls run with
   interrupts enabled but the return path disables them.

---

*Next: **Chapter 8 — The First Process and `exec`**, where we load an ELF binary
into a fresh address space, hand-craft the first process, and watch `init` come
to life.*
