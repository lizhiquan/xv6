# Chapter 17 — The File Descriptor Layer

> This is the top of the file system, and the layer user programs actually see. A
> **file descriptor** is a small integer that names an open thing — a file, a
> pipe, or a device like the console. This chapter builds the open-file table that
> backs descriptors, unifies files/pipes/devices behind one `read`/`write`
> interface, implements pipes, and wires up the `open`/`read`/`write`/`close`/`dup`
> syscalls. After this, "everything is a file" is true.
>
> Milestone: redirection and pipes work from the kernel side.

---

## 17.1 Three layers of indirection

There are three distinct objects between a user's integer and the bytes, and
keeping them straight is the key to the whole chapter:

```
  process fd table         system open-file table        inode / pipe
  ┌─────────────┐          ┌──────────────────┐          ┌──────────┐
  │ 0 │ 1 │ 2 │…│ ───────► │ struct file      │ ───────► │ inode    │
  └─────────────┘          │  type, off, ref  │          │  (Ch.15) │
   per-process             └──────────────────┘          └──────────┘
   (fd = index)            shared, ref-counted            the actual file
```

- A **file descriptor** is an index into a *per-process* array (`p.ofile`).
- It points at a **`struct file`** in a *system-wide* table — the open-file
  object, holding the current offset and a reference count.
- The `struct file` points at an **inode** (for files/devices) or a **pipe**.

This indirection is what makes `dup`, redirection, and inherited descriptors after
`fork` work: several descriptors (in one process or across parent/child) can share
one `struct file`, hence one offset.

---

## 17.2 The open-file object

A `struct file` is deliberately a small union over the three kinds of openable
things:

```go
// file.go
type fileType int
const (
	fdNone fileType = iota
	fdPipe
	fdInode
	fdDevice
)

type file struct {
	typ      fileType
	ref      int      // reference count (dup, fork bump it)
	readable bool
	writable bool
	pipe     *pipe    // fdPipe
	ip       *inode   // fdInode, fdDevice
	off      uint     // fdInode: current read/write offset
	major    int16    // fdDevice: which device driver
}

var ftable struct {
	lock spinlock
	file [NFILE]file
}
```

`filealloc` hands out a free slot; `filedup` bumps `ref`; `fileclose` drops it and,
at zero, releases the underlying inode or pipe. The reference count is why closing
a descriptor in the parent doesn't disturb the child's copy after `fork`.

---

## 17.3 One interface, three backends

`fileread` and `filewrite` dispatch on `typ`, so the same syscall serves a regular
file, a pipe, or the console:

```go
// file.go
func fileread(f *file, addr uintptr, n int) int {
	if !f.readable {
		return -1
	}
	switch f.typ {
	case fdPipe:
		return piperead(f.pipe, addr, n)
	case fdDevice:
		return devsw[f.major].read(addr, n) // e.g. consoleRead (Chapter 3)
	case fdInode:
		ilock(f.ip)
		r := readi(f.ip, addr, f.off, uint(n)) // Chapter 15
		if r > 0 {
			f.off += uint(r) // advance the shared offset
		}
		iunlock(f.ip)
		return r
	}
	panic("fileread")
}
```

`filewrite` mirrors it, and for `fdInode` it wraps the write in `beginOp`/`endOp`
(Chapter 14) so a write is crash-safe. The **`devsw` table** is how the console
plugs in: at boot, `consoleRead`/`consoleWrite` (Chapter 3) are registered under
the console's major number, so `read(0, ...)` from a shell flows through
`fileread → devsw[CONSOLE].read → consoleRead`. *Everything is a file* is literally
this switch statement.

---

## 17.4 Pipes

A **pipe** is an in-kernel bounded buffer with a read end and a write end. It's
the IPC primitive that lets the shell connect `ls | wc`. `pipealloc` creates the
buffer and two `struct file`s — one readable, one writable:

```go
// pipe.go
const PIPESIZE = 512

type pipe struct {
	lock      spinlock
	data      [PIPESIZE]byte
	nread     uint // total bytes read
	nwrite    uint // total bytes written
	readopen  bool // is the read end still open?
	writeopen bool // is the write end still open?
}
```

Writing blocks when the buffer is full; reading blocks when it's empty — the
`sleep`/`wakeup` pattern from Chapter 10 again, with the byte counts as the
condition:

