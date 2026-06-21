# Chapter 5 — Virtual Memory and Page Tables

> This is the chapter where addresses stop being physical. We build the RISC-V
> Sv39 page tables, map the kernel to itself, and flip on the MMU — and the
> instant we write the `satp` register, every address the CPU touches is
> translated through our tables. Get it slightly wrong and the very next
> instruction fetch faults. Get it right and you have the foundation for process
> isolation.
>
> Milestone: the kernel runs with paging enabled, having mapped RAM, the UART,
> the PLIC, and the disk.

---

## 5.1 Why virtual memory

Two of the three OS jobs from Chapter 1 depend on this chapter. **Isolation**:
each process must have its own address space, unable to name another's memory.
**Multiplexing**: many processes share one physical RAM, each believing it owns a
clean address range starting at zero. Both come from the same mechanism — a
**page table** that translates the *virtual* addresses a program uses into the
*physical* addresses of actual RAM, under the kernel's control.

The hardware does the translation on every load, store, and instruction fetch.
The kernel's job is to build the tables; the MMU walks them.

---

## 5.2 Sv39 in one picture

RISC-V's Sv39 scheme uses **39-bit virtual addresses** translated through a
**three-level** tree of page tables. A virtual address splits into four fields:

```
 38      30 29      21 20      12 11           0
┌──────────┬──────────┬──────────┬─────────────┐
│  L2 idx  │  L1 idx  │  L0 idx  │   offset    │
│ (9 bits) │ (9 bits) │ (9 bits) │  (12 bits)  │
└──────────┴──────────┴──────────┴─────────────┘
     │          │          │            │
     │          │          │            └─ byte within the 4 KiB page
     │          │          └─ index into the level-0 table
     │          └─ index into the level-1 table
     └─ index into the level-2 (root) table
```

Each table is itself one 4096-byte page holding **512 entries** of 8 bytes each
(512 = 2⁹, matching a 9-bit index). To translate an address: index the root table
with the L2 field to find the L1 table, index that with L1 to find the L0 table,
index that with L0 to find the **PTE** for the page, then add the 12-bit offset to
the physical page address.

Three levels of indirection is what makes a sparse 512 GB address space cheap:
unused regions simply have no lower-level tables, costing nothing.

---

## 5.3 What a PTE looks like

A **page table entry** packs a physical page number and a set of flag bits:

```
63        10 9       0
┌────────────┬────────┐
│    PPN     │ flags  │   (the low 10 bits are flags; PPN is bits 10..53)
└────────────┴────────┘
```

The flags we use:

| Bit | Name | Meaning |
|-----|------|---------|
| 0 | `V` | valid — this entry is in use |
| 1 | `R` | readable |
| 2 | `W` | writable |
| 3 | `X` | executable |
| 4 | `U` | user mode may access |

A PTE with `V` set but `R/W/X` all clear is a *pointer to the next level*; a PTE
with any of `R/W/X` set is a *leaf* naming a real page. We encode these in Go with
small helpers mirroring the hardware's bit layout:

```go
// riscv.go
const (
	PGSIZE  = 4096
	PGSHIFT = 12

	pteV = 1 << 0
	pteR = 1 << 1
	pteW = 1 << 2
	pteX = 1 << 3
	pteU = 1 << 4
)

// physical address -> PTE field (shift right 12, into bits 10+)
func pa2pte(pa uintptr) uint64 { return (uint64(pa) >> 12) << 10 }

// PTE -> physical address
func pte2pa(pte uint64) uintptr { return uintptr((pte >> 10) << 12) }

// extract the 9-bit index for a given level from a virtual address
func px(level int, va uintptr) uint {
	shift := PGSHIFT + 9*level
	return uint((uint64(va) >> shift) & 0x1ff)
}

// MAXVA is one bit below the architectural max, to stay out of trouble.
const MAXVA = uintptr(1) << (9 + 9 + 9 + 12 - 1)
```

A page table is just a page of 512 `uint64` PTEs, which we view through a typed
pointer — the same "struct overlaid on a physical address" idea from Chapter 4:

