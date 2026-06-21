# Appendix D — The Memory Map

> Every address the kernel hard-codes, in one place. The physical layout of the
> QEMU `virt` machine, the virtual layout of kernel and user address spaces, and
> the constants that define them. Reference for Chapters 1, 2, 5, and 6.

---

## D.1 Physical memory (QEMU `virt`)

QEMU fixes these physical addresses; the kernel is written against them:

```
0x00001000  boot ROM            ← every hart starts executing here at power-on
0x02000000  CLINT               ← timer / software interrupts
0x0C000000  PLIC                ← platform-level interrupt controller (devices)
0x10000000  UART0               ← the console (Chapter 3)
0x10001000  virtio disk         ← the block device (Chapter 12)
0x80000000  RAM begins          ← QEMU loads the kernel here and jumps in (Chapter 2)
   …        kernel code/data, then the page-allocation region
0x88000000  PHYSTOP             ← end of RAM the kernel uses (KERNBASE + 128 MiB)
```

The constants (`memlayout.go`):

```go
const (
	UART0      = 0x10000000
	UART0_IRQ  = 10
	VIRTIO0    = 0x10001000
	VIRTIO0_IRQ = 1
	PLIC       = 0x0C000000
	KERNBASE   = 0x80000000
	PHYSTOP    = KERNBASE + 128*1024*1024
)
```

Within RAM, the kernel occupies `[KERNBASE, end)`; the physical page allocator
(Chapter 4) owns `[end, PHYSTOP)`, where `end` is the linker symbol marking the
first byte past the kernel image.

---

## D.2 The top of the virtual address space

Both kernel and user address spaces pin special pages just below `MAXVA` (the top
of the Sv39 range):

```
 MAXVA          ┌────────────────────┐
                │   TRAMPOLINE       │  trap entry/exit code (Chapter 7)
 TRAMPOLINE     ├────────────────────┤  = MAXVA - PGSIZE
                │   TRAPFRAME        │  saved user registers (one per process)
 TRAPFRAME      ├────────────────────┤  = TRAMPOLINE - PGSIZE
                │        ⋮           │
```

```go
const (
	MAXVA      = 1 << (9 + 9 + 9 + 12 - 1)
	TRAMPOLINE = MAXVA - PGSIZE
	TRAPFRAME  = TRAMPOLINE - PGSIZE
)
```

The **trampoline** is mapped at this same virtual address in *every* address space
(kernel and all users), which is what lets the CPU keep executing across the
page-table switch during a trap (Chapter 7). The **trapframe** is per-process,
holding its saved registers while the kernel runs.

---

## D.3 The kernel address space

The kernel uses a **direct map** — virtual address X = physical address X — with
per-region permissions (Chapter 5):

```
KERNBASE  …  etext   kernel code           R-X   (not writable)
etext     …  PHYSTOP kernel data + free RAM RW-   (not executable)
UART0, VIRTIO0, PLIC  device registers      RW-   (direct-mapped MMIO)
TRAMPOLINE            trap code             R-X
KSTACK(p) for each p  per-process kernel stack, with a guard page below each
```

Kernel stacks live high in the space, just under the trampoline, each separated by
an unmapped **guard page** so a stack overflow faults instead of corrupting a
neighbor:

```go
// one stack per process, with an invalid guard page between them
func KSTACK(p int) uintptr { return TRAMPOLINE - uintptr(p+1)*2*PGSIZE }
```

---

## D.4 A user address space

Each process's space runs from 0 upward, with the two special pages at the top
(Chapter 6):

```
 MAXVA      ┌──────────────┐
            │  TRAMPOLINE  │  (no U bit — user can't touch it)
            │  TRAPFRAME   │  (no U bit)
            │      ⋮       │
            │  heap        │  grows up via sbrk (Chapter 6, 18)
            │  guard page  │  unmapped — catches stack overflow
            │  user stack  │  one page (USERSTACK)
            │  data + bss  │
        0   │  text        │  program code (loaded by exec, Chapter 8)
            └──────────────┘
```

The trampoline and trapframe are present but mapped *without* the `U`
permission bit, so user code can neither read them nor jump into them — they exist
in the address space only so the trap path can reach them.

---

## D.5 Sizes and limits (`param.go`)

| Constant | Value | Meaning |
|----------|-------|---------|
| `PGSIZE` | 4096 | bytes per page |
| `NPROC` | 64 | max processes |
| `NCPU` | 8 | max harts |
| `NOFILE` | 16 | open files per process |
| `NFILE` | 100 | open files system-wide |
| `NINODE` | 50 | active in-memory inodes |
| `NBUF` | 30 | buffer cache size (`MAXOPBLOCKS*3`) |
| `MAXOPBLOCKS` | 10 | max blocks one FS op writes |
| `LOGBLOCKS` | 30 | log capacity in blocks |
| `FSSIZE` | 2000 | file system size in blocks |
| `MAXARG` | 32 | max `exec` arguments |
| `MAXPATH` | 128 | max path length |
| `BSIZE` | 1024 | bytes per disk block |

These bound the static tables and tie the layers together — e.g. `NBUF` and
`LOGBLOCKS` are both `MAXOPBLOCKS*3` so the cache and log can hold the largest
transaction.

---

*See also: Chapter 1 §1.8 (first tour of the map), Chapter 5 (the kernel page
table), Chapter 6 (user address spaces), Appendix A (Sv39).*

---

*This is the end of the appendices, and of the book. You now have, in one place,
every address the kernel depends on — and, across the chapters, every line of
reasoning behind them.*