```go
// pipe.go
func pipewrite(pi *pipe, addr uintptr, n int) int {
	acquire(&pi.lock)
	for i := 0; i < n; {
		if !pi.readopen || killed(myproc()) {
			release(&pi.lock)
			return -1 // reader gone (SIGPIPE-like) — broken pipe
		}
		if pi.nwrite == pi.nread+PIPESIZE { // buffer full
			wakeup(unsafe.Pointer(&pi.nread)) // nudge readers
			sleep(unsafe.Pointer(&pi.nwrite), &pi.lock)
		} else {
			var ch byte
			copyin(myproc().pagetable, ptrTo(&ch), addr+uintptr(i), 1)
			pi.data[pi.nwrite%PIPESIZE] = ch
			pi.nwrite++
			i++
		}
	}
	wakeup(unsafe.Pointer(&pi.nread))
	release(&pi.lock)
	return n
}
```

`piperead` is symmetric: it blocks while empty (unless the write end is closed,
which signals EOF). The two ends' `readopen`/`writeopen` flags are how a reader
learns the writer has gone, and vice versa — closing one end eventually unblocks
the other. Pipe data is copied to/from user space with `copyin`/`copyout` (Chapter
6), never by trusting the user pointer.

---

## 17.5 The syscalls

The syscalls tie it together. `open` resolves a path (Chapter 16), gets a `file`,
and installs it in the lowest free descriptor slot:

```go
// sysfile.go (structure)
func sysOpen() uint64 {
	path := argPath(0)
	omode := argint(1)

	beginOp()
	var ip *inode
	if omode&O_CREATE != 0 {
		ip = create(path, T_FILE, 0, 0) // make it if absent (Chapter 16)
	} else {
		ip = namei(path)
		ilock(ip)
	}
	f := filealloc()
	fd := fdalloc(f) // lowest free index in p.ofile
	f.typ = fdInode
	f.ip = ip
	f.off = 0
	f.readable = omode&O_WRONLY == 0
	f.writable = (omode&O_WRONLY != 0) || (omode&O_RDWR != 0)
	iunlock(ip)
	endOp()
	return uint64(fd)
}

// fdalloc finds the lowest unused descriptor — the key to redirection.
func fdalloc(f *file) int {
	p := myproc()
	for fd := 0; fd < NOFILE; fd++ {
		if p.ofile[fd] == nil {
			p.ofile[fd] = f
			return fd
		}
	}
	return -1
}
```

`read`/`write` look up `p.ofile[fd]` and call `fileread`/`filewrite`. `close`
clears the slot and `fileclose`s. `dup` copies a descriptor into the lowest free
slot (sharing the `struct file`).

The "lowest free descriptor" rule is what makes shell **redirection** work without
any special syscall: to run `ls > out`, the shell closes fd 1, then `open`s `out`
— which lands in slot 1 because it's now lowest-free — then `exec`s `ls`. `ls`
writes to fd 1 as always, and the bytes go to the file. Pipelines work the same
way with `pipe` + `dup` + `fork`. We'll watch the shell do exactly this in Chapter
19.

---

## 17.6 What you should take away

- A descriptor is a **per-process index** into `p.ofile`, pointing at a
  **shared, ref-counted `struct file`**, pointing at an **inode or pipe** — three
  layers that make `dup`, `fork` inheritance, and redirection work.
- `fileread`/`filewrite` **dispatch on type**, so files, pipes, and devices share
  one interface; the **`devsw` table** plugs the console in — *everything is a
  file*.
- A **pipe** is a bounded in-kernel buffer using `sleep`/`wakeup`; `readopen`/
  `writeopen` flags signal EOF and broken pipes; data crosses the boundary via
  `copyin`/`copyout`.
- The **lowest-free-descriptor** rule, with no special syscall, is what makes
  `>`, `<`, and `|` work via `close`+`open`/`dup` before `exec`.

---

## Exercises

1. **Three layers.** After `fd2 = dup(fd1)`, a read on `fd1` advances the offset
   seen by `fd2`. Which of the three objects is shared, and which is not? Draw the
   pointers.

2. **Redirection from scratch.** Write the exact sequence of `close`/`open` calls a
   shell makes to run `wc < input.txt`, and explain why the order matters.

3. **Everything is a file.** Trace `write(1, "hi", 2)` from the syscall to actual
   UART output when fd 1 is the console. Which table entry routes it, and where was
   it registered?

4. **Broken pipe.** A process writes to a pipe whose read end has been closed.
   Follow `pipewrite` and explain what it returns and why — what real-world shell
   behavior does this implement?

5. **Offset sharing vs. independence.** After `fork`, parent and child share file
   offsets for inherited descriptors, but two separate `open`s of the same file do
   not. Explain the difference in terms of the open-file table.

---

*Next: **Chapter 18 — The User Library**, which opens Part V. We cross to the
other side of the syscall boundary and build the user-space runtime: syscall
stubs, a minimal libc, and `malloc` — the foundation every user program links
against.*
