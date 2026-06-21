# Appendix C — QEMU and Debugging

> Running the kernel and figuring out why it broke. QEMU flags, the gdb workflow,
> and recipes for inspecting the structures this book builds — page tables,
> trapframes, the process table.

---

## C.1 Running under QEMU

The standard invocation (Chapter 2):

```sh
qemu-system-riscv64 \
  -machine virt \      # the board we target
  -bios none \         # no firmware; our kernel boots directly
  -m 128M \            # RAM (matches PHYSTOP = KERNBASE + 128 MiB)
  -smp 3 \             # number of harts
  -nographic \         # UART to the terminal, no GUI
  -kernel kernel.elf
```

Useful additions:

| Flag | Effect |
|------|--------|
| `-smp 1` | single CPU — isolate concurrency bugs from logic bugs |
| `-drive file=fs.img,if=none,format=raw,id=x0` + virtio-blk | attach a disk image |
| `-d int,guest_errors` | log every trap/interrupt and CPU error |
| `-d in_asm` | log executed instructions (very verbose) |
| `-D qemu.log` | send `-d` output to a file |

**Quitting:** `Ctrl-A` then `x`. (`Ctrl-A` then `c` drops into the QEMU monitor.)

---

## C.2 The gdb workflow

QEMU can wait for a debugger and expose the guest's CPU state:

```sh
# terminal 1: start QEMU frozen, listening for gdb
qemu-system-riscv64 ... -S -gdb tcp::26000

# terminal 2: attach
riscv64-unknown-elf-gdb kernel.elf
(gdb) target remote localhost:26000
(gdb) break main
(gdb) continue
```

- `-S` freezes the machine at reset so you can set breakpoints before any code
  runs — essential for debugging early boot (Chapter 2).
- Load symbols from `kernel.elf` so `break usertrap`, `print p`, and backtraces
  work by name.
- For multi-hart debugging, `info threads` lists harts; `thread N` switches.

A `.gdbinit` that sets the architecture and connects automatically saves typing on
every run.

---

## C.3 Inspecting kernel structures

Once stopped in the kernel, gdb can walk the data structures this book builds:

```gdb
# the current process
(gdb) print *myproc()
(gdb) print myproc()->name
(gdb) print myproc()->state

# the process table
(gdb) print procs

# a trapframe (Chapter 7) — saved user registers
(gdb) print *myproc()->trapframe
(gdb) print/x myproc()->trapframe->epc

# CSRs (the live CPU state)
(gdb) print/x $satp
(gdb) print/x $sepc
(gdb) print/x $scause
```

To **decode a page table** (Chapter 5) by hand, extract the root PPN from `satp`
(`(satp & ((1<<44)-1)) << 12`), then walk the three levels: each step takes 9 bits
of the virtual address as an index, reads the 8-byte PTE, and shifts its PPN left
12 to get the next table. A scripted gdb command or a small in-kernel
`vmprint(pagetable)` debugging routine (a worthwhile thing to write) makes this
far less painful.

---

## C.4 Common boot failures and what they mean

| Symptom | Likely cause |
|---------|--------------|
| nothing prints at all | UART not initialized, or kernel not loaded at `0x80000000` (linker script) |
| triple fault right after `w_satp` | kernel not direct-mapped; the instruction after enabling paging isn't mapped (Chapter 5) |
| "store access fault" before any output | PMP not opened to S-mode (Chapter 2, `start` step 5) |
| hangs immediately, no greeting | stack not set up in `_entry`, or `start` never reaches `mret` |
| panic: "kerneltrap" | an exception (not interrupt) in the kernel — a real bug; check `scause`/`sepc` |
| works on `-smp 1`, breaks on `-smp 3` | a missing lock or a race (Chapter 9) |

The last row is the most instructive debugging heuristic in the book: **if a bug
appears only with multiple CPUs, it's a synchronization bug.** Reproduce on
`-smp 1` to rule out logic errors first.

---

## C.5 Tips

- **`printk` is your friend.** A well-placed print often beats gdb for timing and
  concurrency bugs, where stopping the machine changes the behavior. This is why
  Chapter 3 builds `printk` so early.
- **`objdump` and `readelf`** (from the RISC-V toolchain) show the layout of
  `kernel.elf` — verify `_entry` is at `0x80000000` and inspect generated
  assembly: `riscv64-unknown-elf-objdump -d kernel.elf`.
- **Reproduce, then minimize.** A `grind` (Chapter 21) failure is gold; capture
  the conditions and shrink to the smallest reproducer before debugging.

---

*See also: Appendix A (the CSRs you'll print), Appendix B (building the ELF you
debug).*
