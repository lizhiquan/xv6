# Solutions — Part I (Foundations)

> Answers to the exercises in Chapters 1–3. Try them yourself first; these are for
> checking your reasoning, and several have more than one defensible answer.

---

## Chapter 1 — What an Operating System Does

**1. The three jobs.**
(a) **Page tables → isolation** (each process can't name another's memory) and
**multiplexing** (many spaces share one RAM). (b) **Timer interrupt →
multiplexing** — it lets the kernel take a CPU back and share it. (c) **`read`/
`write` → abstraction** — uniform calls hiding device and file-system detail.
(d) **User can't disable interrupts → isolation/multiplexing** — a process can't
monopolize a CPU by shutting out the scheduler's timer.

**2. The fake return.** A direct "enter user mode" jump would let any code drop
its own privilege *at an address of its choosing* — but the dangerous direction is
the other way, and allowing arbitrary mode changes blurs the one controlled
boundary. RISC-V instead makes the *only* way to change modes a trap (raising
privilege) or a trap-return (lowering it), so privilege changes always pass
through a single, kernel-controlled mechanism. If hardware let you jump straight
into a higher-privileged mode, user code could simply jump into the kernel —
isolation would be gone.

**3. Memory-mapped I/O.** Store the byte to **`0x10000000`** (UART0's THR). A
user-mode store there would **fault** (trap into the kernel): the device pages are
mapped without the `U` permission bit, so user code can't reach them. This serves
**isolation** — a process can't drive hardware directly behind the kernel's back.

**4. Caller vs. callee saved.** `swtch` saves **`ra`, `sp`, and `s0`–`s11`** (14
registers). It needn't save `a0`–`a7` or `t0`–`t6` because those are
*caller-saved*: by the calling convention, whoever called `swtch` already
preserved any temporaries it still needed, so they're dead across the call.

**5. The Go tax.** Example: the **garbage collector** first bites at boot — the
moment any code allocates (or the runtime tries to start its background collector)
before we've disabled it, there's no managed heap and no OS to back it, so it
faults. That's exactly why Chapter 2 sets `gc: none` before `main` runs.

---

## Chapter 2 — From Power-On to `main`

**1. Stack arithmetic.** With `STACKSIZE = 4096`: hart 0 gets `sp = stack0 + 1*4096`
(top of bytes `[0,4096)`); hart 2 gets `sp = stack0 + 3*4096`. We use `(hartid+1)`
because the stack grows **downward**, so `sp` must start at the *top* of this
hart's slice, not its base — `hartid*STACKSIZE` would point at the bottom and
immediately collide with the slice below.

**2. Remove PMP.** Without the PMP setup, S-mode is denied access to physical
memory by default. The first memory access after `mret` drops to S-mode — fetching
`main`'s instructions — faults, so the kernel dies **before** `printk` ever runs.
You'd see no output at all (or a QEMU access-fault log with `-d`).

**3. Count the harts.** Making every hart print produces interleaved/garbled lines
because `printk`/`uartPutcSync` is not synchronized — bytes from different harts
mix in the UART. The fix is the **console lock (real locks in Chapter 9)**; until
then we print only from hart 0.

**4. The mret trick → User.** If `mstatus.MPP` is set to User, `mret` drops to
**user mode**, and `main`'s first UART store hits device memory that user mode
isn't allowed to touch → a fault. This illustrates **isolation**: the hardware
enforces that only supervisor (or higher) code reaches device registers.

**5. Bytes on the wire.** Dropping the `lsrTHRE` spin usually still *appears* to
work under QEMU, because the emulated UART accepts bytes instantly. On real
hardware it would **drop or corrupt** output: writing THR before the previous byte
has been shifted out overwrites it. The spin loop protects against **writing
faster than the UART can transmit**.

---

## Chapter 3 — Talking to Hardware: the Console

**1. Width and padding (`%5d`).** You must parse the digits between `%` and the
conversion into a **field width**, format the number into a temporary buffer,
compute how many pad characters are needed (`width - len`), and emit the padding
(spaces) before the digits. State carried across: the accumulating width integer.

**2. `%u` and `%l`.** `printInt` takes a Go `int` and, for `%x`, casts through
`uint(v)`. A value with the top bit set (a large unsigned, or a negative reused as
unsigned) is misread because the *signed* path and the 32-vs-64-bit width aren't
distinguished. `%u` needs an unsigned parameter and no sign handling; `%l` needs
the full 64-bit width so high bits aren't truncated.

**3. Why spin, not sleep, in `printk`.** (a) Inside an **interrupt handler** there
may be no process context to sleep, and sleeping could deadlock the very path that
would wake it. (b) During a **panic**, the scheduler/locks may be untrustworthy,
so `printk` must produce output without depending on them. Spinning is wasteful
but always safe.

**4. Echo policy.** A password prompt should **not** echo. You'd add a "no-echo"
flag consulted in the input/line-discipline path (§3.5) where characters are
normally echoed, suppressing the echo write. This serves **isolation/abstraction**
of the user's secret — the kernel mediates what's shown.

**5. Interleaving.** With the lock stubbed out, two harts printing `"abc\n"` can
interleave at any byte boundary: `aabcbc\n\n`, `abacbc...`, etc. — any byte-level
shuffle is possible. Once the lock is real, each `printk` call's bytes appear
**contiguously**; you can still get `abc\nabc\n` in either order, but never a
*within-call* interleave.

---

*Next: [Solutions — Part II](solutions-part2.md).*
