# Solutions — Part V (User Space)

> Answers to the exercises in Chapters 18–21.

---

## Chapter 18 — The User Library

**1. The whole interface.** A stub needs only `li a7, N; ecall; ret` because the
calling convention already placed the arguments in `a0`–`a5` (the C/Go caller did
that), and `ecall` traps into the kernel, which reads `a7` for the number and the
`a` registers for args. On return, the kernel left the result in `a0`, which is
exactly where a Go function returns its value — so `ret` hands it back.

**2. printk vs printf.** `printk` runs in the kernel and writes bytes directly to
the UART (`uartPutcSync`); the user `printf` runs in user mode and emits via the
`write` **syscall**. A user program can't call `printk` because that's kernel code
in a different address space and privilege level — the only way to produce output
is to ask the kernel via a syscall.

**3. morecore granularity.** `morecore` rounds up (≥ 4096 units) so each `sbrk`
syscall yields many allocations' worth of heap, amortizing the trap cost. For 1000
small `malloc`s that fit in one chunk, you make ~1 `sbrk` instead of ~1000 — a
roughly 1000× reduction in syscalls.

**4. Coalescing.** Free A, then C: the free list has two separate small blocks
(A and C), with B still allocated between them. Free B: `free` sees B is adjacent
to both A and C in address order and merges all three into **one** large free
block, instead of leaving three fragments — so a later large `malloc` can succeed.

**5. No GC.** `make([]int, 100)` relies on the **garbage collector** and runtime
heap management we removed (`gc: none`). Our programs must instead `malloc` the
memory explicitly (and `free` it), managing lifetime by hand, because nothing
reclaims it automatically.

---

## Chapter 19 — The Shell

**1. Trace a pipeline.** `cat f | grep x`: `pipe(p)`; `fork` left child →
`close(1); dup(p[1]); close(p[0],p[1]); exec("cat","f")` (its fd 1 = pipe write);
`fork` right child → `close(0); dup(p[0]); close(p[0],p[1]); exec("grep","x")` (its
fd 0 = pipe read); parent `close(p[0],p[1]); wait; wait`. At each `exec`: `cat` has
fd 1 → pipe, `grep` has fd 0 → pipe.

**2. Why before exec.** Redirection must be set up before `exec` because `exec`
replaces the program image but **keeps the descriptor table** — so the new program
inherits whatever fds were arranged. After `exec` the shell's code is gone
(replaced by the new program), so it couldn't set anything up; the new program
would have to, and it doesn't know about the redirection.

**3. cd in a child.** If `cd /tmp` ran via `fork`+`exec`, the `chdir` would change
the **child's** current directory, then the child exits — the parent shell's cwd
is unchanged. So typing `cd /tmp` would appear to do nothing. That's why `cd` is
handled in the shell process itself.

**4. Descriptor leak.** Each end of the pipe stays "open" as long as any fd refers
to it. If the children (and parent) don't close the ends they don't use, the pipe's
write end never fully closes, so the reader (`grep`) never sees EOF and **hangs**
waiting for more input. Everyone must close what they don't need.

**5. Build a feature (`>>`).** Add an `O_APPEND`-like flag (or open with the
append mode from Chapter 17) in the `redirCmd` node, and in `runcmd`'s `redirCmd`
case pass that flag to `open` so writes go to the end of the file instead of
truncating. The parser sets the node's `mode` when it sees `>>`.

---

## Chapter 20 — The Userland Utilities

**1. fd-agnostic.** `cat` always reads from a numbered fd and writes to fd 1; it
never names a device. The difference between `cat file`, `cat < file`, and
`echo hi | cat` is handled by the **shell**, which arranges fd 0 (open the file,
or connect a pipe) before `exec`ing `cat`. `cat` just reads fd 0/its argument fds.

**2. ls internals.** Reading `dirent`s in user space is safe because a directory is
an ordinary **readable file** (Chapter 16): its data blocks hold the entry array,
and `read` returns those bytes through the normal file path. The kernel decision
that a directory's contents are readable as a file is what enables it.

**3. init's dups.** `open("console")` returns fd **0** (lowest free); `dup(0)`
returns fd **1**; `dup(0)` again returns fd **2**. All three point at the console
`struct file`. Every program the shell forks inherits these descriptors (fork
copies the table, exec preserves it), so each starts with a working stdin/stdout/
stderr.

**4. Restart loop.** `init` `wait`s in an inner loop because it's the reparenting
target (Chapter 11): besides its own shell, `wait` may return **orphaned
processes** whose parents exited and were handed to `init`. It keeps reaping until
its own shell's pid comes back, then restarts the shell.

**5. Add a utility (`head`).** It's closest to `cat`: same read loop, but count
newlines and stop after N lines.

```go
func head(fd, n int) {
	var buf [512]byte
	lines := 0
	for lines < n {
		k := read(fd, ptrTo(&buf), len(buf))
		if k <= 0 { break }
		for i := 0; i < k && lines < n; i++ {
			putc(1, buf[i])
			if buf[i] == '\n' { lines++ }
		}
	}
}
```

(A real `head` would parse `-n N` and open file arguments like `cat`.)

---

## Chapter 21 — Testing It All

**1. Why a child per test.** Each test runs in a forked child so that a test which
*intentionally* faults (handing the kernel a bad pointer) crashes only the child;
the parent observes the exit and continues. If such a test ran in the main process,
the first fault would kill the whole suite.

**2. The even count.** `forktest` ends with `wait(nil) == -1` to confirm there are
**no extra children** left. A non-`-1` result would reveal a leaked/duplicated
child (a `fork` or process-table bug); a `wait` that blocks forever there would
reveal an unreaped zombie or a lost-wakeup in `wait`.

**3. Boundary test.** Hand `write` a pointer just past the address space; the
kernel must return **−1** (not crash). The code that makes that happen is
`copyin`/`walkaddr` (Chapter 6): the user address has no valid PTE, so the copy
fails and the syscall returns an error.

**4. Reproducing a race.** `grind` does **random** operations with varying timing
across **multiple harts** (Chapter 9), so it explores many interleavings and is far
more likely to hit a 2-instruction window than `stressfs`'s fixed pattern. Multiple
harts are essential — a single core can't exhibit a true two-CPU data race.

**5. Log overflow.** A workload where one operation writes more distinct blocks
than `beginOp` reserved would expose an underestimate: e.g. an op that modifies the
bitmap, an inode, an indirect block, *and* several data blocks beyond
`MAXOPBLOCKS`. The symptom would be a log overrun — `commit` writing past
`LOGBLOCKS`, corrupting the header or earlier log blocks — i.e. a torn or
unrecoverable transaction after a crash.

---

*Next: [Solutions — Part VI](solutions-part6.md).*
