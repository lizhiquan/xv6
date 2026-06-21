# Chapter 8 — The First Process and `exec`

> We have address spaces (Chapter 6) and a trap path (Chapter 7), but every
> process so far is a stub. This chapter turns a *file* into a *running program*:
> we parse an ELF binary, load its segments into a fresh address space, set up its
> stack with command-line arguments, and switch into it. Then we hand-craft the
> very first process out of nothing, so it can `exec` `/init` and bootstrap user
> space.
>
> Milestone: boot all the way to running a real user binary.

---

## 8.1 What `exec` does

`exec(path, argv)` replaces the calling process's memory with a new program. The
process id, open files, and kernel structures survive; everything in the user
address space is thrown away and rebuilt from the executable at `path`. This is
the Unix model: `fork` makes a copy of a process (Chapter 11), `exec` reloads it
with a new program. Together they run every command you type.

The steps:

1. Open the file and read its ELF header; sanity-check the magic number.
2. Create a brand-new page table.
3. Load each program segment into the new address space.
4. Allocate a user stack and push the arguments onto it.
5. Atomically swap the new address space in for the old, and free the old.
6. Return into the new program at its entry point.

The "atomically swap, then free the old" ordering matters: if anything fails
before the swap, the original program is untouched and we return an error.

---

## 8.2 The ELF format, minimally

An **ELF** executable starts with a header naming the architecture, the entry
point, and the location of the **program headers**. Each program header describes
one *segment* to load: where in the file it lives, what virtual address it maps
to, how big it is on disk and in memory, and its permissions.

We can't use Go's `debug/elf` (it allocates and assumes an OS), so we define the
structs ourselves as views over bytes read from disk:

```go
// elf.go
const elfMagic = 0x464C457F // "\x7FELF" little-endian

type elfHeader struct {
	magic uint32
	// … ident bytes, type, machine, version …
	entry uint64 // virtual address of the entry point
	phoff uint64 // file offset of the program headers
	// …
	phnum uint16 // number of program headers
}

type progHeader struct {
	typ    uint32
	flags  uint32 // R/W/X, mapped to PTE bits
	off    uint64 // offset in the file
	vaddr  uint64 // virtual address to load at
	paddr  uint64
	filesz uint64 // bytes present in the file
	memsz  uint64 // bytes to reserve in memory (>= filesz; the rest is zeroed)
}

func flags2perm(flags uint32) uint64 {
	var perm uint64
	if flags&0x1 != 0 { perm |= pteX }
	if flags&0x2 != 0 { perm |= pteW }
	return perm
}
```

The `memsz >= filesz` rule is how `.bss` works: the file stores only the
initialized bytes; the loader zero-fills the rest.

---

## 8.3 Loading the segments

`kexec` opens the file (through the file system, Chapters 14–16, via `namei`),
reads the ELF header, builds a page table, and loads each segment. Loading a
segment means: grow the address space to cover it (`uvmAlloc`), then copy the
bytes from disk into the freshly mapped pages (`loadseg`).

```go
// exec.go (structure)
func kexec(path string, argv []string) int {
	beginOp()                 // file-system transaction (Chapter 14)
	ip := namei(path)         // resolve the path to an inode (Chapter 16)
	if ip == nil {
		endOp()
		return -1
	}
	ilock(ip)

	var elf elfHeader
	if readi(ip, &elf, 0, uint(unsafe.Sizeof(elf))) != int(unsafe.Sizeof(elf)) {
		goto bad
	}
	if elf.magic != elfMagic {
		goto bad // not an executable
	}

	pt := procPagetable(myproc()) // new, with trampoline+trapframe mapped
	if pt == nil {
		goto bad
	}

	// Load each PT_LOAD segment.
	var sz uint64
	for i, off := 0, elf.phoff; i < int(elf.phnum); i, off = i+1, off+phSize {
		var ph progHeader
		readi(ip, &ph, uint(off), uint(phSize))
		if ph.typ != progLoad {
			continue
		}
		sz = uvmAlloc(pt, sz, ph.vaddr+ph.memsz, flags2perm(ph.flags))
		loadseg(pt, ph.vaddr, ip, uint(ph.off), uint(ph.filesz))
	}
	iunlockput(ip)
	endOp()
	// … stack setup (next section) …
}
```

`loadseg` uses `walkaddr` to find the physical page behind each user virtual
address, then reads file bytes straight into it — the kernel writing into the
new program's memory before that program ever runs.

---

## 8.4 Building the stack and arguments