```go
type pagetable = *[512]uint64
```

---

## 5.4 `walk`: find the PTE for an address

`walk` is the heart of the system: given a page table and a virtual address, it
descends the three levels and returns a pointer to the leaf PTE. With `alloc`
set, it creates missing intermediate tables along the way using `kalloc` from
Chapter 4:

```go
// vm.go
// walk returns the address of the level-0 PTE for va, allocating
// intermediate page-table pages when alloc is true.
func walk(pt pagetable, va uintptr, alloc bool) *uint64 {
	if va >= MAXVA {
		panic("walk")
	}
	for level := 2; level > 0; level-- {
		pte := &pt[px(level, va)]
		if *pte&pteV != 0 {
			pt = pagetable(unsafe.Pointer(pte2pa(*pte))) // descend
		} else {
			if !alloc {
				return nil
			}
			page := kalloc()
			if page == 0 {
				return nil // out of memory
			}
			memset(page, 0, PGSIZE)
			*pte = pa2pte(page) | pteV // link new table in (no R/W/X => pointer)
			pt = pagetable(unsafe.Pointer(page))
		}
	}
	return &pt[px(0, va)]
}
```

Read it slowly: at each of levels 2 and 1, it either follows an existing pointer
PTE down, or (if allowed) allocates a zeroed page to be the next table and links
it in as a *pointer* PTE (`V` set, no `R/W/X`). After the loop, it returns the
address of the level-0 PTE — the leaf you'll fill in.

---

## 5.5 `mappages`: install mappings

`mappages` installs leaf PTEs for a range of virtual addresses, walking once per
page and writing the PPN and permission flags:

```go
// vm.go
// mappages maps [va, va+size) to [pa, pa+size), one page at a time.
func mappages(pt pagetable, va, size, pa uintptr, perm uint64) int {
	if size == 0 {
		panic("mappages: zero size")
	}
	a := pgRoundDown(va)
	last := pgRoundDown(va + size - 1)
	for {
		pte := walk(pt, a, true)
		if pte == nil {
			return -1 // allocation failed
		}
		if *pte&pteV != 0 {
			panic("mappages: remap")
		}
		*pte = pa2pte(pa) | perm | pteV
		if a == last {
			break
		}
		a += PGSIZE
		pa += PGSIZE
	}
	return 0
}
```

The `remap` panic is a safety net: mapping an already-mapped page almost always
means a bug. Note `perm` carries the `R/W/X/U` bits the caller wants, and we
always add `V`.

---

## 5.6 The kernel's own page table

Before we can turn on paging, the kernel needs a page table that maps *itself* —
otherwise the instruction right after we enable the MMU would fault. The kernel
uses a **direct map**: virtual address X maps to physical address X. This keeps
kernel code simple (a pointer is both virtual and physical) while still letting us
set per-page permissions.

```go
// vm.go
var kernelPagetable pagetable

func kvmMake() pagetable {
	kpt := pagetable(unsafe.Pointer(kalloc()))
	memset(uintptr(unsafe.Pointer(kpt)), 0, PGSIZE)

	kvmMap(kpt, UART0, UART0, PGSIZE, pteR|pteW)            // UART registers
	kvmMap(kpt, VIRTIO0, VIRTIO0, PGSIZE, pteR|pteW)        // virtio disk
	kvmMap(kpt, PLIC, PLIC, 0x4000000, pteR|pteW)           // interrupt controller

	kvmMap(kpt, KERNBASE, KERNBASE, etext()-KERNBASE, pteR|pteX) // kernel code: R-X
	kvmMap(kpt, etext(), etext(), PHYSTOP-etext(), pteR|pteW)    // kernel data + free RAM: RW-

	kvmMap(kpt, TRAMPOLINE, trampolinePA(), PGSIZE, pteR|pteX)   // trap trampoline (Ch. 7)
	procMapStacks(kpt)                                          // per-process kernel stacks (Ch. 10)
	return kpt
}

func kvmInit()     { kernelPagetable = kvmMake() }
```

