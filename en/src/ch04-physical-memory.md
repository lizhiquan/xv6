# Chapter 4 — Physical Memory Allocation

> Until now everything has lived in statically reserved memory — the per-hart
> stacks from Chapter 2. To run processes, page tables, and pipe buffers we need
> to hand out memory *dynamically*. This chapter builds the kernel's physical
> page allocator: a free list of 4096-byte page frames. The twist is that it must
> live on memory the Go garbage collector cannot see, because *we* are managing
> this memory, not the runtime.
>
> Milestone: `kalloc` and `kfree` working, with a test that drains all of RAM and
> gives it back.

---

## 4.1 What we're allocating, and why pages

The kernel's unit of memory is the **page**: a 4096-byte, page-aligned block.
Everything dynamic is a whole number of pages — a process's memory, each page
table node, kernel stacks, pipe buffers. Fixing the unit at one page size keeps
the allocator trivially simple: there is no fragmentation within a size class,
because there's only one size. Allocation is "give me a page"; freeing is "here's
a page back."

Why 4096? Because that's the page size the RISC-V MMU works in (Chapter 5). If
the allocator's unit matched the hardware's unit, mapping a freshly allocated
page into an address space is a one-to-one affair.

The region we manage runs from the first byte after the kernel image to the top
of RAM:

```
0x80000000  kernel code + data
   …
   end ─────────────────► first free byte (the linker's `end` symbol, Ch. 2)
   …        ← the allocator owns everything here
0x88000000  PHYSTOP (KERNBASE + 128 MiB)
```

`end` comes from the linker script (`PROVIDE(end = .)`), and `PHYSTOP` is the top
of usable RAM. Every page between them is ours to give out.

---

## 4.2 The free list

The classic trick: a free page is its own bookkeeping. We don't keep a separate
table of which pages are free — instead, each free page holds a pointer to the
next free page, right in its first bytes. The allocator is a singly linked list
whose nodes *are* the free pages.

```
freelist ─► [page] ─► [page] ─► [page] ─► nil
             next       next       next
```

- **Allocate**: pop the head of the list.
- **Free**: push the page onto the head.

Both are O(1) and need no extra storage. When a page is free, its contents are
meaningless, so borrowing its first 8 bytes for a `next` pointer costs nothing.

---

## 4.3 The Go problem: memory the GC must not touch

Here is where building a kernel in Go gets interesting. The Go runtime has its
own idea of the heap — memory it got from the OS, scans for pointers, and
collects. But our pages come from *raw physical RAM*. If we stored the free list
as `*page` Go pointers, the garbage collector might scan them, misinterpret junk
as live pointers, or try to move things. We must keep this memory **invisible to
the GC**.

We already disabled the collector entirely in Chapter 2 (`gc: none`). But even so,
the discipline matters and carries forward: the allocator deals in raw addresses
(`uintptr` / `unsafe.Pointer`), never in typed Go pointers the runtime would
track. A free node is just an address written into the first word of a page:

```go
// kalloc.go
package kernel

import "unsafe"

// A run is the header we write into the first bytes of a free page.
// It is never a Go-managed object; it's an overlay on raw RAM.
type run struct {
	next *run
}

var kmem struct {
	lock     spinlock
	freelist *run
}
```

The key idea — and it recurs for page tables (Chapter 5), trapframes (Chapter 7),
and DMA buffers (Chapter 12) — is **a struct is just a typed view over an
address**. We take a physical address, cast it to `*run`, and read/write its
`next` field. No allocation happens; we're reinterpreting bytes we already own.

