# Chapter 6 — Per-Process Address Spaces

> Chapter 5 gave us page tables and a kernel that maps itself. Now we build the
> *user* side: a separate address space per process, laid out so every program
> sees memory starting at zero, with the kernel's trap machinery tucked safely at
> the top. We also write the routines that copy data across the user/kernel
> boundary — because once the page tables enforce isolation, the kernel can no
> longer just dereference a user pointer.
>
> Milestone: build a user address space, map code into it, and switch a (stub)
> process into it.

---

## 6.1 The user address-space layout

Every process gets its own page table, so every process can use the same virtual
addresses for different physical pages — that's the isolation and multiplexing of
Chapter 1, made concrete. A user address space is laid out from zero upward, with
two special pages pinned at the very top:

```
   MAXVA ─┐
          │  TRAMPOLINE   ── trap entry/exit code (same page as the kernel's)
          │  TRAPFRAME    ── saved user registers during a trap
          │      :         (a gap)
          │  heap (grows up, via sbrk)
          │  user stack   (one page, with a guard page below)
          │  data + bss
        0 ┘  text (program code)
```

- **Text, data, stack, heap** are ordinary user-readable/writable pages.
- **TRAPFRAME** holds the user's registers while the kernel runs (Chapter 7).
- **TRAMPOLINE** is the trap entry/exit code, mapped at the *same* virtual
  address in every process *and* in the kernel — which is what lets the CPU keep
  executing across the page-table switch during a trap. (We map it in the kernel
  in Chapter 5; here it appears in user tables too.)

Both top pages are mapped *without* the `U` bit, so user code can't read or jump
into them even though they're in its address space.

---

## 6.2 Creating and growing a user space

A fresh address space is just an empty page table:

```go
// vm.go
func uvmCreate() pagetable {
	pa := kalloc()
	if pa == 0 {
		return nil
	}
	memset(pa, 0, PGSIZE)
	return pagetable(unsafe.Pointer(pa))
}
```

Growing the heap (`sbrk`, used by `malloc` in Chapter 18) allocates pages and maps
them with user permissions:

```go
// vm.go
// uvmAlloc grows the process from oldsz to newsz bytes, returning the new size.
func uvmAlloc(pt pagetable, oldsz, newsz, xperm uint64) uint64 {
	if newsz < oldsz {
		return oldsz
	}
	for a := pgRoundUp(uintptr(oldsz)); a < uintptr(newsz); a += PGSIZE {
		pa := kalloc()
		if pa == 0 {
			uvmDealloc(pt, uint64(a), oldsz) // roll back on failure
			return 0
		}
		memset(pa, 0, PGSIZE)
		if mappages(pt, a, PGSIZE, pa, pteR|pteU|xperm) != 0 {
			kfree(pa)
			uvmDealloc(pt, uint64(a), oldsz)
			return 0
		}
	}
	return newsz
}
```

Shrinking (`uvmDealloc`) walks the freed range, unmapping and `kfree`-ing each
page. Note the careful rollback: a partial failure must leave the address space
exactly as it was, or later code will trip over half-mapped memory. **Every
allocation path in a kernel needs an unwind path.**

---

## 6.3 Unmapping and freeing

`uvmUnmap` is the inverse of `mappages`: it clears leaf PTEs over a range, and
optionally frees the physical pages they pointed to.

```go
// vm.go
func uvmUnmap(pt pagetable, va uintptr, npages int, doFree bool) {
	if va%PGSIZE != 0 {
		panic("uvmUnmap: not aligned")
	}
	for a := va; a < va+uintptr(npages)*PGSIZE; a += PGSIZE {
		pte := walk(pt, a, false)
		if pte == nil {
			panic("uvmUnmap: walk")
		}
		if *pte&pteV == 0 {
			panic("uvmUnmap: not mapped")
		}
		if pteFlags(*pte) == pteV {
			panic("uvmUnmap: not a leaf") // V-only = a page-table page, not a page
		}
		if doFree {
			kfree(pte2pa(*pte))
		}
		*pte = 0
	}
}
```

Freeing a whole address space (`uvmFree`) first unmaps the user pages, then walks
the three-level tree freeing the page-table pages themselves. Tearing down the
*tree* is distinct from freeing the *data* — a recurring distinction.

---

## 6.4 Copying an address space (for `fork`)

`fork` (Chapter 11) needs a child whose memory is an independent copy of the
parent's. `uvmCopy` walks every mapped page of the parent, allocates a fresh
physical page for the child, copies the bytes, and maps it with the same
permissions:

```go
// vm.go
func uvmCopy(old, new pagetable, sz uint64) int {
	for a := uintptr(0); a < uintptr(sz); a += PGSIZE {
		pte := walk(old, a, false)
		if pte == nil || *pte&pteV == 0 {
			panic("uvmCopy: missing page")
		}
		pa := pte2pa(*pte)
		flags := pteFlags(*pte)
		mem := kalloc()
		if mem == 0 {
			uvmUnmap(new, 0, int(a/PGSIZE), true) // roll back
			return -1
		}
		memmove(mem, pa, PGSIZE)
		if mappages(new, a, PGSIZE, mem, flags) != 0 {
			kfree(mem)
			uvmUnmap(new, 0, int(a/PGSIZE), true)
			return -1
		}
	}
	return 0
}
```

