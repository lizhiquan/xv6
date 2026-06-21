# Chapter 18 — The User Library

> We cross to the other side of the syscall boundary. Everything so far has been
> kernel code; from here on we write programs that *run* on our kernel. But a user
> program needs a runtime too — a way to invoke syscalls, format output, and
> allocate memory — and once again we can't use Go's standard library, because it
> assumes a host OS. This chapter builds the minimal user library every program
> links against.
>
> Milestone: a user program that links against our user library and runs.

---

## 18.1 The other side of the boundary

A user program can't call kernel functions directly — that's the whole point of
the user/kernel split (Chapter 1). The only way across is the `ecall` trap
(Chapter 7). So the foundation of user space is a set of tiny **syscall stubs**:
one function per syscall that loads the syscall number and executes `ecall`.

These are mechanical and identical except for the number, so we generate them. In
xv6 a Perl script emits assembly; we do the same, producing one stub per entry in
`syscall.h`:

```asm
# usys.s — generated; one stub per syscall
.global write
write:
        li a7, SYS_write   # syscall number in a7 (Chapter 7 convention)
        ecall              # trap into the kernel
        ret                # a0 holds the kernel's return value

.global fork
fork:
        li a7, SYS_fork
        ecall
        ret
# … one for every syscall …
```

On the Go side we declare them as functions with no body, implemented by these
stubs, exactly like the CSR accessors in Chapter 2:

```go
// user.go — the syscall surface, implemented in usys.s
func fork() int
func exit(status int)
func wait(status *int) int
func read(fd int, buf uintptr, n int) int
func write(fd int, buf uintptr, n int) int
func open(path string, mode int) int
func exec(path string, argv []string) int
func sbrk(n int) uintptr
// … etc …
```

Because arguments are already in `a0`–`a5` and the number in `a7`, the stub does
*nothing* but set `a7` and trap — the calling convention does the rest. This is
the entire interface between every user program and the kernel.

---

## 18.2 The user-mode runtime story

Just like the kernel (Chapter 2), user programs can't use the standard Go runtime
— there's no host OS beneath them either; there's *our* kernel. So user programs
are also built with the freestanding toolchain (`gc: none`, `scheduler: none`),
and we provide the small amount of runtime they need ourselves:

- a `_start` entry that calls `main(argc, argv)` and then `exit` (the arguments
  arrive on the stack, placed there by `exec` in Chapter 8);
- the syscall stubs above;
- string and memory helpers;
- a `malloc`/`free` allocator.

The symmetry is worth pausing on: we wrote a freestanding-Go kernel, and now we
write freestanding-Go *programs* to run on it. Same language, same toolchain
constraints, opposite side of the trap.

---

## 18.3 `ulib`: strings and the basics

`ulib` is the user-side standard library — small, allocation-free where it can be,
and built only on syscalls. The string and memory routines mirror C's:

```go
// ulib.go
func strlen(s uintptr) int
func strcpy(dst, src uintptr) uintptr
func memset(dst uintptr, c, n int) uintptr
func memmove(dst, src uintptr, n int) uintptr
func atoi(s uintptr) int

// gets reads a line from fd 0 using read(), one byte at a time.
func gets(buf []byte) int {
	i := 0
	for i+1 < len(buf) {
		var c byte
		if read(0, ptrTo(&c), 1) < 1 {
			break
		}
		buf[i] = c
		i++
		if c == '\n' || c == '\r' {
			break
		}
	}
	buf[i] = 0
	return i
}
```

These are the building blocks the utilities (Chapter 20) and the shell (Chapter
19) lean on. Note `gets` is just `read` in a loop — every "library" function
bottoms out in a syscall.

---

## 18.4 `printf`, in user space

User programs need formatted output, and again we can't import `fmt`. We write a
small `printf` that formats into bytes and `write`s them — structurally the twin
of the kernel's `printk` (Chapter 3), but emitting through the `write` syscall
instead of the UART directly:

```go
// printf.go (user)
func putc(fd int, c byte) {
	write(fd, ptrTo(&c), 1)
}

func printf(fd int, format string, a ...any) {
	// same %d/%x/%s/%c/%p walk as printk, but each byte goes out via write()
	// … format string parsing identical in spirit to Chapter 3 …
}
```

The kernel's `printk` and the user's `printf` are deliberately parallel: one
writes to hardware because it *is* the kernel; the other asks the kernel to write
on its behalf. Same formatter, different bottom layer — a clean illustration of
the boundary.

---

## 18.5 `malloc` and `free`

Programs need a heap. The kernel gives a process more memory only in whole pages,
via the `sbrk` syscall (which calls `uvmAlloc` from Chapter 6). On top of that raw
growth, `malloc` manages a free list of variable-sized blocks — the classic
K&R allocator:

```go
// umalloc.go
// Each block carries a header: its size and a next pointer when free.
type header struct {
	next *header // circular free list
	size uint    // size in header-sized units
}

var base header   // empty list to get started
var freep *header // most-recently-used free block

func malloc(nbytes uint) uintptr {
	// round up to whole headers, scan the free list for a big-enough block,
	// split it if needed; if none fits, grow the heap with morecore().
	// …
}

func morecore(nu uint) *header {
	if nu < 4096 {
		nu = 4096 // grow in page-ish chunks to amortize the syscall
	}
	p := sbrk(int(nu) * int(unsafe.Sizeof(header{}))) // ask the kernel for memory
	if p == ^uintptr(0) {
		return nil // out of memory
	}
	free(uintptr(unsafe.Pointer(/* block after the header */))) // add to free list
	return freep
}

func free(ap uintptr) {
	// coalesce the freed block with adjacent free blocks, keeping the list sorted
	// …
}
```

The structure is the same idea as the kernel's page allocator (Chapter 4) — a free
list — but at finer granularity and with **coalescing**: adjacent free blocks
merge so the heap doesn't fragment into uselessly small pieces. `morecore` grows
in big chunks so we don't trap into the kernel on every small allocation.

This is also where Go-the-language and our reality diverge most visibly: ordinary
Go code says `make` and `new` and trusts the garbage collector. Our user programs
call `malloc`/`free` by hand, because the collector we removed (Chapter 2) isn't
there to help — on either side of the boundary.

---

## 18.6 What you should take away

- A user program reaches the kernel only through **syscall stubs**: set `a7`,
  `ecall`, return `a0`. They're generated, one per syscall number.
- User programs are **also freestanding Go** (no standard runtime); we supply
  `_start`, the stubs, string helpers, `printf`, and `malloc` ourselves.
- The user `printf` is the **twin of `printk`** — same formatter, but it emits via
  the `write` syscall rather than touching hardware.
- `malloc`/`free` is a **coalescing free list** atop the `sbrk` syscall, growing
  the heap in big chunks; it's the user-space cousin of the kernel page allocator.
- On both sides of the trap, we manage memory by hand because the **garbage
  collector is gone**.

---

## Exercises

1. **The whole interface.** Explain why a syscall stub needs no code beyond
   `li a7, N; ecall; ret`. Where did the arguments come from, and where does the
   return value end up?

2. **printk vs printf.** List the differences between the kernel's `printk` and the
   user's `printf`. Why can't a user program just call `printk`?

3. **morecore granularity.** Why does `morecore` round up to at least 4096 units
   instead of asking `sbrk` for exactly what `malloc` needs? Estimate the syscall
   savings for 1000 small `malloc`s.

4. **Coalescing.** Allocate three adjacent blocks A, B, C, then free A and C, then
   B. Show how `free`'s coalescing produces one large free block instead of three
   small ones.

5. **No GC.** A user program does `s := make([]int, 100)` in ordinary Go. What
   does that rely on that our environment lacks, and what must our programs write
   instead?

---

*Next: **Chapter 19 — The Shell**, the program that ties the whole system
together: parsing command lines, and orchestrating `fork`, `exec`, `open`, `pipe`,
and `dup` into redirection and pipelines.*