> **Allocation-free by construction.** `kalloc`/`kfree` themselves must never
> allocate (there'd be nothing to allocate *from* — they *are* the allocator).
> They also run in delicate places: interrupt handlers free pipe buffers, the
> scheduler allocates stacks. Keeping them pure pointer arithmetic over raw RAM
> is what makes them safe to call from anywhere.

---

## 4.4 `kfree`: pushing a page

Freeing validates the address, scribbles junk over the page to catch
use-after-free bugs, then links it onto the list under the lock:

```go
// kalloc.go
func kfree(pa uintptr) {
	// Must be page-aligned and inside the region we own.
	if pa%PGSIZE != 0 || pa < kernelEnd() || pa >= PHYSTOP {
		panic("kfree")
	}

	// Fill with junk so stale references fail loudly.
	memset(pa, 1, PGSIZE)

	r := (*run)(unsafe.Pointer(pa))
	acquire(&kmem.lock)
	r.next = kmem.freelist
	kmem.freelist = r
	release(&kmem.lock)
}
```

The deliberate "fill with junk" is a debugging gift to your future self: if any
code keeps using a page after freeing it, the `1` bytes turn the bug into an
obvious crash instead of silent corruption. `kernelEnd()` returns the linker's
`end` symbol (an asm stub, like `mainPC` in Chapter 2).

---

## 4.5 `kalloc`: popping a page

Allocation pops the head, then fills the page with a *different* junk value so
that code which forgets to initialize freshly allocated memory also fails loudly:

```go
// kalloc.go
// kalloc returns the physical address of a free 4096-byte page,
// or 0 if none is available.
func kalloc() uintptr {
	acquire(&kmem.lock)
	r := kmem.freelist
	if r != nil {
		kmem.freelist = r.next
	}
	release(&kmem.lock)

	if r == nil {
		return 0 // out of memory
	}
	pa := uintptr(unsafe.Pointer(r))
	memset(pa, 5, PGSIZE) // junk-fill to catch uninitialized use
	return pa
}
```

Returning `0` (the null address) on exhaustion is the kernel's universal
"out of memory" signal; every caller must check it. There is no exception
mechanism to fall back on — running out of pages is an ordinary, expected
condition that propagates up as a `nil`/`0` return.

---

## 4.6 Bootstrapping: filling the list

At boot the free list is empty. `kinit` seeds it by *freeing* every page in the
region — the one time `kfree` is called on memory that was never `kalloc`'d:

```go
// kalloc.go
func kInit() {
	initlock(&kmem.lock, "kmem")
	freeRange(kernelEnd(), PHYSTOP)
}

// freeRange frees every whole page in [start, end).
func freeRange(start, end uintptr) {
	p := pgRoundUp(start)
	for p+PGSIZE <= end {
		kfree(p)
		p += PGSIZE
	}
}
```

`pgRoundUp` advances to the next page boundary so we never hand out a partial
page straddling the kernel image. After `kInit`, the free list contains every
usable page — about 32,000 of them on a 128 MiB machine — chained head to tail.

This is the `kInit()` call from the boot sequence in Chapter 1 (§1.7), and it must
run before anything that allocates: the page tables in Chapter 5, the process
table in Chapter 10.

---

## 4.7 Testing it

A good allocator test exhausts memory and recovers it, checking the count is
stable:

```go
// in main, on hart 0, after kInit()
func kallocTest() {
	var pages []uintptr // a fixed-size scratch array in a real test
	n := 0
	for {
		pa := kalloc()
		if pa == 0 {
			break
		}
		pages = append(pages, pa)
		n++
	}
	printk("kalloc: drained %d pages\n", n)
	for _, pa := range pages {
		kfree(pa)
	}
	printk("kalloc: freed them back\n")
}
```

Run it twice; the page count must match exactly. A mismatch means a page leaked
or was double-counted — the first sign of an allocator bug.

```console
$ make qemu
xv6-go kernel booting on hart 0
kalloc: drained 32603 pages
kalloc: freed them back
```

(The exact number depends on the kernel's size, since `end` moves as the kernel
grows.)

---

## 4.8 What you should take away

- The kernel allocates in **whole 4096-byte pages**, matching the MMU's unit;
  one size means no fragmentation and an O(1) allocator.
- A **free list threaded through the free pages themselves** needs no side table:
  a free page stores the `next` pointer in its own first bytes.
- The allocator works in **raw physical addresses**, never GC-managed pointers —
  a struct overlaid on an address is a *view*, not an allocation. This is the same
  technique we use for page tables and trapframes.
- `kalloc` returns **`0` on exhaustion**; every caller must check, because there's
  no other failure channel.
- `kInit` **bootstraps by freeing** the whole region, the one asymmetric use of
  `kfree`.

---

## Exercises

1. **Why page-align the check?** `kfree` panics if `pa % PGSIZE != 0`. Construct a
   bug that this check catches. What would silently break if it were removed?

2. **The two junk values.** `kfree` fills with `1`, `kalloc` with `5`. Why use
   *different* values rather than the same one? What class of bug does each catch?

3. **Lock contention.** Every `kalloc`/`kfree` takes `kmem.lock`. On an 8-CPU
   machine under heavy allocation, this is a bottleneck. Sketch a per-CPU free
   list design that reduces contention. What new problem (balancing) does it
   introduce?

4. **Leak detector.** Modify the test in §4.7 to allocate N pages, free only N-1,
   then re-drain. By how much should the second drain differ, and what does it
   prove?

5. **Order matters.** `kInit` must run before `kvmInit` (Chapter 5). Explain why,
   tracing what `kvmInit` needs from `kalloc`. What symptom would you see if the
   order were swapped?

---

*Next: **Chapter 5 — Virtual Memory and Page Tables**, where these raw pages
become the building blocks of address spaces, and we turn on the RISC-V MMU —
the moment every address in the kernel quietly changes meaning.*