A C-style program expects `main(argc, argv)`: an argument count and an array of
string pointers, with the strings themselves on the stack. `exec` builds this by
hand at the top of a freshly allocated stack page, copying each argument string
with `copyout` (Chapter 6 — we're writing into *user* space) and recording where
each landed:

```go
// exec.go (stack setup)
	// Allocate two pages at the next page boundary; the lower is a guard.
	sz = pgRoundUp(sz)
	sz1 := uvmAlloc(pt, sz, sz+2*PGSIZE, pteW)
	sz = sz1
	uvmClear(pt, sz-2*PGSIZE) // clear PTE_U on the guard page
	sp := sz
	stackbase := sp - PGSIZE

	var ustack [MAXARG]uint64
	argc := 0
	for ; argc < len(argv); argc++ {
		sp -= uint64(len(argv[argc]) + 1)
		sp -= sp % 16 // RISC-V requires 16-byte stack alignment
		if sp < stackbase {
			goto bad // arguments too big
		}
		copyout(pt, uintptr(sp), strPtr(argv[argc]), uint64(len(argv[argc])+1))
		ustack[argc] = sp
	}
	ustack[argc] = 0 // null-terminate the argv array

	// Push the argv pointer array itself.
	sp -= uint64(argc+1) * 8
	sp -= sp % 16
	copyout(pt, uintptr(sp), ptrTo(&ustack), uint64(argc+1)*8)
```

After this, `a1` is set to `sp` (the address of `argv`) and `a0` to `argc`, so the
program's entry code finds its arguments in the expected registers. The guard
page below the stack (with its `U` bit cleared) turns a stack overflow into a
clean fault instead of silent corruption — the guard-page idea from Chapter 6.

---

## 8.5 The atomic swap

Only now, with everything successfully built, do we commit. We point the process
at the new page table and entry point, save the old table, and free it:

```go
// exec.go (commit)
	p := myproc()
	oldpt := p.pagetable
	p.pagetable = pt
	p.sz = sz
	p.trapframe.epc = elf.entry // start executing at the ELF entry point
	p.trapframe.sp = sp         // the stack we just built
	uvmSwitch(p.pagetable)      // load the new satp
	procFreePagetable(oldpt, oldsz) // reclaim the old address space
	return int(argc)            // returns into the new program

bad:
	// any failure before the swap: free the half-built table, return -1
	if pt != nil {
		procFreePagetable(pt, sz)
	}
	return -1
}
```

When `kexec` returns, the usual trap-return path (Chapter 7) restores registers
and `sret`s — but `epc` and `sp` now point at the *new* program. The process
resumes as a completely different executable. That's the magic of `exec`: same
process, new program.

---

## 8.6 The first process, from nothing

There's a bootstrapping problem: `exec` runs *in* a process, but at boot there are
no processes. `userInit` (called from `main`, Chapter 1 §1.7) hand-crafts process
#1 without `fork` or a real `exec`.

It allocates a process, gives it a one-page address space, and copies in a tiny
machine-code program called **initcode**, compiled in and embedded as a byte
array:

```go
// proc.go
// initcode: the assembled bytes of a program that just does
//   exec("/init", ["/init"]); for(;;) exit();
var initcode = []byte{
	0x17, 0x05, 0x00, 0x00, // auipc a0, 0
	0x13, 0x05, 0x45, 0x02, // addi  a0, a0, 36
	// … sets up exec("/init") and traps in …
}

func userInit() {
	p := allocproc()
	initproc = p

	// Load initcode into the process's address space at virtual address 0.
	uvmFirst(p.pagetable, initcode)
	p.sz = PGSIZE

	// Set it up to "return" to user space at address 0.
	p.trapframe.epc = 0
	p.trapframe.sp = PGSIZE

	p.name = "initcode"
	p.cwd = namei("/")    // current directory = root
	p.state = RUNNABLE    // eligible to be scheduled
}
```

When the scheduler (Chapter 10) first runs process #1, it returns to user space at
address 0 and executes initcode, which immediately calls `exec("/init")`. From
that point on, everything is an ordinary user program: `init` opens the console,
forks a shell, and the system is alive.

```
userInit → initcode (in-kernel bytes) → exec("/init") → init → fork → sh
```

`/init` itself is a normal binary on the file system, loaded by the very `kexec`
we built in this chapter. The hand-crafted initcode exists only to make that first
`exec` call.

---

## 8.7 What you should take away

- `exec` **replaces a process's program**: parse ELF, load segments into a new
  address space, build the argument stack, then **atomically swap** and free the
  old space.
- ELF program headers describe segments; **`memsz >= filesz`** gives zero-filled
  `.bss` for free.
- Arguments are copied into user space with **`copyout`**, the pointer array is
  pushed, and `a0`/`a1` carry `argc`/`argv` to the program; the stack stays
  16-byte aligned with a guard page below.
- Any failure **before the swap** leaves the old program intact — exec either
  fully succeeds or doesn't disturb the caller.
- The first process is **hand-crafted** (`userInit` + `initcode`) solely to issue
  the first `exec("/init")`; after that, user space bootstraps itself.

---

## Exercises

1. **Magic number.** Why check `elf.magic` before doing anything else? What could
   a malicious or corrupt file do if `exec` skipped the check and trusted `phnum`
   and `phoff`?

2. **bss.** A program has a 4 KB initialized data segment and a 1 MB zeroed array.
   How many bytes does `exec` read from disk? How does the 1 MB get into memory?

3. **The swap ordering.** Why does `kexec` build the entire new address space
   before touching `p.pagetable`? Describe the corruption that could occur if it
   swapped first and loaded segments after.

4. **Alignment.** RISC-V requires `sp % 16 == 0`. Trace the stack pointer through
   `exec` with two arguments `"ls"` and `"-l"`. Show that each `copyout` lands at
   a 16-aligned address.

5. **Chicken and egg.** Why can't `userInit` simply call `kexec("/init")`
   directly? What does initcode provide that a direct call cannot, at that point
   in boot?

---

*Next: **Chapter 9 — Locking and Multicore**, where we make concurrency safe:
spinlocks, sleep locks, the RISC-V memory model, and bringing the other harts
online so all those `acquire`/`release` calls we've been writing finally mean
something.*
