# Appendix A — RISC-V Reference

> A compact reference for the RISC-V features the kernel uses. Keep it open while
> reading Chapters 2, 5, and 7. This is not the full privileged spec — it's the
> subset that appears in the book.

---

## A.1 Registers and the calling convention

The 32 integer registers, by role:

| Register | ABI name | Role | Saved by |
|----------|----------|------|----------|
| x0 | `zero` | hardwired zero | — |
| x1 | `ra` | return address | caller |
| x2 | `sp` | stack pointer | callee |
| x3 | `gp` | global pointer | — |
| x4 | `tp` | thread pointer (we use it for CPU id) | — |
| x5–x7 | `t0`–`t2` | temporaries | caller |
| x8 | `s0`/`fp` | saved / frame pointer | callee |
| x9 | `s1` | saved | callee |
| x10–x11 | `a0`–`a1` | args / return values | caller |
| x12–x17 | `a2`–`a7` | args (`a7` = syscall number) | caller |
| x18–x27 | `s2`–`s11` | saved | callee |
| x28–x31 | `t3`–`t6` | temporaries | caller |

**Why it matters:** `swtch` (Chapter 10) saves only the callee-saved set (`ra`,
`sp`, `s0`–`s11`) — 14 registers — because the caller already preserved the rest.

---

## A.2 Privilege modes

| Mode | Encoding | Used for |
|------|----------|----------|
| Machine (M) | 3 | earliest boot, firmware (Chapter 2's `start`) |
| Supervisor (S) | 1 | the kernel |
| User (U) | 0 | application programs |

Transitions: `mret` (M→lower), `sret` (S→lower), and traps (lower→higher). There
is no instruction to *enter* a lower mode except by "returning" from a trap
(Chapter 1, §1.5).

---

## A.3 CSRs used in the book

Machine-mode (set up once in `start`, Chapter 2):

| CSR | Purpose |
|-----|---------|
| `mstatus` | status; `MPP` field selects the mode `mret` returns to |
| `mepc` | address `mret` jumps to |
| `medeleg` / `mideleg` | delegate exceptions / interrupts to S-mode |
| `mhartid` | this CPU's id (M-mode only) |
| `pmpaddr0` / `pmpcfg0` | physical memory protection (open all to S-mode) |
| `menvcfg` / `mcounteren` / `stimecmp` | enable the Sstc timer (Chapter 2) |

Supervisor-mode (used throughout):

| CSR | Purpose | Chapter |
|-----|---------|---------|
| `sstatus` | status; `SPP` = previous mode, `SIE` = interrupt enable | 7, 9 |
| `stvec` | trap handler address | 7 |
| `sepc` | saved PC on a trap | 7 |
| `scause` | trap cause (8 = ecall from user; high bit = interrupt) | 7 |
| `stval` | faulting address/value | 7 |
| `satp` | active page table + mode (Sv39) | 5 |
| `sie` / `sip` | interrupt enable / pending | 7, 9 |
| `sscratch` | scratch for trap entry (holds TRAPFRAME) | 7 |

CSRs are read/written with `csrr`/`csrw`; in Go we wrap each in a one-line asm
stub (Chapter 2, §2.5).

---

## A.4 `scause` values we handle

| `scause` | Meaning | Handled in |
|----------|---------|------------|
| 8 | environment call from U-mode (a syscall) | `usertrap` |
| high bit set, code 5 | supervisor timer interrupt | `devintr` |
| high bit set, code 9 | supervisor external interrupt (PLIC) | `devintr` |
| other (faults) | illegal instruction, page fault, … | kill process / panic |

---

## A.5 Instructions worth knowing

| Instruction | Effect |
|-------------|--------|
| `ecall` | trap into the next-higher mode (the syscall doorway) |
| `mret` / `sret` | return from trap, dropping privilege |
| `csrr` / `csrw` / `csrrw` | read / write / read-and-write a CSR |
| `amoswap.w.aq` / `.rl` | atomic swap with acquire/release barrier (locks) |
| `sfence.vma` | flush the TLB after changing page tables |
| `la` / `li` | load address / immediate (pseudo-instructions) |
| `wfi` | wait for interrupt (idle) |

---

## A.6 Sv39 quick reference

- 39-bit virtual addresses, 3 levels, 512 entries (8 bytes each) per page-table
  page.
- VA fields: `[38:30]` L2, `[29:21]` L1, `[20:12]` L0, `[11:0]` offset.
- PTE flags: bit 0 `V`, 1 `R`, 2 `W`, 3 `X`, 4 `U`; PPN in bits `[53:10]`.
- `V` + no `R/W/X` = pointer to next level; `V` + any of `R/W/X` = leaf.
- `satp = (8 << 60) | (root_ppn)` selects Sv39 (Chapter 5).

---

*See also: Appendix B (toolchain), Appendix D (memory map). The full authority is
the RISC-V Instruction Set Manual, Volumes I (unprivileged) and II (privileged).*