Notice the permissions tell a security story even in the kernel:

- **Devices** (UART, virtio, PLIC) — read/write, no execute.
- **Kernel code** (`KERNBASE`..`etext`) — read + execute, *not* writable, so a
  stray write can't modify code.
- **Kernel data and the page pool** (`etext`..`PHYSTOP`) — read/write, *not*
  executable, so data can't be run as code.

The `etext` symbol (end of code) comes from the linker, like `end` in Chapter 4.
`TRAMPOLINE` and per-process stacks are mapped here but only become meaningful in
Chapters 7 and 10.

---

## 5.7 Turning it on: `satp` and `sfence.vma`

Enabling paging is a single CSR write — but a dangerous one. The `satp` register
holds the root page table's physical page number plus a mode field selecting
Sv39. The moment we write it, translation is live:

```go
// vm.go — run on every hart
func kvmInitHart() {
	sfenceVMA()                       // finish any pending page-table writes
	w_satp(makeSATP(kernelPagetable)) // turn paging ON (Sv39 + root PPN)
	sfenceVMA()                       // flush stale TLB entries
}

// riscv.go
const satpSV39 = uint64(8) << 60
func makeSATP(pt pagetable) uint64 {
	return satpSV39 | uint64(uintptr(unsafe.Pointer(pt)))>>12
}
```

The two `sfence.vma` instructions bracket the switch. The MMU caches recent
translations in a **TLB**; after changing the tables we must flush it, or the CPU
might use stale entries. The first fence orders our page-table writes before the
switch; the second discards any cached translations from before paging was on.

This is why the kernel must be direct-mapped: the instruction *after* `w_satp`
lives at some physical address P, and the CPU now fetches it via virtual address
P. Because virtual P maps to physical P, execution continues seamlessly. If the
mapping were wrong, you'd fault on the very next fetch — the classic, baffling
"it triple-faults the instant I enable paging" bug.

`kvmInit` runs once on hart 0 (it builds the shared table); `kvmInitHart` runs on
*every* hart (each must load `satp` itself). Both appear in the boot sequence from
Chapter 1 (§1.7).

---

## 5.8 What you should take away

- **Sv39** translates 39-bit virtual addresses through a **three-level**,
  512-entry-per-node page table; the bottom 12 bits are the in-page offset.
- A **PTE** holds a physical page number plus `V/R/W/X/U` flags. `V` alone =
  pointer to the next level; `V` + any of `R/W/X` = a leaf mapping.
- **`walk`** descends (and optionally grows) the tree to a leaf PTE; **`mappages`**
  fills leaves for an address range.
- The kernel **direct-maps itself** so addresses keep their meaning across the
  paging switch, with per-region permissions (code R-X, data RW-, devices RW-).
- Writing **`satp`** turns paging on; **`sfence.vma`** before and after orders the
  change and flushes the TLB.

---

## Exercises

1. **Count the tables.** To map a single page at virtual address 0, how many
   page-table pages does `walk(..., alloc=true)` allocate? How many to additionally
   map the page at virtual address `0x40000000`?

2. **Permission bug.** Suppose you accidentally map the kernel code region with
   `pteW` added. What protection do you lose? Write a one-line bug that would now
   silently corrupt the kernel.

3. **The fence.** Remove the *second* `sfenceVMA()` in `kvmInitHart`. Construct a
   scenario where the kernel reads a stale translation. Why is the *first* fence
   also necessary?

4. **Why direct map the kernel?** Explain, instruction by instruction, what would
   happen if `KERNBASE` were mapped to a *different* physical address than itself
   right when `w_satp` executes.

5. **MAXVA.** `MAXVA` is one bit below the architectural maximum. Read the Sv39
   rule about the top virtual address bits and explain what breaks if the kernel
   handed out addresses at the very top of the range.

---

*Next: **Chapter 6 — Per-Process Address Spaces**, where we build user page
tables, the trampoline and guard pages, and the `copyin`/`copyout` routines that
safely move data across the boundary the page tables now enforce.*