This eager copy is simple but wasteful — `fork` often immediately `exec`s,
throwing the copy away. Chapter 23 revisits this with copy-on-write, where parent
and child share pages read-only until one writes. For now, correctness over
cleverness.

---

## 6.5 Crossing the boundary: `copyin` / `copyout`

Here's a subtlety that catches everyone. Once each process has its own page table,
a user pointer like `0x4000` means something *only in that process's* address
space. The kernel runs on the *kernel* page table. So when a syscall hands the
kernel a user pointer, the kernel **cannot simply dereference it** — `0x4000`
isn't mapped (or means something else) in kernel space.

Instead, the kernel translates the user virtual address to a physical address
(via the process's page table) and accesses it through the direct map. That's
what `copyout` (kernel → user) and `copyin` (user → kernel) do, page by page:

```go
// vm.go
// copyout copies len bytes from kernel src to user virtual address dstva.
func copyout(pt pagetable, dstva uintptr, src uintptr, length uint64) int {
	for length > 0 {
		va0 := pgRoundDown(dstva)
		pte := walk(pt, va0, false)
		if pte == nil || *pte&pteV == 0 || *pte&pteU == 0 || *pte&pteW == 0 {
			return -1 // not a writable user page — reject
		}
		pa0 := pte2pa(*pte)
		n := PGSIZE - (dstva - va0) // bytes left in this page
		if n > length {
			n = length
		}
		memmove(pa0+(dstva-va0), src, n)
		length -= n
		src += n
		dstva = va0 + PGSIZE
	}
	return 0
}
```

`copyin` is the mirror image. Three things make these the kernel's security
gate:

- They **check permissions** (`pteU`, and `pteW` for `copyout`): a process can't
  trick the kernel into reading a page it doesn't own or writing a read-only one.
- They **handle page boundaries**: a user buffer can straddle pages that are
  non-contiguous in physical memory, so the copy is done one page at a time.
- They **validate every address**: an unmapped or out-of-range user pointer
  returns an error instead of crashing the kernel.

`copyinstr` is a variant for NUL-terminated strings (path names, `exec`
arguments): it copies until it hits a `\0` or a length limit, so a malicious
process can't make the kernel read forever.

> **The golden rule:** the kernel never trusts a user pointer. Every byte that
> crosses the boundary goes through `copyin`/`copyout`/`copyinstr`, which
> translate and check. Forgetting this is the source of an entire genre of kernel
> vulnerabilities.

---

## 6.6 Switching in

To run a process, the kernel loads its page table into `satp` (the same
mechanism as Chapter 5, but with a *user* table) and fences the TLB. The full
context switch is Chapter 10; the address-space half is just:

```go
// proc.go (sketch)
func uvmSwitch(pt pagetable) {
	sfenceVMA()
	w_satp(makeSATP(pt))
	sfenceVMA()
}
```

Because the trampoline and kernel mappings needed during a trap are present in
*both* the kernel table and (for the trampoline) every user table at the same
virtual address, the switch is safe: the code doing the switching stays mapped
across it. That careful overlap is the whole reason the trampoline exists, as
we'll see in Chapter 7.

---

## 6.7 What you should take away

- Each process has **its own page table**, laid out from 0 upward, with
  **TRAMPOLINE** and **TRAPFRAME** pinned at the top and marked non-user.
- `uvmCreate`/`uvmAlloc`/`uvmDealloc`/`uvmFree` build, grow, shrink, and tear down
  user spaces; every allocation path has a **rollback** path.
- `uvmCopy` duplicates an address space for `fork` (eagerly for now; COW later).
- The kernel **cannot dereference user pointers**; `copyin`/`copyout`/`copyinstr`
  translate through the process's page table and **check permissions and
  bounds** on every access.
- Freeing the **page-table tree** is separate from freeing the **data pages** it
  maps.

---

## Exercises

1. **Guard page.** The user stack has an unmapped guard page below it. What
   happens, hardware-wise, when a program overflows its stack into the guard page?
   Why is a fault better than the alternative?

2. **The boundary bug.** A junior dev writes a `getpid`-style syscall that does
   `*userPtr = pid` directly instead of `copyout`. List two distinct ways a
   malicious user program could exploit this.

3. **Straddling pages.** Trace `copyout` for a 10-byte copy to user address
   `0x2FFB` (5 bytes before a page boundary). How many iterations of the loop
   run, and how many bytes move each time?

4. **Rollback.** In `uvmAlloc`, why must a failed `mappages` call both `kfree` the
   just-allocated page *and* `uvmDealloc` the earlier ones? What leaks if you skip
   either?

5. **Eager vs. lazy.** Estimate the wasted work when a shell `fork`s and the child
   immediately `exec`s a new program, using `uvmCopy` as written. Which Chapter-23
   technique avoids it, and what does it trade away?

---

*Next: **Chapter 7 — Traps, Interrupts, and System Calls**, where we make the
trampoline real: the controlled doorway between user and kernel that every
syscall, timer tick, and device interrupt passes through.*
